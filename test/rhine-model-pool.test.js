import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import * as THREE from 'three'

const packageRequire = createRequire(new URL('../package.json', import.meta.url))
const viteRequire = createRequire(packageRequire.resolve('vite/package.json'))
const { build } = await import(pathToFileURL(viteRequire.resolve('esbuild')).href)

// Exercise the production methods/material controller without constructing a
// WebGL context. External Three imports preserve instanceof and texture identity.
const { outputFiles } = await build({
  stdin: {
    resolveDir: fileURLToPath(new URL('../', import.meta.url)),
    contents: `export { ArchiveScene } from './ui/rhine/original/scene.ts';
      export { ArchiveLabelRenderer } from './ui/rhine/original/label-renderer.ts';
      export { CardAppearance } from './ui/rhine/original/appearance.ts';
      export { ShelfInterior } from './ui/rhine/original/shelf-interior.ts';
      export { ARCHIVE_LABEL_NAME } from './ui/rhine/original/archive-label.ts';`,
  },
  bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2022',
  plugins: [{
    name: 'native-three-and-asset-urls',
    setup(builder) {
      builder.onResolve({ filter: /^three(?:\/|$)/ }, args => ({ path: import.meta.resolve(args.path), external: true }))
      builder.onResolve({ filter: /\?url$/ }, args => ({ path: args.path, namespace: 'asset-url' }))
      builder.onLoad({ filter: /.*/, namespace: 'asset-url' }, args => ({ contents: `export default ${JSON.stringify(args.path)}` }))
    },
  }],
})
const { ArchiveScene, CardAppearance, ShelfInterior, ARCHIVE_LABEL_NAME, ArchiveLabelRenderer } = await import(
  `data:text/javascript;base64,${Buffer.from(outputFiles[0].contents).toString('base64')}`,
)

class FakeCanvas {
  width = 0
  height = 0
  paints = 0
  text = []
  context = {
    setTransform: () => {},
    clearRect: () => { this.paints++; this.text = [] },
    fillRect: () => {},
    fillText: (text, x, y) => { this.text.push({ text, x, y }) },
    drawImage: () => {},
    measureText: text => ({ width: Array.from(text).length * 100 }),
  }
  getContext(type) { assert.equal(type, '2d'); return this.context }
}

const oldDocument = Object.getOwnPropertyDescriptor(globalThis, 'document')
const oldCanvas = Object.getOwnPropertyDescriptor(globalThis, 'HTMLCanvasElement')
Object.defineProperty(globalThis, 'document', { configurable: true, value: {
  createElement(tag) { assert.equal(tag, 'canvas'); return new FakeCanvas() },
  fonts: { status: 'loaded' },
} })
Object.defineProperty(globalThis, 'HTMLCanvasElement', { configurable: true, value: FakeCanvas })
after(() => {
  if (oldDocument) Object.defineProperty(globalThis, 'document', oldDocument)
  else delete globalThis.document
  if (oldCanvas) Object.defineProperty(globalThis, 'HTMLCanvasElement', oldCanvas)
  else delete globalThis.HTMLCanvasElement
})

