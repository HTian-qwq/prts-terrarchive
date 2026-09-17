import * as THREE from "three";
import { bakeArrayInterior, type ArrayInteriorBake } from "./array-interior";

// Keep the complete shell, engraved perimeter, fasteners and printed label.
// Only geometry inside the substrate's front face is replaced by radiance.
const SURFACES = new Set([
  "Internal_Ceramic", "Optical_Edges", "Subsurface_Optics",
  "Optical_Film_Edge", "Amber_Optical_Inlay", "Optical_Film",
  "Champagne_Index", "Moulded_Lettering",
]);
// Perspective ray through the middle of the shelf, rather than the camera's
// optical axis (the organizer sits to the right of the frame).
const DIRECTION = new THREE.Vector3(-1.79, 0.71, 1).normalize();
type Representation = { full: THREE.Mesh[]; proxy: THREE.Mesh[]; detailed: boolean };

/** Shared interior image; the original meshes remain ready for extraction. */
export class ShelfInterior {
  private readonly files = new Map<THREE.Group, Representation>();
  private readonly eye = new THREE.Vector3();
  private readonly center = new THREE.Vector3();
  private readonly bake: ArrayInteriorBake;

  constructor(renderer: THREE.WebGLRenderer, scene: THREE.Scene, template: THREE.Group) {
    this.bake = bakeArrayInterior(renderer, scene,
      template.children.filter((mesh): mesh is THREE.Mesh => mesh instanceof THREE.Mesh
        && (SURFACES.has(mesh.userData.surface) || mesh.userData.surface === "Optical_Diffuser")), {
        surfaces: SURFACES, direction: DIRECTION, maxSize: 1536,
        preserveOutsideSubstrate: true, name: "Shelf_Interior",
        // The overview's shadow-casting key is behind this front face. Its
        // shadow cannot darken ambient radiance: the array's blanket multiplier
        // otherwise makes the stationary shelf interiors visibly too dark.
        shadowStrength: 0,
      });
    try { renderer.initTexture(this.bake.texture); }
    catch (error) { this.bake.dispose(); throw error; }
  }

  attach(group: THREE.Group) {
    if (this.files.has(group)) return;
    const full = group.children.filter((mesh): mesh is THREE.Mesh =>
      mesh instanceof THREE.Mesh && SURFACES.has(mesh.userData.surface));
    const proxy = this.bake.meshes.map(source => {
      const mesh = source.clone();
      mesh.userData.sharedShelfProxy = true;
      mesh.visible = false;
      group.add(mesh);
      return mesh;
    });
    this.files.set(group, { full, proxy, detailed: true });
    group.userData.shelfRepresentation = "geometry";
  }

  update(group: THREE.Group, moving: boolean, camera: THREE.Camera, pixelHeight: number) {
    const file = this.files.get(group);
    if (!file) return;
    group.updateWorldMatrix(true, false);
    this.center.set(0, 1.85, 0).applyMatrix4(group.matrixWorld).applyMatrix4(camera.matrixWorldInverse);
    this.eye.setFromMatrixPosition(camera.matrixWorld);
    group.worldToLocal(this.eye); this.eye.y -= 1.85;
    const pixelsPerUnit = Math.abs(camera.projectionMatrix.elements[5] * pixelHeight / (2 * this.center.z));
    const parallaxPixels = this.eye.z > 0 ? 0.21 * pixelsPerUnit * Math.max(
      Math.abs(this.eye.x / this.eye.z - DIRECTION.x / DIRECTION.z),
      Math.abs(this.eye.y / this.eye.z - DIRECTION.y / DIRECTION.z),
    ) : Infinity;
    // Prefer the exact geometry during inspection, travel or a substantially
    // different angle. Hysteresis prevents threshold flicker when the view moves.
    const detailed = moving || parallaxPixels > (file.detailed ? 2.5 : 3);
    if (file.detailed === detailed) return;
    file.detailed = detailed;
    for (const mesh of file.full) mesh.visible = detailed;
    for (const mesh of file.proxy) mesh.visible = !detailed;
    group.userData.shelfRepresentation = detailed ? "geometry" : "texture";
  }

  detach(group: THREE.Group) {
    const file = this.files.get(group);
    if (!file) return;
    for (const mesh of file.full) mesh.visible = true;
    for (const mesh of file.proxy) group.remove(mesh);
    this.files.delete(group);
    delete group.userData.shelfRepresentation;
  }

  getStats() {
    let textured = 0, detailed = 0;
    for (const [group, file] of this.files) if (group.visible && group.parent) {
      if (file.detailed) detailed++; else textured++;
    }
    return { ...this.bake.stats, textured, detailed };
  }

  dispose() {
    for (const group of this.files.keys()) this.detach(group);
    this.bake.dispose();
  }
}
