import type { ArchiveSource } from './types';
import { SurfaceTransition } from './original/ui-transitions';
import './evidence-inbox.css';

export interface EvidenceInboxView { boardId:string; title:string; count:number; titles:string[] }
export interface EvidenceInboxAnchor { x:number; y:number; visible:boolean }
type Options = {
  mutate(payload:Record<string,unknown>):Promise<unknown>;
  read(source:ArchiveSource):void; notify(message:string):void;
  scene(value:EvidenceInboxView,open:boolean):void;
  ask?(boardId:string,title:string):Promise<void>;
};
const el=<K extends keyof HTMLElementTagNameMap>(tag:K,cls='',text='')=>{const n=document.createElement(tag);n.className=cls;n.textContent=text;return n;};
const button=(cls:string,text:string,fn:()=>void)=>{const n=el('button',cls,text);n.type='button';n.onclick=fn;return n;};

/** A board-owned staging queue. Opening a source and pinning a clue are separate actions. */
export function mountEvidenceInbox(host:HTMLElement,options:Options){
  let board:any=null,sources:any[]=[],active=false,opened=false,busy=false,disposed=false,selected='',page=0,editing=false;
  let anchor:EvidenceInboxAnchor={x:0,y:0,visible:false},signature='';
  const motion=matchMedia('(prefers-reduced-motion: reduce)'),events=new AbortController();
  const entry=button('rhine-inbox-entry','',()=>open());entry.setAttribute('aria-label','打开重点证据盒');entry.setAttribute('aria-expanded','false');entry.hidden=true;
  const entryLabel=el('span','','重点证据盒'),count=el('b','','00'),entryHint=el('small','','待整理 ↗');entry.append(entryLabel,count,entryHint);
  const panel=el('section','rhine-inbox-panel');panel.hidden=true;panel.setAttribute('role','dialog');panel.setAttribute('aria-label','重点证据盒');panel.tabIndex=-1;
  const header=el('header'),kicker=el('span','','EVIDENCE / 待整理'),close=button('rhine-inbox-close','返回调查板 ↗',()=>hide());header.append(kicker,close);
  const content=el('div','rhine-inbox-content'),title=el('h2','','重点证据盒'),subtitle=el('p','rhine-inbox-subtitle');
  const tools=el('div','rhine-inbox-tools'),filter=el('input','rhine-inbox-filter');filter.type='search';filter.placeholder='按标题或待核对问题查找';filter.setAttribute('aria-label','筛选重点证据');
  const ask=button('rhine-inbox-ask','交给 Agent 整理 ↗',()=>{if(!board||!options.ask||busy)return;const target=board;busy=true;paint();void options.ask(target.id,target.title).then(()=>options.notify('已请 Agent 继续整理这块调查板的证据盒。')).catch(fail).finally(()=>{busy=false;paint();});});ask.hidden=!options.ask;
  tools.append(filter,ask);
  const list=el('div','rhine-inbox-list');list.setAttribute('role','list');
  const pager=el('div','rhine-inbox-pager'),prev=button('','← 上一页',()=>{page--;renderList();}),next=button('','下一页 →',()=>{page++;renderList();}),pageText=el('span');pager.append(prev,pageText,next);
  const details=el('div','rhine-inbox-details'),detailTitle=el('h3'),meta=el('p','rhine-inbox-meta'),note=el('p','rhine-inbox-note');
  const actions=el('div','rhine-inbox-actions'),read=button('rhine-inbox-read','阅读原文 ↗',()=>{const source=currentSource();if(source)options.read({...source,id:source.sourceId} as ArchiveSource);}),promote=button('rhine-inbox-promote','整理上板 ＋',()=>edit()),remove=button('rhine-inbox-remove','移出',()=>{if(selected)void mutate({action:'remove',source_id:selected});});actions.append(read,promote,remove);details.append(detailTitle,meta,note,actions);
  const form=el('form','rhine-inbox-form');form.hidden=true;
  const heading=el('input');heading.maxLength=120;heading.required=true;heading.setAttribute('aria-label','线索标题');
  const body=el('textarea');body.maxLength=12000;body.required=true;body.rows=5;body.setAttribute('aria-label','线索摘记');
  const kind=el('select');kind.setAttribute('aria-label','线索款式');for(const [value,label]of [['excerpt','原文摘录'],['finding','研究发现'],['question','未解问题'],['contrast','交叉对照'],['relation','关键关联'],['time','时间节点']]){const o=el('option','',label);o.value=value;kind.append(o);}
  const interpretation=el('select');interpretation.setAttribute('aria-label','核验状态');for(const [value,label]of [['question','待核验'],['observation','观察记录'],['inference','推断']]){const o=el('option','',label);o.value=value;interpretation.append(o);}
  const formOptions=el('div','rhine-inbox-form-options');formOptions.append(kind,interpretation);
  const submit=el('button','','保存线索并上板 ↗');submit.type='submit';const cancel=button('','取消',()=>{editing=false;paint();});
  const formActions=el('div','rhine-inbox-actions');formActions.append(cancel,submit);
  form.append(el('small','','整理成一条线索 · 原始来源会保留'),heading,body,formOptions,formActions);
  form.onsubmit=event=>{event.preventDefault();if(!busy&&heading.value.trim()&&body.value.trim())void mutate({action:'promote',source_id:selected,title:heading.value,detail:body.value,kind:kind.value,interpretation:interpretation.value});};
  content.append(title,subtitle,tools,list,pager,details,form);panel.append(header,content);host.append(entry,panel);
  const transition=new SurfaceTransition(panel,content,280,220);
  const pending=()=>board?.evidenceInbox?.filter((item:any)=>item.status==='pending')||[];
  const currentItem=()=>pending().find((item:any)=>item.source_id===selected);
  const currentSource=()=>sources.find(s=>s.id===selected);
  function scene(){const items=pending();options.scene({boardId:board?.id||'',title:board?.title||'',count:items.length,titles:items.slice(0,6).map((item:any)=>sources.find(s=>s.id===item.source_id)?.title||'待整理资料')},opened&&active);}
  function fail(error:any){if(!disposed)options.notify(error?.message||'证据盒同步失败，材料仍保留。');}
  async function mutate(payload:Record<string,unknown>){
    if(!board||busy)return;
    const target=board.id;busy=true;paint();
    try{const result:any=await options.mutate({board_id:target,expected_inbox_revision:board.inboxRevision,...payload});if(board?.id===target){editing=false;paint();}options.notify(result?.clue_id?'线索已放上证据板，原始资料仍可回查。':'已移出待整理区。');}
    catch(error){fail(error);}finally{busy=false;paint();}
  }
  function renderList(){
    const query=filter.value.trim().toLowerCase();const items=pending().filter((item:any)=>{const source=sources.find(s=>s.id===item.source_id);return !query||`${source?.title||''} ${item.note}`.toLowerCase().includes(query);});
    page=Math.max(0,Math.min(page,Math.ceil(items.length/6)-1));list.replaceChildren();
    if(!items.length)list.append(el('p','rhine-inbox-empty',query?'没有匹配的重点材料。':board?'暂时没有待整理的证据。\n可从检索阵列、档案架或原文页放入；Agent 也会挑选值得核对的资料。':'先选择或创建一块调查板，再收集重点证据。'));
    for(const item of items.slice(page*6,page*6+6)){
      const source=sources.find(s=>s.id===item.source_id),row=el('div','rhine-inbox-row');row.setAttribute('role','listitem');
      const select=button('rhine-inbox-select','',()=>{selected=item.source_id;editing=false;paint();});select.dataset.sourceId=item.source_id;select.setAttribute('aria-pressed',String(item.source_id===selected));select.disabled=busy;
      select.append(el('small','',`${item.addedBy==='user'?'手动选入':'Agent 筛选'} · ${source?.agentRead?'Agent 已读':'待核对原文'}`),el('strong','',source?.title||'资料暂不可用'),el('span','',item.note||'等待进一步核对与整理'));row.append(select);list.append(row);
    }
    prev.disabled=page===0||busy;next.disabled=(page+1)*6>=items.length||busy;pageText.textContent=`${items.length? page*6+1:0}–${Math.min((page+1)*6,items.length)} / ${items.length}`;pager.hidden=items.length<=6;
  }
  function edit(){const source=currentSource();if(!source)return;editing=true;heading.value=source.title.slice(0,120);body.value=(source.excerpt||currentItem()?.note||'').slice(0,12000);kind.value='excerpt';interpretation.value='question';paint();heading.focus();}
  function paint(){
    if(disposed)return;const items=pending();if(!items.some((item:any)=>item.source_id===selected)){selected=items[0]?.source_id||'';editing=false;}
    count.textContent=String(items.length).padStart(2,'0');entry.setAttribute('aria-label',`打开重点证据盒，${items.length} 份待整理材料`);entry.title=board?`${board.title} · ${items.length} 份待整理`:'重点证据盒';
    subtitle.textContent=board?`${board.title} · ${items.length} 份待整理材料`:'材料先暂存，整理后再上板';
    ask.disabled=busy||!board||!items.length;filter.disabled=busy;
    content.classList.toggle('is-editing',editing);renderList();const item=currentItem(),source=currentSource();details.hidden=!item||editing;form.hidden=!editing;
    if(item){detailTitle.textContent=source?.title||'资料暂不可用';meta.textContent=`${({source:'资料',web:'网页',story:'剧情原文',wiki:'Wiki',entity:'实体资料'} as Record<string,string>)[source?.kind]||source?.kind||'资料'} · ${source?.origin==='web'?'联网来源':source?.origin==='cloud'?'云端资料':'本地资料'} · ${source?.agentRead?'Agent 已读':'仅有返回摘要'}`;note.textContent=item.note||source?.excerpt||'等待核对原文。';}
    read.disabled=busy||!source;promote.disabled=busy||!source;remove.disabled=busy||!item;submit.disabled=cancel.disabled=heading.disabled=body.disabled=kind.disabled=interpretation.disabled=busy;
    syncEntry();scene();
  }
  function syncEntry(){
    entry.hidden=!active||opened;entry.setAttribute('aria-expanded',String(opened));
    entry.classList.toggle('is-anchored',anchor.visible);entry.style.left=anchor.visible?`${anchor.x}px`:'';entry.style.top=anchor.visible?`${anchor.y}px`:'';
  }
  function open(){if(!active)return;opened=true;host.classList.add('has-evidence-inbox');transition.show(motion.matches);paint();close.focus({preventScroll:true});}
  function hide(immediate=false){
    opened=false;scene();
    const done=()=>{host.classList.remove('has-evidence-inbox');syncEntry();if(active&&!immediate)entry.focus({preventScroll:true});};
    if(immediate){transition.dispose();panel.hidden=true;delete panel.dataset.transition;done();}else transition.hide(motion.matches,done);
  }
  function handleKeydown(event:KeyboardEvent){
    if(panel.hidden||!active||event.isComposing)return false;
    if(event.key==='Escape'){event.preventDefault();if(panel.dataset.transition!=='closing'){if(editing){editing=false;paint();promote.focus();}else hide();}return true;}
    if(event.key==='Tab'){const focusable=[...panel.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),textarea:not(:disabled),select:not(:disabled)')].filter(n=>n.getClientRects().length);const first=focusable[0],last=focusable.at(-1);if(first&&(!panel.contains(document.activeElement)||event.shiftKey&&document.activeElement===first||!event.shiftKey&&document.activeElement===last)){event.preventDefault();(event.shiftKey?last!:first).focus();}return true;}
    return panel.contains(event.target as Node);
  }
  motion.addEventListener('change',()=>{if(motion.matches)transition.finish();},{signal:events.signal});
  filter.oninput=()=>{page=0;renderList();};
  return {open,hide,handleKeydown,isOpen:()=>opened,
    setData(value:any,rows:any[]){const next=JSON.stringify([value?.id,value?.title,value?.inboxRevision,rows.map(s=>[s.id,s.title,s.agentRead])]);const changed=board?.id!==value?.id;board=value;sources=rows;if(changed){selected='';page=0;editing=false;filter.value='';hide(true);}if(signature!==next){signature=next;paint();}},
    setActive(value:boolean){active=value;if(!active)hide(true);syncEntry();},
    setAnchor(value:EvidenceInboxAnchor){anchor=value;syncEntry();},
    state(){return{boardId:board?.id||'',title:board?.title||'',count:pending().length,titles:pending().slice(0,6).map((item:any)=>sources.find(s=>s.id===item.source_id)?.title||'待整理资料')};},
    stats(){return{open:opened,count:pending().length,boardId:board?.id||'',selected,editing,busy};},
    dispose(){disposed=true;transition.dispose();events.abort();host.classList.remove('has-evidence-inbox');entry.remove();panel.remove();}
  };
}
