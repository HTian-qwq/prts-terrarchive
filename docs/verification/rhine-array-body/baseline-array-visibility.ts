import * as THREE from "three";
import { ArrayOcclusion, substrateRectangle } from "./array-occlusion.ts";

const FRUSTUM_PADDING = 0.35;

type Batch = {
  mesh: THREE.InstancedMesh;
  indices: Uint32Array;
  count: number;
  filtered: Uint32Array;
  occluded: number;
  outside: number;
};
type DetailLOD = {
  high: THREE.InstancedMesh; low: THREE.InstancedMesh;
  featureSize: number; enterBelow: number; leaveAbove: number;
  levels: Uint8Array; highIndices: Uint32Array; lowIndices: Uint32Array;
  highCount: number; lowCount: number;
};

/**
 * Keep logical cassette poses separate from compact GPU instance slots.
 * Batch transforms must be identity: authored geometry and slot matrices share
 * world space. All visible layers use one complete-cassette bounding box, while
 * shadow casters retain off-camera instances that can still shade the scene.
 */
export class ArrayVisibility {
  private readonly matrices: THREE.Matrix4[];
  private readonly active: Uint8Array;
  private readonly activeIndices: Uint32Array;
  private readonly visibleIndices: Uint32Array;
  private readonly cardBounds = new THREE.Box3();
  private readonly worldBounds = new THREE.Box3();
  private readonly viewProjection = new THREE.Matrix4();
  private readonly frustum = new THREE.Frustum();
  private batches: Batch[] = [];
  private readonly batchByMesh = new Map<THREE.InstancedMesh, Batch>();
  private activeSlots = 0;
  private visibleSlots = 0;
  private shadowSlots = 0;
  private readonly detailLODs: DetailLOD[] = [];
  private readonly lodPoint = new THREE.Vector3();
  private occlusion?: ArrayOcclusion;

  setOpaqueSubstrate(geometry: THREE.BufferGeometry) {
    const rectangle = substrateRectangle(geometry);
    this.occlusion = rectangle ? new ArrayOcclusion(rectangle, this.capacity) : undefined;
  }

  addDetailLOD(high: THREE.InstancedMesh, low: THREE.InstancedMesh,
    featureSize: number, enterBelow: number, leaveAbove: number) {
    this.detailLODs.push({ high, low, featureSize, enterBelow, leaveAbove,
      levels: new Uint8Array(this.capacity), highIndices: new Uint32Array(this.capacity),
      lowIndices: new Uint32Array(this.capacity), highCount: 0, lowCount: 0 });
  }

