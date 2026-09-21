import type * as THREE from 'three';

/** Raycaster visits hidden descendants too; navigation must respect what is actually shown. */
export function visibleSceneHit(hits: THREE.Intersection[]): THREE.Intersection | undefined {
  return hits.find(hit => {
    for (let object: THREE.Object3D | null = hit.object; object; object = object.parent) {
      if (!object.visible) return false;
    }
    const material = (hit.object as THREE.Mesh).material;
    const materials = Array.isArray(material) ? material : [material];
    return materials.some(value => !value || value.visible && value.opacity > 0);
  });
}
