import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'

const code = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
function fixture() {
  let serial=0, visibleSession='a'
  const frames=new Map(),timers=new Map()
  const store=state=>({state,listeners:new Set(),getSnapshot(){return this.state},
    subscribe(fn){this.listeners.add(fn);return()=>this.listeners.delete(fn)},
    emit(){for(const fn of this.listeners)fn()}})
  const sessions=store({current:'a',ids:['a','b'],byId:{
    a:{id:'a',title:'Alpha',blank:true,running:false,updatedAt:new Date(2026,8,17,12).getTime()},
    b:{id:'b',title:'Beta',blank:false,running:false,updatedAt:1},
  }})
  const session=store({blank:true,running:false})
  session.cancel=async()=>({ok:true})
  const workspaces=store({items:[],archivedSessionIds:[]})
  const models=store({status:'ready',routable:true,current:{provider:'p',model:'m'},groups:[{id:'p',name:'Provider',models:[{id:'m',name:'Model'}]}]})
  const directory={store:models,load:async()=>{},select:async selection=>{models.state.current=selection;models.emit()}}
  const ctx={sessions:{list:sessions,binding:()=>({session}),refresh:async()=>{},open:id=>{sessions.state.current=id}},
    workspaces:{list:workspaces},modelDirectories:{directoryFor:()=>directory},
    remote:{agentPresets:{list:async()=>({ok:true,value:{presets:[]}})}}}
  let plugin
  vm.runInNewContext(code.replace('let clientContext = null','let clientContext = __ctx'),{
    __ctx:ctx,console,AbortController,DOMException,performance,
    window:{__ModuleLoader__:{load({factory}){plugin=factory(()=>({}))}},
      requestAnimationFrame:fn=>{const id=++serial;frames.set(id,fn);return id},
      cancelAnimationFrame:id=>frames.delete(id)},
    setTimeout:fn=>{const id=++serial;timers.set(id,fn);return id},clearTimeout:id=>timers.delete(id),
  })
  const controls=plugin.__rhineStateForTest.createRhineHostControls(ctx,'a',()=>visibleSession==='a')
  const received=[];controls.subscribe(state=>received.push(state))
  const flush=collection=>{for(const [id,fn] of [...collection])if(collection.delete(id))fn()}
  return {setVisible(id){visibleSession=id},controls,received,sessions,session,workspaces,models,ctx,frames,timers,frame:()=>flush(frames),timer:()=>flush(timers)}
}
test('10,000 unchanged notifications coalesce into one projection and no UI delivery',()=>{
  const h=fixture(),before=h.controls.performanceStats()
  for(let i=0;i<10000;i++){h.sessions.state.byId.a.updatedAt++;h.sessions.emit()}
  assert.equal(h.received.length,0);assert.equal(h.frames.size,1);assert.equal(h.timers.size,1)
  h.frame()
  const stats=h.controls.performanceStats()
  assert.equal(stats.notifications,10000);assert.equal(stats.coalesced,9999)
  assert.equal(stats.stateReads-before.stateReads,1);assert.equal(stats.deduplicated,1)
  assert.equal(h.received.length,0);assert.equal(h.timers.size,0)
  h.controls.dispose()
})
test('latest display changes, same-length title edits, model availability, ordering and next-day dates are preserved',()=>{
  const h=fixture()
  h.sessions.state.byId.a.title='Bravo';h.sessions.emit()
  h.sessions.state.ids.reverse();h.sessions.emit()
  h.models.state.routable=false;h.models.emit()
  h.frame()
  assert.equal(h.received.length,1);assert.equal(h.received[0].title,'Bravo')
  assert.equal(h.received[0].sessions[0].id,'b');assert.equal(h.received[0].canSubmit,false)
  h.models.state.groups[0].models[0].name='New model';h.models.emit();h.frame()
  assert.match(h.received.at(-1).models[0].name,/New model/)
  h.sessions.state.byId.a.updatedAt+=86400000;h.sessions.emit();h.frame()
  assert.equal(h.received.length,3)
  h.controls.dispose()
})
test('background timer delivers latest state once and cancels the dormant RAF',()=>{
  const h=fixture()
  h.session.state.running=true;h.session.emit();h.timer()
  assert.equal(h.received.length,1);assert.equal(h.received[0].running,true)
  assert.equal(h.frames.size,0);h.frame();assert.equal(h.received.length,1)
  h.controls.dispose()
})
test('explicit action busy and error feedback remain synchronous and clear stale queued notifications',async()=>{
  const h=fixture()
  let reject
  h.session.cancel=()=>new Promise((_resolve,no)=>{reject=no})
  h.session.emit();assert.equal(h.frames.size,1)
  const pending=h.controls.cancel()
  assert.equal(h.received.at(-1).cancelling,true);assert.equal(h.frames.size,0)
  reject(new Error('Expected cancellation failure'))
  await assert.rejects(pending,/Expected cancellation failure/)
  assert.equal(h.received.at(-1).cancelling,false);assert.match(h.received.at(-1).error,/Expected cancellation failure/)
  const count=h.received.length;h.frame();h.timer();assert.equal(h.received.length,count)
  h.controls.dispose()
})
test('refresh loading feedback and disposal retain lifecycle correctness',async()=>{
  const h=fixture()
  const pending=h.controls.refresh()
  assert.equal(h.received.at(-1).loading,true)
  await pending
  assert.equal(h.received.at(-1).loading,false)
  h.session.state.running=true;h.session.emit()
  const count=h.received.length;h.controls.dispose();h.frame();h.timer()
  assert.equal(h.received.length,count)
  for(const store of [h.session,h.sessions,h.models,h.workspaces])assert.equal(store.listeners.size,0)
  assert.equal(h.frames.size,0);assert.equal(h.timers.size,0)
})
test('bridge diagnostics expose only counters and bounded fixed work categories',()=>{
  const h=fixture(),spans=[]
  h.controls.setPerformanceMonitor(kind=>{spans.push(kind);return()=>{}})
  h.sessions.state.byId.a.title='PRIVATE TITLE';h.sessions.emit();h.frame()
  const encoded=JSON.stringify(h.controls.performanceStats())
  assert(!encoded.includes('PRIVATE'));assert(!encoded.includes('Alpha'));assert(spans.includes('host-state-project'));assert(spans.includes('host-notify'))
  h.controls.setPerformanceMonitor();h.controls.dispose()
})

