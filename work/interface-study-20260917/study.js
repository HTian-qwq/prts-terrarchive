const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const question = '《孤星》中，克丽斯腾为何执意飞向星空？';
const sources = [
  {title:'阿米娅 · 干员档案',category:'角色档案',group:'all',copy:'罗德岛的公开领袖，身边的人愿意追随她所相信的未来。关于她的记录，散落在干员档案与一次次共同经历之中。'},
  {title:'克丽斯腾 · 人物资料',category:'角色档案',group:'all',copy:'莱茵生命的总辖。她将目光投向天空之外，并将漫长的准备汇入万星园最后的航程。'},
  {title:'孤星 · 活动剧情',category:'剧情原文',group:'story',copy:'特里蒙的疑云、无法停止蓄能的能量井，以及万星园真正的航向。把不同人物留下的记录放在一起，才能看见这场调查的全貌。'},
  {title:'莱茵生命 · 机构资料',category:'机构与计划',group:'knowledge',copy:'理想、研究与不同的选择在这里相遇。同一项计划，在参与者、见证者与离开的人眼中，留下了不同的意义。'},
  {title:'赫默 · 干员档案',category:'角色档案',group:'all',copy:'在科学所能抵达的边界之外，她也关心每一次尝试将如何影响具体的人。她的选择为这场调查留下了另一条线索。'},
  {title:'万星园 · 计划关联',category:'机构与计划',group:'knowledge',copy:'弧光一号所宣称的目标，并不是万星园真正的航向。克丽斯腾最终越过星荚，在群星之间留下观测记录。'},
];
let sourceIndex = 0;
let state = 'idle';
let activeQuestion = question;
let view = 'research';
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
const coarsePointer = matchMedia('(pointer: coarse)');

function setView(next, focus = false) {
  view = next;
  $('.investigation-view').hidden = next !== 'research';
  $('.search-view').hidden = next !== 'search';
  $('.reading-view').hidden = next !== 'reading';
  $('.open-search').setAttribute('aria-expanded', String(next === 'search'));
  if (focus && next === 'search') $('#source-query').focus({preventScroll:true});
  resetParallax();
}
function setState(next) {
  state = next;
  document.body.dataset.state = next;
  setView('research');
  $$('.review-states button').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.previewState === next)));
  const idle = next === 'idle', complete = next === 'complete';
  $('.research-eyebrow').innerHTML = `RESEARCH <span>/</span> ${idle ? 'READY' : complete ? 'COMPLETE' : 'IN PROGRESS'}`;
  if (idle) $('.research-title').innerHTML = '从一条线索，<br>开始一场调查。';
  else if (activeQuestion === question) $('.research-title').innerHTML = '《孤星》中，克丽斯腾<br>为何执意飞向星空？';
  else $('.research-title').textContent = activeQuestion;
  $('.research-caption').textContent = idle ? '让散落的记录，慢慢连成答案。' : complete ? '线索已经汇合，答案仍有值得继续追问的地方。' : '循着人物与计划，核对每一条线索的来处。';
  $('.research-caption').hidden = complete;
  $('.question-form').hidden = !idle && !complete;
  $('#question').placeholder = complete ? '沿着这条线索，继续问…' : '有什么想查明的？';
  $('.question-line button').innerHTML = `${complete ? '继续追问' : '开始调查'} <span aria-hidden="true">↗</span>`;
  if (complete) $('#question').value = '';
  $('.question-example').hidden = !idle;
  $('.research-progress').hidden = idle;
  $('.progress-copy span').textContent = complete ? '调查完成 · 已整理来源与关键线索' : '正在交叉核对相关原文';
  $('.progress-copy').hidden = complete;
  $('.found-count').textContent = complete ? '18' : '12';
  $('.read-count').textContent = complete ? '14' : '08';
  $('.cited-count').textContent = complete ? '06' : '—';
  $('.report-trigger').hidden = !complete;
  $('.report-trigger').setAttribute('aria-expanded','false');
  $('.report-excerpt').hidden = true;
}
function setSource(index) {
  sourceIndex = (index + sources.length) % sources.length;
  const item = sources[sourceIndex];
  $('.source-title').textContent = item.title;
  $('.source-number').textContent = String(sourceIndex + 1).padStart(2,'0');
  $('.source-id').textContent = `S–${String(sourceIndex + 1).padStart(3,'0')}`;
  $('.category-control select').value = item.group;
  $('.reading-title').textContent = item.title;
  $('.reading-category').textContent = item.category;
  $('.reading-copy').textContent = item.copy;
}
function resetParallax() {
  $('.scene').style.removeProperty('--parallax-x');
  $('.scene').style.removeProperty('--parallax-y');
}
function parallaxAllowed() {
  return $('#parallax-toggle').checked && view !== 'reading' && $('#report-excerpt').hidden && !reducedMotion.matches && !coarsePointer.matches && !document.activeElement?.matches('input,select,textarea');
}
function closeMenus() {
  $('#session-menu').hidden = true;
  $('.more-trigger').setAttribute('aria-expanded','false');
}

