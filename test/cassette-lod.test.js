import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { createCassetteLOD, splitCassetteFasteners } from '../ui/rhine/original/cassette-lod.ts'

test('small fastener LOD preserves both silhouettes and sampled front relief without modifying the full model', async () => {
  const bytes = await readFile(new URL('../lib/rhine/assets/archive-cassette.glb', import.meta.url))
  const asset = await new GLTFLoader().parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), '')
  asset.scene.updateMatrixWorld(true)
  const fastener = asset.scene.getObjectsByProperty('isMesh', true).find(mesh => mesh.material.name.startsWith('Titanium_Fasteners'))
  const source = fastener.geometry.clone().applyMatrix4(fastener.matrixWorld)
  const before = Object.fromEntries(Object.entries(source.attributes).map(([key, value]) => [key, Array.from(value.array)]))
  const lod = createCassetteLOD('Titanium_Fasteners', source)
  assert(lod)
  assert(lod.triangles < lod.originalTriangles * 0.8)
  assert(lod.geometry.boundingBox.min.distanceTo(source.boundingBox.min) < 1e-6)
  assert(lod.geometry.boundingBox.max.distanceTo(source.boundingBox.max) < 1e-6)
  for (const [key, attribute] of Object.entries(source.attributes)) assert.deepEqual(Array.from(attribute.array), before[key])
  for (const attribute of Object.values(lod.geometry.attributes)) assert(Array.from(attribute.array).every(Number.isFinite))
  const material = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide })
  const originalMesh = new THREE.Mesh(source, material), lowMesh = new THREE.Mesh(lod.geometry, material)
  const ray = new THREE.Raycaster(), center = new THREE.Vector3(), bounds = new THREE.Box3(), vertex = new THREE.Vector3()
  let comparisons = 0
  for (const side of [-1, 1]) {
    bounds.makeEmpty()
    for (let i = 0; i < source.attributes.position.count; i++) {
      vertex.fromBufferAttribute(source.attributes.position, i)
      if (Math.sign(vertex.x) === side) bounds.expandByPoint(vertex)
    }
    bounds.getCenter(center)
    for (const radius of [0, 0.015, 0.04, 0.055, 0.058]) for (let step = 0; step < 32; step++) {
      const angle = step * Math.PI / 16
      ray.set(new THREE.Vector3(center.x + radius * Math.cos(angle), center.y + radius * Math.sin(angle), 0.5), new THREE.Vector3(0, 0, -1))
      const high = ray.intersectObject(originalMesh)[0], low = ray.intersectObject(lowMesh)[0]
      if (!high) continue
      assert(low, 'a visible fastener surface must not become a hole')
      assert(Math.abs(high.point.z - low.point.z) < 0.003, 'front relief must stay close to the authored surface')
      comparisons++
    }
  }
  assert(comparisons > 200)
  assert.equal(createCassetteLOD('Ivory_Edges', source), undefined)
  assert.equal(createCassetteLOD('Internal_Ceramic', source), undefined)
  for (const original of [source, lod.geometry]) {
    const parts = splitCassetteFasteners(original)
    assert.equal(parts.length, 2)
    assert.equal(parts.reduce((sum, part) => sum + part.index.count, 0), original.index.count)
    assert(parts[0].boundingBox.min.y > 1.85)
    assert(parts[1].boundingBox.max.y < 1.85)
    for (const part of parts) part.dispose()
  }
  lod.geometry.dispose(); source.dispose(); material.dispose()
})
