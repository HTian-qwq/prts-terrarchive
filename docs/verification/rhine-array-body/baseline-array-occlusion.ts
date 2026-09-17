import * as THREE from "three";

type Occluder = {
  index: number; valid: boolean;
  corners: THREE.Vector3[]; planes: THREE.Plane[];
  minX: number; minY: number; maxX: number; maxY: number;
};
const GRID = 16;

/** A verified solid rectangle, not a transparent cover or a mesh bounding box. */
export function substrateRectangle(geometry: THREE.BufferGeometry) {
  const positions = geometry.getAttribute("position"), indices = geometry.index;
  if (!positions || !indices) return undefined;
  let front = -Infinity;
  for (let i = 0; i < positions.count; i++) front = Math.max(front, positions.getZ(i));
  const points = new Map<string, THREE.Vector3>(), triangles: THREE.Vector3[][] = [];
  for (let i = 0; i < indices.count; i += 3) {
    const vertices = [indices.getX(i), indices.getX(i + 1), indices.getX(i + 2)];
    if (!vertices.every(index => Math.abs(positions.getZ(index) - front) < 1e-6)) continue;
    const triangle = vertices.map(index => new THREE.Vector3().fromBufferAttribute(positions, index));
    for (const point of triangle) points.set(`${point.x},${point.y}`, point);
    triangles.push(triangle);
  }
  if (triangles.length !== 2 || points.size !== 4) return undefined;
  const shared = triangles[0].filter(a => triangles[1].some(b => a.equals(b)));
  if (shared.length !== 2 || shared[0].x === shared[1].x || shared[0].y === shared[1].y) return undefined;
  const bounds = new THREE.Box3().setFromPoints([...points.values()]);
  const width = bounds.max.x - bounds.min.x, height = bounds.max.y - bounds.min.y;
  if (width <= 0 || height <= 0) return undefined;
  if ([...points.values()].some(p => ![bounds.min.x, bounds.max.x].includes(p.x)
    || ![bounds.min.y, bounds.max.y].includes(p.y))) return undefined;
  const centers = triangles.map(t => t[0].clone().add(t[1]).add(t[2]).multiplyScalar(1 / 3));
  const area = triangles.reduce((sum, t) => sum + new THREE.Triangle(...t as [THREE.Vector3, THREE.Vector3, THREE.Vector3]).getArea(), 0);
  if (Math.abs(area - width * height) > 1e-5 || centers[0].distanceTo(centers[1]) < 1e-5) return undefined;
  return bounds;
}

/** Conservative camera occlusion volumes behind the array's opaque substrates. */
export class ArrayOcclusion {
  private readonly occluders: Occluder[];
  private readonly grid: Uint32Array;
  private readonly gridCounts = new Uint32Array(GRID * GRID);
  private readonly capacity: number;
  private readonly eye = new THREE.Vector3();
  private readonly direction = new THREE.Vector3();
  private readonly center = new THREE.Vector3();
  private readonly half = new THREE.Vector3();
  private readonly worldCenter = new THREE.Vector3();
  private readonly point = new THREE.Vector3();
  private readonly extrusion = new THREE.Vector3();
  private readonly projection = new THREE.Matrix4();
  private readonly view = new THREE.Matrix4();
  private perspective = true;
  private pixelScale = 0;
  private near = 0;
  private readonly rectangle: THREE.Box3;
  tested = 0;
  rejected = 0;

  constructor(rectangle: THREE.Box3, capacity: number) {
    this.rectangle = rectangle.clone();
    this.capacity = capacity;
    this.grid = new Uint32Array(GRID * GRID * capacity);
    this.occluders = Array.from({ length: capacity }, (_, index) => ({
      index, valid: false,
      corners: Array.from({ length: 4 }, () => new THREE.Vector3()),
      planes: Array.from({ length: 5 }, () => new THREE.Plane()),
      minX: 0, minY: 0, maxX: 0, maxY: 0,
    }));
  }

