import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { splitArrayShell } from '../ui/rhine/original/array-shell.ts'

test('real shell regions preserve every authored triangle, attribute and ray hit', async () => {
  const bytes = await readFile(new URL('../lib/rhine/assets/archive-cassette.glb', import.meta.url))
  const asset = await new GLTFLoader().parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), '')
  asset.scene.updateMatrixWorld(true)
  const material = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide })
  const signatures = geometry => {
    const names = Object.keys(geometry.attributes).sort(), result = []
    for (let i = 0; i < geometry.index.count; i += 3) {
      const values = []
      for (let j = 0; j < 3; j++) for (const name of names) {
        const attribute = geometry.attributes[name]
        for (let c = 0; c < attribute.itemSize; c++) values.push(attribute.getComponent(geometry.index.getX(i + j), c))
      }
      result.push(JSON.stringify(values))
    }
    return result.sort()
  }
  for (const source of asset.scene.getObjectsByProperty('isMesh', true)) {
    const name = source.material.name.replace(/\.\d+$/, '')
    if (!['Frosted_Polymer', 'Ivory_Edges'].includes(name)) continue
    const geometry = source.geometry.clone().applyMatrix4(source.matrixWorld), before = signatures(geometry)
    const parts = splitArrayShell(name, geometry)
    assert.equal(parts.length, 5)
    assert.deepEqual(parts.flatMap(part => signatures(part.geometry)).sort(), before)
    assert.deepEqual(signatures(geometry), before, 'selected model geometry stays unmodified')
    const meshes = parts.map(part => new THREE.Mesh(part.geometry, material)), original = new THREE.Mesh(geometry, material)
    const ray = new THREE.Raycaster()
    let hits = 0
    for (const eye of [new THREE.Vector3(0, 2, 8), new THREE.Vector3(7, 5, 8), new THREE.Vector3(-7, -2, 8)]) {
      for (let x = -2.48; x < 2.5; x += 0.2) for (let y = 0.02; y < 3.7; y += 0.2) {
        ray.set(eye, new THREE.Vector3(x, y, 0.19).sub(eye).normalize())
        const a = ray.intersectObject(original)[0], b = ray.intersectObjects(meshes)[0]
        assert.equal(Boolean(a), Boolean(b))
        if (a) { assert(a.point.distanceTo(b.point) < 1e-6); hits++ }
      }
    }
    assert(hits > 100)
    for (const part of parts) part.geometry.dispose()
    geometry.dispose()
  }
  material.dispose()
})

test('unsupported or unpartitionable meshes retain the original geometry path', () => {
  const geometry = new THREE.PlaneGeometry(1, 1)
  assert.equal(splitArrayShell('Internal_Ceramic', geometry), undefined)
  assert.equal(splitArrayShell('Frosted_Polymer', geometry), undefined)
  geometry.dispose()
})
