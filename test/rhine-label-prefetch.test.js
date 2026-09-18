import { test } from 'node:test'
import assert from 'node:assert/strict'
import { archiveLabelCandidates, archivePointerTarget } from '../ui/rhine/label-prefetch.ts'
test('prefetch covers both row directions and neighbouring lane memories before second neighbours', () => {
  const lanes = Array.from({length:5}, (_, l) => Array.from({length:20}, (_,r) => `${l}:${r}`))
  const candidates = archiveLabelCandidates(lanes, [3,7,19,2,6], 2)
  assert.deepEqual(candidates.map(c=>c.item), ['2:18','2:0','1:7','3:2','2:17','2:1'])
  assert.deepEqual(archiveLabelCandidates(lanes,[3,7,19,2,6],0).map(c=>c.item),['0:2','0:4','4:6','1:7','0:1','0:5'])
})
test('empty or short lanes neither duplicate nor prefetch the selected source and stay bounded', () => {
  assert.deepEqual(archiveLabelCandidates([],[],0),[])
  assert.deepEqual(archiveLabelCandidates([[],['a'],['b','c']],[0,0,1],0).map(c=>c.item),['c','a'])
  assert.deepEqual(archiveLabelCandidates([['a','b']],[0],0).map(c=>c.item),['b'])
  assert.equal(archiveLabelCandidates([['a','b','c','d'],['e']], [1,0],0,2).length,2)
})


test('pointer prediction follows cross-lane clicked slots rather than lane memory', () => {
  const counts=[40,70,50,20,180], rows=[9,63,2,6,156], slots=[3,4,2,6,0];
  assert.deepEqual(archivePointerTarget(counts,rows,slots,4,{lane:4,row:40},3*8,{lane:3,row:44}),{lane:3,row:0,delta:-6});
  assert.deepEqual(archivePointerTarget(counts,rows,slots,4,{lane:4,row:40},4*8+2,{lane:4,row:42}),{lane:4,row:158,delta:2});
  assert.deepEqual(archivePointerTarget(counts,rows,slots,4,{lane:4,row:40},4*8+6,{lane:4,row:38}),{lane:4,row:154,delta:-2});
  assert.equal(archivePointerTarget(counts,rows,slots,4,{lane:4,row:40},4*8,{lane:4,row:40}),null);
});

test('pointer and activity priorities displace neighbours without increasing capacity or duplicating targets', () => {
  const lanes=Array.from({length:5},(_,l)=>Array.from({length:20},(_,r)=>`${l}:${r}`));
  const preferred=[{item:lanes[3][6],lane:3,row:6,axis:'pointer',offset:5},{item:lanes[1][12],lane:1,row:12,axis:'activity',offset:0}];
  const result=archiveLabelCandidates(lanes,[3,7,19,1,6],2,6,[...preferred,preferred[0]]);
  assert.equal(result.length,6);assert.deepEqual(result.slice(0,2),preferred);assert.equal(new Set(result.map(c=>c.item)).size,6);
  assert.deepEqual(archiveLabelCandidates(lanes,[3,7,19,1,6],2,6).slice(0,2).map(c=>c.item),['2:18','2:0']);
});
