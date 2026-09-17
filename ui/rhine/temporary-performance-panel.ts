// TEMPORARY RHINE PROFILER — remove this module and its marked workbench hooks after testing.
import { RenderPerformanceCapture, summarizeFrames } from './temporary-performance';
import './temporary-performance.css';

const ms = (n: number | null | undefined) => n == null ? '—' : n.toFixed(2);
const count = (n: number | null | undefined) => n == null ? '—' : Math.round(n).toLocaleString();
const states: Record<string, string> = { array: '阵列', rack: '档案架', detail: '抽出 / 阅读', travel: '移动到档案架', viewer: '360° 模型' };
const stateLabel = (state: string) => state.split(':').map(s => states[s] || ({ search: '检索', activity: '资料动画' }[s]) || s).join(' · ');

export function mountTemporaryPerformancePanel(root: HTMLElement, metadata: () => unknown) {
  const capture = new RenderPerformanceCapture();
  capture.longTasksSupported = typeof PerformanceObserver !== 'undefined' && PerformanceObserver.supportedEntryTypes?.includes('longtask') === true;
  const container = document.createElement('div');
  container.className = 'rhine-perf-tools';
  container.innerHTML = `<button type="button" class="rhine-perf-toggle" aria-expanded="false">性能测试 · 临时</button>
    <section class="rhine-perf-panel" aria-label="临时渲染性能测试" hidden>
      <header><strong>渲染性能 / 临时测试</strong><button type="button" data-perf="close" aria-label="收起性能面板">收起 ×</button></header>
      <p>开始后正常检索、滚动和抽出档案。收起面板仍会采样。</p>
      <div class="rhine-perf-controls"><label>时长 <select aria-label="性能测试时长"><option value="30">30 秒</option><option value="60" selected>60 秒</option><option value="120">120 秒</option></select></label><button type="button" data-perf="start">开始测试</button><button type="button" data-perf="stop" disabled>停止</button><button type="button" data-perf="export" disabled>导出 JSON</button></div>
      <div class="rhine-perf-status" role="status">尚未开始</div>
      <div class="rhine-perf-current">请等模型载入后开始。</div>
      <canvas width="680" height="110" class="rhine-perf-chart" aria-label="最近 120 帧的帧间隔曲线，横线为 16.7 与 33.3 毫秒"></canvas>
      <table><caption>本次累计 · 单位 ms</caption><thead><tr><th>测量项</th><th>平均</th><th>P95</th><th>最高</th></tr></thead><tbody></tbody></table>
      <div class="rhine-perf-resources"></div><div class="rhine-perf-gpu"></div><div class="rhine-perf-tasks"></div>
      <details><summary>如何读数</summary><p>帧间隔越长，卡顿越明显；P95 表示 95% 的样本不超过此值。60 帧的单帧预算是 16.7 ms。FPS 是渲染回调频率，不保证屏幕实际呈现帧数。</p><p>CPU 是场景更新和绘制提交耗时；GPU 包含阴影、透射与后处理。两者不能相加，也不代表占用率。页面长任务补充记录渲染回调之外的阻塞。</p><p>资源显示数量，无法读取整卡显存或 GPU 占用率。切到后台时断开帧间隔统计，恢复后继续。首次出现的卡顿会保留；可先预热，再另开一次测试。记录只导出到本机。</p></details>
    </section>`;
  root.append(container); // Outside the scaled stage and viewer's inert siblings.
  const get = <T extends HTMLElement = HTMLElement>(selector: string) => container.querySelector<T>(selector)!;
  const toggle = get<HTMLButtonElement>('.rhine-perf-toggle'), panel = get('.rhine-perf-panel');
  const start = get<HTMLButtonElement>('[data-perf=start]'), stop = get<HTMLButtonElement>('[data-perf=stop]');
  const download = get<HTMLButtonElement>('[data-perf=export]');
  const graph = get<HTMLCanvasElement>('canvas'), graphContext = graph.getContext('2d');
  let interval = 0, active = true, observer: PerformanceObserver | undefined, collecting = false;
  const events = new AbortController();
  const longTasks = (entries: PerformanceEntry[]) => {
    if (active && !document.hidden) for (const entry of entries) capture.addLongTask(entry.startTime, entry.duration);
  };
  const finishObserver = () => {
    if (observer) { longTasks(observer.takeRecords()); observer.disconnect(); observer = undefined; }
    if (collecting) { capture.endMetadata = metadata(); collecting = false; }
  };
  const paint = () => {
    capture.poll();
    if (!capture.running) finishObserver();
    toggle.textContent = capture.running ? `● 测试中 ${Math.floor(capture.elapsedMs / 1000)}s` : '性能测试 · 临时';
    if (!panel.hidden) {
      const samples = capture.samples, latest = samples.at(-1);
      const summary = summarizeFrames(samples);
      const recentEnd = capture.running ? capture.elapsedMs : latest?.at || 0;
      const recent = samples.filter(s => s.at >= recentEnd - 2000);
      const fps = summarizeFrames(recent).fps;
      start.disabled = capture.running || capture.pendingGpu > 0;
      stop.disabled = !capture.running; download.disabled = !samples.length || capture.running || capture.pendingGpu > 0;
      start.textContent = samples.length ? '开始新测试' : '开始测试';
      get('.rhine-perf-status').textContent = `${capture.running ? !active || document.hidden ? '采样中 · 页面未激活' : '采样中' : samples.length ? '已停止' : '尚未开始'} · ${(capture.elapsedMs / 1000).toFixed(1)}s · ${samples.length} 帧${capture.pendingGpu ? ` · GPU 待回读 ${capture.pendingGpu}` : ''}`;
      get('.rhine-perf-current').textContent = latest ? `${stateLabel(latest.state)} · 最近 2 秒 ${ms(fps)} FPS · ${latest.width} × ${latest.height}` : '请等模型载入后开始。';
      get('tbody').innerHTML = [ ['帧间隔', summary.frameMs], ['CPU 场景帧', summary.cpuMs], ['GPU 整帧', summary.gpuMs] ]
        .map(([label, value]) => { const d = value as typeof summary.frameMs; return `<tr><th>${label}</th><td>${ms(d.mean)}</td><td>${ms(d.p95)}</td><td>${ms(d.max)}</td></tr>`; }).join('');
      get('.rhine-perf-resources').textContent = latest ? `最近一帧：${count(latest.triangles)} 三角形 / ${latest.calls} 次绘制（含多遍）\n资源：${latest.geometries} 几何 / ${latest.textures} 纹理 / ${latest.programs} 着色程序` : '';
      const adapter = capture.adapters.find(a => a.name === latest?.renderer);
      get('.rhine-perf-gpu').textContent = adapter ? `${adapter.software ? '软件渲染器 · 不能代表硬件表现\n' : ''}${adapter.renderer}\n${adapter.gpuTimerSupported ? `GPU 有效样本 ${summary.gpuMs.count}/${samples.length}；跳过/无效 ${samples.length - summary.gpuMs.count - capture.pendingGpu}` : '浏览器不支持 GPU 计时；GPU 耗时不作推算。'}` : '';
      get('.rhine-perf-tasks').textContent = `帧间隔 >33.3ms：${summary.over33ms} 次；>50ms：${summary.over50ms} 次\n${capture.longTasksSupported ? `页面长任务：${capture.longTasks.length} 次，最长 ${ms(capture.longTasks.reduce((max, t) => Math.max(max, t.durationMs), 0))} ms` : '浏览器不支持页面长任务观测'}`;
      if (graphContext) {
        const ctx = graphContext, tail = samples.slice(-120);
        const ceiling = Math.max(50, ...tail.map(s => s.intervalMs || 0));
        ctx.clearRect(0, 0, graph.width, graph.height);
        ctx.font = '18px sans-serif';
        for (const line of [16.67, 33.34]) { const y = 108 - line / ceiling * 98; ctx.strokeStyle = '#bbc0b3'; ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(680, y); ctx.stroke(); ctx.fillStyle = '#676e5f'; if (ceiling < 90) ctx.fillText(`${line.toFixed(1)} ms`, 6, y - 2); }
        if (ceiling >= 90) ctx.fillText('16.7 / 33.3 ms', 6, 100);
        ctx.fillText(`${Math.ceil(ceiling)} ms`, 565, 20);
        ctx.strokeStyle = '#96734d'; ctx.lineWidth = 2; ctx.beginPath();
        let move = true;
        tail.forEach((s, i) => { if (s.intervalMs === null) { move = true; return; } const x = i / 119 * 680, y = 108 - s.intervalMs / ceiling * 98; if (move) ctx.moveTo(x, y); else ctx.lineTo(x, y); move = false; }); ctx.stroke();
      }
    }
    if (panel.hidden && !capture.running && !capture.pendingGpu) { clearInterval(interval); interval = 0; }
  };
  const wake = () => { if (!interval) interval = window.setInterval(paint, 500); paint(); };
  const show = (visible: boolean) => { panel.hidden = !visible; toggle.setAttribute('aria-expanded', String(visible)); wake(); };
  toggle.addEventListener('click', () => show(panel.hidden));
  get('[data-perf=close]').addEventListener('click', () => { show(false); toggle.focus(); });
  start.addEventListener('click', () => {
    finishObserver(); capture.start(metadata(), Number(get<HTMLSelectElement>('select').value)); collecting = true;
    capture.longTasksSupported = typeof PerformanceObserver !== 'undefined' && PerformanceObserver.supportedEntryTypes?.includes('longtask') === true;
    if (capture.longTasksSupported) {
      observer = new PerformanceObserver(list => longTasks(list.getEntries()));
      observer.observe({ type: 'longtask', buffered: false });
    }
    wake();
  });
  stop.addEventListener('click', () => { capture.stop(); paint(); });
  download.addEventListener('click', () => {
    if (capture.running || capture.pendingGpu) return;
    const blob = new Blob([JSON.stringify(capture.report(), null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob), link = document.createElement('a');
    link.href = url; link.download = `rhine-performance-${capture.startedISO.replace(/[:.]/g, '-')}.json`; link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  // Local keyboard/wheel interaction must not rotate or navigate the model behind the panel.
  for (const name of ['keydown', 'wheel', 'pointerdown']) container.addEventListener(name, e => e.stopPropagation());
  document.addEventListener('visibilitychange', () => capture.breakTimeline(document.hidden ? 'hidden' : 'visible'), { signal: events.signal });
  return { capture,
    setActive(value: boolean) { if (active !== value) capture.breakTimeline(value ? 'workbench-active' : 'workbench-inactive'); active = value; },
    dispose() { capture.stop('dispose'); finishObserver(); clearInterval(interval); events.abort(); capture.dispose(); container.remove(); },
  };
}
