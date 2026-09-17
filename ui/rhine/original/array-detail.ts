import * as THREE from "three";
import data from "./array-detail-data.ts";
import { detailSignature } from "./detail-signature.ts";

/** Prebaked shallow lettering; source mismatch retains real geometry. No browser
 * rasterization/readback is needed. Normals, coverage and live PBR lighting are
 * kept separate, so this is not a photograph with fixed illumination.
 */
export function createArrayDetail(surface: string, source: THREE.BufferGeometry, material: THREE.Material) {
  if (surface !== "Array_Interior_Lettering" || !(material instanceof THREE.MeshStandardMaterial)
    || detailSignature(source) !== data.signature) return undefined;
  const pixels = new Uint8Array(data.width * data.height * 4);
  let offset = 0;
  for (let run = 0; run < data.runs.length; run += 2) {
    const count = data.runs[run], value = data.runs[run + 1];
    for (let i = 0; i < count; i++) {
      pixels[offset++] = value & 255; pixels[offset++] = (value >>> 8) & 255;
      pixels[offset++] = (value >>> 16) & 255; pixels[offset++] = value >>> 24;
    }
  }
  if (offset !== pixels.length) return undefined;
  const texture = new THREE.DataTexture(pixels, data.width, data.height, THREE.RGBAFormat);
  texture.name = "Array lettering normal and coverage"; texture.colorSpace = THREE.NoColorSpace;
  texture.generateMipmaps = true; texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter; texture.anisotropy = 4; texture.needsUpdate = true;
  const geometry = new THREE.PlaneGeometry(data.max[0] - data.min[0], data.max[1] - data.min[1]).translate(
    (data.min[0] + data.max[0]) / 2, (data.min[1] + data.max[1]) / 2, data.max[2]);
  const proxyMaterial = material.clone();
  proxyMaterial.normalMap = texture; proxyMaterial.normalMapType = THREE.TangentSpaceNormalMap;
  proxyMaterial.normalScale.set(1, 1); proxyMaterial.transparent = true; proxyMaterial.depthWrite = false;
  proxyMaterial.alphaTest = 0.01;
  proxyMaterial.onBeforeCompile = shader => {
    shader.fragmentShader = shader.fragmentShader.replace("#include <alphatest_fragment>",
      "diffuseColor.a *= texture2D(normalMap, vNormalMapUv).a;\n#include <alphatest_fragment>");
  };
  proxyMaterial.customProgramCacheKey = () => "array-normal-coverage-v1";
  proxyMaterial.userData.arrayDetail = {
    surface, width: data.width, height: data.height, bakedTriangles: data.sourceTriangles, signature: data.signature,
  };
  return { geometry, material: proxyMaterial, texture };
}
