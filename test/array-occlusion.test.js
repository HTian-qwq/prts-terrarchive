import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as THREE from 'three'
import { ArrayOcclusion, substrateRectangle } from '../ui/rhine/original/array-occlusion.ts'

const rectangle = new THREE.Box3(new THREE.Vector3(-2, -2, 0), new THREE.Vector3(2, 2, 0))
const small = new THREE.Box3(new THREE.Vector3(-0.2, -0.2, -0.1), new THREE.Vector3(0.2, 0.2, 0.1))
const pose = (x, y, z, angle = 0) => new THREE.Matrix4().compose(new THREE.Vector3(x, y, z),
  new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), angle), new THREE.Vector3(1, 1, 1))
function camera(perspective = true) {
  const camera = perspective ? new THREE.PerspectiveCamera(50, 1.5, 0.1, 100)
    : new THREE.OrthographicCamera(-5, 5, 5, -5, 0.1, 100)
  camera.position.set(0, 0, 10); camera.lookAt(0, 0, 0); camera.updateMatrixWorld(true)
  return camera
}

test('whole-part proof keeps exposed edges, front surfaces and the hole left by a removed neighbor', () => {
  for (const perspective of [true, false]) {
    const view = camera(perspective), occlusion = new ArrayOcclusion(rectangle, 3)
    const matrices = [pose(0, 0, 2), pose(0, 0, 0), pose(2, 0, 0)]
    occlusion.update(view, matrices, new Uint32Array([0, 1]), 2, 1080)
    assert.equal(occlusion.hidden(small, matrices[1], 1), true)
    assert.equal(occlusion.hidden(small, pose(0, 0, 3), 1), false, 'nothing in front of the opaque plane is hidden')
    assert.equal(occlusion.hidden(small, pose(2.6, 0, 0), 1), false, 'a partly exposed edge must survive')
    assert.equal(occlusion.hidden(rectangle, pose(1, 0, 0), 1), false, 'covered center does not prove a covered box')
    occlusion.update(view, matrices, new Uint32Array([1]), 1, 1080)
    assert.equal(occlusion.hidden(small, matrices[1], 1), false, 'removing the neighbor restores the part in this update')
    occlusion.update(view, matrices, new Uint32Array([0, 1]), 2, 1080)
    assert.equal(occlusion.hidden(small, matrices[1], 1), true)
    matrices[0] = pose(0, 5, 2)
    occlusion.update(view, matrices, new Uint32Array([0, 1]), 2, 1080)
    assert.equal(occlusion.hidden(small, matrices[1], 1), false, 'raising the neighbor uncovers the part')
  }
})

test('near clipping, missing pixel dimensions and grazing occluders fall back to visible geometry', () => {
  const view = camera(), occlusion = new ArrayOcclusion(rectangle, 2)
  const active = new Uint32Array([0])
  occlusion.update(view, [pose(0, 0, 9.95)], active, 1, 1080)
  assert.equal(occlusion.hidden(small, pose(0, 0, 0), 1), false)
  occlusion.update(view, [pose(0, 0, 2)], active, 1, 0)
  assert.equal(occlusion.hidden(small, pose(0, 0, 0), 1), false)
  occlusion.update(view, [pose(0, 0, 2, Math.PI / 2)], active, 1, 1080)
  assert.equal(occlusion.hidden(small, pose(0, 0, 0), 1), false)
})

test('oblique, rotated candidate boxes rejected by the proof are covered along every sampled camera ray', () => {
  const material = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide })
  const occluder = new THREE.Mesh(new THREE.PlaneGeometry(4, 4), material)
  occluder.matrixAutoUpdate = false; occluder.matrix.copy(pose(0, 0, 2, 0.12)); occluder.updateMatrixWorld(true)
  const culling = new ArrayOcclusion(rectangle, 2), ray = new THREE.Raycaster(), point = new THREE.Vector3(), eye = new THREE.Vector3()
  let hidden = 0, samples = 0
  for (const perspective of [true, false]) for (const x of [-6, -2, 0, 3, 7]) {
    const view = camera(perspective); view.position.x = x; view.position.y = 2; view.lookAt(0, 0, 0); view.updateMatrixWorld(true)
    eye.copy(view.position)
    culling.update(view, [occluder.matrix], new Uint32Array([0]), 1, 1080)
    for (let i = -10; i <= 10; i++) for (const y of [-1, 0, 1]) {
      const candidate = pose(i * 0.28, y, -1, i * 0.16)
      if (!culling.hidden(small, candidate, 1)) continue
      hidden++
      for (let corner = 0; corner < 8; corner++) {
        point.set(corner & 1 ? small.max.x : small.min.x, corner & 2 ? small.max.y : small.min.y,
          corner & 4 ? small.max.z : small.min.z).applyMatrix4(candidate)
        if (perspective) ray.set(eye, point.clone().sub(eye).normalize())
        else {
          const projected = point.clone().project(view)
          ray.setFromCamera(new THREE.Vector2(projected.x, projected.y), view)
        }
        const hit = ray.intersectObject(occluder)[0]
        assert(hit, 'every discarded box corner must have an opaque hit')
        assert(hit.distance < ray.ray.origin.distanceTo(point) - 0.01)
        samples++
      }
    }
  }
  assert(hidden > 40); assert(samples > 320)
  occluder.geometry.dispose(); material.dispose()
})

test('only two triangles sharing a rectangle diagonal can define an opaque substrate', () => {
  const valid = new THREE.PlaneGeometry(4, 3)
  assert(substrateRectangle(valid))
  const incomplete = valid.clone(); incomplete.setIndex([0, 2, 1])
  assert.equal(substrateRectangle(incomplete), undefined)
  const overlapping = valid.clone(); overlapping.setIndex([0, 2, 1, 0, 2, 3])
  assert.equal(substrateRectangle(overlapping), undefined)
  valid.dispose(); incomplete.dispose(); overlapping.dispose()
})
