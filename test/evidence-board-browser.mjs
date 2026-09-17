import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, writeFile, mkdtemp } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const root = fileURLToPath(new URL('../', import.meta.url));
const hostRequire = createRequire(join(process.env.PRTS_DSH_SOURCE_DIR || resolve(root, '../deepseek-harness'), 'package.json'));
const playwright = process.env.PRTS_PLAYWRIGHT_MODULE || hostRequire.resolve('playwright');
const { chromium } = await import(pathToFileURL(playwright).href);
const output = process.env.PRTS_BOARD_OUTPUT || await mkdtemp(join(tmpdir(), 'prts-evidence-board-'));
await mkdir(output, { recursive: true });
const preview = process.env.PRTS_RHINE_PREVIEW_URL || 'http://127.0.0.1:4177/';
const browser = await chromium.launch({ headless: true,
  ...(process.env.PRTS_BROWSER_EXECUTABLE ? { executablePath: process.env.PRTS_BROWSER_EXECUTABLE } : {}),
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const report = { errors: [], screenshots: [], checks: [], output };
try {
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, reducedMotion: 'reduce' });
  page.setDefaultTimeout(90000);
  page.on('pageerror', error => report.errors.push(error.message));
  // Advance intermediate frames without GL draws on SwiftShader; baking runs
  // outside RAF as in production. Endpoints render normally at product quality.
  await page.addInitScript(() => {
    const nativeRAF = requestAnimationFrame.bind(window), nativeCancel = cancelAnimationFrame.bind(window);
    const tasks = new Map(); let nextId = 0, enabled = true, inFrame = false, drawing = false, budget = 0, time = 1000;
    let mainScene, mainCamera, mainRenderer, rememberedScene, rememberedRenderer, tracing = false;
    const travelSamples = [];
    window.__THREE_DEVTOOLS__ = new EventTarget();
    window.__THREE_DEVTOOLS__.addEventListener('observe', event => {
      const renderer = event.detail;
      if (!renderer?.isWebGLRenderer) return;
      const render = renderer.render;
      renderer.render = function(scene, camera, ...args) {
        if (scene.children?.some(child => child.isInstancedMesh)) { mainScene = scene; mainCamera = camera; mainRenderer = this; }
        return render.call(this, scene, camera, ...args);
      };
    });
    for (const proto of [window.WebGLRenderingContext?.prototype, window.WebGL2RenderingContext?.prototype]) {
      if (!proto) continue;
      for (const name of ['drawArrays', 'drawElements', 'drawArraysInstanced', 'drawElementsInstanced', 'drawRangeElements']) {
        const draw = proto[name];
        if (draw) proto[name] = function(...args) { if (!inFrame || drawing) return draw.apply(this, args); };
      }
    }
    const room = () => {
      const board = mainScene?.getObjectByName('Rhine_Evidence_Board');
      const rack = mainScene?.getObjectByName('Rhine_Archive_Rack');
      const files = mainScene?.children.filter(child => child.userData?.sourceId) || [];
      return { board: Boolean(board), rack: Boolean(rack), boardVisible: Boolean(board?.visible), rackVisible: Boolean(rack?.visible),
        arrays: mainScene?.children.filter(child => child.isInstancedMesh).length || 0,
        files: files.length, visibleFiles: files.filter(file => file.visible).length,
        sameScene: mainScene === rememberedScene, sameRenderer: mainRenderer === rememberedRenderer,
      };
    };
    const sampleTravel = () => {
      const stats = window.rhineWorkbench.stats();
      travelSamples.push({ frame: stats.renderedFrames, cameraX: stats.cameraX, cameraPosition: stats.cameraPosition,
        fieldOfView: stats.fieldOfView, moving: stats.movingCamera, ...room(),
        sameCanvas: document.querySelector('.rhine-scene canvas') === window.boardCanvas,
      });
    };
    const pause = () => { enabled = false; for (const task of tasks.values()) { if (task.native) nativeCancel(task.native); task.native = 0; } };
    const schedule = task => {
      task.native = nativeRAF(() => {
        task.native = 0; if (!enabled) return; tasks.delete(task.id);
        const before = window.rhineWorkbench?.stats().renderedFrames;
        inFrame = true;
        try { task.callback(time += 50); } finally { inFrame = false; }
        if (tracing && window.rhineWorkbench?.stats().renderedFrames !== before) sampleTravel();
        if (drawing && window.rhineWorkbench?.stats().renderedFrames !== before && --budget <= 0) pause();
      });
    };
    window.requestAnimationFrame = callback => {
      const task = { id: ++nextId, callback, native: 0 }; tasks.set(task.id, task);
      if (enabled) schedule(task); return task.id;
    };
    window.cancelAnimationFrame = id => { const task = tasks.get(id); if (task?.native) nativeCancel(task.native); tasks.delete(id); };
    window.boardProbe = {
      run(draw = false, frames = 3) { drawing = draw; budget = frames; enabled = true; for (const task of tasks.values()) if (!task.native) schedule(task); },
      get paused() { return !enabled; },
      cardPoints() {
        const canvas = document.querySelector('.rhine-scene canvas'), rect = canvas.getBoundingClientRect(), result = [];
        mainScene?.traverse(object => {
          if (!object.userData.evidenceCardId) return;
          const position = object.position.clone(); object.getWorldPosition(position); position.project(mainCamera);
          result.push({ id: object.userData.evidenceCardId, x: rect.left + (position.x + 1) * rect.width / 2, y: rect.top + (1 - position.y) * rect.height / 2 });
        }); return result;
      },
      projectBoard(x, y) {
        const board = mainScene.getObjectByName('Rhine_Evidence_Board');
        const rect = mainRenderer.domElement.getBoundingClientRect();
        const point = board.position.clone().set(x, y, 0.3);
        board.localToWorld(point); point.project(mainCamera);
        return { x: rect.left + (point.x + 1) * rect.width / 2, y: rect.top + (1 - point.y) * rect.height / 2 };
      },
      room,
      rememberRoom() { rememberedScene = mainScene; rememberedRenderer = mainRenderer; },
      traceTravel() { travelSamples.length = 0; sampleTravel(); tracing = true; },
      finishTravel() { tracing = false; return travelSamples.slice(); },
    };
  });
  await page.goto(new URL('?rhineView=board', preview).href, { waitUntil: 'domcontentloaded' });
  const settle = async () => {
    await page.evaluate(() => window.boardProbe.run());
    await page.waitForFunction(() => window.rhineWorkbench?.stats().loaded && !window.rhineWorkbench.stats().movingCamera
      && window.rhineWorkbench.stats().renderedFrames > 65, undefined, { polling: 100 });
    // Let the camera's damped target settle after its travel ends.
    const start = await page.evaluate(() => window.rhineWorkbench.stats().renderedFrames);
    await page.waitForFunction(frame => window.rhineWorkbench.stats().renderedFrames >= frame + 35, start, { polling: 100 });
    await page.evaluate(() => window.boardProbe.run(true));
    await page.waitForFunction(() => window.boardProbe.paused, undefined, { polling: 100 });
  };
  const capture = async name => { const path = join(output, name + '.png'); await page.screenshot({ path }); report.screenshots.push(path); console.log('SCREENSHOT', name); };
  await settle();
  let stats = await page.evaluate(() => window.rhineWorkbench.stats());
  assert.equal(stats.location, 'board'); assert.equal(stats.board.cards, 6); assert.equal(stats.evidenceBoard.sameScene, true);
  assert(Math.abs(stats.cameraX - 29.7) < 0.001, 'the board occupies the middle station at X=29.7');
  assert(stats.evidenceBoard.connections > 0, 'explicit example relationships have physical strings');
  assert.equal(await page.locator('.rhine-scene canvas').count(), 1);
  const initialRoom = await page.evaluate(() => window.boardProbe.room());
  assert(initialRoom.arrays > 0 && initialRoom.boardVisible && initialRoom.rackVisible);
  await capture('board'); report.checks.push('One scene contains the raised board, array and visible archive rack.');
  const first = await page.evaluate(() => window.boardProbe.cardPoints()[0]);
  await page.mouse.click(first.x, first.y);
  await page.waitForFunction(() => window.rhineWorkbench.stats().board.selected !== null, undefined, { polling: 100 });
  await page.locator('.rhine-evidence-title-input').fill('手动预览 · 一条新的发现');
  await page.locator('.rhine-evidence-body-input').fill('从真实资料中摘录证据，并在这里补充自己的观察。');
  await page.locator('.rhine-evidence-save').click();
  await page.waitForFunction(() => window.rhineWorkbench.stats().board.examples === 5, undefined, { polling: 100 });
  await settle(); await capture('board-edit'); report.checks.push('Physical card picking, manual editing and example conversion.');
  const storedCards = () => page.evaluate(() => JSON.parse(localStorage.getItem('prts-rhine-evidence-board:v1:preview-local-v1')).cards);
  const firstSaved = (await storedCards())[0], beforeDrag = firstSaved.position;
  const draggable = await page.evaluate(id => window.boardProbe.cardPoints().find(card => card.id === id), firstSaved.id);
  await page.mouse.move(draggable.x, draggable.y); await page.mouse.down();
  await page.mouse.move(draggable.x + 60, draggable.y + 35, { steps: 6 }); await page.mouse.up();
  const afterDrag = (await storedCards())[0].position;
  assert(Math.hypot(afterDrag.x - beforeDrag.x, afterDrag.y - beforeDrag.y) > 0.2, 'dragging changes the stored paper position');
  report.checks.push('Dragging a pinned paper moves its strings and persists its position.');
  await page.locator('.rhine-evidence-back-tools').click();
  await page.locator('.rhine-evidence-tools-more > summary').click();
  await page.locator('.rhine-evidence-clear-examples').click();
  assert.equal(await page.evaluate(() => window.rhineWorkbench.stats().board.cards), 1);
  await page.locator('.rhine-evidence-template[data-template="note"]').click();
  assert.equal(await page.evaluate(() => window.rhineWorkbench.stats().board.tool.mode), 'place');
  const placement = await page.evaluate(() => {
    const point = window.boardProbe.projectBoard(-4, -1.7);
    return { ...point, onCanvas: document.elementFromPoint(point.x, point.y) === document.querySelector('.rhine-scene canvas') };
  });
  assert(placement.onCanvas, 'the new note is placed on a visible writing area, outside the floating tools');
  await page.mouse.move(placement.x, placement.y); await page.mouse.click(placement.x, placement.y);
  await page.waitForFunction(() => window.rhineWorkbench.stats().board.cards === 2, undefined, { polling: 100 });
  assert.equal(await page.evaluate(() => window.rhineWorkbench.stats().board.tool.mode), 'select');
  await page.locator('.rhine-evidence-title-input').fill('第二阶段的问题');
  await page.locator('.rhine-evidence-attributes > summary').click();
  await page.locator('.rhine-evidence-stage-input').selectOption('1');
  await page.locator('.rhine-evidence-kind-input').selectOption('question');
  await page.locator('.rhine-evidence-save').click();
  assert.deepEqual(await page.evaluate(() => window.rhineWorkbench.stats().board.byStage), [1, 1, 0]);
  const connectedId = (await storedCards())[0].id;
  await page.locator('.rhine-evidence-connections > summary').click();
  await page.locator('.rhine-evidence-link-target').selectOption(connectedId);
  await page.locator('.rhine-evidence-link-add').click();
  assert.equal(await page.evaluate(() => window.rhineWorkbench.stats().evidenceBoard.connections), 1);
  await page.locator('.rhine-evidence-link-remove').click();
  assert.equal(await page.evaluate(() => window.rhineWorkbench.stats().evidenceBoard.connections), 0);
  await page.locator('.rhine-evidence-link-target').selectOption(connectedId);
  await page.locator('.rhine-evidence-link-add').click();
  await page.locator('.rhine-evidence-remove').click();
  assert.equal(await page.evaluate(() => window.rhineWorkbench.stats().board.cards), 1);
  assert.equal(await page.evaluate(() => window.rhineWorkbench.stats().evidenceBoard.connections), 0);
  report.checks.push('Manual connections render, can be removed, and disappear with their endpoint.');
  await page.reload({ waitUntil: 'domcontentloaded' }); await settle();
  assert.equal(await page.evaluate(() => window.rhineWorkbench.stats().board.cards), 1);
  assert.equal(await page.evaluate(() => window.rhineWorkbench.stats().board.examples), 0);
  report.checks.push('Stage changes, removal and reload preserve manual cards without reviving examples.');
  // Populate only this isolated browser session with actual search results so
  // the surrounding rack can be inspected. No document or Agent state is invented.
  const fixtureSources = await page.evaluate(async () => {
    const response = await fetch('/rpc', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ endpoint: 'archive.search', payload: { query: '克丽斯腾' } }),
    });
    if (!response.ok) throw new Error(`Spatial fixture search failed: ${response.status}`);
    const result = await response.json();
    return (result.sources || []).slice(0, 6);
  });
  assert(fixtureSources.length > 0, 'spatial screenshots use real corpus results');
  await page.evaluate(sources => window.rhineWorkbench.update({ sessionId: 'preview-layout-spatial',
    running: false, searching: false, query: '', tool: '', sources, answer: '', records: [],
  }), fixtureSources);
  await page.evaluate(() => window.boardProbe.run());
  await page.waitForFunction(count => window.rhineWorkbench.stats().physicalFiles === count,
    fixtureSources.length, { polling: 100 });
  await settle();
  await page.evaluate(() => {
    window.boardCanvas = document.querySelector('.rhine-scene canvas');
    window.boardProbe.rememberRoom();
  });
  const expectedCameraX = { archive: 0, board: 29.7, desk: 35 };
  const assertStation = async zone => {
    const station = await page.evaluate(() => ({ ...window.rhineWorkbench.stats(), room: window.boardProbe.room(),
      sameCanvas: document.querySelector('.rhine-scene canvas') === window.boardCanvas,
    }));
    assert.equal(station.cameraLocation, zone);
    assert(Math.abs(station.cameraX - expectedCameraX[zone]) < 0.001, `${zone} uses its physical station coordinate`);
    assert(station.sameCanvas && station.room.sameRenderer && station.room.sameScene, `${zone} retains the renderer, scene and canvas`);
    assert(station.room.boardVisible && station.room.rackVisible && station.evidenceBoard.sameScene,
      `${zone} keeps both neighbouring stations visible`);
    assert.equal(station.room.files, fixtureSources.length);
    assert.equal(station.room.visibleFiles, fixtureSources.length, `${zone} keeps all prepared rack files visible`);
    (report.stations ||= []).push({ zone, cameraX: station.cameraX, cameraPosition: station.cameraPosition,
      fieldOfView: station.fieldOfView, room: station.room });
  };
  await assertStation('archive'); await capture('workspace-array');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.waitForFunction(() => !window.rhineWorkbench.stats().reducedMotion, undefined, { polling: 100 });
  await page.evaluate(() => window.boardProbe.traceTravel());
  for (const zone of ['desk', 'board', 'archive', 'board']) {
    await page.locator(`[data-zone="${zone}"]`).click(); await settle();
    await assertStation(zone);
    if (zone === 'desk') {
      const samples = await page.evaluate(() => window.boardProbe.finishTravel());
      report.directTravel = samples;
      assert(samples.length > 25, 'direct array-to-rack travel records intermediate camera frames');
      assert(Math.abs(samples[0].cameraX) < 0.001);
      assert(Math.abs(samples.at(-1).cameraX - 35) < 0.001);
      const middle = samples.findIndex(sample => sample.moving && Math.abs(sample.cameraX - 29.7) < 0.3);
      assert(middle > 0 && middle < samples.length - 1, 'direct travel passes through the board before reaching the rack');
      for (const [index, sample] of samples.entries()) {
        assert(sample.boardVisible && sample.rackVisible && sample.visibleFiles === fixtureSources.length,
          `direct travel frame ${index} retains neighbouring geometry`);
        assert(sample.sameCanvas && sample.sameRenderer && sample.sameScene, `direct travel frame ${index} retains the same room`);
        assert(sample.cameraPosition.every(Number.isFinite) && Number.isFinite(sample.fieldOfView));
        if (!index) continue;
        const previous = samples[index - 1], step = sample.cameraX - previous.cameraX;
        assert(step >= -0.001 && step < 5, `direct travel frame ${index} advances continuously without resetting X`);
        assert(Math.hypot(...sample.cameraPosition.map((value, axis) => value - previous.cameraPosition[axis])) < 15,
          `direct travel frame ${index} preserves a continuous camera pose`);
      }
      await capture('workspace-rack');
    }
  }
  await capture('workspace-board');
  report.checks.push('All three stations preserve one renderer and their neighbouring geometry at X=0, 29.7 and 35.');
  report.checks.push('Direct array-to-rack travel crosses the board continuously without hiding geometry or replacing the scene.');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.evaluate(() => window.rhineWorkbench.update({ sessionId: 'preview-layout-mobile',
    running: false, searching: false, query: '', tool: '', sources: [], answer: '', records: [],
  }));
  await page.locator('[data-zone="board"]').click();
  await page.setViewportSize({ width: 900, height: 1200 }); await settle(); await capture('board-portrait');
  await page.setViewportSize({ width: 390, height: 844 }); await settle(); await capture('board-mobile');
  const mobileCard = await page.evaluate(() => window.boardProbe.cardPoints()[0]);
  await page.mouse.click(mobileCard.x, mobileCard.y);
  assert.equal(await page.locator('.rhine-evidence-editor').isVisible(), true);
  await capture('board-mobile-edit');
  report.checks.push('Portrait and mobile scene previews render.');
  const fallback = await browser.newPage({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
  fallback.on('pageerror', error => report.errors.push(error.message));
  await fallback.addInitScript(() => {
    const getContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function(type, ...args) {
      return /webgl/i.test(type) ? null : getContext.call(this, type, ...args);
    };
  });
  await fallback.goto(new URL('?rhineView=board', preview).href);
  await fallback.waitForSelector('.rhine-scene-unavailable');
  // The no-WebGL directory opens the same editing window; clearing examples
  // lives on its tools home rather than the old persistent side panel.
  await fallback.locator('.rhine-evidence-card-button').first().click();
  await fallback.locator('.rhine-evidence-back-tools').click();
  await fallback.locator('.rhine-evidence-tools-more > summary').click();
  await fallback.locator('.rhine-evidence-clear-examples').click();
  assert.equal(await fallback.evaluate(() => window.rhineWorkbench.stats().board.cards), 0);
  await fallback.locator('.rhine-evidence-browse').click();
  await fallback.waitForSelector('.rhine-result-pin');
  await fallback.locator('.rhine-result-pin').first().click();
  assert.equal(await fallback.evaluate(() => window.rhineWorkbench.stats().board.cards), 1);
  assert.equal(await fallback.evaluate(() => window.rhineWorkbench.stats().sourceCount), 0, 'pinning does not invent archive/Agent reading state');
  const sourceCards = await fallback.evaluate(() => JSON.parse(localStorage.getItem('prts-rhine-evidence-board:v1:preview-local-v1')).cards);
  assert(sourceCards[0].sourceId); assert.equal(sourceCards[0].kind, 'source');
  await fallback.locator('.rhine-evidence-back-tools').click();
  await fallback.locator('.rhine-evidence-browse').click();
  await fallback.locator('.rhine-result-pin').first().click();
  assert.equal(await fallback.evaluate(() => window.rhineWorkbench.stats().board.cards), 1, 'a repeated source pin selects its existing paper');
  const switchSession = id => fallback.evaluate(sessionId => window.rhineWorkbench.update({
    sessionId, running: false, searching: false, query: '', tool: '', sources: [], answer: '', records: [],
  }), id);
  await switchSession('whiteboard-test-other-session');
  assert.equal(await fallback.evaluate(() => window.rhineWorkbench.stats().board.cards), 6);
  await switchSession('preview-local-v1');
  assert.equal(await fallback.evaluate(() => window.rhineWorkbench.stats().board.cards), 1);
  report.checks.push('Without WebGL, real source pinning remains available, deduplicates and isolates sessions.');
  await fallback.close();
  assert.deepEqual(report.errors, []);
  report.final = await page.evaluate(() => window.rhineWorkbench.stats());
} catch (error) {
  report.failure = error.stack || String(error);
  throw error;
} finally {
  await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2));
  await browser.close(); console.log('REPORT', output);
}
