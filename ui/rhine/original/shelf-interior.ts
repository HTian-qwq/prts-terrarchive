import * as THREE from "three";
import { bakeArrayInterior, type ArrayInteriorBake } from "./array-interior";

// Keep the complete shell, engraved perimeter, fasteners and printed label.
// Only geometry inside the substrate's front face is replaced by radiance.
export const SHELF_INTERIOR_SURFACES = new Set([
  "Internal_Ceramic", "Optical_Edges", "Subsurface_Optics",
  "Optical_Film_Edge", "Amber_Optical_Inlay", "Optical_Film",
  "Champagne_Index", "Moulded_Lettering",
]);
// Perspective ray through the middle of the shelf, rather than the camera's
// optical axis (the organizer sits to the right of the frame).
const DIRECTION = new THREE.Vector3(-1.79, 0.71, 1).normalize();
type Representation = { full: THREE.Mesh[]; proxy: THREE.Mesh[]; views: THREE.Mesh[][]; view: number; detailed: boolean; reason: "motion" | "angle" | "texture"; parallaxPixels: number; cameraDepth: number; eyeSlope: [number, number] | null };

/** Shared interior image; the original meshes remain ready for extraction. */
export class ShelfInterior {
  private readonly files = new Map<THREE.Group, Representation>();
  private readonly eye = new THREE.Vector3();
  private readonly center = new THREE.Vector3();
  private readonly bake: ArrayInteriorBake;
  private readonly views: { direction: THREE.Vector3; bake: ArrayInteriorBake }[] = [];

  constructor(renderer: THREE.WebGLRenderer, scene: THREE.Scene, template: THREE.Group) {
    this.bake = bakeArrayInterior(renderer, scene,
      template.children.filter((mesh): mesh is THREE.Mesh => mesh instanceof THREE.Mesh
        && (SHELF_INTERIOR_SURFACES.has(mesh.userData.surface) || mesh.userData.surface === "Optical_Diffuser")), {
        surfaces: SHELF_INTERIOR_SURFACES, direction: DIRECTION, maxSize: 1536,
        preserveOutsideSubstrate: true, name: "Shelf_Interior",
        // The overview's shadow-casting key is behind this front face. Its
        // shadow cannot darken ambient radiance: the array's blanket multiplier
        // otherwise makes the stationary shelf interiors visibly too dark.
        shadowStrength: 0,
      });
    this.views.push({ direction: DIRECTION, bake: this.bake });
    try { renderer.initTexture(this.bake.texture); }
    catch (error) { this.bake.dispose(); throw error; }
  }

  hasView(index: number) { return index >= 0 && index < this.views.length; }

