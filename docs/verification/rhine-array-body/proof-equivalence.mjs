import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import * as THREE from 'three';
import ts from 'typescript';
import {ArrayOcclusion} from '../../../ui/rhine/original/array-occlusion.ts';
const evidence=fileURLToPath(new URL('.',import.meta.url));
const input=process.env.PRTS_RHINE_PROOF_LAYOUT||evidence+'after/stats.json';
const root=fileURLToPath(new URL('../../../',import.meta.url));
const source=ts.transpileModule(await readFile(evidence+'baseline-array-occlusion.ts','utf8'),{
  compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext},
}).outputText.replace('from "three"',`from "file://${root}node_modules/three/build/three.module.js"`);
const {ArrayOcclusion:Previous}=await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
const report=JSON.parse(await readFile(input,'utf8'));
const rectangle=new THREE.Box3(new THREE.Vector3(-2.3940000534057617,.13100004196166992,-.03800000250339508),new THREE.Vector3(2.3940000534057617,3.5889999866485596,-.03800000250339508));
const results=[];
for(const record of report.records){
 const substrate=record.arrays.find(m=>m.name==='Optical_Diffuser'),camera=new THREE.PerspectiveCamera();
 camera.matrixAutoUpdate=false;camera.matrix.fromArray(record.arrayCamera.world);camera.updateMatrixWorld(true);
 camera.near=record.arrayCamera.near;camera.projectionMatrix.fromArray(record.arrayCamera.projection);
 const matrices=Array.from({length:substrate.count},(_,i)=>new THREE.Matrix4().fromArray(substrate.matrices,i*16));
 const active=Uint32Array.from(matrices.map((_,i)=>i));
 const before=new Previous(rectangle,matrices.length),after=new ArrayOcclusion(rectangle,matrices.length);
 before.update(camera,matrices,active,active.length,record.canvas.height);after.update(camera,matrices,active,active.length,record.canvas.height);
 let comparisons=0,hidden=0;
 for(const meta of record.stats.arrayVisibility.batches){
  const src=record.arrays.find(m=>m.name===meta.name),bounds=new THREE.Box3(new THREE.Vector3().fromArray(src.bounds.min),new THREE.Vector3().fromArray(src.bounds.max));
  for(let i=0;i<matrices.length;i++){
   const a=before.hidden(bounds,matrices[i],i),b=after.hidden(bounds,matrices[i],i);
   assert.equal(b,a,`${record.name} ${meta.name} slot ${i}`);comparisons++;if(b)hidden++;
  }
 }
 results.push({view:record.name,comparisons,hidden});
}
const result={method:'Previous eight-corner projection proof versus final OBB plane-support proof, all recorded logical matrices and all batch bounds (including unsubmitted combinations). This verifies equivalent decisions, not frame rate.',sourceBundle:report.bundle,results};
await writeFile(evidence+'proof-equivalence.json',JSON.stringify(result,null,2));console.log(results);
