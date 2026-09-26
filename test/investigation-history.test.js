import test from 'node:test';
import assert from 'node:assert/strict';
import {investigationVersion} from '../ui/rhine/investigation-history.ts';
test('historical projection retains frozen state and never borrows current relations or sources',()=>{
 const report={version:1,clues:[{id:'C001'}],sources:[{id:'R001'}],title:'旧报告',summary:'旧摘要',publishedAt:'2026-09-26',basisKnowledgeRevision:1,
 boardSnapshot:{id:'b',title:'旧板',clues:[{id:'C001',title:'旧线索'},{id:'C002'}],relations:[{from:'C001',to:'C002'}],sources:[{id:'R001',title:'旧资料'}]}};
 const board={id:'b',title:'新版',clues:[],relations:[],reports:[report]};
 const v=investigationVersion(board,[{id:'new'}],1);assert.equal(v.complete,true);assert.equal(v.board.clues.length,2);assert.equal(v.board.relations.length,1);assert.equal(v.sources[0].title,'旧资料');
 v.board.clues[0].title='尝试修改';assert.equal(report.boardSnapshot.clues[0].title,'旧线索');
 assert.equal(investigationVersion(board,[],0).board,board);
 delete report.boardSnapshot;const legacy=investigationVersion(board,[],1);assert.equal(legacy.complete,false);assert.deepEqual(legacy.board.relations,[]);assert.equal(legacy.board.clues.length,1);
 assert.throws(()=>investigationVersion(board,[],2),/不存在/);
});