  constructor(readonly capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 0)
      throw new RangeError("Array capacity must be a non-negative integer.");
    this.matrices = Array.from({ length: capacity }, () => new THREE.Matrix4());
    this.active = new Uint8Array(capacity);
    this.activeIndices = new Uint32Array(capacity);
    this.visibleIndices = new Uint32Array(capacity);
  }

  setSlot(index: number, matrix: THREE.Matrix4, active: boolean) {
    this.matrixAt(index).copy(matrix);
    this.active[index] = active ? 1 : 0;
  }

  /** Borrow the full authored pose, including hidden and culled slots. */
  matrixAt(index: number): THREE.Matrix4 {
    if (!Number.isInteger(index) || index < 0 || index >= this.capacity)
      throw new RangeError("Array slot is outside the logical pool.");
    return this.matrices[index];
  }

  /** Call after all geometry/bake batches have been created. */
  prepare(instances: readonly THREE.InstancedMesh[]) {
    this.cardBounds.makeEmpty();
    this.batchByMesh.clear();
    this.batches = instances.map((mesh) => {
      if (mesh.instanceMatrix.count < this.capacity)
        throw new RangeError("Instance buffer is smaller than the logical pool.");
      if (mesh.geometry.boundingBox === null) mesh.geometry.computeBoundingBox();
      if (mesh.geometry.boundingBox) this.cardBounds.union(mesh.geometry.boundingBox);
      const batch = { mesh, indices: this.visibleIndices, count: 0,
        filtered: new Uint32Array(this.capacity), occluded: 0, outside: 0 };
      this.batchByMesh.set(mesh, batch);
      return batch;
    });
  }

  submit(camera: THREE.Camera, instances: readonly THREE.InstancedMesh[], cull = true, pixelHeight = 0) {
    if (instances.length !== this.batches.length ||
      instances.some((mesh, index) => mesh !== this.batches[index].mesh))
      this.prepare(instances);
    camera.updateWorldMatrix(true, false);
    this.viewProjection.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(
      this.viewProjection, camera.coordinateSystem, camera.reversedDepth,
    );
    this.activeSlots = 0;
    this.visibleSlots = 0;
    const testBounds = cull && !this.cardBounds.isEmpty();
    for (let index = 0; index < this.capacity; index++) {
      if (!this.active[index]) continue;
      this.activeIndices[this.activeSlots++] = index;
      if (testBounds) {
        this.worldBounds.copy(this.cardBounds)
          .applyMatrix4(this.matrices[index]).expandByScalar(FRUSTUM_PADDING);
        if (!this.frustum.intersectsBox(this.worldBounds)) continue;
      }
      this.visibleIndices[this.visibleSlots++] = index;
    }
    // A substrate covering an on-screen point necessarily intersects this
    // conservative complete-card frustum list. Off-screen casters stay in the
    // separate shadow list and do not need camera-occlusion volumes.
    this.occlusion?.update(camera, this.matrices, this.visibleIndices, this.visibleSlots, pixelHeight);
    for (const lod of this.detailLODs) {
      lod.highCount = lod.lowCount = 0;
      for (let index = 0; index < this.visibleSlots; index++) {
        const logical = this.visibleIndices[index];
        this.lodPoint.set(0, 1.85, 0).applyMatrix4(this.matrices[logical]).applyMatrix4(camera.matrixWorldInverse);
        const depth = camera instanceof THREE.PerspectiveCamera ? Math.max(0.01, -this.lodPoint.z - 3) : 1;
        const pixels = pixelHeight > 0 ? lod.featureSize * Math.abs(camera.projectionMatrix.elements[5]) * pixelHeight / (2 * depth) : Infinity;
        const low = pixels < (lod.levels[logical] ? lod.leaveAbove : lod.enterBelow);
        lod.levels[logical] = low ? 1 : 0;
        if (low) lod.lowIndices[lod.lowCount++] = logical;
        else lod.highIndices[lod.highCount++] = logical;
      }
    }
    this.shadowSlots = 0;
    for (const batch of this.batches) {
      const { mesh } = batch;
      batch.indices = mesh.castShadow ? this.activeIndices : this.visibleIndices;
      batch.count = mesh.castShadow ? this.activeSlots : this.visibleSlots;
      const lod = this.detailLODs.find(item => item.high === mesh || item.low === mesh);
      if (lod) {
        batch.indices = mesh === lod.high ? lod.highIndices : lod.lowIndices;
        batch.count = mesh === lod.high ? lod.highCount : lod.lowCount;
      }
      batch.occluded = batch.outside = 0;
      if (this.occlusion && mesh.userData.occlusionCull && !mesh.castShadow) {
        let kept = 0;
        for (let i = 0; i < batch.count; i++) {
          const logical = batch.indices[i];
          this.worldBounds.copy(mesh.geometry.boundingBox!).applyMatrix4(this.matrices[logical]).expandByScalar(FRUSTUM_PADDING);
          if (cull && !this.frustum.intersectsBox(this.worldBounds)) batch.outside++;
          else if (this.occlusion.hidden(mesh.geometry.boundingBox!, this.matrices[logical], logical)) batch.occluded++;
          else batch.filtered[kept++] = logical;
        }
        batch.indices = batch.filtered; batch.count = kept;
      }
      if (mesh.castShadow) this.shadowSlots = this.activeSlots;
      for (let index = 0; index < batch.count; index++)
        mesh.setMatrixAt(index, this.matrices[batch.indices[index]]);
      mesh.count = batch.count;
      mesh.instanceMatrix.clearUpdateRanges();
      if (batch.count > 0) {
        // BufferAttribute ranges count scalar components, not matrices/bytes.
        mesh.instanceMatrix.addUpdateRange(0, batch.count * 16);
        mesh.instanceMatrix.needsUpdate = true;
      }
      // setMatrixAt does not invalidate these. Raycasting also uses the sphere
      // when frustumCulled is false, so both must follow compaction and motion.
      mesh.boundingBox = null;
      mesh.boundingSphere = null;
    }
  }

  logicalIndex(mesh: THREE.InstancedMesh, instanceId: number): number | undefined {
    const batch = this.batchByMesh.get(mesh);
    if (!batch || !Number.isInteger(instanceId) || instanceId < 0 || instanceId >= batch.count)
      return undefined;
    return batch.indices[instanceId];
  }

  getStats() {
    return {
      capacity: this.capacity,
      activeSlots: this.activeSlots,
      visibleSlots: this.visibleSlots,
      culledSlots: this.activeSlots - this.visibleSlots,
      shadowSlots: this.shadowSlots,
      ...(this.detailLODs.length ? { lod: this.detailLODs.map(item => ({
        name: item.high.name, high: this.batchByMesh.get(item.high)?.count ?? 0,
        low: this.batchByMesh.get(item.low)?.count ?? 0,
        enterBelowPixels: item.enterBelow, leaveAbovePixels: item.leaveAbove,
      })) } : {}),
      ...(this.occlusion ? { occlusion: {
        testedParts: this.occlusion.tested, culledParts: this.occlusion.rejected,
        outsideParts: this.batches.reduce((sum, batch) => sum + batch.outside, 0),
        savedTrianglesPerPass: this.batches.reduce((sum, batch) => sum + (batch.occluded + batch.outside)
          * (batch.mesh.geometry.index?.count ?? batch.mesh.geometry.attributes.position.count) / 3, 0),
        parts: this.batches.filter(batch => batch.mesh.userData.occlusionCull).map(batch => ({
          name: batch.mesh.name, visible: batch.count, culled: batch.occluded, outside: batch.outside,
        })),
      } } : {}),
      batches: this.batches.map(({ mesh, count }) => ({
        name: mesh.name,
        castShadow: mesh.castShadow,
        count,
      })),
    };
  }
}
