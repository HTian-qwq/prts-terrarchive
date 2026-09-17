import * as THREE from "three";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { SMAAPass } from "three/addons/postprocessing/SMAAPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { renderDimensions, type RenderQuality } from "./render-quality";

export function applyTextureQuality(
  root: THREE.Object3D,
  renderer: THREE.WebGLRenderer,
  quality: RenderQuality,
) {
  const maximum = Math.min(
    quality.anisotropy,
    renderer.capabilities.getMaxAnisotropy(),
  );
  const textures = new Set<THREE.Texture>();
  root.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    for (const material of Array.isArray(object.material)
      ? object.material
      : [object.material]) {
      for (const value of Object.values(material)) {
        if (value instanceof THREE.Texture && !value.isRenderTargetTexture)
          textures.add(value);
      }
    }
  });
  for (const texture of textures) {
    // Oblique printed text gets a small, local sampling budget; the scene's
    // large baked textures retain the selected performance preset.
    const requested = texture.userData.archivePrint
      ? Math.min(16, renderer.capabilities.getMaxAnisotropy()) : maximum;
    if (texture.anisotropy === requested) continue;
    texture.anisotropy = requested;
    texture.needsUpdate = true;
  }
}

export function resizeQuality(
  renderer: THREE.WebGLRenderer,
  composer: EffectComposer,
  host: HTMLElement,
  quality: RenderQuality,
  options: { sharpLabels?: boolean } = {},
) {
  const width = Math.max(1, host.clientWidth),
    height = Math.max(1, host.clientHeight);
  const stageScale = host.getBoundingClientRect().width / width;
  const dimensions = renderDimensions(
    quality,
    width,
    height,
    stageScale,
    devicePixelRatio,
    renderer.capabilities.maxTextureSize,
  );
  // Only the final drawing buffer and printed labels use the finer grid.
  // Lighting, AO, transmission, depth capture and DOF keep their existing targets.
  const labelDimensions = options.sharpLabels ? renderDimensions(
    { ...quality, scale: 100, pixelRatio: 2 }, width, height, stageScale, 2,
    renderer.capabilities.maxTextureSize,
  ) : dimensions;
  const outputRatio = Math.max(dimensions.ratio, labelDimensions.ratio);
  renderer.setPixelRatio(outputRatio);
  renderer.setSize(width, height);
  composer.setPixelRatio(dimensions.ratio);
  composer.setSize(width, height);
  renderer.transmissionResolutionScale = quality.transmission;
  host.dataset.renderQuality = JSON.stringify({
    ...dimensions,
    outputRatio,
    labelRatio: options.sharpLabels ? outputRatio : undefined,
    labelWidth: options.sharpLabels ? Math.max(1, Math.floor(width * outputRatio)) : undefined,
    labelHeight: options.sharpLabels ? Math.max(1, Math.floor(height * outputRatio)) : undefined,
    antialias: quality.antialias,
    transmission: quality.transmission,
    anisotropy: Math.min(
      quality.anisotropy,
      renderer.capabilities.getMaxAnisotropy(),
    ),
  });
  return dimensions;
}

export function createViewerPipeline(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  camera: THREE.Camera,
) {
  const composer = new EffectComposer(renderer);
  const smaa = new SMAAPass();
  composer.addPass(new RenderPass(scene, camera));
  composer.addPass(smaa);
  composer.addPass(new OutputPass());
  return { composer, smaa };
}
