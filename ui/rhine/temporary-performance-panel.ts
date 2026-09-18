// TEMPORARY RHINE PROFILER — remove this module and its marked workbench hooks after testing.
import { RenderPerformanceCapture, liveFrameSummary } from './temporary-performance';
import { observePerformance } from './temporary-performance-observers';
import './temporary-performance.css';

const ms = (n: number | null | undefined) => n == null ? '—' : n.toFixed(2);
const count = (n: number | null | undefined) => n == null ? '—' : Math.round(n).toLocaleString();
const states: Record<string, string> = { array: '阵列', rack: '档案架', detail: '抽出 / 阅读', travel: '移动到档案架', viewer: '360° 模型' };
const stateLabel = (state: string) => state.split(':').map(s => states[s] || ({ search: '检索', activity: '资料动画' }[s]) || s).join(' · ');

export function mountTemporaryPerformancePanel(root: HTMLElement, metadata: () => unknown, state: () => unknown = () => null) {
  const capture = new RenderPerformanceCapture();
  capture.longTasksSupported = typeof PerformanceObserver !== 'undefined' && PerformanceObserver.supportedEntryTypes?.includes('longtask') === true;
  const container = document.createElement('div');
  container.className = 'rhine-perf-tools';
  container.innerHTML = `<button type="button" class="rhine-perf-toggle" aria-expanded="false">性能测试 · 临时</button>
    <section class="rhine-perf-panel" aria-label="临时渲染性能测试" hidden>
      <header><strong>性能诊断 / v3.10</strong><button type="button" data-perf="close" aria-label="收起性能面板">收起 ×</button></header>
      <p>保持日常使用即可，收起面板仍采集完整日志。可先录制 120 秒静置，再单独录制操作过程。</p>
      <div class="rhine-perf-controls"><label>时长 <select aria-label="性能测试时长"><option value="30">30 秒</option><option value="60" selected>60 秒</option><option value="120">120 秒</option></select></label><button type="button" data-perf="start">开始测试</button><button type="button" data-perf="stop" disabled>停止</button><button type="button" data-perf="export" disabled>导出 JSON</button></div>
      <div class="rhine-perf-controls"><label><input type="checkbox" data-perf="gpu" checked> GPU 计时</label><label><input type="checkbox" data-perf="detailed" checked> 详细诊断（抽样）</label><button type="button" data-perf="mark" disabled>标记刚才的卡顿</button><span>关闭详细诊断或 GPU 计时可对照采集开销</span></div>
      <div class="rhine-perf-status" role="status">尚未开始</div>
      <div class="rhine-perf-current">请等模型载入后开始。</div>
      <canvas width="680" height="110" class="rhine-perf-chart" aria-label="最近 120 帧的实际回调间隔曲线，横线为 16.7 与 33.3 毫秒"></canvas>
      <table><caption>最近 2 秒（最多 512 帧）· 单位 ms</caption><thead><tr><th>测量项</th><th>平均</th><th>P95</th><th>P99</th><th>最高</th></tr></thead><tbody></tbody></table>
      <div class="rhine-perf-resources"></div><div class="rhine-perf-gpu"></div><div class="rhine-perf-tasks"></div>
      <details><summary>如何读数</summary><p>实际回调间隔越长，停顿越明显；RAF 时间戳差单独保留在日志中。P95 表示 95% 的样本不超过此值。60 帧的单帧预算是 16.7 ms。FPS 是渲染回调频率，不保证屏幕实际呈现帧数。</p><p>CPU 是场景更新和绘制提交耗时；GPU 包含阴影、透射与后处理。两者不能相加，也不代表占用率。表格只统计最近窗口，全程数据和精确累计分位数保留在导出中。日志还记录绘制阶段、场景构成、资源加载生命周期、界面更新、长动画帧、交互延迟和后台档案准备。浏览器不支持的项目会明确注明。</p><p>资源显示数量，无法读取整卡显存或 GPU 占用率。切到后台时断开帧间隔统计，恢复后继续。首次出现的卡顿会保留；可先预热，再另开一次测试。记录只导出到本机；不采集正文或输入内容。JS 堆是浏览器估值，不能据此直接判断泄漏。新测试会覆盖未导出的记录。</p></details>
    </section>`;
  root.append(container); // Outside the scaled stage and viewer's inert siblings.
  const get = <T extends HTMLElement = HTMLElement>(selector: string) => container.querySelector<T>(selector)!;
  const toggle = get<HTMLButtonElement>('.rhine-perf-toggle'), panel = get('.rhine-perf-panel');
  const start = get<HTMLButtonElement>('[data-perf=start]'), stop = get<HTMLButtonElement>('[data-perf=stop]');
  const download = get<HTMLButtonElement>('[data-perf=export]');
  const labels = ['实际回调间隔', 'RAF 调度滞后', '帧外空档', 'CPU 场景帧', 'GPU 帧区间 / 分段合计', '逐帧采集开销'];
  const tbody = get('tbody');
  const cells = labels.map(label => {
    const row = document.createElement('tr'), heading = document.createElement('th');
    heading.textContent = label; row.append(heading);
    const values = Array.from({ length: 4 }, () => document.createElement('td'));
    row.append(...values); tbody.append(row); return values;
  });
  const textNodes = new Map<string, HTMLElement>();
  const setText = (selector: string, text: string) => {
    let node = textNodes.get(selector);
    if (!node) { node = get(selector); textNodes.set(selector, node); }
    if (node.textContent !== text) node.textContent = text;
  };
  const graph = get<HTMLCanvasElement>('canvas'), graphContext = graph.getContext('2d');
  const detailed = get<HTMLInputElement>('[data-perf=detailed]');
  const gpu = get<HTMLInputElement>('[data-perf=gpu]'), marker = get<HTMLButtonElement>('[data-perf=mark]');
  let interval = 0, active = true, disconnect: (() => void) | undefined, collecting = false;
  const events = new AbortController();
  const finishObserver = () => {
    disconnect?.(); disconnect = undefined;
    if (collecting) { capture.endMetadata = metadata(); collecting = false; }
  };
  const paint = () => {
    const paintStart = performance.now();
    capture.poll();
    if (!capture.running) finishObserver();
    toggle.textContent = capture.running ? `● 测试中 ${Math.floor(capture.elapsedMs / 1000)}s` : '性能测试 · 临时';
    if (!panel.hidden) {
      const samples = capture.samples, latest = samples.at(-1);
      const recentEnd = capture.running ? capture.elapsedMs : latest?.at || 0;
      const summary = liveFrameSummary(samples, recentEnd);
      const recentMean = summary.callbackMs.mean;
      const fps = recentMean ? 1000 / recentMean : null;
      start.disabled = capture.running || capture.pendingGpu > 0;
      stop.disabled = !capture.running; download.disabled = !capture.startedISO || capture.running || capture.pendingGpu > 0;
      gpu.disabled = capture.running || capture.pendingGpu > 0; detailed.disabled = gpu.disabled; marker.disabled = !capture.running;
      start.textContent = samples.length ? '开始新测试' : '开始测试';
      setText(".rhine-perf-status", `${capture.running ? !active || document.hidden ? '采样中 · 页面未激活' : '采样中' : samples.length ? '已停止' : '尚未开始'} · ${(capture.elapsedMs / 1000).toFixed(1)}s · ${samples.length} 帧${capture.pendingGpu ? ` · GPU 待回读 ${capture.pendingGpu}` : ''}`);
      setText(".rhine-perf-current", latest ? `${stateLabel(latest.state)} · 最近 2 秒 ${ms(fps)} 回调/秒 · ${latest.width} × ${latest.height}${summary.truncated ? ' · 已达 512 帧窗口上限' : ''} · 加载中 ${capture.loadingState().active.length}` : '请等模型载入后开始。');
      [summary.callbackMs, summary.rafLagMs, summary.outsideFrameMs, summary.cpuMs, summary.gpuMs, summary.probeMs]
        .forEach((d, row) => [d.mean, d.p95, d.p99, d.max].forEach((value, col) => {
          const text = ms(value); if (cells[row][col].textContent !== text) cells[row][col].textContent = text;
        }));
      setText(".rhine-perf-resources", latest ? `最近一帧：${count(latest.triangles)} 三角形 / ${latest.calls} 次绘制（含多遍）\n资源：${latest.geometries} 几何 / ${latest.textures} 纹理 / ${latest.programs} 着色程序` : '');
      const adapter = capture.adapters.find(a => a.name === latest?.renderer);
      setText(".rhine-perf-gpu", adapter ? `${adapter.software ? '软件渲染器 · 不能代表硬件表现\n' : ''}${adapter.renderer}\n${!capture.options.gpuTiming ? '本次已关闭 GPU 计时，仍记录 CPU 和浏览器诊断。' : adapter.gpuTimerSupported ? `窗口内 GPU 有效样本 ${summary.gpuMs.count}/${summary.frames}；全程统计见导出` : '浏览器不支持 GPU 计时；GPU 耗时不作推算。'}` : '');
      setText(".rhine-perf-tasks", `窗口内实际回调间隔 >50ms：${summary.callbackOver50ms} 次；RAF >50ms：${summary.over50ms} 次\n${capture.longTasksSupported ? `页面长任务：${capture.longTasks.length} 次，最长 ${ms(capture.longTaskMaxMs)} ms` : '浏览器不支持页面长任务观测'}\n长动画帧：${capture.capabilities['long-animation-frame']?.active ? capture.diagnostics.longAnimationFrames.length + ' 次' : '不可用'}；交互记录：${capture.diagnostics.interactions.length}；心跳：${capture.diagnostics.heartbeat.length}`);
      if (graphContext) {
        const ctx = graphContext, tail = samples.slice(-120);
        const ceiling = Math.max(50, ...tail.map(s => s.callbackIntervalMs || 0));
        ctx.clearRect(0, 0, graph.width, graph.height);
        ctx.font = '18px sans-serif';
        for (const line of [16.67, 33.34]) { const y = 108 - line / ceiling * 98; ctx.strokeStyle = '#bbc0b3'; ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(680, y); ctx.stroke(); ctx.fillStyle = '#676e5f'; if (ceiling < 90) ctx.fillText(`${line.toFixed(1)} ms`, 6, y - 2); }
        if (ceiling >= 90) ctx.fillText('16.7 / 33.3 ms', 6, 100);
        ctx.fillText(`${Math.ceil(ceiling)} ms`, 565, 20);
        ctx.strokeStyle = '#96734d'; ctx.lineWidth = 2; ctx.beginPath();
        let move = true;
        tail.forEach((s, i) => { if (s.callbackIntervalMs === null) { move = true; return; } const x = i / 119 * 680, y = 108 - s.callbackIntervalMs / ceiling * 98; if (move) ctx.moveTo(x, y); else ctx.lineTo(x, y); move = false; }); ctx.stroke();
      }
    }
    capture.diagnostic('overhead', { kind: 'panel', visible: !panel.hidden, durationMs: performance.now() - paintStart }, paintStart);
    if (!capture.running && !capture.pendingGpu) { clearInterval(interval); interval = 0; }
  };
  const wake = () => { if (!interval) interval = window.setInterval(paint, 1000); paint(); };
  const show = (visible: boolean) => { capture.mark('profiler-panel', { visible }); panel.hidden = !visible; toggle.setAttribute('aria-expanded', String(visible)); wake(); };
  toggle.addEventListener('click', () => show(panel.hidden));
  get('[data-perf=close]').addEventListener('click', () => { show(false); toggle.focus(); });
  start.addEventListener('click', () => {
    finishObserver(); capture.start(metadata(), Number(get<HTMLSelectElement>('select').value), { gpuTiming: gpu.checked, detailed: detailed.checked }); collecting = true;
    disconnect = observePerformance(capture, root, () => ({ active, state: state() }));
    capture.mark('profiler-panel', { visible: !panel.hidden });
    wake();
  });
  marker.addEventListener('click', () => capture.mark('user-hitch-marker'));
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
