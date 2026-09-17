import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
import * as THREE from 'three';
const source=await readFile(new URL('../ui/rhine/original/archive-label.ts',import.meta.url),'utf8');
const compiled=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText;
const { archiveTitleLine, archiveLabelKey, positionArchiveLabel, ARCHIVE_LABEL_SIZE }=await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);

test('plate titles stay in one visible line and truncate Unicode without shrinking the font',()=>{
 const measure=text=>Array.from(text).length;
 assert.equal(archiveTitleLine(' 阿米娅 / 干员语音 ',measure,30),'阿米娅 / 干员语音');
 assert.equal(archiveTitleLine('甲乙丙丁戊己庚辛壬癸',measure,4),'甲乙丙…');
 assert.equal(archiveTitleLine('甲😀乙😀丙😀丁😀',measure,4),'甲😀乙…');
 assert.equal(archiveTitleLine('A\n\t B',measure,20),'A B');
 assert.equal(archiveTitleLine('😀'.repeat(2000),measure,5),'😀😀😀😀…');
 assert.equal(archiveTitleLine('超长',measure,0),'');
});

test('title and identity participate in cached text ownership',()=>{
 const first={code:'NO.001',title:'同名文档',sourceId:'revision-one'};
 assert.equal(archiveLabelKey(first),archiveLabelKey({...first}));
 assert.notEqual(archiveLabelKey(first),archiveLabelKey({...first,title:'修订标题'}));
 assert.notEqual(archiveLabelKey(first),archiveLabelKey({...first,sourceId:'revision-two'}));
});

test('title plate keeps the authored size and stays flush as its parent cassette turns',()=>{
 assert.deepEqual(ARCHIVE_LABEL_SIZE,{width:0.99,height:0.46});
 const cassette=new THREE.Group(),label=new THREE.Object3D();cassette.add(label);
 label.rotation.set(-0.12,-0.5,0);label.position.set(-0.6,3.86,1);
 positionArchiveLabel(label);
 assert.deepEqual(label.position.toArray(),[-1.36,3.04,0.255]);
 for(const yaw of [0,-0.3,0.8]){
  cassette.rotation.set(0.1,yaw,0.03);cassette.updateMatrixWorld(true);
  const coverNormal=new THREE.Vector3(0,0,1).transformDirection(cassette.matrixWorld);
  const titleNormal=new THREE.Vector3(0,0,1).transformDirection(label.matrixWorld);
  assert(coverNormal.distanceTo(titleNormal)<1e-10);
  for(const x of [-0.5,0.5])for(const y of [-0.5,0.5]){
   const corner=new THREE.Vector3(x*ARCHIVE_LABEL_SIZE.width,y*ARCHIVE_LABEL_SIZE.height,0).applyMatrix4(label.matrix);
   assert(Math.abs(corner.z-0.255)<1e-10,'all corners remain on the original cover plane');
   assert(corner.y<3.7,'the plate never protrudes above the cassette');
  }
 }
});
