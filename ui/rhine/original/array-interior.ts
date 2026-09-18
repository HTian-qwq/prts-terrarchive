import * as THREE from "three";

export const ARRAY_INTERIOR_SURFACES = new Set([
  "Internal_Ceramic",
  "Subsurface_Optics",
  "Optical_Edges",
]);

export type ArrayInteriorBake = {
  meshes: THREE.Mesh[];
  texture: THREE.Texture;
  dispose(): void;
  stats: {
    width: number;
    height: number;
    sourceTriangles: number;
    bakedTriangles: number;
    proxyTriangles: number;
    letteringTriangles: number;
    instanceTriangles: number;
    textureType: "half-float";
    textureBytes: number;
    shadowStrength: number;
  };
};

export type InteriorBakeOptions = {
  surfaces?: ReadonlySet<string>;
  /** Shelf overview direction in the cassette's local space. */
  direction?: THREE.Vector3;
  maxSize?: number;
  preserveOutsideSubstrate?: boolean;
  shadowStrength?: number;
  name?: string;
};

const LETTERING_DEPTH = 0.22;
const SURFACE_OFFSET = 0.001;
// A lit image contains ambient as well as direct illumination. This deliberately
// conservative approximation restores moving shadows without blackening both.
const SHADOW_STRENGTH = 0.3;

function surfaceName(mesh: THREE.Mesh) {
  const material = mesh.material as THREE.Material;
  return String(mesh.userData.surface ?? material.name).replace(/\.\d+$/, "");
}

function triangleCount(geometry: THREE.BufferGeometry) {
  return (geometry.index?.count ?? geometry.getAttribute("position").count) / 3;
}

/** Copy selected triangles, owning every attribute independently of the GLB. */
function extractTriangles(
  source: THREE.BufferGeometry,
  keep: (a: number, b: number, c: number) => boolean,
) {
  const index = source.index;
  const count = index?.count ?? source.getAttribute("position").count;
  const original: number[] = [];
  const remap = new Map<number, number>();
  const indices: number[] = [];
  for (let offset = 0; offset < count; offset += 3) {
    const a = index ? index.getX(offset) : offset;
    const b = index ? index.getX(offset + 1) : offset + 1;
    const c = index ? index.getX(offset + 2) : offset + 2;
    if (!keep(a, b, c)) continue;
    for (const vertex of [a, b, c]) {
      if (!remap.has(vertex)) {
        remap.set(vertex, original.length);
        original.push(vertex);
      }
      indices.push(remap.get(vertex)!);
    }
  }
  const geometry = new THREE.BufferGeometry();
  for (const [name, attribute] of Object.entries(source.attributes)) {
    const values = new Float32Array(original.length * attribute.itemSize);
    for (let i = 0; i < original.length; i++) {
      for (let component = 0; component < attribute.itemSize; component++) {
        values[i * attribute.itemSize + component] = attribute.getComponent(original[i], component);
      }
    }
    geometry.setAttribute(name, new THREE.BufferAttribute(values, attribute.itemSize));
  }
  geometry.setIndex(indices);
  return geometry;
}

export function copyInteriorLights(source: THREE.Scene, target: THREE.Scene) {
  source.traverse((object) => {
    if (!(object instanceof THREE.Light)) return;
    object.updateWorldMatrix(true, false);
    const light = object.clone();
    object.matrixWorld.decompose(light.position, light.quaternion, light.scale);
    light.castShadow = false;
    if (
      (object instanceof THREE.DirectionalLight && light instanceof THREE.DirectionalLight) ||
      (object instanceof THREE.SpotLight && light instanceof THREE.SpotLight)
    ) {
      object.target.getWorldPosition(light.target.position);
      target.add(light.target);
    }
    target.add(light);
  });
}

function proxyMaterial(texture: THREE.Texture, shadowStrength: number) {
  // The built-in shadow vertex path already handles instance matrices, normal
  // bias, logarithmic depth and directional/spot/point shadow coordinates.
  const shader = THREE.ShaderLib.shadow;
  const uniforms = THREE.UniformsUtils.clone(shader.uniforms);
  uniforms.arrayInteriorMap = { value: texture };
  uniforms.arrayShadowStrength = { value: shadowStrength };
  const material = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: shader.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec2 vArrayUv;")
      .replace("#include <begin_vertex>", "#include <begin_vertex>\nvArrayUv = uv;"),
    fragmentShader: shader.fragmentShader
      .replace(
        "#include <common>",
        "#include <common>\nvarying vec2 vArrayUv;\nuniform sampler2D arrayInteriorMap;\nuniform float arrayShadowStrength;",
      )
      .replace(
        "gl_FragColor = vec4( color, opacity * ( 1.0 - getShadowMask() ) );",
        "vec3 radiance = texture2D(arrayInteriorMap, vArrayUv).rgb;\n" +
        "gl_FragColor = vec4(radiance * mix(1.0, getShadowMask(), arrayShadowStrength), 1.0);",
      ),
    lights: true,
    fog: true,
    toneMapped: true,
    transparent: false,
    depthTest: true,
    depthWrite: true,
    side: THREE.FrontSide,
  });
  material.name = "Array_Interior";
  return material;
}