  /** Additional front-facing views share the same original shell and error budget. */
  addView(renderer: THREE.WebGLRenderer, scene: THREE.Scene, template: THREE.Group, direction: THREE.Vector3) {
    const bake = bakeArrayInterior(renderer, scene,
      template.children.filter((mesh): mesh is THREE.Mesh => mesh instanceof THREE.Mesh
        && (SHELF_INTERIOR_SURFACES.has(mesh.userData.surface) || mesh.userData.surface === "Optical_Diffuser")),
      { surfaces: SHELF_INTERIOR_SURFACES, direction, maxSize: 1536, preserveOutsideSubstrate: true, name: "Shelf_Interior", shadowStrength: 0 });
    try { renderer.initTexture(bake.texture); } catch (error) { bake.dispose(); throw error; }
    this.views.push({ direction: direction.clone().normalize(), bake });
    for (const [group, file] of this.files) file.views.push(this.attachProxy(group, bake));
  }
  private attachProxy(group: THREE.Group, bake: ArrayInteriorBake) {
    return bake.meshes.map(source => {
      const mesh = source.clone(); mesh.userData.sharedShelfProxy = true;
      mesh.visible = false; group.add(mesh); return mesh;
    });
  }
  attach(group: THREE.Group) {
    if (this.files.has(group)) return;
    const full = group.children.filter((mesh): mesh is THREE.Mesh =>
      mesh instanceof THREE.Mesh && SHELF_INTERIOR_SURFACES.has(mesh.userData.surface));
    const views = (this.views ?? [{ bake: this.bake }]).map(view => this.attachProxy(group, view.bake));
    this.files.set(group, { full, proxy: views[0], views, view: 0, detailed: true, reason: "motion", parallaxPixels: 0, cameraDepth: 0, eyeSlope: null });
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
    const views = this.views ?? [{ direction: DIRECTION, bake: this.bake }];
    const error = (direction: THREE.Vector3) => this.eye.z > 0 ? 0.21 * pixelsPerUnit * Math.max(
      Math.abs(this.eye.x / this.eye.z - direction.x / direction.z),
      Math.abs(this.eye.y / this.eye.z - direction.y / direction.z),
    ) : Infinity;
    let view = file.view, parallaxPixels = error(views[view].direction);
    // Keep an acceptable current view. Enter another only below the lower
    // threshold, so adjacent captures cannot flicker at their boundary.
    if (file.detailed || parallaxPixels > 3) {
      for (let index = 0; index < views.length; index++) {
        const candidate = error(views[index].direction);
        if (candidate < parallaxPixels) { parallaxPixels = candidate; view = index; }
      }
    }
    // Return to the authored rack capture whenever it re-enters the lower
    // threshold; arriving through another angle must not change the settled rack.
    const primaryError = error(views[0].direction);
    if (primaryError <= 2.5) { view = 0; parallaxPixels = primaryError; }
    const changing = view !== file.view;
    const detailed = moving || parallaxPixels > (file.detailed || changing ? 2.5 : 3);
    file.reason = moving ? "motion" : detailed ? "angle" : "texture";
    file.parallaxPixels = Number.isFinite(parallaxPixels) ? parallaxPixels : -1;
    file.cameraDepth = -this.center.z;
    // Scalars only; no per-frame arrays allocated for this diagnostic inventory.
    if (this.eye.z > 0) {
      file.eyeSlope ||= [0, 0]; file.eyeSlope[0] = this.eye.x / this.eye.z; file.eyeSlope[1] = this.eye.y / this.eye.z;
    } else file.eyeSlope = null;
    if (file.detailed === detailed && !changing) return;
    file.detailed = detailed; file.view = view;
    for (const mesh of file.full) mesh.visible = detailed;
    for (let index = 0; index < file.views.length; index++)
      for (const mesh of file.views[index]) mesh.visible = !detailed && index === view;
    group.userData.shelfRepresentation = detailed ? "geometry" : "texture";
    group.userData.shelfView = detailed ? -1 : view;
  }

  detach(group: THREE.Group) {
    const file = this.files.get(group);
    if (!file) return;
    for (const mesh of file.full) mesh.visible = true;
    for (const meshes of file.views) for (const mesh of meshes) group.remove(mesh);
    this.files.delete(group);
    delete group.userData.shelfRepresentation;
    delete group.userData.shelfView;
  }

  getStats(detailedSnapshot = false) {
    let textured = 0, detailed = 0, motion = 0, angle = 0, angleErrorMaxPixels = 0, backFacing = 0;
    const files: { slot: number; representation: string; reason: string; view: number; errorPixels: number;
      cameraDepth: number; eyeSlope: [number, number] | null }[] | undefined = detailedSnapshot ? [] : undefined;
    const viewCounts = (this.views ?? [this.bake]).map(() => 0);
    for (const [group, file] of this.files) if (group.visible && group.parent) {
      if (file.reason === 'angle') {
        if (file.parallaxPixels < 0) backFacing++; else angleErrorMaxPixels = Math.max(angleErrorMaxPixels, file.parallaxPixels);
      }
      if (files) files.push({ slot: files.length, representation: file.detailed ? 'geometry' : 'texture', reason: file.reason,
        view: file.view, errorPixels: file.parallaxPixels, cameraDepth: file.cameraDepth, eyeSlope: file.eyeSlope ? [...file.eyeSlope] : null });
      if (file.detailed) { detailed++; if (file.reason === "motion") motion++; else angle++; } else { textured++; viewCounts[file.view]++; }
    }
    return { ...this.bake.stats, angleErrorMaxPixels, backFacing,
      ...(files ? { files, enterBelowPixels: 2.5, leaveAbovePixels: 3, directions: (this.views ?? [{ direction: DIRECTION }]).map(v => v.direction.toArray()) } : {}), views: viewCounts.length, viewCounts, totalTextureBytes: (this.views ?? [{ bake: this.bake }]).reduce((sum, view) => sum + (view.bake.stats.textureBytes ?? 0), 0), textured, detailed, reasons: { motion, angle, texture: textured } };
  }

  dispose() {
    for (const group of this.files.keys()) this.detach(group);
    for (const view of this.views ?? [{ bake: this.bake }]) view.bake.dispose();
  }
}