function fixture(t) {
  const instance = Object.create(ArchiveScene.prototype)
  const model = new THREE.Group()
  const appearance = new CardAppearance()
  const palettes = []
  function surface(name, highOptions, lowOptions) {
    const high = new THREE.MeshPhysicalMaterial(highOptions)
    const low = lowOptions ? new THREE.MeshPhysicalMaterial(lowOptions) : undefined
    palettes.push(high, ...(low ? [low] : []))
    appearance.register(name, high, low)
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 3.7, 0.25), high)
    mesh.userData.surface = name
    model.add(mesh)
  }
  surface('Frosted_Polymer', { color: '#fffdfa', transmission: 0.9, roughness: 0.025, thickness: 0.12, attenuationDistance: 2 },
    { color: '#fffdfa', transmission: 0.985, roughness: 0.025, thickness: 0.018, attenuationDistance: 8 })
  surface('Ivory_Edges', { color: '#f0e7df', transmission: 0.65, roughness: 0.31 },
    { color: '#fff5e9', transmission: 0, roughness: 0.38 })
  surface('Internal_Ceramic', { color: '#c7beb6', roughness: 0.6 })
  const labelCanvas = new FakeCanvas()
  labelCanvas.width = 1024; labelCanvas.height = 440
  const labelTexture = new THREE.CanvasTexture(labelCanvas)
  const label = new THREE.Mesh(new THREE.PlaneGeometry(0.99, 0.46), new THREE.MeshBasicMaterial({ map: labelTexture, transparent: true }))
  label.name = ARCHIVE_LABEL_NAME
  label.position.set(-1.36, 3.04, 0.255)
  model.add(label)
  appearance.prepare(model); appearance.apply(model, 1); appearance.setClarity(model, 1)
  const calls = { uploads: [], rendererDisposals: 0, lostContexts: 0, removedCanvases: 0, composerDisposals: 0, passDisposals: 0 }
  const scene = new THREE.Scene()
  scene.add(model)
  Object.assign(instance, {
    model, appearance, scene, labelCanvas, labelTexture, labelMark: {}, labelRenderer: new ArchiveLabelRenderer(),
    archiveLabel: null, paintedArchiveLabel: '', quality: { anisotropy: 4 },
    collectionPools: { moving: [], shelf: [] }, collectionKinds: new WeakMap(),
    pooledCollections: new Set(), collectionCreated: 0, collectionReused: 0,
    decryption: { clarity: 1 }, disposed: false,
    renderer: {
      capabilities: { getMaxAnisotropy: () => 8 },
      initTexture: texture => calls.uploads.push(texture),
      dispose: () => calls.rendererDisposals++,
      forceContextLoss: () => calls.lostContexts++,
      domElement: { remove: () => calls.removedCanvases++ },
    },
    events: new AbortController(), investigationSlots: new Map(), investigationPoses: new Map(),
    arrayInteriorInstances: [], arrayInteriorSources: [], light: new THREE.DirectionalLight(),
    composer: { passes: [{ dispose: () => calls.passDisposals++ }], dispose: () => calls.composerDisposals++ },
    looping: true, loaded: true, selectedCell: { lane: 2, row: 12 }, selectedSlot: 76,
    lift: { value: 0.4, velocity: 0 }, rotation: 0, returnY: null,
    clock: 1, outgoing: [], pulses: [], deferSelectionPulse: false,
  })
  instance.drawLabel()
  t.after(() => { instance.dispose(); palettes.forEach(material => material.dispose()) })
  return { instance, calls, model }
}

const surface = (group, name) => group.children.find(mesh => mesh.userData.surface === name)
const label = group => group.getObjectByName(ARCHIVE_LABEL_NAME)
const map = group => label(group).material.map
const printedCode = group => map(group).image.text.find(call => /^(NO\.\d+|ARCHIVE|READING)$/.test(call.text))?.text
function disposals(resource) {
  let count = 0
  resource.addEventListener('dispose', () => count++)
  return () => count
}

