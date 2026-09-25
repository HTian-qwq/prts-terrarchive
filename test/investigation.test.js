import test from 'node:test'
import assert from 'node:assert/strict'
import { createInvestigationStore, acquireInvestigationStore } from '../src/investigation-store.js'
import { investigationSources, mountInvestigationTools } from '../src/investigation-tools.js'

function memoryFacility() {
  const values = new Map(); let failed = false
  return { rewrite(fn) { for (const [key,value] of values) values.set(key,fn(structuredClone(value))) }, failNext() { failed = true }, async open(spec) {
    let tail = Promise.resolve()
    const get = () => values.get(spec.name)
    const table = { get: () => get(), put: async (_key, value) => { values.set(spec.name, structuredClone(value)) },
      update(_key, operation) { const promise = tail.then(async () => {
        const value = operation(get()); spec.tables.portfolios.valueSchema.parse(value)
        if (failed) { failed = false; throw new Error('disk unavailable') }
        values.set(spec.name, structuredClone(value)); return structuredClone(value)
      }); tail = promise.catch(() => {}); return promise } }
    return { table: () => table, close: async () => {} }
  } }
}
const execution = (callId, turnId = 1) => ({ callId, turnId })
const create = (s, callId='open') => s.open('session', { mode:'new', title:'黑蛇与塔露拉',objective:'研究双方选择的依据',reason:'独立研究' },execution(callId))
const add = (binding, revision=0) => ({board_id:binding.board_id,run_id:binding.run_id,expected_revision:revision,clues:[{client_key:'origin',title:'一条研究发现',summary:'资料给出了相应描述',kind:'finding',sources:[{source_id:'R0001',quote:'已读的原文',line_start:3,line_end:4}]}]})

test('user edits return durable per-clue revisions and resolve new relation endpoints atomically', async () => {
  const s=createInvestigationStore(memoryFacility()), b=await s.createUserBoard('session',{mutation_id:'new'});
  try {
    const args={board_id:b.board_id,mutation_id:'two',changes:[{client_key:'a',title:'A'},{client_key:'b',title:'B'}],relations:[{from:'a',to:'b',type:'supports',label:'依据'}]};
    const result=await s.edit('session',args);
    assert.deepEqual(result.clue_revisions,{C001:{content_revision:1,layout_revision:0},C002:{content_revision:1,layout_revision:0}});
    assert.deepEqual(await s.edit('session',args),result);
    const before=await s.read('session',{board_id:b.board_id});
    const removed=await s.edit('session',{board_id:b.board_id,mutation_id:'remove',changes:[{id:'C001',action:'retract',expected_content_revision:1}]});
    assert.equal(removed.clue_revisions.C001.content_revision,2);
    const restored=await s.edit('session',{board_id:b.board_id,mutation_id:'restore',changes:[{id:'C001',status:'active',expected_content_revision:2},{id:'C001',action:'layout',expected_layout_revision:0,scale:1.2}]});
    assert.deepEqual(restored.clue_revisions.C001,{content_revision:3,layout_revision:1});
    const after=await s.read('session',{board_id:b.board_id});
    assert.equal(after.board.clues.length,2);assert.equal(after.board.clues[0].status,'active');
    assert.deepEqual(after.board.relations,before.board.relations);
    await assert.rejects(s.edit('session',{board_id:b.board_id,mutation_id:'stale',changes:[{id:'C001',title:'stale',expected_content_revision:2}]}),e=>e.code==='INVESTIGATION_CONFLICT');
  } finally { await s.close(); }
});

