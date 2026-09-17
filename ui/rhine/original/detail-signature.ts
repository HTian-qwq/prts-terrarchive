import type * as THREE from "three";

/** Triangle order and authored front normals bind the bake to this exact mesh.
 * Independent of attribute compaction/index renumbering in the interior bake.
 */
export function detailSignature(geometry: THREE.BufferGeometry) {
  if (!geometry.index || !geometry.attributes.position || !geometry.attributes.normal) return "";
  let hash = 2166136261;
  const buffer = new ArrayBuffer(4), value = new DataView(buffer);
  for (let i = 0; i < geometry.index.count; i++) {
    const index = geometry.index.getX(i);
    for (const name of ["position", "normal"]) for (let c = 0; c < 3; c++) {
      value.setFloat32(0, geometry.attributes[name].getComponent(index, c), true);
      for (let b = 0; b < 4; b++) hash = Math.imul(hash ^ value.getUint8(b), 16777619);
    }
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}
