import { test } from 'node:test';
import assert from 'node:assert/strict';
import { beginWorkspaceTravel, advanceWorkspaceTravel } from '../ui/rhine/workspace-travel.ts';

const stops = { archive: {board:0,desk:0}, board: {board:1,desk:0}, desk: {board:0,desk:1} };
test('rack and array travel directly in both directions without a board stop or midpoint slowdown', () => {
  for(const [from,to] of [['desk','archive'],['archive','desk']]) {
    const travel=beginWorkspaceTravel(stops[from],to), samples=[];
    for(let step=0;step<240;step++) {
      const value=advanceWorkspaceTravel(travel,travel.duration/240);
      assert.equal(value.board,0,'the evidence board must never become an intermediate camera target');
      samples.push(value.desk);
    }
    const speeds=samples.slice(1).map((value,index)=>Math.abs(value-samples[index]));
    assert(speeds[119]>speeds[59],'camera continues through the middle, rather than braking at a hidden waypoint');
    for(let i=1;i<samples.length;i++) assert((samples[i]-samples[i-1])*(to==='desk'?1:-1)>=0);
    assert(Math.abs(samples.at(-1)-stops[to].desk)<1e-12);
  }
});

test('all six navigation routes finish exactly at their target and remain within the endpoint segment', () => {
  for(const from of Object.keys(stops))for(const to of Object.keys(stops))if(from!==to) {
    const travel=beginWorkspaceTravel(stops[from],to);
    for(let i=0;i<100;i++) {
      const value=advanceWorkspaceTravel(travel,0.03);
      assert(value.board>=0&&value.desk>=0&&value.board+value.desk<=1+1e-12);
      for(const key of ['board','desk'])if(stops[from][key]===stops[to][key])assert.equal(value[key],stops[to][key]);
    }
    const end=advanceWorkspaceTravel(travel,0);
    assert.deepEqual(end,{...stops[to],complete:true});
  }
});

test('redirecting a live transition starts at its current pose, with no snap back to a station', () => {
  let value=advanceWorkspaceTravel(beginWorkspaceTravel(stops.desk,'archive'),0.73);
  for(const destination of ['board','desk','archive','desk']) {
    const travel=beginWorkspaceTravel(value,destination);
    assert.deepEqual(advanceWorkspaceTravel(travel,0),{board:value.board,desk:value.desk,complete:false});
    value=advanceWorkspaceTravel(travel,0.19);
  }
});

test('reduced motion and an oversized frame settle without a phantom intermediate frame', () => {
  for(const reduced of [false,true]) {
    const travel=beginWorkspaceTravel(stops.desk,'archive');
    assert.deepEqual(advanceWorkspaceTravel(travel,reduced?0:99,reduced),{board:0,desk:0,complete:true});
  }
});