test('persistent board workflow: real provenance, idempotency, reports, resume, separate runs',async()=>{
  const facility=memoryFacility(),s=createInvestigationStore(facility)
  const b=await create(s)
  assert.deepEqual(await create(s),b)
  await assert.rejects(s.update('session',add(b),execution('add')),e=>e.code==='INVESTIGATION_SOURCE_MISSING')
  await s.recordSources('session',[{id:'doc',title:'剧情原文',origin:'local',state:'read',agentRead:true,excerpt:'已读的原文',content:'已读的原文',lineStart:3,lineEnd:8}],'read')
  const result=await s.update('session',add(b),execution('add'))
  assert.equal(result.created_ids.origin,'C001');assert.equal(result.revision,1)
  assert.deepEqual(await s.update('session',add(b),execution('add')),result)
  await assert.rejects(s.update('session',{...add(b,1),clues:[{title:'编造引文',sources:[{source_id:'R0001',quote:'不存在的说法'}]}]},execution('bad')),e=>e.code==='INVESTIGATION_QUOTE_MISMATCH')
  const publish={board_id:b.board_id,run_id:b.run_id,expected_revision:1,title:'研究报告',summary:'阶段结论',markdown:'已有依据 [C001]',clue_ids:['C001']}
  await s.publish('session',publish,execution('publish'))
  await s.edit('session',{board_id:b.board_id,mutation_id:'move',changes:[{id:'C001',action:'layout',position:{x:-5,y:2},expected_layout_revision:0}]})
  let current=await s.read('session',{board_id:b.board_id})
  assert.equal(current.knowledgeRevision,1);assert.equal(current.reportStale,false)
  await s.edit('session',{board_id:b.board_id,mutation_id:'edit',changes:[{id:'C001',title:'用户修正的标题',expected_content_revision:1}]})
  await assert.rejects(s.update('session',{...add(b,2),clues:[{id:'C001',title:'Agent 覆盖用户'}]},execution('overwrite')),e=>e.code==='INVESTIGATION_USER_EDIT')
  current=await s.read('session',{board_id:b.board_id});assert.equal(current.board.reports[0].clues[0].title,'一条研究发现');assert.equal(current.reportStale,true)
  await s.endTurn('session',1,'completed');assert.equal((await s.read('session')).workingBoardId,null)
  const resumed=await s.open('session',{mode:'resume',board_id:b.board_id,reason:'同目标追问'},execution('resume',2))
  assert.equal(resumed.board_id,b.board_id);assert.notEqual(resumed.run_id,b.run_id)
  await s.close()
  const reopened=createInvestigationStore(facility);current=await reopened.read('session',{board_id:b.board_id})
  assert.equal(current.board.clues[0].title,'用户修正的标题');assert.equal(current.run.status,'interrupted');assert.equal(current.board.reports.length,1)
  await reopened.close()
})

test('atomic conflict and failure do not erase successful work; watch wakes on durable changes',async()=>{
  const facility=memoryFacility(),s=createInvestigationStore(facility),b=await create(s)
  const args={board_id:b.board_id,run_id:b.run_id,expected_revision:0,clues:[{title:'待验证',kind:'question'}]}
  const results=await Promise.allSettled([s.update('session',args,execution('a')),s.update('session',args,execution('b'))])
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1)
  assert.equal(results.find(r=>r.status==='rejected').reason.code,'INVESTIGATION_CONFLICT')
  const before=await s.read('session');const watch=s.watch('session',before.commitSeq)
  facility.failNext();await assert.rejects(s.update('session',{...args,expected_revision:1},execution('c')),/disk unavailable/)
  assert.equal((await s.read('session')).commitSeq,before.commitSeq)
  await s.update('session',{...args,expected_revision:1},execution('c'))
  assert.ok((await watch).commitSeq>before.commitSeq)
  const aborter=new AbortController();const cancelled=s.watch('session',9999,aborter.signal);aborter.abort();await assert.rejects(cancelled,e=>e.code==='CANCELLED')
  await s.close()
})

test('network and local receipts distinguish snippets, success, failure and read contents',()=>{
  assert.equal(investigationSources('web_search',{sources:[{url:'https://example.com',title:'来源',snippet:'摘要'}]})[0].state,'found')
  assert.deepEqual(investigationSources('web_fetch',{url:'https://example.com',statusCode:404,body:{kind:'text',content:'not found'}}),[])
  const read=investigationSources('web_fetch',{url:'https://example.com',statusCode:200,body:{kind:'html',content:'<title>原文</title><p>正文</p>'},truncated:true})[0]
  assert.equal(read.agentRead,true);assert.equal(read.title,'原文');assert.equal(read.contentTruncated,true)
  const local=investigationSources('corpus_read',{presentation:{document_id:'story/1',data_version:'v1'},primary:{title:'原文',selection:{line_start:1,line_end:2},lines:[{text:'第一句'},{text:'第二句'}]}})[0]
  assert.equal(local.content,'第一句\n第二句');assert.equal(local.lineEnd,2)
})

