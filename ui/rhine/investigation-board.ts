import { mountEvidenceInbox, type EvidenceInboxView, type EvidenceInboxAnchor } from './evidence-inbox';
import { READING_ENTER_MS, READING_RETURN_MS, READING_FADE_EASING, readingFrameTime, type ReadingObject } from './reading-object';
import { SurfaceTransition } from './original/ui-transitions';
import { createPreviewCards, evidenceStorageKey, parseEvidenceCards, type EvidenceCard } from './evidence-board-model';
import { investigationPositions, investigationClueIndex } from './investigation-layout';
import { renderReportMarkdown } from './report-markdown';
import type { ArchiveSource, BoardAnchorFrame } from './types';
import { boardPlaneTransform } from './board-plane-transform';
import { INVESTIGATION_BOARD_PLANE } from './investigation-board-plane';
import './investigation-board.css';

type Panel = { closeTools():void; getCards(): EvidenceCard[]; remapIds(mapping:Record<string,string>):void; replaceCards(cards: EvidenceCard[], reset?: boolean): void; select(id: string | null, edit?: boolean): void };
export interface InvestigationContext {
  sessionId: string;
  boards: { id: string; title: string }[];
  selectedId: string;
  workingId: string;
  ready: boolean;
}
type Options = { onContext?(value: InvestigationContext): void; sessionId: string; api(endpoint: string, payload?: any, signal?: AbortSignal): Promise<any>;
  panel: Panel; onInbox(value:EvidenceInboxView,open:boolean):void; askInbox?(boardId:string,title:string):Promise<void>; onReading(value: ReadingObject | null): void; onCards(cards: EvidenceCard[]): void; openSource(source: ArchiveSource, inbox?:boolean): void; notify(text: string): void };
const REPORT_ID = 'investigation-report';
const labels: Record<string, string> = { excerpt: '原文摘录', finding: '研究发现', time: '时间节点', relation: '关键关联', question: '未解问题', contrast: '交叉对照' };
const uid = () => crypto.randomUUID();
const clueSlot = investigationClueIndex;
const pageCount = (board:any) => Math.max(1,...activeClues(board).map((c:any)=>Math.floor(clueSlot(c)/12)+1));
const same = (a: any, b: any) => JSON.stringify(a) === JSON.stringify(b);
const activeClues = (board: any) => (board?.clues || []).filter((c: any) => !['superseded','retracted'].includes(c.status));
const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string) => { const n = document.createElement(tag); n.className = className; if (text !== undefined) n.textContent = text; return n; };

