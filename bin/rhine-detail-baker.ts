import * as THREE from "three";

/** Offline rasterization of the authored shallow lettering. Runtime uses the
 * generated data only; this module is not imported by the browser bundle. */
export function createArrayDetail(surface: string, source: THREE.BufferGeometry, material: THREE.Material) {
  if (surface !== "Array_Interior_Lettering") return undefined;
  const position = source.getAttribute("position"), normal = source.getAttribute("normal"), index = source.index;
  if (!index || !normal || !position || !(material instanceof THREE.MeshStandardMaterial)) return undefined;
  if (!source.boundingBox) source.computeBoundingBox();
  const baked: number[] = [], bounds = new THREE.Box3(), point = new THREE.Vector3();
  for (let i = 0; i < index.count; i += 3) {
    const vertices = [index.getX(i), index.getX(i + 1), index.getX(i + 2)];
    baked.push(...vertices);
    for (const v of vertices) bounds.expandByPoint(point.fromBufferAttribute(position, v));
  }
  if (baked.length < 30 || bounds.isEmpty()) return undefined;
  const size = bounds.getSize(new THREE.Vector3());
  // Unsupported relief keeps the real mesh. This is not a general 3D impostor.
  if (size.z > 0.0011 || size.x <= 0 || size.y <= 0) return undefined;
  const width = 512, height = 64;
  const paddingX = size.x * 2 / (width - 4), paddingY = size.y * 2 / (height - 4);
  bounds.min.x -= paddingX; bounds.max.x += paddingX;
  bounds.min.y -= paddingY; bounds.max.y += paddingY;
  bounds.getSize(size);
  const w = width * 2, h = height * 2;
  const depth = new Float32Array(w * h).fill(-Infinity), normals = new Float32Array(w * h * 3);
  for (let i = 0; i < baked.length; i += 3) {
    const vertices = baked.slice(i, i + 3);
    const xs = vertices.map(v => (position.getX(v) - bounds.min.x) / size.x * w);
    const ys = vertices.map(v => (position.getY(v) - bounds.min.y) / size.y * h);
    const denominator = (ys[1] - ys[2]) * (xs[0] - xs[2]) + (xs[2] - xs[1]) * (ys[0] - ys[2]);
    if (Math.abs(denominator) < 1e-10) continue;
    for (let y = Math.max(0, Math.floor(Math.min(...ys))); y < Math.min(h, Math.ceil(Math.max(...ys))); y++) {
      for (let x = Math.max(0, Math.floor(Math.min(...xs))); x < Math.min(w, Math.ceil(Math.max(...xs))); x++) {
        const a = ((ys[1] - ys[2]) * (x + 0.5 - xs[2]) + (xs[2] - xs[1]) * (y + 0.5 - ys[2])) / denominator;
        const b = ((ys[2] - ys[0]) * (x + 0.5 - xs[2]) + (xs[0] - xs[2]) * (y + 0.5 - ys[2])) / denominator;
        const c = 1 - a - b;
        if (Math.min(a, b, c) < -1e-6) continue;
        const z = a * position.getZ(vertices[0]) + b * position.getZ(vertices[1]) + c * position.getZ(vertices[2]);
        const pixel = y * w + x;
        if (z < depth[pixel]) continue;
        depth[pixel] = z;
        for (let channel = 0; channel < 3; channel++) normals[pixel * 3 + channel] =
          a * normal.getComponent(vertices[0], channel) + b * normal.getComponent(vertices[1], channel) + c * normal.getComponent(vertices[2], channel);
      }
    }
  }
  const pixels = new Uint8Array(width * height * 4);
  let occupied = 0;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    point.set(0, 0, 0); let count = 0;
    for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
      const pixel = (y * 2 + dy) * w + x * 2 + dx;
      if (!Number.isFinite(depth[pixel])) continue;
      point.x += normals[pixel * 3]; point.y += normals[pixel * 3 + 1]; point.z += normals[pixel * 3 + 2]; count++;
    }
    if (count) { point.normalize(); occupied++; } else point.set(0, 0, 1);
    const offset = (y * width + x) * 4;
    pixels[offset] = Math.round((point.x * 0.5 + 0.5) * 255);
    pixels[offset + 1] = Math.round((point.y * 0.5 + 0.5) * 255);
    pixels[offset + 2] = Math.round((point.z * 0.5 + 0.5) * 255);
    pixels[offset + 3] = Math.round(count * 255 / 4);
  }
  if (!occupied) return undefined;
  const texture = new THREE.DataTexture(pixels, width, height, THREE.RGBAFormat);
  texture.name = `Array ${surface} normal and coverage`;
  texture.colorSpace = THREE.NoColorSpace;
  texture.generateMipmaps = true; texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter; texture.anisotropy = 4; texture.needsUpdate = true;
  const geometry = new THREE.PlaneGeometry(size.x, size.y).translate(
    (bounds.min.x + bounds.max.x) / 2, (bounds.min.y + bounds.max.y) / 2, bounds.max.z + 0.00001);
  const proxyMaterial = material.clone();
  proxyMaterial.normalMap = texture; proxyMaterial.normalMapType = THREE.TangentSpaceNormalMap;
  proxyMaterial.normalScale.set(1, 1); proxyMaterial.transparent = true; proxyMaterial.depthWrite = false;
  proxyMaterial.alphaTest = 0.01;
  proxyMaterial.onBeforeCompile = shader => {
    shader.fragmentShader = shader.fragmentShader.replace("#include <alphatest_fragment>",
      "diffuseColor.a *= texture2D(normalMap, vNormalMapUv).a;\n#include <alphatest_fragment>");
  };
  proxyMaterial.customProgramCacheKey = () => "array-normal-coverage-v1";
  proxyMaterial.userData.arrayDetail = { surface, width, height, bakedTriangles: baked.length / 3 };
  return { geometry, material: proxyMaterial, texture, bakedTriangles: baked.length / 3,
    textureBytes: pixels.byteLength, sourceTriangles: index.count / 3 };
}