test('moving reuse retains its owned materials/canvas and resets the previous source state', t => {
  const { instance } = fixture(t)
  const file = instance.createCollectionFile(0)
  const materials = file.children.map(mesh => mesh.material)
  const texture = map(file)
  const clarity = surface(file, 'Frosted_Polymer').userData.glassClarity
  assert.equal(printedCode(file), 'NO.001')
  instance.appearance.apply(file, 0.1); instance.appearance.setClarity(file, 0.2)
  file.userData.sourceId = 'previous-source'
  file.position.set(6, 7, 8); file.rotation.set(0.2, 0.5, 0.7); file.scale.setScalar(0.3)
  instance.disposeCollectionFile(file)
  const reused = instance.createCollectionFile(11)
  assert.equal(reused, file)
  assert.deepEqual(reused.children.map(mesh => mesh.material), materials)
  assert.equal(map(reused), texture)
  assert.equal(surface(reused, 'Frosted_Polymer').userData.glassClarity, clarity)
  assert.equal(clarity.value, 1)
  assert.equal(surface(reused, 'Frosted_Polymer').userData.appearance.value, 1)
  assert.equal(label(reused).material.opacity, 1)
  assert.equal(reused.userData.sourceId, undefined)
  assert.deepEqual(reused.position.toArray(), [0, 0, 0])
  assert.deepEqual(reused.scale.toArray(), [1, 1, 1])
  assert.ok(reused.quaternion.equals(new THREE.Quaternion()))
  assert.equal(reused.visible, true)
  assert.equal(printedCode(reused), 'NO.012')
  assert.equal(texture.anisotropy, 8)
  const paints = texture.image.paints, version = texture.version
  instance.disposeCollectionFile(reused)
  assert.equal(instance.createCollectionFile(11), file)
  assert.equal(texture.image.paints, paints)
  assert.equal(texture.version, version, 'same plate number avoids repaint/upload invalidation')
  instance.disposeCollectionFile(file)
})

test('concurrent labels/uniforms are independent and shelf borders never enter the moving pool', t => {
  const { instance, model } = fixture(t)
  const first = instance.createCollectionFile(0)
  const second = instance.createCollectionFile(1)
  const shelf = instance.createCollectionFile(2, { shelf: true })
  for (const other of [second, shelf, model]) {
    assert.notEqual(map(first), map(other))
    assert.notEqual(map(first).image, map(other).image)
    for (const name of ['Frosted_Polymer', 'Ivory_Edges', 'Internal_Ceramic']) {
      assert.notEqual(surface(first, name).material, surface(other, name).material)
      assert.notEqual(surface(first, name).userData.appearance, surface(other, name).userData.appearance)
      assert.notEqual(surface(first, name).userData.glassClarity, surface(other, name).userData.glassClarity)
    }
  }
  instance.appearance.setClarity(first, 0)
  assert.equal(surface(second, 'Frosted_Polymer').userData.glassClarity.value, 1)
  assert.equal(surface(shelf, 'Frosted_Polymer').userData.glassClarity.value, 1)
  instance.setCollectionLabel(second, 36)
  assert.equal(printedCode(first), 'NO.001')
  assert.equal(printedCode(second), 'NO.037')
  assert.equal(surface(shelf, 'Ivory_Edges').material.transmission, 0)
  assert.equal(surface(first, 'Ivory_Edges').material.transmission, 0.65)
  assert.equal(surface(model, 'Ivory_Edges').userData.useArrayMaterial, undefined)
  instance.disposeCollectionFile(first); instance.disposeCollectionFile(second); instance.disposeCollectionFile(shelf)
  const movingAgain = instance.createCollectionFile(9)
  const shelfAgain = instance.createCollectionFile(8, { shelf: true })
  assert.equal(shelfAgain, shelf)
  assert.notEqual(movingAgain, shelf)
  assert.equal(surface(movingAgain, 'Ivory_Edges').userData.useArrayMaterial, undefined)
  assert.equal(surface(shelfAgain, 'Ivory_Edges').material.transmission, 0)
  assert.equal(printedCode(shelfAgain), 'NO.009')
  instance.disposeCollectionFile(movingAgain); instance.disposeCollectionFile(shelfAgain)
})

