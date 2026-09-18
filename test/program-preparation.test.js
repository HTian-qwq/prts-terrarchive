import {test} from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {ProgramPreparation} from '../ui/rhine/original/program-preparation.ts';

function fixture({supported=true,fail=false}={}) {
 const original={name:'visible-target'},target={name:'scene-color'},properties=new Map(),programs=[],calls=[],queries=[];
 let current=original,ready=false,lost=false;
 const renderer={getRenderTarget:()=>current,getActiveCubeFace:()=>2,getActiveMipmapLevel:()=>1,
  setRenderTarget:(value,face,mip)=>{current=value;calls.push({target:value,face,mip})},
  info:{programs},properties:{get:material=>properties.get(material)},
  extensions:{get:()=>supported?{COMPLETION_STATUS_KHR:99}:null},
  getContext:()=>({isContextLost:()=>lost,LINK_STATUS:1,getProgramParameter:(program,key)=>{queries.push(key);assert(!program.deleted);if(key===1)assert(ready,'link status must wait for nonblocking completion');return key===99?ready:true}}),
  compile(root,camera){if(fail)throw Error('compile failed');const set=new Set();root.traverse(o=>{if(!o.material)return;set.add(o.material);const program={};programs.push({program});properties.set(o.material,{currentProgram:{program,getUniforms(){assert(ready)},getAttributes(){assert(ready)}}});});calls.push({materials:[...set],layers:camera.layers.mask});return set;}
 };
 return {renderer,target,original,calls,queries,get current(){return current},ready:()=>{ready=true},lose:()=>{lost=true}};
}
function meshes(){const group=new THREE.Group(),geometry=new THREE.BoxGeometry(),material=new THREE.MeshBasicMaterial({transparent:true,side:THREE.DoubleSide});material.onBeforeCompile=()=>{};material.customProgramCacheKey=()=> 'owned-hook';const mesh=new THREE.Mesh(geometry,material);const label=new THREE.Mesh(new THREE.PlaneGeometry(),new THREE.MeshBasicMaterial());label.layers.set(1);group.add(mesh,label);return {group,geometry,material,label};}

test('program preparation keeps both sides, matches pass layers and restores render target while waiting',async()=>{
 const f=fixture(),m=meshes(),warm=new ProgramPreparation(),camera=new THREE.PerspectiveCamera();let disposed=0;m.material.addEventListener('dispose',()=>disposed++);
 const promise=warm.prepare('workspace',[m.group],f.renderer,camera,new THREE.Scene(),f.target);
 assert.equal(warm.stats().workspace.status,'compiling');assert.equal(f.current,f.original);assert.equal(camera.layers.mask,1);assert.equal(m.material.side,THREE.DoubleSide);
 const passes=f.calls.filter(c=>c.materials);assert.deepEqual(passes.map(c=>c.layers),[1,2]);assert.deepEqual(passes[0].materials.map(m=>m.side),[THREE.BackSide,THREE.FrontSide]);
 for(const copy of passes[0].materials){assert.notEqual(copy,m.material);assert.equal(copy.onBeforeCompile,m.material.onBeforeCompile);assert.equal(copy.customProgramCacheKey(),m.material.customProgramCacheKey());}
 assert(!f.queries.includes(1));f.ready();await promise;assert.equal(warm.stats().workspace.status,'ready');assert.equal(warm.stats().workspace.programs,3);
 warm.dispose();assert.equal(disposed,0);assert.equal(m.group.children.length,2);assert.equal(m.group.children[0].geometry,m.geometry);
});
test('cancellation stops polling before deleted or lost-context handles can be queried',async()=>{
 const f=fixture(),m=meshes(),warm=new ProgramPreparation();const promise=warm.prepare('shelf',[m.group],f.renderer,new THREE.Camera(),new THREE.Scene(),f.target);
 const n=f.queries.length;warm.invalidate();await promise;assert.equal(f.queries.length,n);assert.deepEqual(warm.stats(),{});
 const second=warm.prepare('restored',[m.group],f.renderer,new THREE.Camera(),new THREE.Scene(),f.target);f.lose();await second;assert.equal(warm.stats().restored.status,'cancelled');warm.dispose();
});
test('unsupported parallel compilation is reported without a blocking link query',async()=>{
 const f=fixture({supported:false}),warm=new ProgramPreparation();await warm.prepare('shelf',[meshes().group],f.renderer,new THREE.Camera(),new THREE.Scene(),f.target);
 assert.equal(warm.stats().shelf.status,'unsupported');assert.deepEqual(f.queries,[]);assert.equal(f.current,f.original);warm.dispose();
});
test('compile failure restores the target and remains observable',async()=>{
 const f=fixture({fail:true}),warm=new ProgramPreparation();await assert.rejects(warm.prepare('shelf',[meshes().group],f.renderer,new THREE.Camera(),new THREE.Scene(),f.target),/compile failed/);
 assert.equal(f.current,f.original);assert.equal(warm.stats().shelf.status,'failed');warm.dispose();
});
