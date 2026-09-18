import test from 'node:test';
import assert from 'node:assert/strict';
import { SnapshotUpdateGate } from '../ui/rhine/snapshot-update-gate.ts';

const fixture = () => ({ sessionId:'session-a', investigationId:'turn-a', running:true, searching:false,
  query:'question', tool:'corpus_read', answer:'A', phase:'synthesizing', outcome:'running',
  sources:[{id:'s',title:'Alpha',kind:'story',origin:'cloud',state:'read',excerpt:'x'.repeat(100),
    dataVersion:'v1',readRanges:[{start:1,end:3}]}],
  operations:[{id:'read-1',kind:'read',tool:'corpus_read',state:'complete',sourceIds:['s']}],
  toolCalls:[{id:'read-1',tool:'corpus_read',state:'complete'}],
  records:[{id:'read-1',tool:'corpus_read',state:'complete',query:'q',text:'old'}] });

test('1,000 answer chunks with fresh equivalent sources skip both heavy paths',()=>{
  const state=fixture(),gate=new SnapshotUpdateGate(state);
  for(let i=0;i<1000;i++){
    const next=structuredClone(state);next.answer='Chunk '+i;
    assert.deepEqual(gate.read(next),{sessionChanged:false,sourcesChanged:false,statusChanged:false});
  }
});
test('equal-length edits, deep mutations, late excerpt changes and source identity remain observable',()=>{
  for(const mutate of [
    s=>s.sources[0].title='Bravo',s=>s.sources[0].excerpt='x'.repeat(99)+'y',
    s=>s.sources[0].readRanges[0].end=4,s=>s.sources[0].dataVersion='v2',
    s=>s.sources[0].state='cited',s=>s.sources[0].documentUid='uid',
    s=>s.sources[0].saved=true,s=>s.sources.push({...s.sources[0],id:'t'}),
  ]){
    const state=fixture(),gate=new SnapshotUpdateGate(state);mutate(state);
    assert.deepEqual(gate.read(state),{sessionChanged:false,sourcesChanged:true,statusChanged:true});
  }
});
test('tool lifecycle, references and same-count turn sources update without remerging cumulative sources',()=>{
  for(const mutate of [
    s=>s.operations[0].state='error',s=>s.operations[0].sourceIds=['other'],
    s=>s.toolCalls[0].query='new',s=>s.activeDataVersion='v2',
    s=>s.turnSources=[{...s.sources[0],state:'cited'}],
    s=>s.reportSources=[s.sources[0]],s=>s.running=false,s=>s.outcome='completed',
    s=>s.investigationId='turn-b',s=>s.loadingHistory=true,s=>s.error='failed',
  ]){
    const state=fixture(),gate=new SnapshotUpdateGate(state);mutate(state);
    const changes=gate.read(state);assert.equal(changes.sourcesChanged,false);assert.equal(changes.statusChanged,true);
  }
});
test('answer presence updates the status entry; records-only changes are left to reading panels',()=>{
  const state=fixture(),gate=new SnapshotUpdateGate(state);
  state.answer='B';state.records[0].text='new';assert.equal(gate.read(state).statusChanged,false);
  state.answer='';assert.equal(gate.read(state).statusChanged,true);
  state.answer='C';assert.equal(gate.read(state).statusChanged,true);
});
test('in-place session changes and source reordering are detected from retained values',()=>{
  const state=fixture();state.sources.push({...state.sources[0],id:'t'});
  const gate=new SnapshotUpdateGate(state);state.sources.reverse();
  assert.equal(gate.read(state).sourcesChanged,true);
  state.sessionId='session-b';
  assert.deepEqual(gate.read(state),{sessionChanged:true,sourcesChanged:true,statusChanged:true});
});