test('recycling removes source markers and disposes their materials without freeing shared geometry', t => {
  const { instance, model } = fixture(t)
  const file = instance.createCollectionFile(0, { shelf: true })
  const sharedBox = new THREE.BoxGeometry()
  const markerMaterials = [new THREE.MeshStandardMaterial(), new THREE.MeshStandardMaterial()]
  const markerDisposals = markerMaterials.map(disposals)
  const boxDisposals = disposals(sharedBox)
  const geometryDisposals = model.children.map(mesh => disposals(mesh.geometry))
  const textureDisposals = disposals(map(file))
  const markers = markerMaterials.map(material => new THREE.Mesh(sharedBox, material))
  file.add(...markers); file.userData.sourceId = 'old'
  instance.scene.add(file)
  instance.disposeCollectionFile(file)
  instance.disposeCollectionFile(file)
  assert.equal(file.parent, null)
  assert.equal(file.userData.sourceId, undefined)
  assert.equal(file.children.length, model.children.length)
  assert.ok(markers.every(marker => marker.parent === null))
  assert.deepEqual(markerDisposals.map(count => count()), [1, 1])
  assert.equal(boxDisposals(), 0)
  assert.ok(geometryDisposals.every(count => count() === 0))
  assert.equal(textureDisposals(), 0)
  const next = instance.createCollectionFile(21, { shelf: true })
  assert.equal(next, file)
  assert.equal(printedCode(next), 'NO.022')
  instance.disposeCollectionFile(next)
  instance.dispose()
  assert.equal(textureDisposals(), 1)
  assert.ok(geometryDisposals.every(count => count() === 1))
  assert.equal(boxDisposals(), 0, 'adapter retains ownership of its marker/rack box')
  sharedBox.dispose()
})

test('idle pools are bounded and final dispose frees pooled and scene-owned resources once', t => {
  const { instance, calls, model } = fixture(t)
  const moving = Array.from({ length: 6 }, (_, index) => instance.createCollectionFile(index))
  const shelf = Array.from({ length: 26 }, (_, index) => instance.createCollectionFile(index, { shelf: true }))
  const resources = [...moving, ...shelf].map(file => ({
    file, texture: disposals(map(file)), materials: file.children.map(mesh => disposals(mesh.material)),
  }))
  const sharedGeometry = model.children.map(mesh => disposals(mesh.geometry))
  moving.forEach(file => instance.disposeCollectionFile(file))
  shelf.forEach(file => instance.disposeCollectionFile(file))
  assert.equal(instance.collectionPools.moving.length, 4)
  assert.equal(instance.collectionPools.shelf.length, 24)
  assert.equal(instance.pooledCollections.size, 28)
  for (const resource of resources) {
    const kept = instance.pooledCollections.has(resource.file)
    assert.equal(resource.texture(), kept ? 0 : 1)
    assert.ok(resource.materials.every(count => count() === (kept ? 0 : 1)))
  }
  assert.ok(sharedGeometry.every(count => count() === 0))
  const active = instance.createCollectionFile(39)
  instance.scene.add(active)
  instance.dispose(); instance.dispose()
  assert.equal(instance.pooledCollections.size, 0)
  assert.equal(instance.collectionPools.moving.length, 0)
  assert.equal(instance.collectionPools.shelf.length, 0)
  assert.ok(resources.every(resource => resource.texture() === 1 && resource.materials.every(count => count() === 1)))
  assert.ok(sharedGeometry.every(count => count() === 1))
  assert.equal(calls.rendererDisposals, 1)
  assert.equal(calls.lostContexts, 1)
  assert.equal(calls.removedCanvases, 1)
  assert.equal(calls.composerDisposals, 1)
  assert.equal(calls.passDisposals, 1)
})

test('moving preparation fills a small reserve and returns ownership even if texture upload fails', t => {
  const { instance, calls } = fixture(t)
  for (let index = 0; index < 5; index++) instance.prepareMovingFile()
  assert.equal(instance.collectionCreated, 3)
  assert.equal(instance.collectionPools.moving.length, 3)
  assert.equal(calls.uploads.length, 3)
  assert.equal(new Set(calls.uploads).size, 3)
  const active = instance.createCollectionFile(11)
  assert.ok(calls.uploads.includes(map(active)))
  assert.equal(instance.collectionCreated, 3)
  assert.equal(instance.collectionReused, 1)
  instance.prepareMovingFile()
  assert.equal(instance.collectionCreated, 4)
  assert.equal(instance.collectionPools.moving.length, 3)
  instance.disposeCollectionFile(active)
  instance.prepareMovingFile()
  assert.equal(instance.collectionCreated, 4)

  const failing = fixture(t).instance
  failing.renderer.initTexture = () => { throw new Error('GPU upload failed') }
  assert.throws(() => failing.prepareMovingFile(), /GPU upload failed/)
  assert.equal(failing.collectionPools.moving.length, 1)
  assert.equal(failing.pooledCollections.size, 1)
  failing.dispose()
  failing.prepareMovingFile()
  assert.equal(failing.collectionCreated, 1)
})