test('shared host/agent service; sources alone never create a board',async()=>{
  const facility=memoryFacility(),host=acquireInvestigationStore(facility),agent=acquireInvestigationStore(facility)
  assert.equal(host.service,agent.service)
  await host.service.recordSources('session',[{id:'url',title:'来源',origin:'web',url:'https://example.com',excerpt:'摘要'}],'search')
  assert.equal((await agent.service.read('session')).boards.length,0)
  await host.release();assert.equal((await agent.service.read('session',{section:'sources'})).sources.length,1);await agent.release()
})

test('tool hooks bind the native turn, capture sources, and close running investigations',async()=>{
  const service=createInvestigationStore(memoryFacility()),hooks={},definitions={},contexts=[]
  mountInvestigationTools({on:(name,fn)=>hooks[name]=fn,tools:{register:d=>definitions[d.name]=d},systemPrompt:{context:c=>contexts.push(c)}},service)
  const agent={session:{id:'session'}};hooks['agent/inbox/claimed']({agent,turn:7})
  const exec={agent,callId:'open',name:'investigation_open'}
  const result=await definitions.investigation_open.execute({mode:'new',title:'目标',objective:'核验',reason:'新的研究'},exec)
  assert.equal(service.peek('session').runs[0].turnId,'7')
  hooks['tools/result']({...exec,name:'web_search',callId:'search'},{value:{sources:[{url:'https://example.com',snippet:'摘要'}]}})
  assert.equal((await service.read('session',{section:'sources'})).sources.length,1)
  hooks['session/event'](agent.session,{type:'turn/end',data:{turn:7,reason:{kind:'completed'}}})
  await new Promise(resolve=>setImmediate(resolve))
  assert.equal((await service.read('session',{board_id:result.board_id})).run.status,'completed')
  assert.match(contexts[0].text({scope:agent}),/追问不自动新建板/)
  await service.close()
})

test('collection reads retain each real document locator and its own excerpt',()=>{
  const sources=investigationSources('corpus_read',{presentation:{document_id:'collection',data_version:'v1',sources:[
    {document_id:'chapter-a',document_uid:'uid-a',title:'第一篇',line_start:3,line_end:3},
    {document_id:'chapter-b',document_uid:'uid-b',title:'第二篇',line_start:7,line_end:7}]},
    primary:{title:'整组剧情',lines:[{document_uid:'uid-a',speaker:'角色甲',text:'第一份原文'},{document_uid:'uid-b',text:'第二份原文'}]}})
  assert.equal(sources.length,2);assert.equal(sources[0].documentId,'chapter-a');assert.equal(sources[0].content,'角色甲：第一份原文');
  assert.equal(sources[1].content,'第二份原文');assert.equal(sources[1].lineStart,7)
});

test('a different turn cannot borrow a previous run; rebinding closes the earlier working board',async()=>{
  const service=createInvestigationStore(memoryFacility()),first=await create(service);
  const payload={board_id:first.board_id,run_id:first.run_id,expected_revision:0,clues:[{kind:'question',title:'后续问题'}]};
  await assert.rejects(service.update('session',payload,execution('foreign',2)),e=>e.code==='INVESTIGATION_RUN_MISMATCH');
  await create(service,'second');
  assert.equal((await service.read('session',{board_id:first.board_id})).run.status,'interrupted');
  await service.close();
});

