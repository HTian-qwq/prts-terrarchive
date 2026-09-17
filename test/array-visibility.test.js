import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import * as THREE from 'three'
import ts from 'typescript'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { splitArrayShell } from '../ui/rhine/original/array-shell.ts'

// Real Three geometry, camera frustums and picking; no WebGL/browser required.
const source = await readFile(new URL('../ui/rhine/original/array-visibility.ts', import.meta.url), 'utf8')
const threeUrl = new URL('../node_modules/three/build/three.module.js', import.meta.url).href
const compiled = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText.replace('from "three"', `from ${JSON.stringify(threeUrl)}`)
  .replace('from "./array-occlusion.ts"', `from ${JSON.stringify(new URL('../ui/rhine/original/array-occlusion.ts', import.meta.url).href)}`)
const { ArrayVisibility } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`)

test('every region of the real cover picks the logical cassette after compaction and slot replacement', async () => {
  const bytes = await readFile(new URL('../lib/rhine/assets/archive-cassette.glb', import.meta.url))
  const asset = await new GLTFLoader().parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), '')
  asset.scene.updateMatrixWorld(true)
  const original = asset.scene.getObjectsByProperty('isMesh', true).find(m => m.material.name.startsWith('Frosted_Polymer'))
  const geometry = original.geometry.clone().applyMatrix4(original.matrixWorld)
  const parts = splitArrayShell('Frosted_Polymer', geometry).map(p => batch(3, p.geometry))
  const visibility = new ArrayVisibility(3), view = new THREE.OrthographicCamera(-3, 3, 4, -1, 0.1, 30)
  view.position.z = 10; view.updateMatrixWorld()
  visibility.prepare(parts)
  visibility.setSlot(0, pose(-16), true); visibility.setSlot(1, pose(0), true); visibility.setSlot(2, pose(16), true)
  const ray = new THREE.Raycaster()
  for (const logical of [1, 0]) {
    if (logical === 0) { visibility.setSlot(1, pose(0), false); visibility.setSlot(0, pose(0), true) }
    visibility.submit(view, parts, true, 1080)
    for (const [x, y] of [[-2, 0.3], [2, 0.3], [-2, 3.2], [2, 3.2], [0, 1.85]]) {
      ray.set(new THREE.Vector3(x, y, 10), new THREE.Vector3(0, 0, -1))
      const hit = ray.intersectObjects(parts)[0]
      assert(hit)
      assert.equal(visibility.logicalIndex(hit.object, hit.instanceId), logical)
    }
  }
  for (const mesh of parts) { mesh.geometry.dispose(); mesh.material.dispose(); mesh.dispose() }
  geometry.dispose()
})

function camera() {
  const result = new THREE.OrthographicCamera(-2, 2, 2, -2, 0.1, 30)
  result.position.set(0, 0, 10)
  result.lookAt(0, 0, 0)
  result.updateMatrixWorld()
  return result
}

function batch(capacity, geometry = new THREE.BoxGeometry(1, 1, 1), castShadow = false) {
  const result = new THREE.InstancedMesh(geometry, new THREE.MeshBasicMaterial(), capacity)
  result.name = castShadow ? 'substrate' : 'cover'
  result.castShadow = castShadow
  result.frustumCulled = false
  return result
}

function pose(x, y = 0, z = 0, rotation = 0) {
  return new THREE.Matrix4().compose(
    new THREE.Vector3(x, y, z),
    new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), rotation),
    new THREE.Vector3(1, 1, 1),
  )
}

function slotIndices(visibility, mesh) {
  return Array.from({ length: mesh.count }, (_, index) => visibility.logicalIndex(mesh, index))
}

test('compaction keeps complete edge-crossing cards and off-camera shadow casters', () => {
  const visibility = new ArrayVisibility(6)
  const cover = batch(6)
  const substrate = batch(6, new THREE.BoxGeometry(1, 1, 1), true)
  visibility.prepare([cover, substrate])
  visibility.setSlot(0, pose(0), false)
  visibility.setSlot(1, pose(0), true)
  visibility.setSlot(2, pose(2.6), true) // Body ends at 2.1, padding crosses x=2.
  visibility.setSlot(3, pose(2.86), true) // Even the padded body is outside.
  visibility.setSlot(4, pose(30), true)
  visibility.setSlot(5, pose(0, 0, 12), true) // Behind the camera.
  visibility.submit(camera(), [cover, substrate])
  assert.deepEqual(slotIndices(visibility, cover), [1, 2])
  assert.deepEqual(slotIndices(visibility, substrate), [1, 2, 3, 4, 5])
  assert.deepEqual(visibility.getStats(), {
    capacity: 6, activeSlots: 5, visibleSlots: 2, culledSlots: 3, shadowSlots: 5,
    batches: [
      { name: 'cover', castShadow: false, count: 2 },
      { name: 'substrate', castShadow: true, count: 5 },
    ],
  })
  assert.deepEqual(cover.instanceMatrix.updateRanges, [{ start: 0, count: 32 }])
  assert.equal(visibility.logicalIndex(cover, 2), undefined)
})

test('all layers share the transformed full-card bounds rather than their own centers', () => {
  const visibility = new ArrayVisibility(2)
  const smallLayer = batch(2, new THREE.BoxGeometry(0.1, 0.1, 0.1))
  const tallLayer = batch(2, new THREE.BoxGeometry(0.2, 4, 0.2))
  visibility.prepare([smallLayer, tallLayer])
  visibility.setSlot(0, pose(3.5, 0, 0, Math.PI / 2), true)
  visibility.setSlot(1, pose(3.5), true)
  visibility.submit(camera(), [smallLayer, tallLayer])
  // The rotated long layer enters the view; even its tiny companion is kept.
  assert.deepEqual(slotIndices(visibility, smallLayer), [0])
  assert.deepEqual(slotIndices(visibility, tallLayer), [0])
})

test('perspective culling follows the current lens and keeps near/far clipping conservative', () => {
  const visibility = new ArrayVisibility(4)
  const mesh = batch(4)
  const view = new THREE.PerspectiveCamera(60, 1, 1, 20)
  view.position.set(0, 0, 10)
  view.lookAt(0, 0, 0)
  visibility.setSlot(0, pose(0), true)
  visibility.setSlot(1, pose(7.2), true)
  visibility.setSlot(2, pose(0, 0, -12), true)
  visibility.setSlot(3, pose(0, 0, 12), true)
  visibility.submit(view, [mesh])
  assert.deepEqual(slotIndices(visibility, mesh), [0])
  view.aspect = 2
  view.updateProjectionMatrix()
  visibility.submit(view, [mesh])
  assert.deepEqual(slotIndices(visibility, mesh), [0, 1])
})

test('logical poses survive hiding and camera compaction without retaining the input matrix', () => {
  const visibility = new ArrayVisibility(3)
  const mesh = batch(3)
  const hiddenPose = pose(15, 2, -3, 0.3)
  const hiddenSnapshot = hiddenPose.clone()
  visibility.setSlot(0, hiddenPose, false)
  hiddenPose.identity()
  visibility.setSlot(1, pose(0), true)
  visibility.setSlot(2, pose(15, 0, 0, 0.2), true)
  const view = camera()
  visibility.submit(view, [mesh])
  assert.deepEqual(slotIndices(visibility, mesh), [1])
  assert.ok(visibility.matrixAt(0).equals(hiddenSnapshot))
  const offscreenSnapshot = visibility.matrixAt(2).clone()
  view.position.x = 15
  view.lookAt(15, 0, 0)
  visibility.submit(view, [mesh])
  assert.deepEqual(slotIndices(visibility, mesh), [2])
  assert.ok(visibility.matrixAt(0).equals(hiddenSnapshot))
  assert.ok(visibility.matrixAt(2).equals(offscreenSnapshot))
  visibility.submit(view, [mesh], false)
  assert.deepEqual(slotIndices(visibility, mesh), [1, 2])
  assert.equal(visibility.getStats().culledSlots, 0)
})

test('real raycasts map compact instance IDs and refresh moved bounds after an empty frame', () => {
  const visibility = new ArrayVisibility(4)
  const mesh = batch(4)
  const view = camera()
  const raycaster = new THREE.Raycaster()
  visibility.setSlot(0, pose(0), false)
  visibility.setSlot(1, pose(30), true)
  visibility.setSlot(2, pose(0), true)
  visibility.setSlot(3, pose(1.25), true)
  visibility.submit(view, [mesh])
  raycaster.setFromCamera(new THREE.Vector2(0, 0), view)
  let hit = raycaster.intersectObject(mesh)[0]
  assert.equal(hit.instanceId, 0)
  assert.equal(visibility.logicalIndex(mesh, hit.instanceId), 2)
  assert.notEqual(mesh.boundingSphere, null)
  mesh.computeBoundingBox()

  // Compaction changes which logical file is instance 0 and where its sphere is.
  visibility.setSlot(2, pose(0), false)
  visibility.submit(view, [mesh])
  assert.equal(mesh.boundingSphere, null)
  assert.equal(mesh.boundingBox, null)
  raycaster.setFromCamera(new THREE.Vector2(0.625, 0), view)
  hit = raycaster.intersectObject(mesh)[0]
  assert.equal(hit.instanceId, 0)
  assert.equal(visibility.logicalIndex(mesh, hit.instanceId), 3)

  visibility.setSlot(1, pose(30), false)
  visibility.setSlot(3, pose(1.25), false)
  const attributeVersion = mesh.instanceMatrix.version
  visibility.submit(view, [mesh])
  assert.equal(mesh.count, 0)
  assert.equal(mesh.instanceMatrix.version, attributeVersion)
  assert.deepEqual(mesh.instanceMatrix.updateRanges, [])
  assert.equal(visibility.logicalIndex(mesh, 0), undefined)
  assert.deepEqual(raycaster.intersectObject(mesh), [])

  visibility.setSlot(1, pose(-1.25), true)
  visibility.submit(view, [mesh])
  assert.equal(mesh.count, 1)
  assert.ok(mesh.instanceMatrix.version > attributeVersion)
  raycaster.setFromCamera(new THREE.Vector2(-0.625, 0), view)
  hit = raycaster.intersectObject(mesh)[0]
  assert.equal(visibility.logicalIndex(mesh, hit.instanceId), 1)
  assert.equal(visibility.getStats().shadowSlots, 0)
})

test('screen-size LOD is exclusive, keeps logical picking and uses hysteresis across zoom changes', () => {
  const visibility = new ArrayVisibility(3)
  const high = batch(3), low = batch(3), cover = batch(3)
  low.name = 'low'
  visibility.addDetailLOD(high, low, 0.12, 18, 22)
  const batches = [cover, high, low]
  visibility.prepare(batches)
  visibility.setSlot(0, pose(0), true)
  visibility.setSlot(1, pose(1), true)
  visibility.setSlot(2, pose(0), false)
  const view = camera()
  visibility.submit(view, batches, true, 500) // 15 px -> low.
  assert.deepEqual(slotIndices(visibility, high), [])
  assert.deepEqual(slotIndices(visibility, low), [0, 1])
  assert.deepEqual(slotIndices(visibility, cover), [0, 1])
  visibility.submit(view, batches, true, 650) // 19.5 px stays low.
  assert.equal(low.count, 2)
  visibility.submit(view, batches, true, 800) // 24 px -> high.
  assert.deepEqual(slotIndices(visibility, high), [0, 1])
  assert.equal(low.count, 0)
  visibility.submit(view, batches, true, 650) // 19.5 px stays high.
  assert.equal(high.count, 2)
  visibility.setSlot(0, pose(30), true)
  visibility.submit(view, batches, true, 500)
  assert.deepEqual(slotIndices(visibility, low), [1])
  assert.equal(visibility.logicalIndex(low, 0), 1)
  assert.equal(high.count + low.count, cover.count)
})

test('occluded parts leave the GPU list and restore their picking identity when a neighbor is removed', () => {
  const visibility = new ArrayVisibility(3), part = batch(3, new THREE.BoxGeometry(0.1, 0.1, 0.1))
  const substrate = batch(3, new THREE.PlaneGeometry(3, 3), true), cover = batch(3)
  part.userData.occlusionCull = true
  visibility.setOpaqueSubstrate(substrate.geometry)
  visibility.prepare([cover, substrate, part])
  visibility.setSlot(0, pose(0, 0, 2), true); visibility.setSlot(1, pose(0), true); visibility.setSlot(2, pose(30), true)
  visibility.submit(camera(), [cover, substrate, part], true, 1080)
  assert.deepEqual(slotIndices(visibility, part), [0])
  assert.deepEqual(slotIndices(visibility, cover), [0, 1], 'transparent shells retain the existing picking surface')
  assert.deepEqual(slotIndices(visibility, substrate), [0, 1, 2], 'off-camera shadows are still submitted')
  assert.equal(visibility.getStats().occlusion.culledParts, 1)
  visibility.setSlot(0, pose(0, 0, 2), false)
  visibility.submit(camera(), [cover, substrate, part], true, 1080)
  assert.deepEqual(slotIndices(visibility, part), [1])
  assert.equal(visibility.logicalIndex(part, 0), 1)
})

test('an off-screen lower part is omitted even while its complete cassette remains visible', () => {
  const visibility = new ArrayVisibility(2)
  const part = batch(2, new THREE.BoxGeometry(0.1, 0.1, 0.1).translate(0, -2.8, 0))
  const cover = batch(2, new THREE.BoxGeometry(1, 5, 1)), substrate = batch(2, new THREE.PlaneGeometry(3, 3), true)
  part.userData.occlusionCull = true
  visibility.setOpaqueSubstrate(substrate.geometry); visibility.prepare([cover, substrate, part])
  visibility.setSlot(0, pose(0, 0, 2), true); visibility.setSlot(1, pose(1), true)
  const view = camera()
  visibility.submit(view, [cover, substrate, part], true, 1080)
  assert.equal(part.count, 0); assert.equal(cover.count, 2); assert.equal(substrate.count, 2)
  assert.equal(visibility.getStats().occlusion.outsideParts, 2)
  view.position.y = -2.8; view.lookAt(0, -2.8, 0); view.updateMatrixWorld(true)
  visibility.submit(view, [cover, substrate, part], true, 1080)
  assert.deepEqual(slotIndices(visibility, part), [0, 1], 'new camera framing restores the visible parts immediately')
})
