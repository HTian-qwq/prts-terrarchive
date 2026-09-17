import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import * as THREE from 'three'
import ts from 'typescript'

// Keep these CPU geometry/state checks runnable without a browser or WebGL.
const source = await readFile(new URL('../ui/rhine/original/array-interior.ts', import.meta.url), 'utf8')
const threeUrl = new URL('../node_modules/three/build/three.module.js', import.meta.url).href
const compiled = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText.replace('from "three"', `from ${JSON.stringify(threeUrl)}`)
const { bakeArrayInterior, ARRAY_INTERIOR_SURFACES } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`)

async function assetSources() {
  const file = await readFile(new URL('../lib/rhine/assets/archive-cassette.glb', import.meta.url))
  let json, binary
  for (let offset = 12; offset < file.length;) {
    const size = file.readUInt32LE(offset), type = file.readUInt32LE(offset + 4)
    offset += 8
    if (type === 0x4e4f534a) json = JSON.parse(file.subarray(offset, offset + size))
    if (type === 0x004e4942) binary = file.subarray(offset, offset + size)
    offset += size
  }
  function attribute(id) {
    const accessor = json.accessors[id], view = json.bufferViews[accessor.bufferView]
    const size = { SCALAR: 1, VEC2: 2, VEC3: 3 }[accessor.type]
    const bytes = accessor.componentType === 5123 ? 2 : 4
    const values = new Float32Array(accessor.count * size)
    for (let i = 0; i < accessor.count; i++) {
      for (let c = 0; c < size; c++) {
        const at = (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0) + i * (view.byteStride ?? size * bytes) + c * bytes
        values[i * size + c] = accessor.componentType === 5126 ? binary.readFloatLE(at) : bytes === 2 ? binary.readUInt16LE(at) : binary.readUInt32LE(at)
      }
    }
    return new THREE.BufferAttribute(values, size)
  }
  return json.meshes.flatMap((mesh) => mesh.primitives).flatMap((primitive) => {
    const name = json.materials[primitive.material].name.replace(/\.\d+$/, '')
    if (!ARRAY_INTERIOR_SURFACES.has(name) && name !== 'Optical_Diffuser') return []
    const geometry = new THREE.BufferGeometry()
    for (const [key, id] of Object.entries(primitive.attributes)) {
      geometry.setAttribute({ POSITION: 'position', NORMAL: 'normal', TEXCOORD_0: 'uv' }[key], attribute(id))
    }
    geometry.setIndex(Array.from(attribute(primitive.indices).array))
    const material = new THREE.MeshStandardMaterial({ color: '#d4c7be' })
    material.name = name
    const result = new THREE.Mesh(geometry, material)
    result.userData.surface = name
    return result
  })
}

function fakeRenderer(readback = 'valid') {
  const initialTarget = new THREE.WebGLRenderTarget(37, 29)
  const state = {
    target: initialTarget, face: 2, mip: 1,
    viewport: new THREE.Vector4(3, 5, 111, 73),
    scissor: new THREE.Vector4(7, 11, 61, 47), scissorTest: true,
    color: new THREE.Color('#abcdef'), alpha: 0.4,
  }
  const renderer = {
    extensions: { has: () => true },
    capabilities: { maxTextureSize: 4096, getMaxAnisotropy: () => 8 },
    shadowMap: { enabled: true, autoUpdate: true, needsUpdate: true },
    xr: { enabled: true }, clippingPlanes: [new THREE.Plane()], localClippingEnabled: true,
    autoClear: false, autoClearColor: false, autoClearDepth: false, autoClearStencil: false,
    toneMapping: THREE.ACESFilmicToneMapping, toneMappingExposure: 1.05, outputColorSpace: THREE.SRGBColorSpace,
    getRenderTarget: () => state.target,
    getActiveCubeFace: () => state.face,
    getActiveMipmapLevel: () => state.mip,
    getViewport: (out) => out.copy(state.viewport),
    getScissor: (out) => out.copy(state.scissor),
    getScissorTest: () => state.scissorTest,
    getClearColor: (out) => out.copy(state.color),
    getClearAlpha: () => state.alpha,
    setRenderTarget(target, face = 0, mip = 0) { state.target = target; state.face = face; state.mip = mip },
    setViewport: (value) => state.viewport.copy(value),
    setScissor: (value) => state.scissor.copy(value),
    setScissorTest: (value) => { state.scissorTest = value },
    setClearColor: (color, alpha) => { state.color.set(color); state.alpha = alpha },
    render(scene, camera) {
      assert.equal(this.toneMapping, THREE.NoToneMapping)
      assert.equal(this.toneMappingExposure, 1)
      assert.equal(this.outputColorSpace, THREE.LinearSRGBColorSpace)
      assert.equal(this.shadowMap.enabled, false)
      assert.equal(scene.fog, null)
      assert.equal(state.target.texture.type, THREE.HalfFloatType)
      // No canvas-DPR viewport setter should have overwritten the RT's pixels.
      assert.deepEqual(state.target.viewport.toArray(), [0, 0, state.target.width, state.target.height])
      this.capture = { scene, camera, target: state.target }
    },
    readRenderTargetPixels(target, x, y, width, height, pixels) {
      if (readback === 'throw') throw new Error('readback failed')
      if (readback === 'silent') return
      for (let i = 0; i < pixels.length; i += 4) {
        pixels[i] = pixels[i + 1] = pixels[i + 2] = readback === 'black' ? 0 : 0x3800
        pixels[i + 3] = 0x3c00
      }
    },
  }
  function assertRestored() {
    assert.equal(state.target, initialTarget)
    assert.equal(state.face, 2); assert.equal(state.mip, 1)
    assert.deepEqual(state.viewport.toArray(), [3, 5, 111, 73])
    assert.deepEqual(state.scissor.toArray(), [7, 11, 61, 47])
    assert.equal(state.scissorTest, true)
    assert.equal(state.color.getHexString(), 'abcdef'); assert.equal(state.alpha, 0.4)
    assert.equal(renderer.toneMapping, THREE.ACESFilmicToneMapping)
    assert.equal(renderer.toneMappingExposure, 1.05)
    assert.equal(renderer.outputColorSpace, THREE.SRGBColorSpace)
    assert.deepEqual(renderer.shadowMap, { enabled: true, autoUpdate: true, needsUpdate: true })
    assert.equal(renderer.xr.enabled, true)
    assert.equal(renderer.localClippingEnabled, true)
    assert.equal(renderer.clippingPlanes.length, 1)
    for (const key of ['autoClear', 'autoClearColor', 'autoClearDepth', 'autoClearStencil']) assert.equal(renderer[key], false)
  }
  return { renderer, assertRestored }
}

test('array bake keeps the real substrate footprint and separates exterior lettering', async () => {
  const sources = await assetSources()
  const before = sources.map((mesh) => Array.from(mesh.geometry.getAttribute('position').array))
  const { renderer, assertRestored } = fakeRenderer()
  const scene = new THREE.Scene()
  scene.environment = new THREE.Texture()
  const light = new THREE.DirectionalLight(0xffffff, 1.4)
  light.position.set(-6, 14, -5); light.castShadow = true; scene.add(light)
  const result = bakeArrayInterior(renderer, scene, sources)
  assert.equal(result.stats.sourceTriangles, 19356)
  assert.equal(result.stats.bakedTriangles, 17616)
  assert.equal(result.stats.proxyTriangles, 2)
  assert.equal(result.stats.letteringTriangles, 1928)
  assert.equal(result.stats.instanceTriangles, 1930)
  assert.deepEqual([result.stats.width, result.stats.height], [1024, 740])
  const [proxy, lettering] = result.meshes
  assert.equal(proxy.name, 'Array_Interior')
  assert.equal(proxy.material.transparent, false)
  assert.equal(proxy.material.depthWrite, true)
  assert.equal(proxy.material.side, THREE.FrontSide)
  assert.equal(proxy.castShadow, false); assert.equal(proxy.receiveShadow, true)
  const position = proxy.geometry.getAttribute('position'), uv = proxy.geometry.getAttribute('uv')
  for (let i = 0; i < position.count; i++) {
    assert.ok(Math.abs(position.getX(i)) <= 2.394001)
    assert.ok(position.getY(i) >= 0.131 && position.getY(i) <= 3.589001)
    assert.ok(Math.abs(position.getZ(i) + 0.037) < 1e-6)
    assert.ok(uv.getX(i) >= 0 && uv.getX(i) <= 1 && uv.getY(i) >= 0 && uv.getY(i) <= 1)
  }
  const letters = lettering.geometry.getAttribute('position')
  for (let i = 0; i < letters.count; i++) assert.ok(letters.getZ(i) > 0.22)
  const capturedCeramic = renderer.capture.scene.children.find((mesh) => mesh.name === 'Internal_Ceramic')
  const captured = capturedCeramic.geometry.getAttribute('position')
  for (let i = 0; i < captured.count; i++) assert.ok(captured.getZ(i) <= 0.22)
  assert.equal(renderer.capture.scene.environment, scene.environment)
  assert.equal(renderer.capture.scene.children.find((object) => object.isLight).castShadow, false)
  assert.equal(light.castShadow, true)
  assert.deepEqual(sources.map((mesh) => Array.from(mesh.geometry.getAttribute('position').array)), before)
  assertRestored()
  result.dispose()
})

test('bake owns a restorable half-float data texture and never disposes original GLB resources', async () => {
  const sources = await assetSources()
  let sourceDisposals = 0
  for (const mesh of sources) {
    mesh.geometry.addEventListener('dispose', () => sourceDisposals++)
    mesh.material.addEventListener('dispose', () => sourceDisposals++)
  }
  const { renderer } = fakeRenderer()
  const result = bakeArrayInterior(renderer, new THREE.Scene(), sources)
  assert.equal(result.texture.isDataTexture, true)
  assert.equal(result.texture.isRenderTargetTexture, false)
  assert.equal(result.texture.type, THREE.HalfFloatType)
  assert.equal(result.texture.colorSpace, THREE.LinearSRGBColorSpace)
  assert.equal(result.texture.flipY, false)
  assert.equal(result.texture.generateMipmaps, true)
  assert.equal(result.texture.minFilter, THREE.LinearMipmapLinearFilter)
  assert.ok(result.texture.image.data instanceof Uint16Array)
  assert.ok(result.texture.version > 0)
  let ownedDisposals = 0
  result.texture.addEventListener('dispose', () => ownedDisposals++)
  for (const mesh of result.meshes) {
    mesh.geometry.addEventListener('dispose', () => ownedDisposals++)
    mesh.material.addEventListener('dispose', () => ownedDisposals++)
  }
  result.dispose(); result.dispose()
  assert.equal(ownedDisposals, 5)
  assert.equal(sourceDisposals, 0)
})

test('failed or silent half-float readback throws and restores renderer state for geometry fallback', async () => {
  for (const failure of ['throw', 'silent', 'black']) {
    const sources = await assetSources()
    const { renderer, assertRestored } = fakeRenderer(failure)
    assert.throws(() => bakeArrayInterior(renderer, new THREE.Scene(), sources), /readback|empty image/)
    assertRestored()
  }
})

test('oblique interior capture retains outlying detail and maps the proxy through the capture camera', async () => {
  const sources = await assetSources(), { renderer } = fakeRenderer()
  const direction = new THREE.Vector3(-0.81, 0.326, 0.487).normalize()
  const bake = bakeArrayInterior(renderer, new THREE.Scene(), sources, {
    direction, maxSize: 1536, preserveOutsideSubstrate: true, name: 'Shelf_Interior', shadowStrength: 0,
  })
  assert.equal(Math.max(bake.stats.width, bake.stats.height), 1536)
  const proxy = bake.meshes[0], camera = renderer.capture.camera
  assert.equal(proxy.name, 'Shelf_Interior')
  assert.equal(bake.stats.shadowStrength, 0)
  assert.equal(proxy.material.uniforms.arrayShadowStrength.value, 0)
  assert.equal(proxy.receiveShadow, false, 'the shelf image must not shadow its ambient lighting')
  const projected = new THREE.Vector3(), uv = proxy.geometry.attributes.uv
  for (let i = 0; i < proxy.geometry.attributes.position.count; i++) {
    projected.fromBufferAttribute(proxy.geometry.attributes.position, i).project(camera)
    assert(Math.abs(uv.getX(i) - (projected.x * 0.5 + 0.5)) < 1e-6)
    assert(Math.abs(uv.getY(i) - (projected.y * 0.5 + 0.5)) < 1e-6)
  }
  assert(bake.stats.letteringTriangles >= 1928, 'external brand lettering remains real geometry')
  assert(bake.stats.proxyTriangles === 2)
  bake.dispose()
  for (const source of sources) { source.geometry.dispose(); source.material.dispose() }
})
