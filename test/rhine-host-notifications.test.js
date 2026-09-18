import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'

const code = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
function fixture() {
  let serial=0
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
  const controls=plugin.__rhineStateForTest.createRhineHostControls(ctx,'a')
  const received=[];controls.subscribe(state=>received.push(state))
  const flush=collection=>{for(const [id,fn] of [...collection])if(collection.delete(id))fn()}
  return {controls,received,sessions,session,workspaces,models,ctx,frames,timers,frame:()=>flush(frames),timer:()=>flush(timers)}
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
  assert.equal(h.received.at(-1).busy,true);assert.equal(h.frames.size,0)
  reject(new Error('Expected cancellation failure'))
  await assert.rejects(pending,/Expected cancellation failure/)
  assert.equal(h.received.at(-1).busy,false);assert.match(h.received.at(-1).error,/Expected cancellation failure/)
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