test('legacy migration keeps source identity and is applied only once',async()=>{
  const service=createInvestigationStore(memoryFacility());
  const input={migration_id:'legacy-v1',cards:[{id:'manual:1',title:'旧资料',body:'用户摘录',kind:'source',sourceId:'document:version:uid',sourceTitle:'原文标题',position:{x:-4,y:1}}]};
  const first=await service.importLegacy('session',input);
  const again=await service.importLegacy('session',input);assert.deepEqual(first,again);
  const board=await service.read('session',{board_id:first.board_id});
  assert.equal(board.sources[0].sourceId,'document:version:uid');assert.equal(board.sources[0].documentUid,'uid');
  assert.equal(board.sources[0].agentRead,false);assert.equal(board.board.clues[0].sources[0].source_id,board.sources[0].id);
  assert.equal((await service.read('session')).boards.length,1);await service.close();
});

test('evidence inbox persists per board, deduplicates, and does not mark a report stale until promotion',async()=>{
  const facility=memoryFacility(),s=createInvestigationStore(facility),b=await create(s)
  await s.recordSources('session',[{id:'candidate',title:'重点候选',origin:'web',url:'https://example.com/important',excerpt:'仅是摘要'}],'candidate')
  await s.publish('session',{board_id:b.board_id,run_id:b.run_id,expected_revision:0,title:'初版报告',summary:'尚待补证',markdown:'## 待核验',clue_ids:[]},execution('report'))
  const args={board_id:b.board_id,run_id:b.run_id,expected_inbox_revision:0,changes:[{action:'add',source_id:'R0001',note:'核对关键说法的上下文'}]}
  const staged=await s.stage('session',args,execution('stage'))
  assert.deepEqual(await s.stage('session',args,execution('stage')),staged)
  await s.stage('session',{...args,expected_inbox_revision:1},execution('stage-again'))
  const first=await s.read('session',{board_id:b.board_id})
  assert.equal(first.board.knowledgeRevision,0);assert.equal(first.reportStale,false);assert.equal(first.pendingEvidenceCount,1)
  assert.equal(first.sources[0].state,'found');assert.equal(first.sources[0].agentRead,false)
  const second=await s.createUserBoard('session',{mutation_id:'second',title:'另一项调查'})
  assert.equal((await s.read('session',{board_id:second.board_id})).pendingEvidenceCount,0)
  await s.close();const reopened=createInvestigationStore(facility)
  const inbox=await reopened.read('session',{board_id:b.board_id,section:'inbox'})
  assert.equal(inbox.items.length,1);assert.equal(inbox.items[0].note,'核对关键说法的上下文');assert.equal(inbox.items[0].source.content,undefined)
  const result=await reopened.editInbox('session',{board_id:b.board_id,mutation_id:'promote',expected_inbox_revision:1,action:'promote',source_id:'R0001',title:'需要继续核对的说法',detail:'当前仅有摘要，等待完整上下文',kind:'question',interpretation:'question'})
  const after=await reopened.read('session',{board_id:b.board_id});assert.equal(after.pendingEvidenceCount,0);assert.equal(after.board.clues[0].id,result.clue_id);assert.equal(after.reportStale,true);assert.equal(after.board.evidenceInbox[0].status,'promoted');assert.equal(after.sources[0].id,'R0001')
  assert.deepEqual(await reopened.editInbox('session',{board_id:b.board_id,mutation_id:'promote',expected_inbox_revision:1,action:'promote',source_id:'R0001',title:'需要继续核对的说法',detail:'当前仅有摘要，等待完整上下文',kind:'question',interpretation:'question'}),result)
  await reopened.close()
})