/**
 * Bake the packed array's three interior surfaces onto the substrate's real
 * opaque front face. Source meshes/attributes/materials remain caller-owned.
 * The original substrate still supplies its bevels, back face and cast shadow;
 * the cover and perimeter retain their authored geometry and transmission.
 */
export function bakeArrayInterior(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  sources: THREE.Mesh[],
  options: InteriorBakeOptions = {},
): ArrayInteriorBake {
  const interiorSurfaces = options.surfaces ?? ARRAY_INTERIOR_SURFACES;
  const shadowStrength = THREE.MathUtils.clamp(options.shadowStrength ?? SHADOW_STRENGTH, 0, 1);
  const substrate = sources.find((mesh) => surfaceName(mesh) === "Optical_Diffuser");
  if (!substrate) throw new Error("Array interior baking requires the optical substrate.");
  if (sources.some((mesh) => Array.isArray(mesh.material))) {
    throw new Error("Array interior baking requires one material per source mesh.");
  }
  if (!renderer.extensions.has("EXT_color_buffer_float")) {
    // Let the caller retain the authored meshes rather than silently clipping
    // HDR lighting into an 8-bit render target on unsupported hardware.
    throw new Error("Array interior baking requires a linear half-float render target.");
  }

  const meshes: THREE.Mesh[] = [];
  const ownedGeometry = new Set<THREE.BufferGeometry>();
  const ownedMaterial = new Set<THREE.Material>();
  const temporaryGeometry = new Set<THREE.BufferGeometry>();
  const temporaryMaterial = new Set<THREE.Material>();
  let target: THREE.WebGLRenderTarget | undefined;
  let texture: THREE.DataTexture | undefined;
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    for (const geometry of ownedGeometry) geometry.dispose();
    for (const material of ownedMaterial) material.dispose();
    target?.dispose();
    texture?.dispose();
  };

  try {
    const sourcePosition = substrate.geometry.getAttribute("position");
    let frontZ = -Infinity;
    for (let i = 0; i < sourcePosition.count; i++) frontZ = Math.max(frontZ, sourcePosition.getZ(i));
    const front = extractTriangles(substrate.geometry, (a, b, c) =>
      [a, b, c].every((index) => Math.abs(sourcePosition.getZ(index) - frontZ) < 1e-6),
    );
    ownedGeometry.add(front);
    if (!front.index?.count) throw new Error("The optical substrate has no planar front face.");
    front.computeBoundingBox();
    const bounds = front.boundingBox!;
    const size = bounds.getSize(new THREE.Vector3());
    const center = bounds.getCenter(new THREE.Vector3());
    if (!(size.x > 0 && size.y > 0)) throw new Error("The optical substrate has an empty front face.");
    const position = front.getAttribute("position");
    const uv = new Float32Array(position.count * 2);
    for (let i = 0; i < position.count; i++) {
      uv[i * 2] = (position.getX(i) - bounds.min.x) / size.x;
      uv[i * 2 + 1] = (position.getY(i) - bounds.min.y) / size.y;
      position.setZ(i, position.getZ(i) + SURFACE_OFFSET);
    }
    front.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
    front.computeBoundingBox();
    front.computeBoundingSphere();

    const bakeScene = new THREE.Scene();
    bakeScene.environment = scene.environment;
    bakeScene.environmentIntensity = scene.environmentIntensity;
    bakeScene.environmentRotation.copy(scene.environmentRotation);
    copyInteriorLights(scene, bakeScene);
    let sourceTriangles = 0;
    let bakedTriangles = 0;
    let letteringTriangles = 0;
    for (const source of sources) {
      const name = surfaceName(source);
      if (!interiorSurfaces.has(name) && name !== "Optical_Diffuser") continue;
      if (interiorSurfaces.has(name)) sourceTriangles += triangleCount(source.geometry);
      let geometry = source.geometry;
      if (name === "Internal_Ceramic" || options.preserveOutsideSubstrate && name !== "Optical_Diffuser") {
        const attribute = source.geometry.getAttribute("position");
        const isLetter = (a: number, b: number, c: number) =>
          name === "Internal_Ceramic" && [a, b, c].every((index) => attribute.getZ(index) > LETTERING_DEPTH)
          || !!options.preserveOutsideSubstrate && [a, b, c].some(index =>
            attribute.getX(index) < bounds.min.x || attribute.getX(index) > bounds.max.x
            || attribute.getY(index) < bounds.min.y || attribute.getY(index) > bounds.max.y);
        const lettering = extractTriangles(source.geometry, isLetter);
        ownedGeometry.add(lettering);
        if (lettering.index!.count > 0) {
          const material = (source.material as THREE.Material).clone();
          ownedMaterial.add(material);
          const mesh = new THREE.Mesh(lettering, material);
          mesh.name = options.name ? `${options.name}_${name}_Retained` : "Array_Interior_Lettering";
          mesh.userData.surface = mesh.name;
          mesh.receiveShadow = true;
          meshes.push(mesh);
          letteringTriangles += triangleCount(lettering);
        }
        geometry = extractTriangles(source.geometry, (a, b, c) => !isLetter(a, b, c));
        temporaryGeometry.add(geometry);
      }
      const material = (source.material as THREE.MeshStandardMaterial).clone();
      material.fog = false;
      material.toneMapped = false;
      if (material instanceof THREE.MeshPhysicalMaterial) material.transmission = 0;
      temporaryMaterial.add(material);
      const mesh = new THREE.Mesh(geometry, material);
      mesh.name = name;
      bakeScene.add(mesh);
      bakedTriangles += triangleCount(geometry);
    }

    const camera = new THREE.OrthographicCamera(-size.x / 2, size.x / 2, size.y / 2, -size.y / 2, 0.1, options.direction ? 20 : 4);
    camera.position.copy(center).addScaledVector(options.direction?.clone().normalize() ?? new THREE.Vector3(0, 0, 1), options.direction ? 10 : 2 - center.z);
    camera.lookAt(center.x, center.y, options.direction ? center.z : 0);
    camera.updateMatrixWorld(true);
    if (options.direction) {
      const projectedBounds = bounds.clone().applyMatrix4(camera.matrixWorldInverse);
      camera.left = projectedBounds.min.x; camera.right = projectedBounds.max.x;
      camera.bottom = projectedBounds.min.y; camera.top = projectedBounds.max.y;
      camera.updateProjectionMatrix();
      const projected = new THREE.Vector3();
      for (let i = 0; i < position.count; i++) {
        projected.fromBufferAttribute(position, i).project(camera);
        uv[i * 2] = projected.x * 0.5 + 0.5;
        uv[i * 2 + 1] = projected.y * 0.5 + 0.5;
      }
      front.getAttribute("uv").needsUpdate = true;
    }
    const maximum = Math.min(options.maxSize ?? 1024, renderer.capabilities.maxTextureSize);
    const aspect = (camera.right - camera.left) / (camera.top - camera.bottom);
    const width = options.direction ? Math.max(1, Math.round(maximum * Math.min(1, aspect))) : maximum;
    const height = options.direction ? Math.max(1, Math.round(maximum * Math.min(1, 1 / aspect))) : Math.max(1, Math.round(width * size.y / size.x));
    target = new THREE.WebGLRenderTarget(width, height, {
      type: THREE.HalfFloatType,
      format: THREE.RGBAFormat,
      colorSpace: THREE.LinearSRGBColorSpace,
      depthBuffer: true,
      stencilBuffer: false,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      generateMipmaps: false,
    });

    const saved = {
      target: renderer.getRenderTarget(),
      face: renderer.getActiveCubeFace(),
      mip: renderer.getActiveMipmapLevel(),
      viewport: renderer.getViewport(new THREE.Vector4()),
      scissor: renderer.getScissor(new THREE.Vector4()),
      scissorTest: renderer.getScissorTest(),
      clearColor: renderer.getClearColor(new THREE.Color()),
      clearAlpha: renderer.getClearAlpha(),
      autoClear: renderer.autoClear,
      autoClearColor: renderer.autoClearColor,
      autoClearDepth: renderer.autoClearDepth,
      autoClearStencil: renderer.autoClearStencil,
      toneMapping: renderer.toneMapping,
      exposure: renderer.toneMappingExposure,
      outputColorSpace: renderer.outputColorSpace,
      shadowEnabled: renderer.shadowMap.enabled,
      shadowAutoUpdate: renderer.shadowMap.autoUpdate,
      shadowNeedsUpdate: renderer.shadowMap.needsUpdate,
      xrEnabled: renderer.xr.enabled,
      clippingPlanes: renderer.clippingPlanes,
      localClipping: renderer.localClippingEnabled,
    };
    const pixels = new Uint16Array(width * height * 4);
    // Some readback failures only log an error. A NaN sentinel plus opaque,
    // finite-pixel validation keeps those failures on the real-geometry path.
    pixels.fill(0x7e00);
    try {
      renderer.xr.enabled = false;
      renderer.shadowMap.enabled = false;
      renderer.shadowMap.autoUpdate = false;
      renderer.shadowMap.needsUpdate = false;
      renderer.clippingPlanes = [];
      renderer.localClippingEnabled = false;
      renderer.toneMapping = THREE.NoToneMapping;
      renderer.toneMappingExposure = 1;
      renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
      renderer.autoClear = true;
      renderer.autoClearColor = true;
      renderer.autoClearDepth = true;
      renderer.autoClearStencil = true;
      // RenderTarget viewport/scissor are physical pixels. Renderer.setViewport
      // would multiply by the main canvas DPR and crop this independent image.
      renderer.setRenderTarget(target);
      renderer.setClearColor(0x000000, 1);
      renderer.render(bakeScene, camera);
      renderer.readRenderTargetPixels(target, 0, 0, width, height, pixels);
      let hasColor = false;
      for (let offset = 0; offset < pixels.length; offset += 4) {
        if (pixels[offset + 3] !== 0x3c00) {
          throw new Error("Array interior half-float readback did not produce an opaque image.");
        }
        for (let channel = 0; channel < 3; channel++) {
          const value = pixels[offset + channel];
          if ((value & 0x7c00) === 0x7c00) {
            throw new Error("Array interior half-float readback contains non-finite pixels.");
          }
          if ((value & 0x7fff) !== 0) hasColor = true;
        }
      }
      if (!hasColor) throw new Error("Array interior baking produced an empty image.");
    } finally {
      renderer.setViewport(saved.viewport);
      renderer.setScissor(saved.scissor);
      renderer.setScissorTest(saved.scissorTest);
      renderer.setRenderTarget(saved.target, saved.face, saved.mip);
      renderer.setClearColor(saved.clearColor, saved.clearAlpha);
      renderer.autoClear = saved.autoClear;
      renderer.autoClearColor = saved.autoClearColor;
      renderer.autoClearDepth = saved.autoClearDepth;
      renderer.autoClearStencil = saved.autoClearStencil;
      renderer.toneMapping = saved.toneMapping;
      renderer.toneMappingExposure = saved.exposure;
      renderer.outputColorSpace = saved.outputColorSpace;
      renderer.shadowMap.enabled = saved.shadowEnabled;
      renderer.shadowMap.autoUpdate = saved.shadowAutoUpdate;
      renderer.shadowMap.needsUpdate = saved.shadowNeedsUpdate;
      renderer.xr.enabled = saved.xrEnabled;
      renderer.clippingPlanes = saved.clippingPlanes;
      renderer.localClippingEnabled = saved.localClipping;
    }

    // Retain pixels in an ordinary texture: context restoration can upload it
    // again, and the existing quality control can change its anisotropy.
    texture = new THREE.DataTexture(pixels, width, height, THREE.RGBAFormat, THREE.HalfFloatType);
    texture.name = options.name ?? "Rhine array interior radiance";
    texture.colorSpace = THREE.LinearSRGBColorSpace;
    texture.flipY = false;
    texture.generateMipmaps = true;
    texture.minFilter = THREE.LinearMipmapLinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.anisotropy = Math.min(4, renderer.capabilities.getMaxAnisotropy());
    texture.needsUpdate = true;
    target.dispose();
    target = undefined;
    const material = proxyMaterial(texture, shadowStrength);
    ownedMaterial.add(material);
    const proxy = new THREE.Mesh(front, material);
    proxy.name = options.name ?? "Array_Interior";
    proxy.userData.surface = proxy.name;
    proxy.receiveShadow = shadowStrength > 0;
    meshes.unshift(proxy);
    const proxyTriangles = triangleCount(front);
    let textureBytes = 0;
    for (let w = width, h = height; ; w = Math.max(1, w >> 1), h = Math.max(1, h >> 1)) {
      textureBytes += w * h * 8;
      if (w === 1 && h === 1) break;
    }
    return {
      meshes,
      texture,
      dispose,
      stats: {
        width, height, sourceTriangles, bakedTriangles, proxyTriangles,
        letteringTriangles, instanceTriangles: proxyTriangles + letteringTriangles,
        textureType: "half-float", textureBytes, shadowStrength,
      },
    };
  } catch (error) {
    dispose();
    throw error;
  } finally {
    for (const geometry of temporaryGeometry) geometry.dispose();
    for (const material of temporaryMaterial) material.dispose();
  }
}
