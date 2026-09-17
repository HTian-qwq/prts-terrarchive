import * as THREE from 'three';
import { Pass, FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import type { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';

export const ARCHIVE_LABEL_LAYER = 1;

/** Save the beauty pass's existing depth before later effects reuse its buffer. */
class LabelDepthCapture extends Pass {
  readonly target = new THREE.WebGLRenderTarget(1, 1, {
    depthBuffer: false, stencilBuffer: false,
    minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter,
  });
  private readonly material = new THREE.ShaderMaterial({
    uniforms: { sourceDepth: { value: null } },
    vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0., 1.); }',
    fragmentShader: `uniform sampler2D sourceDepth;
      varying vec2 vUv;
      #include <packing>
      void main(){ gl_FragColor = packDepthToRGBA(texture2D(sourceDepth, vUv).x); }`,
    depthTest: false, depthWrite: false, blending: THREE.NoBlending,
  });
  private readonly quad = new FullScreenQuad(this.material);
  private disposed = false;
  constructor() { super(); this.needsSwap = false; this.target.texture.name = 'Archive label occlusion'; }
  render(renderer: THREE.WebGLRenderer, _write: THREE.WebGLRenderTarget, read: THREE.WebGLRenderTarget) {
    const previous = renderer.getRenderTarget();
    this.target.setSize(read.width, read.height);
    this.material.uniforms.sourceDepth.value = read.depthTexture;
    try { renderer.setRenderTarget(this.target); this.quad.render(renderer); }
    finally { renderer.setRenderTarget(previous); }
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true; this.target.dispose(); this.material.dispose(); this.quad.dispose();
  }
}

/** Sharp final-resolution print, using scene depth instead of redrawing geometry. */
export class ArchiveLabelRenderer {
  readonly capture = new LabelDepthCapture();
  private readonly uniforms = {
    archiveSceneDepth: { value: this.capture.target.texture },
    archiveOutputSize: { value: new THREE.Vector2(1, 1) },
    archiveDepthSize: { value: new THREE.Vector2(1, 1) },
    archiveCameraNear: { value: 5 }, archiveCameraFar: { value: 300 },
  };
  private active = false;
  private disposed = false;

  attach(composer: EffectComposer) {
    // The normal beauty pass already computes these values. Both alternating
    // targets need an attachment; the capture is one fullscreen GPU copy only.
    for (const target of [composer.renderTarget1, composer.renderTarget2]) {
      target.depthTexture = new THREE.DepthTexture(1, 1, THREE.UnsignedIntType);
    }
    composer.insertPass(this.capture, 1);
  }
  createMaterial(map: THREE.Texture, options: { alignDepthSamples?: boolean } = {}) {
    const material = new THREE.MeshBasicMaterial({ map, toneMapped: false,
      transparent: true, depthWrite: false, depthTest: false, fog: false });
    material.onBeforeCompile = shader => {
      Object.assign(shader.uniforms, this.uniforms);
      shader.fragmentShader = `uniform sampler2D archiveSceneDepth;
        uniform vec2 archiveOutputSize;
        uniform vec2 archiveDepthSize;
        uniform float archiveCameraNear;
        uniform float archiveCameraFar;
        #include <packing>\n` + shader.fragmentShader;
      shader.fragmentShader = shader.fragmentShader.replace('#include <clipping_planes_fragment>',
        `#include <clipping_planes_fragment>
        float sceneDepth = unpackRGBAToDepth(texture2D(archiveSceneDepth, gl_FragCoord.xy / archiveOutputSize));
        float sceneDistance = -perspectiveDepthToViewZ(sceneDepth, archiveCameraNear, archiveCameraFar);
        float printDepth = gl_FragCoord.z;
        ${options.alignDepthSamples ? `
        // Compare both planes at the coarse depth texel's center. Otherwise a
        // slanted sheet intermittently occludes itself on the finer print grid.
        vec2 depthPixel = floor(gl_FragCoord.xy / archiveOutputSize * archiveDepthSize);
        vec2 samplePosition = (depthPixel + 0.5) / archiveDepthSize * archiveOutputSize;
        printDepth += dot(vec2(dFdx(gl_FragCoord.z), dFdy(gl_FragCoord.z)), samplePosition - gl_FragCoord.xy);
        ` : ''}
        float printDistance = -perspectiveDepthToViewZ(printDepth, archiveCameraNear, archiveCameraFar);
        if (printDistance > sceneDistance + 0.006) discard;`);
    };
    material.customProgramCacheKey = () => options.alignDepthSamples
      ? 'archive-print-scene-depth-aligned-v1' : 'archive-print-scene-depth-v1';
    return material;
  }
  prepare(scene: THREE.Scene) {
    this.active = false;
    scene.traverseVisible(object => {
      if (this.active || !(object instanceof THREE.Mesh) || !object.layers.isEnabled(ARCHIVE_LABEL_LAYER)) return;
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      this.active = materials.some(material => material.visible && material.opacity > 0);
    });
    this.capture.enabled = this.active;
  }
  render(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.PerspectiveCamera) {
    if (this.disposed || !this.active) return;
    renderer.getDrawingBufferSize(this.uniforms.archiveOutputSize.value);
    this.uniforms.archiveDepthSize.value.set(this.capture.target.width, this.capture.target.height);
    this.uniforms.archiveCameraNear.value = camera.near;
    this.uniforms.archiveCameraFar.value = camera.far;
    const autoClear = renderer.autoClear, background = scene.background;
    const override = scene.overrideMaterial, layers = camera.layers.mask;
    const target = renderer.getRenderTarget(), face = renderer.getActiveCubeFace(), mip = renderer.getActiveMipmapLevel();
    const shadowAuto = renderer.shadowMap.autoUpdate, shadowUpdate = renderer.shadowMap.needsUpdate;
    try {
      renderer.autoClear = false; scene.background = null; scene.overrideMaterial = null;
      renderer.shadowMap.autoUpdate = false; renderer.shadowMap.needsUpdate = false;
      renderer.setRenderTarget(null); camera.layers.set(ARCHIVE_LABEL_LAYER);
      renderer.render(scene, camera);
    } finally {
      renderer.autoClear = autoClear; scene.background = background; scene.overrideMaterial = override;
      camera.layers.mask = layers; renderer.shadowMap.autoUpdate = shadowAuto; renderer.shadowMap.needsUpdate = shadowUpdate;
      renderer.setRenderTarget(target, face, mip);
    }
  }
  dispose() { if (!this.disposed) { this.disposed = true; this.capture.dispose(); } }
}