function modernHost() {
  const h=fixture(), opened=[], retained=new Set(), releases=[];
  delete h.sessions.state.current;delete h.ctx.sessions.open;
  h.ctx.uiWorkspace={openSession:id=>{opened.push(id);h.setVisible(id)}};
  h.ctx.sessions.create=async()=>{h.sessions.state.ids.push('new');h.sessions.state.byId.new={id:'new',blank:true,running:false};return 'new'};
  h.ctx.sessions.retain=(id,{signal})=>{assert(!signal.aborted);retained.add(id);return {ready:Promise.resolve(),release(){retained.delete(id);releases.push(id)}}};
  h.ctx.remote.agentPresets.list=async()=>({ok:true,value:{presets:[{id:'prts',name:'PRTS'}]}});
  h.ctx.remote.agentPresets.select=async(id,mode)=>{if(id!=='a')assert(retained.has(id));h.sessions.state.byId[id].projectionValues={agentPreset:mode};return {ok:true}};
  const originalDirectory=h.ctx.modelDirectories.directoryFor;
  h.ctx.modelDirectories.directoryFor=id=>{if(id!=='a')assert(retained.has(id));return originalDirectory(id)};
  return {...h,opened,retained,releases};
}
test('DSH 0.1.7 cancels and changes mode/model without catalog.current or sessions.open',async()=>{
  const h=modernHost();let cancelled=0;h.session.cancel=async()=>{cancelled++;return {ok:true}};
  await h.controls.refresh();await h.controls.selectMode('prts');
  await h.controls.selectModel(JSON.stringify(['p','m']));await h.controls.cancel();
  assert.equal(cancelled,1);assert.equal(h.controls.getState().mode,'prts');
  await h.controls.openSession('b');assert.deepEqual(h.opened,['b']);
  await assert.rejects(h.controls.cancel(),{name:'AbortError'});h.controls.dispose();
});
test('new DSH retains a created session while configuring, navigates, then releases it',async()=>{
  const h=modernHost();await h.controls.refresh();await h.controls.createSession('prts');
  assert.deepEqual(h.opened,['new']);assert.equal(h.sessions.state.byId.new.projectionValues.agentPreset,'prts');
  assert.equal(h.retained.size,0);assert.deepEqual(h.releases,['new']);h.controls.dispose();
});
test('navigation during async creation never opens the stale target or leaks a reference',async()=>{
  const h=modernHost();let finish;const create=h.ctx.sessions.create;
  h.ctx.sessions.create=async()=>{await new Promise(resolve=>finish=resolve);return create()};
  const pending=h.controls.createSession();h.setVisible('b');finish();
  await assert.rejects(pending,{name:'AbortError'});assert.deepEqual(h.opened,[]);assert.equal(h.retained.size,0);h.controls.dispose();
});
test('failed new-session configuration releases ownership and retries the same blank entry',async()=>{
  const h=modernHost();let attempt=0;const directory=h.ctx.modelDirectories.directoryFor('a');
  directory.select=async()=>{if(!attempt++)throw new Error('model offline')};
  await assert.rejects(h.controls.createSession(),/model offline/);assert.equal(h.retained.size,0);assert.equal(h.opened.length,0);
  await h.controls.createSession();assert.deepEqual(h.opened,['new']);assert.equal(h.sessions.state.ids.filter(x=>x==='new').length,1);h.controls.dispose();
});
test('cancel remains available during catalog loading or model selection and deduplicates repeated clicks',async()=>{
  const h=modernHost();let loaded,stopped,count=0;
  h.ctx.modelDirectories.directoryFor('a').load=()=>new Promise(resolve=>loaded=resolve);
  const refresh=h.controls.refresh();h.models.state.status='selecting';
  h.session.cancel=()=>{count++;return new Promise(resolve=>stopped=()=>resolve({ok:true}))};
  const cancel=h.controls.cancel();await h.controls.cancel();assert.equal(count,1);assert.equal(h.controls.getState().cancelling,true);
  stopped();await cancel;loaded();await refresh;assert.equal(h.controls.getState().cancelling,false);h.controls.dispose();
});
test('legacy host navigation remains available and protects the selected session',async()=>{
  const h=fixture();await h.controls.openSession('b');assert.equal(h.sessions.state.current,'b');
  await assert.rejects(h.controls.cancel(),{name:'AbortError'});h.controls.dispose();
});


