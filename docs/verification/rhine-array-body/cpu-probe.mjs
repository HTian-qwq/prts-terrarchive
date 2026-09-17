import * as THREE from 'three';
import ts from 'typescript';
import {readFile,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../../../',import.meta.url)).replace(/\/$/,'');
const evidence=fileURLToPath(new URL('.',import.meta.url));
let oldHelper=ts.transpileModule(await readFile(evidence+'baseline-array-occlusion.ts','utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText.replace('from "three"',`from "file://${root}/node_modules/three/build/three.module.js"`);
oldHelper=`data:text/javascript;base64,${Buffer.from(oldHelper).toString('base64')}`;
async function moduleAt(path){let src=ts.transpileModule(await readFile(path,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText;src=src.replace('from "three"',`from "file://${root}/node_modules/three/build/three.module.js"`).replace('from "./array-occlusion.ts"',`from "${path.endsWith("baseline-array-visibility.ts")?oldHelper:`file://${root}/ui/rhine/original/array-occlusion.ts`}"`);return import(`data:text/javascript;base64,${Buffer.from(src).toString('base64')}`);}
const before=(await moduleAt(evidence+'baseline-array-visibility.ts')).ArrayVisibility;
const after=(await moduleAt(root+'/ui/rhine/original/array-visibility.ts')).ArrayVisibility;
const reports=JSON.parse(await readFile(evidence+'cpu-layouts.json','utf8'));
function setup(Type,record,enabled){
 const source=record.arrays.find(m=>m.name==='Optical_Diffuser');const v=new Type(288),batches=record.stats.arrayVisibility.batches.map(meta=>{
  const src=record.arrays.find(m=>m.name===meta.name),min=new THREE.Vector3().fromArray(src.bounds.min),max=new THREE.Vector3().fromArray(src.bounds.max),size=max.clone().sub(min),center=max.clone().add(min).multiplyScalar(.5);
  const geo=new THREE.BoxGeometry(size.x,size.y,size.z).translate(center.x,center.y,center.z);geo.computeBoundingBox();
  const mesh=new THREE.InstancedMesh(geo,new THREE.MeshBasicMaterial(),288);mesh.name=meta.name;mesh.castShadow=meta.castShadow;
  mesh.userData.occlusionCull=(mesh.name.includes('_Bottom')||mesh.name.startsWith('Array_Interior_Lettering')||enabled&&(mesh.name.includes('_Region_')||mesh.name.endsWith('_Spanning')));return mesh;
 });
 for(const low of batches.filter(m=>m.name.endsWith('_LOD1'))){const high=batches.find(m=>m.name===low.name.replace(/_LOD1$/,''));const lettering=low.name.startsWith('Array_Interior_Lettering');v.addDetailLOD(high,low,lettering?.43:.12,lettering?64:18,lettering?72:22);}
 v.setOpaqueSubstrate(new THREE.PlaneGeometry(4.788000106811523,3.4579999446868896).translate(0,1.8600000143051147,-.03800000250339508));
 for(const lod of v.detailLODs)if(record.stats.arrayVisibility.lod.find(item=>item.name===lod.high.name)?.high===0)lod.levels.fill(1);
 v.prepare(batches);for(let i=0;i<source.count;i++)v.setSlot(i,new THREE.Matrix4().fromArray(source.matrices,i*16),true);
 const c=record.arrayCamera,cam=new THREE.PerspectiveCamera(c.fov,c.aspect,c.near,300);cam.matrixAutoUpdate=false;cam.matrix.fromArray(c.world);cam.updateMatrixWorld(true);cam.projectionMatrix.fromArray(c.projection);cam.projectionMatrixInverse.copy(cam.projectionMatrix).invert();
 return{v,batches,cam};
}
const output={method:'Node '+process.version+' CPU-only submit microbenchmark on actual recorded scene matrices. Includes frustum, LOD, compaction, and optional occlusion, with the recorded low-detail hysteresis state restored. Recorded bounds are represented by box geometry; geometry triangle counts are not measured here. No GL, no GPU/FPS claim. 200 warmup and 1000 measured calls per view/variant.',records:[]};
for(const name of ['current','rack'])for(const [label,Type,enabled]of[['baseline',before,false],['after',after,true]]){
 const record=reports[label].records.find(r=>r.name===name);if(!record)continue;
 const{v,batches,cam}=setup(Type,record,enabled);for(let i=0;i<200;i++)v.submit(cam,batches,true,record.canvas.height);
 const times=[];for(let i=0;i<1000;i++){const t=performance.now();v.submit(cam,batches,true,record.canvas.height);times.push(performance.now()-t);}times.sort((a,b)=>a-b);
 const stats=v.getStats();if(stats.occlusion)delete stats.occlusion.savedTrianglesPerPass;
 output.records.push({view:name,label,medianMs:times[500],p95Ms:times[950],stats});
}
await writeFile(process.env.PRTS_RHINE_CPU_OUTPUT||'/tmp/rhine-body-cpu-replay.json',JSON.stringify(output,null,2));console.log(output.records.map(r=>({view:r.view,label:r.label,medianMs:r.medianMs,p95Ms:r.p95Ms,occlusion:r.stats.occlusion})));
