import * as THREE from "three";

const closed = new WeakMap<THREE.BufferGeometry, boolean>();

/** Exact-position topology check, once during model preparation, never per frame. */
function closedOutwardSurface(geometry: THREE.BufferGeometry) {
  const cached = closed.get(geometry);
  if (cached !== undefined) return cached;
  const position = geometry.attributes.position, index = geometry.index, normal = geometry.attributes.normal;
  if (!position || !index || !normal) return false;
  const ids: number[] = [], parent: number[] = [], points: THREE.Vector3[] = [];
  const weld = new Map<string, number>(), edges = new Map<string, { count: number; direction: number }>();
  const faces: { vertex: number; volume: number }[] = [];
  const find = (id: number): number => {
    while (parent[id] !== id) { parent[id] = parent[parent[id]]; id = parent[id]; }
    return id;
  };
  for (let i = 0; i < position.count; i++) {
    const point = new THREE.Vector3().fromBufferAttribute(position, i), key = `${point.x},${point.y},${point.z}`;
    let id = weld.get(key);
    if (id === undefined) { id = parent.length; weld.set(key, id); parent.push(id); points.push(point); }
    ids.push(id);
  }
  const cross = new THREE.Vector3(), edge = new THREE.Vector3(), normals = new THREE.Vector3(), n = new THREE.Vector3();
  let valid = true;
  for (let i = 0; i < index.count; i += 3) {
    const raw = [index.getX(i), index.getX(i + 1), index.getX(i + 2)], vertices = raw.map(vertex => ids[vertex]);
    const [a, b, c] = vertices.map(vertex => points[vertex]);
    cross.copy(b).sub(a).cross(edge.copy(c).sub(a));
    if (cross.lengthSq() < 1e-20) continue;
    normals.set(0, 0, 0);
    for (const vertex of raw) normals.add(n.fromBufferAttribute(normal, vertex));
    if (cross.dot(normals) < -1e-14) valid = false;
    for (let j = 0; j < 3; j++) {
      const a = vertices[j], b = vertices[(j + 1) % 3], key = `${Math.min(a, b)}:${Math.max(a, b)}`;
      const count = edges.get(key) ?? { count: 0, direction: 0 };
      count.count++; count.direction += a < b ? 1 : -1; edges.set(key, count);
      parent[find(a)] = find(b);
    }
    faces.push({ vertex: vertices[0], volume: a.dot(cross.copy(b).cross(c)) / 6 });
  }
  const volumes = new Map<number, number>();
  for (const face of faces) { const id = find(face.vertex); volumes.set(id, (volumes.get(id) ?? 0) + face.volume); }
  valid &&= faces.length > 0 && [...edges.values()].every(edge => edge.count === 2 && edge.direction === 0)
    && [...volumes.values()].every(volume => volume > 1e-12);
  closed.set(geometry, valid);
  return valid;
}

/** Whitelist opaque solids; thin/open/transmissive parts retain their original side. */
export function enableOpaqueBackfaces(surface: string, geometry: THREE.BufferGeometry,
  material: THREE.MeshPhysicalMaterial, representation: "array" | "full") {
  const candidate = surface === "Index_Inlay" || surface === "Optical_Diffuser"
    || representation === "array" && surface === "Ivory_Edges"
    || representation === "full" && surface === "Titanium_Fasteners";
  if (!candidate || material.transparent || material.transmission > 0 || material.opacity !== 1
    || material.blending !== THREE.NormalBlending || !material.depthWrite
    || material.side !== THREE.DoubleSide && material.side !== THREE.FrontSide
    || !closedOutwardSurface(geometry)) return false;
  // Three normally derives shadowSide from side. Preserve the authored shadow.
  material.shadowSide ??= material.side === THREE.DoubleSide ? THREE.DoubleSide : THREE.BackSide;
  if (material.side !== THREE.FrontSide) { material.side = THREE.FrontSide; material.needsUpdate = true; }
  return true;
}
