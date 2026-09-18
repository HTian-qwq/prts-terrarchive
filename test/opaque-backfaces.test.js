import {test} from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import * as THREE from 'three'
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js'
import {enableOpaqueBackfaces} from '../ui/rhine/original/opaque-backfaces.ts'
import {createCassetteLOD} from '../ui/rhine/original/cassette-lod.ts'
const material=()=>new THREE.MeshPhysicalMaterial({side:THREE.DoubleSide})
test('real assets admit only closed opaque variants, retaining authored shadow sidedness',async()=>{
 const bytes=await readFile(new URL('../lib/rhine/assets/archive-cassette.glb',import.meta.url))
 const asset=await new GLTFLoader().parseAsync(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength),'');asset.scene.updateMatrixWorld(true)
 const expected=new Set(['Index_Inlay','Optical_Diffuser','Titanium_Fasteners'])
 for(const mesh of asset.scene.getObjectsByProperty('isMesh',true)){
  const name=mesh.material.name.replace(/\.\d+$/,''),g=mesh.geometry.clone().applyMatrix4(mesh.matrixWorld),m=material()
  assert.equal(enableOpaqueBackfaces(name,g,m,'full'),expected.has(name),name)
  if(expected.has(name)){assert.equal(m.side,THREE.FrontSide);assert.equal(m.shadowSide,THREE.DoubleSide)}
  const array=material();assert.equal(enableOpaqueBackfaces(name,g,array,'array'),['Ivory_Edges','Index_Inlay','Optical_Diffuser'].includes(name),name)
  if(name==='Titanium_Fasteners')assert.equal(enableOpaqueBackfaces(name,createCassetteLOD(name,g).geometry,material(),'full'),false,'open screw LOD remains double-sided')
 }
})
test('open, reversed, blended and transmissive candidates preserve their materials',()=>{
 const box=new THREE.BoxGeometry(),open=new THREE.PlaneGeometry(),inverted=box.clone()
 const indices=Array.from(inverted.index.array);for(let i=0;i<indices.length;i+=3)[indices[i],indices[i+1]]=[indices[i+1],indices[i]];inverted.setIndex(indices)
 for(const geometry of [open,inverted]){const m=material();assert.equal(enableOpaqueBackfaces('Index_Inlay',geometry,m,'full'),false);assert.equal(m.side,THREE.DoubleSide)}
 for(const config of [{transmission:.5},{transparent:true},{opacity:.5},{depthWrite:false},{blending:THREE.CustomBlending}]){
  const m=material();Object.assign(m,config);assert.equal(enableOpaqueBackfaces('Index_Inlay',box,m,'full'),false);assert.equal(m.side,THREE.DoubleSide)
 }
 const m=material();m.shadowSide=THREE.FrontSide;assert(enableOpaqueBackfaces('Index_Inlay',box,m,'full'));assert.equal(m.shadowSide,THREE.FrontSide)
})
