import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
const code=await readFile(new URL('../lib/client.js',import.meta.url),'utf8');
function fixture(React={}) {
  let plugin;
  vm.runInNewContext(code,{window:{__ModuleLoader__:{load({factory}){plugin=factory(()=>React)}}},
    console,AbortController,setTimeout,clearTimeout});
  return plugin.__rhineStateForTest;
}
test('upstream spans close on success and failure, counters are isolated and payload-free',()=>{
  const {createRhineSnapshotDiagnostics,rhineSnapshotSignature}=fixture(),d=createRhineSnapshotDiagnostics(),other=createRhineSnapshotDiagnostics();
  const spans=[],closed=[];d.setPerformanceMonitor(kind=>{spans.push(kind);return()=>closed.push(kind)});
  rhineSnapshotSignature({order:[],nodes:new Map()},d);
  assert.deepEqual(spans,['host-snapshot-selector','host-snapshot-build','host-snapshot-serialize']);
  assert.deepEqual(closed,['host-snapshot-build','host-snapshot-serialize','host-snapshot-selector']);
  assert.throws(()=>d.measure('host-snapshot-parse',()=>{throw Error('PRIVATE FAILURE')}),/PRIVATE/);
  assert.equal(closed.at(-1),'host-snapshot-parse');
  d.measure('PRIVATE UNKNOWN CATEGORY',()=>123);
  assert(!JSON.stringify(d.performanceStats()).includes('PRIVATE'));
  assert.equal(other.performanceStats().counts['host-snapshot-selector'],0);
  const count=spans.length;d.setPerformanceMonitor();rhineSnapshotSignature({},d);
  assert.equal(spans.length,count);assert.equal(d.performanceStats().counts['host-snapshot-selector'],2);
});
test('actual RhineControl reuses unchanged chat projection across lifecycle-only updates',()=>{
  let position=0,running=true,diagnostics;
  const hooks=[],React={
    useState:value=>{const i=position++;hooks[i]??={value};return[hooks[i].value,()=>{}]},
    useRef:value=>{const i=position++;hooks[i]??={current:value};return hooks[i]},
    useEffect:()=>{},
    useMemo:(fn,deps)=>{const i=position++,old=hooks[i];if(old&&deps.every((x,n)=>x===old.deps[n]))return old.value;
      const value=fn();hooks[i]={deps,value};if(value?.measure&&value?.performanceStats)diagnostics=value;return value;}
  };
  const {RhineControl}=fixture(React),seen=[],selectors=[];
  const render=()=>{position=0;RhineControl({sessionId:'s',
    useChat:selector=>{selectors.push(selector);return selector({order:[],nodes:new Map()})},
    useSession:selector=>selector({running})});};
  render();const owner=diagnostics;
  owner.setPerformanceMonitor(kind=>{seen.push(kind);return()=>{}});
  running=false;render();
  assert.equal(owner,diagnostics);assert.equal(selectors[0],selectors[1]);
  const stats=owner.performanceStats();
  for(const [kind,count] of Object.entries({'host-snapshot-selector':2,'host-snapshot-input':2,
    'host-snapshot-build':1,'host-snapshot-serialize':1,'host-snapshot-parse':0,
    'host-snapshot-merge':1,'host-snapshot-derive':2}))assert.equal(stats.counts[kind],count,kind);
  assert.equal(stats.cache.inputHits,1);assert.equal(stats.cache.sourceMergeHits,1);
  assert(seen.includes('host-snapshot-input'));assert(!seen.includes('host-snapshot-build'));
  assert(!seen.includes('host-snapshot-parse'));assert(!seen.includes('host-snapshot-merge'));
  owner.setPerformanceMonitor();
});

test('actual RhineControl skips parse/source merge during streaming and resets on session change',async()=>{
  const {snapshotWorkload}=await import('./helpers/rhine-snapshot-fixture.js');
  let input=snapshotWorkload(),sessionId='first',position=0,diagnostics;
  const hooks=[],React={
    useState:value=>{const i=position++;hooks[i]??={value};return[hooks[i].value,()=>{}]},
    useRef:value=>{const i=position++;hooks[i]??={current:value};return hooks[i]},
    useEffect:()=>{},
    useMemo:(fn,deps)=>{const i=position++,old=hooks[i];if(old&&deps.every((x,n)=>x===old.deps[n]))return old.value;
      const value=fn();hooks[i]={deps,value};if(value?.measure&&value?.performanceStats)diagnostics=value;return value;}
  };
  const {RhineControl}=fixture(React);
  const render=()=>{position=0;RhineControl({sessionId,useChat:select=>select(input),useSession:select=>select({running:true})});
    return hooks.find(slot=>slot?.current?.phase&&Array.isArray(slot.current.sources)).current;};
  const initial=render(),owner=diagnostics;
  for(let i=0;i<30;i++){
    input.nodes.get('answer').data.blocks[0].text='Stream '+i;
    const next=render();assert.equal(next.answer,'Stream '+i);assert.equal(next.sources,initial.sources);
  }
  assert.equal(owner.performanceStats().counts['host-snapshot-parse'],0);
  assert.equal(owner.performanceStats().counts['host-snapshot-merge'],1);
  assert.equal(owner.performanceStats().cache.sourceMergeHits,30);
  input.nodes.get('tool-0').data.root.meta.sources[0].excerpt='Changed material';
  assert.equal(render().sources[0].excerpt,'Changed material');
  assert.equal(owner.performanceStats().counts['host-snapshot-merge'],2);
  sessionId='second';input={order:[],nodes:new Map()};
  const empty=render();assert.equal(empty.sessionId,'second');assert.equal(empty.sources.length,0);
  assert.notEqual(diagnostics,owner);assert.equal(diagnostics.performanceStats().cache.inputMisses,1);
});
