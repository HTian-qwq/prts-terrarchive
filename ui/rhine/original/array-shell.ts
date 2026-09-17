import * as THREE from "three";

/** Partition authored faces without cutting triangles or changing their normals.
 * Fine bevels occupy four corners; a small shared group keeps faces spanning
 * quadrant boundaries. Every original triangle occurs in exactly one region.
 */
export function splitArrayShell(surface: string, source: THREE.BufferGeometry) {
  if (!["Frosted_Polymer", "Ivory_Edges"].includes(surface) || !source.index) return undefined;
  const position = source.getAttribute("position");
  if (!position) return undefined;
  const bounds = new THREE.Box3().setFromBufferAttribute(position as THREE.BufferAttribute);
  const center = bounds.getCenter(new THREE.Vector3());
  const regions = Array.from({ length: 5 }, () => [] as number[]);
  for (let i = 0; i < source.index.count; i += 3) {
    const vertices = [source.index.getX(i), source.index.getX(i + 1), source.index.getX(i + 2)];
    const side = vertices.map(index => (position.getX(index) < center.x ? 0 : 1)
      + (position.getY(index) < center.y ? 0 : 2));
    const region = side.every(value => value === side[0]) ? side[0] : 4;
    regions[region].push(...vertices);
  }
  if (regions.filter(region => region.length).length < 2) return undefined;
  return regions.flatMap((indices, region) => {
    if (!indices.length) return [];
    const geometry = new THREE.BufferGeometry(), vertices: number[] = [], remap = new Map<number, number>();
    const compact = indices.map(index => {
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
    return [{ geometry, suffix: region === 4 ? "_Spanning" : `_Region_${region}` }];
  });
}
