import * as THREE from "three";

/** Independent screws allow the buried lower screw to be omitted entirely. */
export function splitCassetteFasteners(source: THREE.BufferGeometry) {
  if (!source.index) return undefined;
  const positions = source.getAttribute("position"), top: number[] = [], bottom: number[] = [];
  for (let offset = 0; offset < source.index.count; offset += 3) {
    const indices = [source.index.getX(offset), source.index.getX(offset + 1), source.index.getX(offset + 2)];
    const upper = indices.every(index => positions.getY(index) > 1.85);
    const lower = indices.every(index => positions.getY(index) < 1.85);
    if (!upper && !lower) return undefined;
    (upper ? top : bottom).push(...indices);
  }
  if (!top.length || !bottom.length) return undefined;
  return [top, bottom].map(indices => {
    // Compact attributes as well as indices: BufferGeometry computes bounds
    // from all vertices, including unreferenced ones.
    const geometry = new THREE.BufferGeometry(), remap = new Map<number, number>();
    const vertices: number[] = [], compact = indices.map(index => {
      if (!remap.has(index)) { remap.set(index, vertices.length); vertices.push(index); }
      return remap.get(index)!;
    });
    for (const [name, attribute] of Object.entries(source.attributes)) {
      const values = new Float32Array(vertices.length * attribute.itemSize);
      for (let i = 0; i < vertices.length; i++) for (let c = 0; c < attribute.itemSize; c++)
        values[i * attribute.itemSize + c] = attribute.getComponent(vertices[i], c);
      geometry.setAttribute(name, new THREE.BufferAttribute(values, attribute.itemSize));
    }
    geometry.setIndex(compact); geometry.computeBoundingBox(); geometry.computeBoundingSphere();
    return geometry;
  });
}

/** Reduce outer-ring tessellation while keeping the screw recess and relief exact. */
export function createCassetteLOD(surface: string, source: THREE.BufferGeometry) {
  if (surface !== "Titanium_Fasteners" || !source.index) return undefined;
  const position = source.getAttribute("position");
  const originalTriangles = source.index.count / 3;
  if (originalTriangles < 500) return undefined;
  const bounds = [new THREE.Box3(), new THREE.Box3()];
  const point = new THREE.Vector3();
  for (let i = 0; i < position.count; i++) {
    point.fromBufferAttribute(position, i);
    bounds[point.x < 0 ? 0 : 1].expandByPoint(point);
  }
  // These are the two authored circular fasteners. A changed asset keeps its
  // original mesh until its replacement can be validated independently.
  if (bounds.some(box => box.isEmpty() || Math.abs(box.max.x - box.min.x - 0.12) > 0.00001
    || Math.abs(box.max.y - box.min.y - 0.12) > 0.00001)) return undefined;
  const centers = bounds.map(box => box.getCenter(new THREE.Vector3()));
  const geometry = source.clone(), output = geometry.getAttribute("position"), normals = geometry.getAttribute("normal");
  const step = Math.PI * 2 / 16;
  for (let i = 0; i < position.count; i++) {
    const center = centers[position.getX(i) < 0 ? 0 : 1];
    const x = position.getX(i) - center.x, y = position.getY(i) - center.y;
    const radius = Math.hypot(x, y);
    if (radius <= 0.05) continue; // Recess, slots and all inner engraving stay exact.
    const angle = Math.atan2(y, x), target = Math.round(angle / step) * step;
    const snappedRadius = Math.round(radius * 100000) / 100000;
    output.setXY(i, center.x + Math.cos(target) * snappedRadius, center.y + Math.sin(target) * snappedRadius);
    if (normals) {
      const nx = normals.getX(i), ny = normals.getY(i), delta = target - angle;
      normals.setXY(i, nx * Math.cos(delta) - ny * Math.sin(delta), nx * Math.sin(delta) + ny * Math.cos(delta));
    }
  }
  const indices: number[] = [], a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  for (let i = 0; i < source.index.count; i += 3) {
    const ia = source.index.getX(i), ib = source.index.getX(i + 1), ic = source.index.getX(i + 2);
    a.fromBufferAttribute(output, ia); b.fromBufferAttribute(output, ib); c.fromBufferAttribute(output, ic);
    if (b.sub(a).cross(c.sub(a)).lengthSq() > 1e-20) indices.push(ia, ib, ic);
  }
  geometry.setIndex(indices); geometry.computeBoundingBox(); geometry.computeBoundingSphere();
  if (source.boundingBox === null) source.computeBoundingBox();
  const triangles = indices.length / 3;
  if (triangles >= originalTriangles
    || geometry.boundingBox!.min.distanceTo(source.boundingBox!.min) > 0.000001
    || geometry.boundingBox!.max.distanceTo(source.boundingBox!.max) > 0.000001) {
    geometry.dispose(); return undefined;
  }
  return { geometry, featureSize: 0.12, enterBelow: 18, leaveAbove: 22, originalTriangles, triangles };
}