/** The viewed board is a browser preference; only investigation_open binds agent work. */
export function mountInvestigationBoard(host: HTMLElement, options: Options) {
  let sessionId = options.sessionId, board: any = null, catalog: any[] = [], sourceRows: any[] = [];
  let selectedId = '', workingId = '', followWorking = true, page = 0, commitSeq = 0, disposed = false, active = false;
  let contextReady = false;
  let syncing = false, saving = 0, refreshPending = false, loadEpoch = 0, loading = false;
  let baseline: EvidenceCard[] = [], sceneCards: EvidenceCard[] = [], revisions = new Map<string, any>();
  let aborter = new AbortController(), queue = Promise.resolve(), inboxStageQueue = Promise.resolve();
  const aliases = new Map<string,string>(), events = new AbortController();
  const hud = el('section', 'rhine-investigation-hud'); hud.hidden = true;
  hud.style.width = `${INVESTIGATION_BOARD_PLANE.pixelWidth}px`;
  hud.style.height = `${INVESTIGATION_BOARD_PLANE.pixelHeight}px`;
  let planeVisible = false;
  function setBoardFrame(frame: BoardAnchorFrame) {
    const transform = frame.visible && frame.surface.every(point => point.visible)
      ? boardPlaneTransform(frame.surface, INVESTIGATION_BOARD_PLANE.pixelWidth, INVESTIGATION_BOARD_PLANE.pixelHeight) : null;
    planeVisible = Boolean(transform);
    if (transform) hud.style.transform = transform;
    hud.hidden = !active || !planeVisible;
  }
  const header = el('div', 'rhine-investigation-heading');
  const index = el('span','rhine-investigation-index');
  index.append(el('b','','RHINE LAB'),el('small','','RESEARCH / 研究调查'));
  const picker = el('select','rhine-investigation-picker'); picker.setAttribute('aria-label','切换调查板');
  const status = el('span','rhine-investigation-status'); status.setAttribute('role','status');
  const follow = el('button','rhine-investigation-follow','查看工作板 ↗'); follow.type='button'; follow.hidden=true;
  const directory = el('button','rhine-investigation-directory','线索目录 ↗'); directory.type='button';
  const add = el('button','rhine-investigation-add','＋ 手动建板'); add.type='button';
  header.append(index,picker,status,follow,directory,add); hud.append(header);
  const footer=el('div','rhine-investigation-footer');
  const previous=el('button','','←'), next=el('button','','→'), paging=el('span','','');
  previous.type=next.type='button'; previous.setAttribute('aria-label','上一组线索'); next.setAttribute('aria-label','下一组线索');
  const hint=el('span','rhine-investigation-hint','重要线索随调查加入 · 点击阅读，双击编辑'); footer.append(hint,previous,paging,next);hud.append(footer);
  const empty=el('div','rhine-investigation-empty'); empty.append(el('small','','RESEARCH / READY'),el('h2','','从一个值得调查的问题开始'),el('p','','Agent 会在这里整理重要线索，并在中央留下报告。追问可以延续同一块板。'));hud.append(empty);
  const drawer=el('aside','rhine-investigation-drawer');drawer.hidden=true;drawer.setAttribute('aria-label','线索详情');
  const drawerTop=el('div','rhine-investigation-drawer-top'), close=el('button','','返回调查板 ↗');close.type='button';
  const drawerLabel=el('small','','');drawerTop.append(drawerLabel,close);const drawerBody=el('div','rhine-investigation-drawer-body');drawer.append(drawerTop,drawerBody);
  const report=el('section','rhine-investigation-report');report.hidden=true; report.setAttribute('role','dialog');report.setAttribute('aria-label','调查报告');report.tabIndex=-1;
  const reportHeader=el('header',''), reportLabel=el('span','','RESEARCH REPORT / 调查报告'), versions=el('select','');versions.setAttribute('aria-label','报告版本');
  const reportClose=el('button','','返回调查板 ↗');reportClose.setAttribute('aria-keyshortcuts','Escape');reportClose.type='button';reportHeader.append(reportLabel,versions,reportClose);
  const reportTitle=el('h2','',''), reportNotice=el('p','rhine-investigation-report-notice'),reportArticle=el('article','rhine-report-body');
  const reportIntro=el('div','rhine-investigation-report-intro');reportIntro.append(reportTitle,reportNotice);
  const reportScroll=el('div','rhine-investigation-report-scroll');reportScroll.tabIndex=0;reportScroll.append(reportIntro,reportArticle);
  report.append(reportHeader,reportScroll);host.append(hud,drawer,report);
  const motion=window.matchMedia('(prefers-reduced-motion: reduce)');
  const readingTransitions=new Map([[report,new SurfaceTransition(report,undefined,READING_ENTER_MS,READING_RETURN_MS,READING_FADE_EASING,READING_FADE_EASING,true)],
    [drawer,new SurfaceTransition(drawer,undefined,READING_ENTER_MS,READING_RETURN_MS,READING_FADE_EASING,READING_FADE_EASING,true)]]);
  let enterStartedAt:number|undefined,returnStartedAt:number|undefined;
  const inbox=mountEvidenceInbox(host,{
    scene:options.onInbox,notify:options.notify,ask:options.askInbox,
    read:source=>options.openSource(source,true),
    async mutate(payload){const currentSession=sessionId;try{const result=await request('inbox',{mutation_id:uid(),...payload});if(sessionId===currentSession)await refresh();return result;}catch(error){if(sessionId===currentSession)await refresh().catch(()=>{});throw error;}}
  });

  function syncReading(){
    options.onReading(!active?null:!report.hidden?{title:reportTitle.textContent||'调查报告',code:`REPORT / V${versions.value}`,kind:'report',enterStartedAt,returnStartedAt}:!drawer.hidden?{title:drawerBody.querySelector('h2')?.textContent||drawerLabel.textContent||'线索记录',code:drawerLabel.textContent?.split(' / ')[0]||'EVIDENCE',kind:'clue',enterStartedAt,returnStartedAt}:null);
  }
  function showReading(layer:HTMLElement){
    if(layer.hidden||!layer.dataset.transition){
      enterStartedAt=readingFrameTime();readingTransitions.get(layer)!.show(motion.matches);
    }
    syncReading();
  }
  const visibility=new MutationObserver(()=>{
    // Hiding a layer to open a source or leave the board must cancel its entrance,
    // otherwise its completion callback would make the old report visible again.
    for(const [layer,transition]of readingTransitions)if(layer.hidden){transition.dispose();delete layer.dataset.transition;}
    syncReading();
  });visibility.observe(report,{attributes:true,attributeFilter:['hidden']});visibility.observe(drawer,{attributes:true,attributeFilter:['hidden']});
  function cancelReturn(){
    if(returnStartedAt===undefined)return;
    returnStartedAt=undefined;
    for(const [layer,transition]of readingTransitions){transition.dispose();delete layer.dataset.transition;layer.removeAttribute('aria-busy');}
  }
  function closeReading(){
    if(returnStartedAt!==undefined)return;
    const layer=!report.hidden?report:!drawer.hidden?drawer:null;if(!layer)return;
    returnStartedAt=readingFrameTime();layer.setAttribute('aria-busy','true');syncReading();
    readingTransitions.get(layer)!.hide(motion.matches,()=>{
      report.hidden=true;drawer.hidden=true;returnStartedAt=undefined;layer.removeAttribute('aria-busy');syncReading();
      if(active&&!disposed)(picker.hidden?add:picker).focus({preventScroll:true});
    });
  }
  motion.addEventListener('change',()=>{if(motion.matches)for(const transition of readingTransitions.values())transition.finish();},{signal:events.signal});
  function handleKeydown(event:KeyboardEvent){
    if(inbox.handleKeydown(event))return true;
    const layer=!report.hidden?report:!drawer.hidden?drawer:null;if(!active||!layer||event.isComposing)return false;
    if(returnStartedAt!==undefined){event.preventDefault();return true;}
    if(event.key==='Escape'){event.preventDefault();closeReading();return true;}
    if(event.key==='Tab'){
      const focusable=[...layer.querySelectorAll<HTMLElement>('button:not(:disabled),a[href],input,textarea,select,summary,[tabindex="0"]')].filter(n=>n.getClientRects().length&&!n.closest('[hidden]'));
      const first=focusable[0],last=focusable.at(-1);
      if(first&&(!layer.contains(document.activeElement)||event.shiftKey&&document.activeElement===first||!event.shiftKey&&document.activeElement===last)){event.preventDefault();(event.shiftKey?last!:first).focus();}
    }
    return layer.contains(event.target as Node)||event.key==='Tab';
  }
  const preference=()=>`prts-investigation-view:${encodeURIComponent(sessionId)}`;
  function request(endpoint: string, payload: any = {}, signal=aborter.signal) { return options.api(`investigation.${endpoint}`,{ session_id:sessionId,...payload },signal); }
  function fail(error: any) { if (disposed || error?.name==='AbortError' || aborter.signal.aborted) return; status.textContent='同步未完成'; options.notify(error?.message || '调查板暂时无法同步，请稍后重试'); }
  function sourceFor(ref: any): ArchiveSource | null {
    const s=sourceRows.find(s=>s.id===ref.source_id);if(!s)return null;
    return { ...s,id:s.sourceId,excerpt:s.excerpt||'',state:s.state, ...(ref.line_start?{lineStart:ref.line_start,lineEnd:ref.line_end}:{}) } as ArchiveSource;
  }
  function toCards(): EvidenceCard[] {
    const clues=activeClues(board), offset=page*12, positions=investigationPositions(board?.clues || []);
    return clues.filter((c:any)=>clueSlot(c)>=offset&&clueSlot(c)<offset+12).map((c:any)=>{
      const i=clueSlot(c)%12;
      const source=sourceRows.find(s=>s.id===c.sources[0]?.source_id);
      const position=positions.get(c.id)||{x:0,y:2.65};
      return {id:c.id,contentRevision:c.contentRevision,layoutRevision:c.layoutRevision,title:c.title,body:c.detail||c.summary,summary:c.summary,clueKind:c.kind,variant:c.variant,
        evidenceLabel:c.interpretation==='inference'?'推断':c.kind==='question'?'待核验':c.sources.some((r:any)=>!sourceRows.find(s=>s.id===r.source_id)?.agentRead)?'含检索摘要':'已核对来源',
        kind:c.kind==='question'?'question':c.kind==='excerpt'?'source':'note',stage:c.status==='unresolved'?0:c.importance==='key'?2:1,
        position:c.position||position,rotation:c.rotation??[-1.6,.9,-.7][c.variant ?? i%3],scale:c.scale||1,
        sourceId:source?.sourceId,sourceTitle:source?.title,
        sourceLabel:[...new Set(c.sources.map((r:any)=>r.source_id))].join(' · '),
        relationKinds:Object.fromEntries(board.relations.filter((r:any)=>r.from===c.id).map((r:any)=>[r.to,r.type])),
        links:board.relations.filter((r:any)=>r.from===c.id).map((r:any)=>r.to)};
    });
  }
  function renderCards(reset=false) {
    if(saving){refreshPending=true;return;}
    baseline=toCards();revisions=new Map((board?.clues||[]).map((c:any)=>[c.id,{content:c.contentRevision,layout:c.layoutRevision}]));
    syncing=true;options.panel.replaceCards(baseline,reset);syncing=false;
    const latest=board?.reports.at(-1), running=catalog.find(b=>b.id===selectedId)?.run?.status==='running';
    sceneCards=board?[{id:REPORT_ID,title:latest?.title||(running?'调查进行中':'等待调查报告'),body:latest?.summary||'重要线索正在汇入，报告将在调查完成后发布。',kind:'note',stage:2,clueKind:'report',
      evidenceLabel:latest?`REPORT / V${String(latest.version).padStart(2,'0')}`:'RESEARCH / IN PROGRESS',sourceLabel:`${activeClues(board).length} 条线索 · ${latest?.sources?.length || 0} 份来源`,position:{x:0,y:0},rotation:0,scale:1},...baseline]:[];
    options.onCards(sceneCards);
  }
  function getContext(): InvestigationContext {
    return { sessionId, boards: catalog.map(({id,title})=>({id,title})), selectedId, workingId, ready: contextReady };
  }
  function holdReadingContext() {
    // A source detour must return to the same board even if the agent starts another investigation.
    followWorking=false;
    try { if(selectedId)localStorage.setItem(preference(),selectedId); } catch {}
  }
  function render() {
    options.onContext?.(getContext());
    inbox.setData(board,sourceRows);
    const value=selectedId;picker.replaceChildren();
    for(const row of catalog){const option=el('option','',`${row.title} · ${row.clueCount} 条线索`);option.value=row.id;picker.append(option);}picker.value=value;
    picker.disabled=!catalog.length;picker.hidden=!catalog.length;empty.hidden=!!board;directory.disabled=!board;
    follow.hidden=!workingId||workingId===selectedId;
    const row=catalog.find(b=>b.id===selectedId),latest=board?.reports.at(-1);
    status.textContent=saving?'正在保存…':loading?'正在同步…':!board?'尚无调查':row?.run?.status==='running'?'● Agent 正在整理':row?.run?.status==='interrupted'?'已暂停 · 线索已保留':latest?`报告 V${latest.version}${row?.reportStale?' · 有新线索待更新':''}`:'线索已保存';
    const pages=pageCount(board);previous.disabled=page===0;next.disabled=page>=pages-1;
    paging.textContent=`${page+1} / ${pages}  ·  ${activeClues(board).length} 条线索`;footer.hidden=!board;
  }
  async function refresh(reset=false) {
    if(disposed||saving){refreshPending=true;return;}
    const epoch=++loadEpoch;loading=true;
    const directory=await request('get',{limit:128});if(disposed||epoch!==loadEpoch)return;
    // Only the catalog snapshot may advance the watch cursor; a newer board read can race a catalog change.
    catalog=directory.boards;workingId=directory.workingBoardId||'';commitSeq=directory.commitSeq;
    const oldId=selectedId;
    if(followWorking&&workingId)selectedId=workingId;
    if(!catalog.some(b=>b.id===selectedId))selectedId=workingId||catalog[0]?.id||'';
    if(oldId!==selectedId){cancelReturn();page=0;drawer.hidden=true;report.hidden=true;}
    if(selectedId){const result=await request('get',{board_id:selectedId});if(disposed||epoch!==loadEpoch)return;board=result.board;sourceRows=result.sources;}else{board=null;sourceRows=[];}
    page=Math.min(page,pageCount(board)-1);loading=false;contextReady=true;renderCards(reset||oldId!==selectedId);render();
  }
  async function loop(generation: AbortController) {
    while(!disposed&&!generation.signal.aborted){
      try{if(saving){await queue;continue;}const value=await request('watch',{after:commitSeq},generation.signal);if(generation!==aborter)return;if(value.commitSeq>commitSeq)await refresh();}
      catch(error){if(generation.signal.aborted||disposed)return;status.textContent='连接暂断 · 保留当前内容';await new Promise<void>(resolve=>{const timer=setTimeout(resolve,3000);generation.signal.addEventListener('abort',()=>{clearTimeout(timer);resolve();},{once:true});});try{await refresh();}catch{}}
    }
  }
  function showClue(id:string) {
    cancelReturn();inbox.hide(true);
    const clue=board?.clues.find((c:any)=>c.id===id);if(!clue)return;
    options.panel.closeTools();options.panel.select(id,false);report.hidden=true;
    drawerLabel.textContent=`${clue.id} / ${labels[clue.kind]}`;drawerBody.replaceChildren();
    drawerBody.append(el('h2','',clue.title),el('p','rhine-investigation-provenance',`${clue.interpretation==='inference'?'推断':clue.interpretation==='question'?'待核验':'观察'} · ${clue.editedBy==='user'?'用户整理':'Agent 整理'}`));
    const content=el('div','rhine-investigation-clue-text rhine-markdown');renderReportMarkdown(content,clue.detail||clue.summary);drawerBody.append(content);
    const edit=el('button','','编辑这条线索 ↗');edit.type='button';edit.onclick=()=>{drawer.hidden=true;options.panel.select(id,true);};drawerBody.append(edit);
    drawerBody.append(el('h3','','来源与核验'));
    for(const ref of clue.sources){const source=sourceFor(ref);if(!source)continue;const button=el('button','rhine-investigation-source',`${source.agentRead?'已读':'检索摘要'} · ${source.title} ↗`);button.type='button';button.onclick=()=>options.openSource(source);drawerBody.append(button);if(ref.quote)drawerBody.append(el('blockquote','',ref.quote));}
    if(!clue.sources.length)drawerBody.append(el('p','','尚无来源，不能作为已核实结论。'));
    const relations=board.relations.filter((r:any)=>r.from===id||r.to===id);
    if(relations.length){
      drawerBody.append(el('h3','','关联线索'));
      const names:Record<string,string>={supports:'支持',contradicts:'存在矛盾',precedes:'时间在先',relates:'相关'};
      for(const relation of relations){
        const outgoing=relation.from===id,otherId=outgoing?relation.to:relation.from;
        const other=board.clues.find((c:any)=>c.id===otherId&&!['superseded','retracted'].includes(c.status));if(!other)continue;
        const meaning=outgoing?names[relation.type]:relation.type==='supports'?'得到支持':relation.type==='precedes'?'时间在后':names[relation.type];
        const button=el('button','rhine-investigation-source',`${meaning} · ${other.id}\n${other.title}${relation.label?'\n'+relation.label:''}`);button.type='button';
        button.onclick=()=>{page=Math.floor(clueSlot(other)/12);renderCards();render();showClue(other.id);};drawerBody.append(button);
      }
    }
    showReading(drawer);syncReading();
  }
  function showDirectory() {
    cancelReturn();inbox.hide(true);
    options.panel.closeTools();report.hidden=true;
    drawerLabel.textContent='INVESTIGATION / 全部线索';drawerBody.replaceChildren();
    for(const [i,c]of activeClues(board).entries()){const button=el('button','rhine-investigation-source',`${c.id} · ${labels[c.kind]}\n${c.title}`);button.type='button';button.onclick=()=>{page=Math.floor(clueSlot(c)/12);renderCards();render();showClue(c.id);};drawerBody.append(button);}showReading(drawer);syncReading();
  }
  function showReport(version?:number) {
    cancelReturn();inbox.hide(true);
    if(!board?.reports.length){options.notify('报告尚未发布，已保存的线索可以先阅读。');return;}
    options.panel.closeTools();
    versions.replaceChildren();for(const r of [...board.reports].reverse()){const o=el('option','',`V${r.version} · ${new Date(r.publishedAt).toLocaleString()}`);o.value=String(r.version);versions.append(o);}
    const r=board.reports.find((r:any)=>r.version===version)||board.reports.at(-1);versions.value=String(r.version);reportTitle.textContent=r.title;
    reportNotice.textContent=`${r.clues.length} 条依据 · ${r.sources.length} 份来源 · ${r.basisKnowledgeRevision!==board.knowledgeRevision?'发布后已有线索更新，以下保留当时版本':'已保存版本'}`;
    renderReportMarkdown(reportArticle,r.markdown.replace(/\[(C\d+)\](?!\()/g, (_match:string,id:string) => r.clues.some((c:any)=>c.id===id) ? `[${id}](#investigation-clue-${id})` : `[${id}]`));
    const details=el('details','rhine-investigation-report-evidence');details.append(el('summary','','查看此版本使用的线索与来源'));
    for(const c of r.clues){const heading=el('h3','',`${c.id} · ${c.title}`);heading.id=`investigation-clue-${c.id}`;details.append(heading,el('p','',c.summary));for(const ref of c.sources){const s=r.sources.find((s:any)=>s.id===ref.source_id);if(s){const button=el('button','rhine-investigation-source',`${s.title}${ref.line_start?` · L${ref.line_start}–${ref.line_end}`:''} ↗`);button.type='button';button.onclick=()=>options.openSource({...s,id:s.sourceId} as ArchiveSource);details.append(button);if(ref.quote)details.append(el('blockquote','',ref.quote));}}}reportArticle.append(details);
    reportArticle.onclick=event=>{const anchor=(event.target as HTMLElement).closest<HTMLAnchorElement>('a[href^="#investigation-clue-"]');if(!anchor)return;event.preventDefault();details.open=true;reportArticle.querySelector(anchor.getAttribute('href')!)?.scrollIntoView({block:'nearest'});};
    drawer.hidden=true;showReading(report);reportScroll.scrollTop=0;syncReading();report.focus({preventScroll:true});
  }
  function userChange(rawCards:EvidenceCard[]) {
    if(syncing||disposed)return;
    const cards=rawCards.map(c=>({...c,id:aliases.get(c.id)||c.id,links:c.links?.map(id=>aliases.get(id)||id)}));
    const before=baseline.map(c=>({...c,id:aliases.get(c.id)||c.id})), changes:any[]=[],relations:any[]=[];
    for(const c of cards){const old=before.find(o=>o.id===c.id),rev=revisions.get(c.id);
      if(!old)changes.push({client_key:c.id,position:c.position,scale:c.scale,rotation:c.rotation,sources:sourceRows.filter(s=>s.sourceId===c.sourceId).map(s=>({source_id:s.id})),title:c.title,summary:c.body.slice(0,480),detail:c.body,kind:c.clueKind|| (c.kind==='question'?'question':c.kind==='source'?'excerpt':'finding'),interpretation:'question'});
      else{
        if(c.title!==old.title||c.body!==old.body||c.kind!==old.kind||c.stage!==old.stage)changes.push({id:c.id,expected_content_revision:c.contentRevision??rev?.content,importance:c.stage===2?'key':'supporting',status:c.stage===0?'unresolved':'active',title:c.title,summary:c.body.slice(0,480),detail:c.body,kind:c.kind===old.kind?c.clueKind:c.kind==='question'?'question':c.kind==='source'?'excerpt':'finding'});
        if(!same(c.position,old.position)||c.scale!==old.scale||c.rotation!==old.rotation)changes.push({id:c.id,action:'layout',expected_layout_revision:c.layoutRevision??rev?.layout,position:c.position,scale:c.scale,rotation:c.rotation});
        for(const to of c.links||[])if(!old.links?.includes(to))relations.push({from:c.id,to,type:'relates'});
        for(const to of old.links||[])if(!c.links?.includes(to))relations.push({from:c.id,to,remove:true});
      }
    }
    for(const c of before)if(!cards.some(n=>n.id===c.id))changes.push({id:c.id,action:'retract',expected_content_revision:revisions.get(c.id)?.content});
    if(!changes.length&&!relations.length){options.onCards([...sceneCards.filter(c=>c.id===REPORT_ID),...cards]);return;}
    const target=selectedId,currentSession=sessionId;baseline=cards;saving++;render();
    options.onCards([...sceneCards.filter(c=>c.id===REPORT_ID),...cards]);
    queue=queue.then(async()=>{
      if(disposed||sessionId!==currentSession)return;
      let boardId=target;
      if(!boardId){const created=await request('create',{mutation_id:uid()});boardId=created.board_id;selectedId=boardId;followWorking=false;}
      const result=await request('edit',{mutation_id:uid(),board_id:boardId,changes,relations});
      for(const [from,to]of Object.entries(result.created_ids))aliases.set(from,to as string);
      options.panel.remapIds(result.created_ids);
    }).catch(error=>{
      const draft=JSON.stringify(cards,null,2);try{localStorage.setItem(`prts-investigation-draft:${currentSession}:${target}`,draft);}catch{}
      fail(error);drawerLabel.textContent='编辑尚未保存';drawerBody.replaceChildren(el('p','','内容出现冲突或同步失败，草稿已保留。复制下面的内容，刷新后可重新编辑。'));const area=el('textarea','');area.value=draft;area.readOnly=true;drawerBody.append(area);showReading(drawer);
    }).finally(async()=>{saving--;if(!saving&&!disposed&&sessionId===currentSession){refreshPending=false;try{await refresh();}catch(error){fail(error);}}});
  }
  async function migrate() {
    let cards:EvidenceCard[]=[];try{const raw=localStorage.getItem(evidenceStorageKey(sessionId));if(raw){const parsed=JSON.parse(raw);cards=parseEvidenceCards(parsed.cards);const previews=new Map(createPreviewCards().map(c=>[c.id,c]));cards=cards.filter(c=>{const original=previews.get(c.id);return !original||c.title!==original.title||c.body!==original.body;});}}catch{}
    if(cards.length)await request('import',{migration_id:`legacy:${sessionId}`,cards});
  }
  async function start() {
    const generation=aborter;
    try{const preferenceValue=localStorage.getItem(preference());selectedId=preferenceValue||'';followWorking=!preferenceValue;}catch{}
    try{await migrate();await refresh(true);if(generation===aborter&&!disposed)void loop(generation);}catch(error){fail(error);if(generation===aborter&&!disposed)void loop(generation);}
  }
  picker.onchange=()=>{selectedId=picker.value;followWorking=false;page=0;try{localStorage.setItem(preference(),selectedId);}catch{};void refresh(true).catch(fail);};
  follow.onclick=()=>{followWorking=true;page=0;try{localStorage.removeItem(preference());}catch{};void refresh(true).catch(fail);};
  previous.onclick=()=>{page=Math.max(0,page-1);renderCards(true);render();};next.onclick=()=>{page++;renderCards(true);render();};
  directory.onclick=showDirectory;close.onclick=closeReading;reportClose.onclick=closeReading;versions.onchange=()=>showReport(Number(versions.value));
  add.onclick=()=>{cancelReturn();options.panel.closeTools();report.hidden=true;drawerLabel.textContent='NEW / 新建手动调查';drawerBody.replaceChildren();const input=el('input','');input.placeholder='调查标题';input.maxLength=120;input.setAttribute('aria-label','新调查标题');const button=el('button','','创建调查板');button.type='button';button.onclick=async()=>{if(!input.value.trim())return;button.disabled=true;try{const r=await request('create',{mutation_id:uid(),title:input.value.trim()});selectedId=r.board_id;followWorking=false;drawer.hidden=true;await refresh(true);}catch(error){fail(error);button.disabled=false;}};drawerBody.append(input,button);showReading(drawer);input.focus();};
  void start();
  return { userChange, handleKeydown, getContext, holdReadingContext, getCards:()=>sceneCards, select(id:string|null,edit=false){cancelReturn();drawer.hidden=true;report.hidden=true;if(id===REPORT_ID){showReport();return;}if(id&&!edit)showClue(id);else options.panel.select(id,edit);},
    resumeReading(kind:'report'|'clue'|'inbox'){if(!active)return;if(kind==='inbox'){inbox.open();return;}cancelReturn();if(kind==='report'){showReading(report);report.focus({preventScroll:true});}else showReading(drawer);syncReading();},
    setBoardFrame, setInboxAnchor:(value:EvidenceInboxAnchor)=>inbox.setAnchor(value), getInboxState:()=>inbox.state(), openInbox(){options.panel.closeTools();cancelReturn();report.hidden=true;drawer.hidden=true;syncReading();inbox.open();},
    setActive(value:boolean){active=value;inbox.setActive(value);hud.hidden=!value||!planeVisible;if(!value){cancelReturn();drawer.hidden=true;report.hidden=true;}syncReading();},
    async setSession(id:string){if(id===sessionId)return;cancelReturn();aborter.abort();aborter=new AbortController();loadEpoch++;sessionId=id;board=null;selectedId='';workingId='';contextReady=false;catalog=[];sourceRows=[];baseline=[];aliases.clear();commitSeq=0;page=0;drawer.hidden=true;report.hidden=true;renderCards(true);render();await start();},
    stageSource(source:ArchiveSource,targetId?:string){
      const currentSession=sessionId,generation=aborter,targetAtClick=targetId ?? (workingId||selectedId);
      const send=(endpoint:string,payload:Record<string,unknown>)=>options.api(`investigation.${endpoint}`,{session_id:currentSession,...payload},generation.signal);
      const task=inboxStageQueue.then(async()=>{
        if(disposed||sessionId!==currentSession||generation.signal.aborted)return;
        if(loading||!catalog.length)await refresh();
        if(disposed||sessionId!==currentSession||generation.signal.aborted)return;
        let target=targetAtClick||workingId||selectedId;
        if(!target){const created=await send('create',{mutation_id:uid()});if(sessionId!==currentSession||generation.signal.aborted)return;target=created.board_id;selectedId=target;followWorking=false;}
        const current=await send('get',{board_id:target});
        await send('inbox',{mutation_id:uid(),board_id:target,expected_inbox_revision:current.board.inboxRevision,action:'add',source_id:source.id,sources:[source],note:''});
        if(sessionId===currentSession&&!disposed){await refresh();options.notify(`已放入「${current.board.title}」的重点证据盒。`);}
      });
      inboxStageQueue=task.catch(()=>{});return task;
    },
    async addSource(source:ArchiveSource){if(loading)await refresh();let target=selectedId;if(!target){const created=await request('create',{mutation_id:uid()});target=created.board_id;selectedId=target;followWorking=false;}await request('edit',{mutation_id:uid(),board_id:target,sources:[source],changes:[{title:source.title.slice(0,120),summary:source.excerpt.slice(0,480),detail:source.excerpt.slice(0,12000),kind:'excerpt',interpretation:'question',sources:[{source_id:source.id}]}]});await refresh();},
    dispose(){disposed=true;inbox.dispose();cancelReturn();for(const transition of readingTransitions.values())transition.dispose();visibility.disconnect();options.onReading(null);aborter.abort();events.abort();hud.remove();drawer.remove();report.remove();},
    stats(){return{inbox:inbox.stats(),selectedId,workingId,boards:catalog.length,clues:activeClues(board).length,reportVersions:board?.reports.length||0,reportOpen:!report.hidden,returning:returnStartedAt!==undefined,drawerOpen:!drawer.hidden,commitSeq,active,saving};},
  };
}