test('returning copies retain the original plate and authored pose when the selected file changes', t => {
  const { instance, model } = fixture(t)
  instance.setArchiveLabel('NO.012')
  const paints = instance.labelCanvas.paints
  instance.setArchiveLabel('NO.012')
  assert.equal(instance.labelCanvas.paints, paints)
  model.position.set(2, 3, 4); model.rotation.set(0.1, 0.2, 0.3)
  instance.select(17)
  assert.equal(instance.outgoing.length, 1)
  const returning = instance.outgoing[0].group
  assert.equal(printedCode(returning), 'NO.012')
  assert.notEqual(map(returning), map(model))
  assert.ok(returning.position.equals(model.position))
  assert.ok(returning.quaternion.equals(model.quaternion))
  instance.setArchiveLabel('NO.013')
  assert.equal(printedCode(model), 'NO.013')
  assert.equal(printedCode(returning), 'NO.012')
  instance.select(16)
  assert.equal(instance.outgoing.length, 0)
  assert.ok(instance.pooledCollections.has(returning))
  instance.setArchiveLabel('NO.040')
  const reused = instance.createCollectionFile(null, { returning: true })
  assert.equal(reused, returning)
  assert.equal(printedCode(reused), 'NO.040')
  instance.setArchiveLabel('NO.001')
  assert.equal(printedCode(reused), 'NO.040')
  instance.disposeCollectionFile(reused)
})

test('shelf proxies switch before motion, retain the shell and survive recycling with shared ownership', t => {
  const { instance } = fixture(t)
  const geometry = new THREE.PlaneGeometry(4, 3), material = new THREE.MeshBasicMaterial()
  const proxy = new THREE.Mesh(geometry, material)
  proxy.name = 'Shelf_Interior'; proxy.userData.surface = 'Shelf_Interior'
  const geometryDisposals = disposals(geometry), materialDisposals = disposals(material)
  let disposed = false
  const interior = Object.create(ShelfInterior.prototype)
  Object.assign(interior, {
    files: new Map(), eye: new THREE.Vector3(), center: new THREE.Vector3(),
    bake: { meshes: [proxy], stats: {}, dispose() {
      if (disposed) return
      disposed = true; geometry.dispose(); material.dispose()
    } },
  })
  instance.shelfInterior = interior
  const first = instance.createCollectionFile(0, { shelf: true })
  const second = instance.createCollectionFile(1, { shelf: true })
  instance.scene.add(first, second)
  const cover = surface(first, 'Frosted_Polymer'), full = surface(first, 'Internal_Ceramic')
  const clone = first.getObjectByName('Shelf_Interior')
  const camera = new THREE.PerspectiveCamera(30, 16 / 9, 0.1, 1000)
  camera.position.set(-179, 72.85, 100); camera.lookAt(0, 1.85, 0); camera.updateMatrixWorld(true)
  interior.update(first, false, camera, 1080); interior.update(second, false, camera, 1080)
  assert.equal(first.userData.shelfRepresentation, 'texture')
  assert.equal(full.visible, false); assert.equal(clone.visible, true)
  assert.equal(cover.visible, true); assert.equal(label(first).visible, true)
  assert.equal(clone.geometry, second.getObjectByName('Shelf_Interior').geometry)
  assert.equal(clone.material, second.getObjectByName('Shelf_Interior').material)
  instance.appearance.apply(first, 0.2)
  assert.equal(material.opacity, 1, 'shared proxy must not acquire the selected file opacity')
  interior.update(first, true, camera, 1080)
  assert.equal(first.userData.shelfRepresentation, 'geometry')
  assert.equal(full.visible, true); assert.equal(clone.visible, false)
  assert.equal(second.userData.shelfRepresentation, 'texture')
  interior.update(first, false, camera, 1080)
  assert.equal(first.userData.shelfRepresentation, 'texture')
  camera.position.set(0, 1.85, 8); camera.lookAt(0, 1.85, 0); camera.updateMatrixWorld(true)
  interior.update(first, false, camera, 1080)
  assert.equal(first.userData.shelfRepresentation, 'geometry', 'inspection angle restores true parallax')
  camera.position.set(0, 1.85, -8); camera.lookAt(0, 1.85, 0); camera.updateMatrixWorld(true)
  interior.update(first, false, camera, 1080)
  assert.equal(first.userData.shelfRepresentation, 'geometry', 'rear views cannot show a front-only image')
  instance.disposeCollectionFile(first)
  const reused = instance.createCollectionFile(11, { shelf: true })
  assert.equal(reused, first); assert.equal(reused.getObjectByName('Shelf_Interior'), clone)
  assert.equal(printedCode(reused), 'NO.012')
  assert.equal(instance.collectionCreated, 2)
  instance.disposeCollectionFile(reused); instance.disposeCollectionFile(second)
  assert.equal(geometryDisposals(), 0); assert.equal(materialDisposals(), 0)
  instance.dispose()
  assert.equal(geometryDisposals(), 1); assert.equal(materialDisposals(), 1)
  assert.equal(first.getObjectByName('Shelf_Interior'), undefined)
  assert.equal(full.visible, true)
})


