import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { shelfSlot, shelfReadingPath, SHELF_WITHDRAW_END, SHELF_WIDTH, SHELF_DEPTH, SHELF_LEVEL_SPACING, SHELF_HEIGHT } from '../ui/rhine/shelf-layout.ts';

const bytes = await readFile(new URL('../lib/rhine/assets/archive-cassette.glb', import.meta.url));
const gltf = await new GLTFLoader().parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), '');
const cassette = new THREE.Box3().setFromObject(gltf.scene, true);
// The shelf marker protrudes slightly beyond the authored shell.
cassette.max.z = Math.max(cassette.max.z, 0.3125);
const bounds = (position, yaw = 0) => cassette.clone().applyMatrix4(new THREE.Matrix4().compose(
  new THREE.Vector3(position.x, position.y, position.z), new THREE.Quaternion().setFromEuler(new THREE.Euler(0, yaw, 0)), new THREE.Vector3(1, 1, 1)));
const part = (x, y, z, w, h, d) => new THREE.Box3().setFromCenterAndSize(new THREE.Vector3(x,y,z), new THREE.Vector3(w,h,d));
const frame = [];
for (const level of [0, 1]) {
  const y = level * SHELF_LEVEL_SPACING;
  frame.push(part(0,y+0.12,0,SHELF_WIDTH,0.24,SHELF_DEPTH),
    part(-SHELF_WIDTH/2,y+0.20,0,0.14,0.12,SHELF_DEPTH),
    part(SHELF_WIDTH/2,y+0.7,0,0.14,1.1,SHELF_DEPTH));
  for (const z of [-SHELF_DEPTH/2,SHELF_DEPTH/2]) frame.push(part(0,y+0.4,z,SHELF_WIDTH,0.55,0.14));
}
for (const x of [-SHELF_WIDTH/2-0.12,SHELF_WIDTH/2+0.12]) for (const z of [-SHELF_DEPTH/2,SHELF_DEPTH/2])
  frame.push(part(x,SHELF_HEIGHT/2,z,0.16,SHELF_HEIGHT,0.16));

test('every full-rack slot clears neighbours and both trays throughout extraction and rotation', () => {
  for (let index=0; index<24; index++) {
    const obstacles = [...frame, ...Array.from({length:24},(_,i)=>i).filter(i=>i!==index).map(i=>bounds(shelfSlot(i)))];
    for (let step=0; step<=200; step++) {
      const progress = step/200;
      const pose = shelfReadingPath(index,progress,1);
      if (progress<SHELF_WITHDRAW_END) {
        assert.equal(pose.y,shelfSlot(index).y);
        assert.equal(pose.z,shelfSlot(index).z);
        assert.equal(pose.turn,0,'no tilt or turn inside a occupied slot');
      }
      for (const yaw of [0, Math.PI/2, Math.PI, -Math.PI/2]) {
        const box=bounds(pose,yaw*pose.turn);
        assert(!obstacles.some(obstacle=>box.intersectsBox(obstacle)),`collision: slot=${index}, p=${progress}, yaw=${yaw}`);
      }
    }
  }
});

test('all pages share the safe reading station and a continuous withdrawal handoff', () => {
  for(let index=0;index<335;index++) {
    const target=shelfReadingPath(index,1), reference=shelfReadingPath(0,1);
    assert(Math.hypot(target.x-reference.x,target.y-reference.y,target.z-reference.z)<1e-12);
    const left=shelfReadingPath(index,SHELF_WITHDRAW_END-1e-5,1);
    const right=shelfReadingPath(index,SHELF_WITHDRAW_END+1e-5,1);
    assert(Math.hypot(left.x-right.x,left.y-right.y,left.z-right.z)<1e-8);
  }
});