$$('[data-preview-state]').forEach(button => button.addEventListener('click', () => setState(button.dataset.previewState)));
$('.question-form').addEventListener('submit', event => {
  event.preventDefault();
  const value = $('#question').value.trim();
  if (!value) { $('#question').focus(); return; }
  activeQuestion = value;
  setState('investigating');
});
$('.question-example').addEventListener('click', () => { $('#question').value = question; $('#question').focus(); });
$('.source-previous').addEventListener('click', () => setSource(sourceIndex - 1));
$('.source-next').addEventListener('click', () => setSource(sourceIndex + 1));
$('.category-control select').addEventListener('change', event => setSource(sources.findIndex(item => item.group === event.target.value)));
$('.read-source').addEventListener('click', () => { setSource(sourceIndex); setView('reading'); });
$('.open-search').addEventListener('click', () => { closeMenus(); setView(view === 'search' ? 'research' : 'search', true); });
$$('.back-to-research').forEach(button => button.addEventListener('click', () => { setView('research'); $('.open-search').focus({preventScroll:true}); }));
$('.source-search-form').addEventListener('submit', event => {
  event.preventDefault();
  const value = $('#source-query').value.trim();
  if (!value) return;
  const matches = sources.map((item,index) => ({...item,index})).filter(item => `${item.title}${item.copy}`.includes(value));
  const container = $('.inline-results');
  container.replaceChildren();
  const caption = document.createElement('p');
  caption.className = 'results-caption';
  caption.textContent = matches.length ? `找到 ${String(matches.length).padStart(2,'0')} 份资料` : '暂未找到对应资料，试试「孤星」或「克丽斯腾」。';
  container.append(caption);
  matches.forEach(item => {
    const button = document.createElement('button'); button.type='button';
    const label = document.createElement('span'); label.textContent='↗';
    button.append(document.createTextNode(item.title),label);
    button.addEventListener('click', () => { setSource(item.index); setView('reading'); });
    container.append(button);
  });
  container.hidden = false;
});
$('.more-trigger').addEventListener('click', () => {
  const opening = $('#session-menu').hidden;
  $('#session-menu').hidden = !opening;
  $('.more-trigger').setAttribute('aria-expanded',String(opening));
});
$$('[data-session]').forEach(button => button.addEventListener('click', () => {
  closeMenus();
  if (button.dataset.session === 'new') { activeQuestion=question; $('#question').value=''; setState('idle'); }
  else setView('research');
  $('.more-trigger').focus({preventScroll:true});
}));
$('.report-trigger').addEventListener('click', () => {
  const opening = $('#report-excerpt').hidden;
  $('#report-excerpt').hidden = !opening;
  $('.report-trigger').setAttribute('aria-expanded',String(opening));
  resetParallax();
});
$('.back-chat').addEventListener('click', event => { event.preventDefault(); $('.return-notice').hidden = false; });
document.addEventListener('keydown', event => {
  if (event.key !== 'Escape' || event.isComposing) return;
  if (!$('#session-menu').hidden) { closeMenus(); $('.more-trigger').focus(); }
  else if (view !== 'research') { setView('research'); $('.open-search').focus({preventScroll:true}); }
  else if (!$('#report-excerpt').hidden) { $('#report-excerpt').hidden=true; $('.report-trigger').setAttribute('aria-expanded','false'); $('.report-trigger').focus(); }
});
document.addEventListener('pointerdown', event => { if (!event.target.closest('.top-actions')) closeMenus(); });
$('.workspace').addEventListener('pointermove', event => {
  if (event.pointerType !== 'mouse' || !parallaxAllowed()) return;
  const bounds = $('.workspace').getBoundingClientRect();
  const x = Math.max(-1,Math.min(1,(event.clientX-bounds.left)/bounds.width*2-1));
  const y = Math.max(-1,Math.min(1,(event.clientY-bounds.top)/bounds.height*2-1));
  $('.scene').style.setProperty('--parallax-x',`${(x*6).toFixed(2)}px`);
  $('.scene').style.setProperty('--parallax-y',`${(y*4).toFixed(2)}px`);
});
$('.workspace').addEventListener('pointerleave',resetParallax);
document.addEventListener('focusin', () => { if (!parallaxAllowed()) resetParallax(); });
$('#parallax-toggle').addEventListener('change',resetParallax);
reducedMotion.addEventListener('change',resetParallax);
coarsePointer.addEventListener('change',resetParallax);
setSource(0);
const requestedState = new URLSearchParams(location.search).get('state');
if (['idle','investigating','complete'].includes(requestedState)) setState(requestedState);
if (new URLSearchParams(location.search).has('capture')) document.body.classList.add('capture');