test('document titles follow identity updates without new textures and returns preserve the previous title', t => {
  const { instance, model } = fixture(t)
  const first = { code: 'NO.012', title: '阿米娅 / 干员语音', sourceId: 'source-12' }
  instance.setArchiveLabel(first)
  const texture = map(model), paints = texture.image.paints
  instance.setArchiveLabel({ ...first })
  assert.equal(texture.image.paints, paints)
  instance.select(17)
  const returning = instance.outgoing[0].group
  instance.setArchiveLabel({ code: 'NO.013', title: '切尔诺伯格事件', sourceId: 'source-13' })
  assert.deepEqual(label(returning).userData.archiveLabel, first)
  assert.equal(label(model).userData.archiveLabel.sourceId, 'source-13')
  assert(map(returning).image.text.some(call => call.text === '阿米娅'))
  assert(map(returning).image.text.some(call => call.text === '干员语音'))
  const titleCalls = map(returning).image.text.filter(call => ['阿米娅', '/', '干员语音'].includes(call.text))
  assert.equal(new Set(titleCalls.map(call => call.y)).size, 1, 'name and document type share the exposed line')
  assert(titleCalls.every(call => call.y < 714 * 0.35), 'the category stays in the upper visible strip')
  assert.equal(map(model), texture)
  const file = instance.createCollectionFile(0, { shelf: true })
  instance.setCollectionLabel(file, 0, { title: '旧资料', sourceId: 'one' })
  const owned = map(file), before = owned.image.paints
  instance.setCollectionLabel(file, 0, { title: '资料修订标题', sourceId: 'one' })
  assert.equal(owned.image.paints, before + 1)
  assert.equal(map(file), owned)
  assert(!owned.image.text.some(call => call.text === '旧资料'))
  instance.disposeCollectionFile(file)
  const reused = instance.createCollectionFile(2, { shelf: true, label: { code: 'NO.003', title: '另一份资料', sourceId: 'three' } })
  assert.equal(reused, file)
  assert.equal(label(reused).userData.archiveLabel.sourceId, 'three')
  assert.equal(map(reused), owned)
  instance.disposeCollectionFile(reused)
})