  update(camera: THREE.Camera, matrices: readonly THREE.Matrix4[], active: Uint32Array, count: number, pixelHeight: number) {
    this.tested = this.rejected = 0;
    this.gridCounts.fill(0);
    this.eye.setFromMatrixPosition(camera.matrixWorld);
    camera.getWorldDirection(this.direction);
    this.perspective = camera instanceof THREE.PerspectiveCamera;
    this.near = (camera as THREE.PerspectiveCamera).near ?? 0.1;
    this.view.copy(camera.matrixWorldInverse);
    this.projection.multiplyMatrices(camera.projectionMatrix, this.view);
    // Three output pixels plus a world-space guard protect antialiasing and
    // the existing thin cover's refracted samples near an occluder's edge.
    this.pixelScale = pixelHeight > 0 ? 6 / (Math.abs(camera.projectionMatrix.elements[5]) * pixelHeight) : Infinity;
    for (let i = 0; i < count; i++) {
      const index = active[i], object = this.occluders[index], matrix = matrices[index];
      const { min, max } = this.rectangle, corners = object.corners;
      corners[0].set(min.x, min.y, max.z).applyMatrix4(matrix);
      corners[1].set(max.x, min.y, max.z).applyMatrix4(matrix);
      corners[2].set(max.x, max.y, max.z).applyMatrix4(matrix);
      corners[3].set(min.x, max.y, max.z).applyMatrix4(matrix);
      object.minX = object.minY = Infinity; object.maxX = object.maxY = -Infinity;
      object.valid = true;
      this.center.set(0, 0, 0);
      for (const corner of corners) {
        this.center.add(corner);
        this.point.copy(corner).applyMatrix4(this.view);
        if (-this.point.z <= this.near + 0.01) object.valid = false;
        this.point.copy(corner).applyMatrix4(this.projection);
        object.minX = Math.min(object.minX, this.point.x); object.maxX = Math.max(object.maxX, this.point.x);
        object.minY = Math.min(object.minY, this.point.y); object.maxY = Math.max(object.maxY, this.point.y);
      }
      if (!object.valid) continue;
      if (object.minX > 1 || object.maxX < -1 || object.minY > 1 || object.maxY < -1) continue;
      this.center.multiplyScalar(0.25);
      const front = object.planes[4].setFromCoplanarPoints(corners[0], corners[1], corners[2]);
      if (Math.abs(front.normal.dot(this.direction)) < 0.01) continue;
      // All five planes point into the hidden volume. Rejects are valid only
      // when the entire candidate box is strictly inside this one volume.
      if (this.perspective ? front.distanceToPoint(this.eye) > 0 : front.normal.dot(this.direction) < 0) front.negate();
      for (let edge = 0; edge < 4; edge++) {
        const a = corners[edge], b = corners[(edge + 1) % 4];
        this.extrusion.copy(a).add(this.direction);
        const plane = object.planes[edge].setFromCoplanarPoints(a, b, this.perspective ? this.eye : this.extrusion);
        if (plane.distanceToPoint(this.center) < 0) plane.negate();
      }
      const left = Math.max(0, Math.floor((object.minX + 1) * GRID / 2));
      const right = Math.min(GRID - 1, Math.floor((object.maxX + 1) * GRID / 2));
      const bottom = Math.max(0, Math.floor((object.minY + 1) * GRID / 2));
      const top = Math.min(GRID - 1, Math.floor((object.maxY + 1) * GRID / 2));
      for (let y = bottom; y <= top; y++) for (let x = left; x <= right; x++) {
        const cell = y * GRID + x;
        this.grid[cell * this.capacity + this.gridCounts[cell]++] = index;
      }
    }
  }

  hidden(bounds: THREE.Box3, matrix: THREE.Matrix4, index: number) {
    this.tested++;
    if (bounds.isEmpty() || !Number.isFinite(this.pixelScale)) return false;
    bounds.getCenter(this.center); bounds.getSize(this.half).multiplyScalar(0.5);
    this.worldCenter.copy(this.center).applyMatrix4(matrix);
    this.point.copy(this.worldCenter).applyMatrix4(this.view);
    const margin = Math.max(0.08, this.pixelScale * (this.perspective ? Math.max(0, -this.point.z) : 1));
    this.point.copy(this.worldCenter).applyMatrix4(this.projection);
    const x = Math.floor((this.point.x + 1) * GRID / 2), y = Math.floor((this.point.y + 1) * GRID / 2);
    // A volume covering the candidate must also cover its projected center.
    // Spatial bins only reduce the candidate list; the exact five-plane proof
    // below still decides visibility, with the same conservative margin.
    if (x < 0 || x >= GRID || y < 0 || y >= GRID) return false;
    const cell = y * GRID + x, candidateCount = this.gridCounts[cell], start = cell * this.capacity;
    if (!candidateCount) return false;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let corner = 0; corner < 8; corner++) {
      this.point.set(corner & 1 ? bounds.max.x : bounds.min.x,
        corner & 2 ? bounds.max.y : bounds.min.y, corner & 4 ? bounds.max.z : bounds.min.z).applyMatrix4(matrix);
      this.extrusion.copy(this.point).applyMatrix4(this.view);
      if (-this.extrusion.z <= this.near + margin) return false;
      this.point.applyMatrix4(this.projection);
      minX = Math.min(minX, this.point.x); maxX = Math.max(maxX, this.point.x);
      minY = Math.min(minY, this.point.y); maxY = Math.max(maxY, this.point.y);
    }
    const m = matrix.elements, h = this.half;
    for (let candidate = 0; candidate < candidateCount; candidate++) {
      const object = this.occluders[this.grid[start + candidate]];
      if (object.index === index || minX <= object.minX || maxX >= object.maxX
        || minY <= object.minY || maxY >= object.maxY) continue;
      let covered = true;
      for (const plane of object.planes) {
        const n = plane.normal;
        const radius = Math.abs(n.x * m[0] + n.y * m[1] + n.z * m[2]) * h.x
          + Math.abs(n.x * m[4] + n.y * m[5] + n.z * m[6]) * h.y
          + Math.abs(n.x * m[8] + n.y * m[9] + n.z * m[10]) * h.z;
        if (plane.distanceToPoint(this.worldCenter) - radius <= margin) { covered = false; break; }
      }
      if (covered) { this.rejected++; return true; }
    }
    return false;
  }
}