test('modern model rejection keeps the old session and allows retrying the same new session',async()=>{
  const h=modernHost();let attempts=0;const directory=h.ctx.modelDirectories.directoryFor('a');
  directory.select=async()=>++attempts===1?{ok:false,error:{code:'model/unavailable',message:'模型不可用'}}:{ok:true,value:undefined};
  await assert.rejects(h.controls.createSession(),/模型不可用/);
  assert.equal(h.opened.length,0);assert.equal(h.retained.size,0);
  await h.controls.createSession();assert.deepEqual(h.opened,['new']);
  assert.equal(h.sessions.state.ids.filter(id=>id==='new').length,1);h.controls.dispose();
});
test('model picker handles modern failure results and legacy void successes',async()=>{
  for(const modern of [false,true]){
    const h=modern?modernHost():fixture(),directory=h.ctx.modelDirectories.directoryFor('a');
    try{
      directory.select=async()=>modern?{ok:false,error:{code:'model/unavailable',message:'模型不可用'}}:Promise.reject(new Error('模型不可用'));
      await assert.rejects(h.controls.selectModel(JSON.stringify(['p','m'])),/模型不可用/);
      assert.match(h.controls.getState().error,/模型不可用/);
      directory.select=async()=>modern?{ok:true,value:undefined}:undefined;
      await h.controls.selectModel(JSON.stringify(['p','m']));assert.equal(h.controls.getState().error,'');
    }finally{h.controls.dispose()}
  }
});
