import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { createArrayDetail } from '../ui/rhine/original/array-detail.ts'
import { detailSignature } from '../ui/rhine/original/detail-signature.ts'
import data from '../ui/rhine/original/array-detail-data.ts'
import { createArrayDetail as bake } from '../bin/rhine-detail-baker.ts'

async function lettering() {
  const raw = await readFile(new URL('../lib/rhine/assets/archive-cassette.glb', import.meta.url))
  const gltf = await new GLTFLoader().parseAsync(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength), '')
  gltf.scene.updateMatrixWorld(true)
  const source = gltf.scene.getObjectsByProperty('isMesh', true).find(mesh => mesh.material.name.startsWith('Internal_Ceramic'))
  const geometry = source.geometry.clone().applyMatrix4(source.matrixWorld).scale(1, 1, 1), position = geometry.attributes.position, indices = []
  for (let i = 0; i < geometry.index.count; i += 3) {
    const vertices = [geometry.index.getX(i), geometry.index.getX(i + 1), geometry.index.getX(i + 2)]
    if (vertices.every(v => position.getZ(v) > 0.22)) indices.push(...vertices)
  }
  geometry.setIndex(indices)
  return new THREE.Mesh(geometry, source.material.clone())
}

test('prebaked lettering matches the real asset bake and preserves live material parameters', async () => {
  const source = await lettering(), signature = detailSignature(source.geometry)
  const detail = createArrayDetail('Array_Interior_Lettering', source.geometry, source.material)
  assert(detail)
  const expected = bake('Array_Interior_Lettering', source.geometry, source.material)
  assert.deepEqual(detail.texture.image.data, expected.texture.image.data)
  assert.equal(detail.geometry.index.count, 6)
  assert.equal(detail.texture.image.data.byteLength, 131072)
  assert.equal(detail.texture.colorSpace, THREE.NoColorSpace)
  assert.equal(detail.material.roughness, source.material.roughness)
  assert(detail.material.color.equals(source.material.color))
  assert.equal(detail.material.metalness, source.material.metalness)
  assert.equal(detail.material.depthWrite, false)
  assert.equal(detailSignature(source.geometry), signature)
  assert.equal(signature, data.signature)
  for (const item of [detail, expected]) { item.geometry.dispose(); item.texture.dispose(); item.material.dispose() }
  source.geometry.dispose(); source.material.dispose()
})

test('opaque map samples retain the authored lettering coverage and normal direction', async () => {
  const source = await lettering(), detail = createArrayDetail('Array_Interior_Lettering', source.geometry, source.material)
  const ray = new THREE.Raycaster(), encoded = new THREE.Vector3()
  const { width, height, data: pixels } = detail.texture.image
  let tested = 0, hits = 0, aligned = 0
  for (let y = 2; y < height - 2; y += 2) for (let x = 2; x < width - 2; x += 3) {
    const offset = (y * width + x) * 4
    if (pixels[offset + 3] !== 255) continue
    ray.set(new THREE.Vector3(data.min[0] + (x + 0.5) / width * (data.max[0] - data.min[0]),
      data.min[1] + (y + 0.5) / height * (data.max[1] - data.min[1]), 1), new THREE.Vector3(0, 0, -1))
    tested++
    const hit = ray.intersectObject(source)[0]
    if (!hit) continue
    hits++
    encoded.set(pixels[offset] / 255 * 2 - 1, pixels[offset + 1] / 255 * 2 - 1, pixels[offset + 2] / 255 * 2 - 1).normalize()
    if (encoded.dot(hit.normal) > 0.97) aligned++
  }
  assert(tested > 150)
  assert(hits / tested > 0.99)
  assert(aligned / hits > 0.98)
  detail.geometry.dispose(); detail.texture.dispose(); detail.material.dispose(); source.geometry.dispose(); source.material.dispose()
})

test('changed assets and non-lettering surfaces fall back to real geometry', async () => {
  const source = await lettering()
  assert.equal(createArrayDetail('Titanium_Fasteners', source.geometry, source.material), undefined)
  source.geometry.translate(0.001, 0, 0)
  assert.equal(createArrayDetail('Array_Interior_Lettering', source.geometry, source.material), undefined)
  source.geometry.dispose(); source.material.dispose()
})