test('inbox changes reject cross-turn, missing sources, stale revisions and uncommitted promotion',async()=>{
  const facility=memoryFacility(),s=createInvestigationStore(facility),b=await create(s)
  const args={board_id:b.board_id,run_id:b.run_id,expected_inbox_revision:0,changes:[{action:'add',source_id:'fake',note:'待核对'}]}
  await assert.rejects(s.stage('session',args,execution('other-turn',2)),e=>e.code==='INVESTIGATION_RUN_MISMATCH')
  await assert.rejects(s.stage('session',args,execution('fake')),e=>e.code==='INVESTIGATION_SOURCE_MISSING')
  await s.recordSources('session',[{id:'doc',title:'来源',excerpt:'实际返回片段'}],'receipt')
  await s.editInbox('session',{board_id:b.board_id,mutation_id:'user-add',expected_inbox_revision:0,action:'add',source_id:'R0001',note:'用户挑选'})
  await assert.rejects(s.stage('session',{...args,expected_inbox_revision:1,changes:[{action:'remove',source_id:'R0001'}]},execution('remove-user')),e=>e.code==='INVESTIGATION_USER_EDIT')
  const promotion={board_id:b.board_id,mutation_id:'promote',expected_inbox_revision:1,action:'promote',source_id:'R0001',title:'用户整理',detail:'实际返回片段',interpretation:'observation'}
  facility.failNext();await assert.rejects(s.editInbox('session',promotion),/disk unavailable/)
  const unchanged=await s.read('session',{board_id:b.board_id});assert.equal(unchanged.board.clues.length,0);assert.equal(unchanged.pendingEvidenceCount,1)
  await s.editInbox('session',{board_id:b.board_id,mutation_id:'remove',expected_inbox_revision:1,action:'remove',source_id:'R0001'})
  await assert.rejects(s.editInbox('session',promotion),e=>e.code==='INVESTIGATION_INBOX_CONFLICT')
  assert.equal((await s.read('session',{section:'sources'})).sources.length,1)
  await assert.rejects(s.stage('session',{...args,expected_inbox_revision:2,changes:[{action:'add',source_id:'R0001',note:'自动重放'}]},execution('re-add')),e=>e.code==='INVESTIGATION_USER_EDIT')
  await s.close()
})

test('agent increments consume only referenced pending evidence and retain unrelated candidates',async()=>{
  const s=createInvestigationStore(memoryFacility()),b=await create(s)
  await s.recordSources('session',[{id:'a',title:'候选 A',excerpt:'片段 A'},{id:'b',title:'候选 B',excerpt:'片段 B'}],'candidates')
  await s.stage('session',{board_id:b.board_id,run_id:b.run_id,expected_inbox_revision:0,changes:[{action:'add',source_id:'R0001',note:'查上下文'},{action:'add',source_id:'R0002',note:'比较差异'}]},execution('stage'))
  const update=await s.update('session',{board_id:b.board_id,run_id:b.run_id,expected_revision:0,clues:[{title:'一项待核验的发现',kind:'question',sources:[{source_id:'R0001'}]}]},execution('update'))
  assert.equal(update.inbox_revision,2)
  const inbox=await s.read('session',{board_id:b.board_id,section:'inbox'});assert.deepEqual(inbox.items.map(i=>i.source_id),['R0002'])
  const saved=await s.read('session',{board_id:b.board_id});assert.deepEqual(saved.board.evidenceInbox[0].clueIds,update.updated_ids);assert.equal(saved.sources.length,2)
  await s.close()
})


test('pre-inbox saved boards reopen with an empty inbox without losing clues or reports',async()=>{
  const facility=memoryFacility(),old=createInvestigationStore(facility),b=await create(old)
  await old.update('session',{board_id:b.board_id,run_id:b.run_id,expected_revision:0,clues:[{kind:'question',title:'既有问题'}]},execution('old-update'))
  await old.close();facility.rewrite(p=>{for(const board of p.boards){delete board.evidenceInbox;delete board.inboxRevision}return p})
  const current=createInvestigationStore(facility),saved=await current.read('session',{board_id:b.board_id})
  assert.equal(saved.pendingEvidenceCount,0);assert.equal(saved.board.inboxRevision,0);assert.equal(saved.board.clues[0].title,'既有问题')
  await current.editInbox('session',{board_id:b.board_id,mutation_id:'first-inbox-write',expected_inbox_revision:0,action:'add',source_id:'user-source',sources:[{id:'user-source',title:'用户新材料',excerpt:'摘记'}]})
  const after=await current.read('session',{board_id:b.board_id});assert.equal(after.pendingEvidenceCount,1);assert.equal(after.board.clues[0].title,'既有问题');await current.close()
})
