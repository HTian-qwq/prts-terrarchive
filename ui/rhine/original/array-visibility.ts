import * as THREE from "three";
import { ArrayOcclusion, substrateRectangle } from "./array-occlusion.ts";

const FRUSTUM_PADDING = 0.35;
// A companion attribute makes WebGLGeometries upload the shadow matrices before
// onBeforeShadow. It is not a shader input; binding uses mesh.instanceMatrix.
const SHADOW_MATRIX_ATTRIBUTE = "rhineShadowMatrix";
type ShadowBuffers = {
  geometry: THREE.BufferGeometry;
  camera: THREE.InstancedBufferAttribute;
  shadow: THREE.InstancedBufferAttribute;
};

type Batch = {
  mesh: THREE.InstancedMesh;
  indices: Uint32Array;
  count: number;
  filtered: Uint32Array;
  occluded: number;
  outside: number;
  shadowCount: number;
  triangles: number;
  shadowBuffers?: ShadowBuffers;

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
 * world space. Complete-cassette bounds provide the broad phase; flagged parts
 * can be culled individually. Shadow casters use an independent light-frustum list.
 * Pass every shadow light frustum, or omit the list to retain all active casters.
 */
export class ArrayVisibility {
  private readonly matrices: THREE.Matrix4[];
  private readonly active: Uint8Array;
  private readonly activeIndices: Uint32Array;
  private readonly visibleIndices: Uint32Array;
  private readonly submitted: Uint8Array;
  private readonly shadowHooks = new WeakSet<THREE.InstancedMesh>();
  private readonly shadowBuffers = new WeakMap<THREE.InstancedMesh, ShadowBuffers>();
  private readonly shadowSubmitted: Uint8Array;
  private readonly cardBounds = new THREE.Box3();
  private readonly worldBounds = new THREE.Box3();
  private readonly viewProjection = new THREE.Matrix4();
  private readonly frustum = new THREE.Frustum();
  private batches: Batch[] = [];
  private readonly batchByMesh = new Map<THREE.InstancedMesh, Batch>();
  private activeSlots = 0;
  private visibleSlots = 0;
  private shadowSlots = 0;
  private cameraTriangles = 0;
  private shadowTriangles = 0;
  private shadowOnlyTriangles = 0;
  private shadowCulledTriangles = 0;
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
    this.submitted = new Uint8Array(capacity);
    this.shadowSubmitted = new Uint8Array(capacity);
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
      let buffers = this.shadowBuffers.get(mesh);
      if (mesh.castShadow && (!buffers || buffers.geometry !== mesh.geometry)) {
        // Keep the upload-only attribute off shared selected/baked geometries.
        const geometry = mesh.geometry.clone();
        const shadow = new THREE.InstancedBufferAttribute(new Float32Array(this.capacity * 16), 16)
          .setUsage(THREE.DynamicDrawUsage);
        geometry.setAttribute(SHADOW_MATRIX_ATTRIBUTE, shadow);
        mesh.geometry = geometry;
        buffers = { geometry, camera: mesh.instanceMatrix, shadow };
        this.shadowBuffers.set(mesh, buffers);
      }
      const batch: Batch = { mesh, indices: this.visibleIndices, count: 0,
        filtered: new Uint32Array(this.capacity), occluded: 0, outside: 0, shadowCount: 0,
        triangles: (mesh.geometry.index?.count ?? mesh.geometry.attributes.position.count) / 3,
        shadowBuffers: buffers };
      if (mesh.castShadow && !this.shadowHooks.has(mesh)) {
        this.shadowHooks.add(mesh);
        const before = mesh.onBeforeShadow, after = mesh.onAfterShadow;
        const restore = () => {
          const current = this.batchByMesh.get(mesh);
          if (current?.shadowBuffers) mesh.instanceMatrix = current.shadowBuffers.camera;
          mesh.count = current?.count ?? 0;
        };
        mesh.onBeforeShadow = (...args) => {
          const current = this.batchByMesh.get(mesh);
          if (current?.shadowBuffers) mesh.instanceMatrix = current.shadowBuffers.shadow;
          mesh.count = current?.shadowCount ?? 0;
          try { before.apply(mesh, args); }
          catch (error) { restore(); throw error; }
        };
        mesh.onAfterShadow = (...args) => {
          try { after.apply(mesh, args); }
          finally { restore(); }
        };
      }
      this.batchByMesh.set(mesh, batch);
      return batch;
    });
  }

  submit(camera: THREE.Camera, instances: readonly THREE.InstancedMesh[], cull = true, pixelHeight = 0,
    shadowFrusta?: readonly THREE.Frustum[]) {
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
    this.cameraTriangles = this.shadowTriangles = this.shadowOnlyTriangles = this.shadowCulledTriangles = 0;
    this.shadowSubmitted.fill(0);
    for (const batch of this.batches) {
      const { mesh } = batch;
      // A renderer error can interrupt a shadow draw before onAfterShadow.
      // Start every submission from the owned camera buffer in that case too.
      if (batch.shadowBuffers) mesh.instanceMatrix = batch.shadowBuffers.camera;
      batch.indices = this.visibleIndices;
      batch.count = this.visibleSlots;
      batch.shadowCount = 0;
      const lod = this.detailLODs.find(item => item.high === mesh || item.low === mesh);
      if (lod) {
        batch.indices = mesh === lod.high ? lod.highIndices : lod.lowIndices;
        batch.count = mesh === lod.high ? lod.highCount : lod.lowCount;
      }
      batch.occluded = batch.outside = 0;
      if (this.occlusion && mesh.userData.occlusionCull) {
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
      if (mesh.castShadow) this.submitted.fill(0);
      for (let index = 0; index < batch.count; index++) {
        const logical = batch.indices[index];
        mesh.setMatrixAt(index, this.matrices[logical]);
        if (mesh.castShadow) this.submitted[logical] = 1;
      }
      if (mesh.castShadow && batch.shadowBuffers) {
        const attribute = batch.shadowBuffers.shadow;
        // Use the union when there are multiple shadow lights. The main camera
        // list is independent: a visible object need not enter a light's map.
        for (let index = 0; index < this.activeSlots; index++) {
          const logical = this.activeIndices[index];
          if (cull && shadowFrusta?.length) {
            this.worldBounds.copy(mesh.geometry.boundingBox!).applyMatrix4(this.matrices[logical])
              .expandByScalar(FRUSTUM_PADDING);
            if (!shadowFrusta.some(frustum => frustum.intersectsBox(this.worldBounds))) continue;
          }
          this.matrices[logical].toArray(attribute.array, batch.shadowCount++ * 16);
          if (!this.submitted[logical]) this.shadowOnlyTriangles += batch.triangles;
          if (!this.shadowSubmitted[logical]) { this.shadowSubmitted[logical] = 1; this.shadowSlots++; }
        }
        attribute.clearUpdateRanges();
        if (batch.shadowCount > 0) {
          attribute.addUpdateRange(0, batch.shadowCount * 16);
          attribute.needsUpdate = true;
        }
        mesh.userData.shadowInstanceCount = batch.shadowCount;
        this.shadowTriangles += batch.shadowCount * batch.triangles;
        this.shadowCulledTriangles += (this.activeSlots - batch.shadowCount) * batch.triangles;
      }
      this.cameraTriangles += batch.count * batch.triangles;
      mesh.count = batch.count;
      mesh.instanceMatrix.clearUpdateRanges();
      if (batch.count > 0) {
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

  /** Geometry inventory per pass; actual frame submissions can draw it again. */
  triangleStats() {
    return { cameraTrianglesPerPass: this.cameraTriangles,
      shadowTrianglesPerPass: this.shadowTriangles,
      shadowOnlyTrianglesPerPass: this.shadowOnlyTriangles,
      shadowCulledTrianglesPerPass: this.shadowCulledTriangles };
  }

  getStats() {
    return {
      capacity: this.capacity,
      activeSlots: this.activeSlots,
      visibleSlots: this.visibleSlots,
      culledSlots: this.activeSlots - this.visibleSlots,
      shadowSlots: this.shadowSlots,
      ...this.triangleStats(),
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
          trianglesPerInstance: batch.triangles, submittedTrianglesPerPass: batch.count * batch.triangles,
        })),
      } } : {}),
      batches: this.batches.map(({ mesh, count, shadowCount }) => ({
        name: mesh.name,
        castShadow: mesh.castShadow,
        count,
        ...(mesh.castShadow ? { shadowCount } : {}),
      })),
    };
  }
}
