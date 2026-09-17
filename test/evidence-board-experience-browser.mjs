import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, writeFile, mkdtemp } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
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

async function configure(page) {
  await page.route('**/favicon.ico', route => route.fulfill({status: 204}));
  page.setDefaultTimeout(90000);
  page.on('pageerror', error => report.errors.push(error.message));
  page.on('console', message => {
    if (message.type() !== 'error') return;
    const entry = { text: message.text(), location: message.location() };
    (report.consoleErrors ||= []).push(entry);
    report.errors.push(`console.error: ${entry.text}`);
  });
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
        visibleArrays: mainScene?.children.filter(child=>child.isInstancedMesh&&child.visible).length||0,
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
      run(draw = false, frames = 1) { drawing = draw; budget = frames; enabled = true; for (const task of tasks.values()) if (!task.native) schedule(task); },
      get paused() { return !enabled; },
      cardPoints() {
        const canvas = document.querySelector('.rhine-scene canvas'), rect = canvas.getBoundingClientRect(), result = [];
        mainScene?.traverse(object => {
          if (!object.userData.evidenceCardId) return;
          const position = object.position.clone(); object.getWorldPosition(position); position.project(mainCamera);
          result.push({ id: object.userData.evidenceCardId, x: rect.left + (position.x + 1) * rect.width / 2, y: rect.top + (1 - position.y) * rect.height / 2 });
        }); return result;
      },
      printState() {
        const board = mainScene?.getObjectByName('Rhine_Evidence_Board'), prints = [], backings = [], printedBackings = [];
        board?.traverse(object => {
          if (object.userData.evidenceCardId) prints.push({
            id: object.userData.evidenceCardId, layer: object.layers.mask,
            basic: object.material.isMeshBasicMaterial, depthWrite: object.material.depthWrite,
            depthTest: object.material.depthTest, toneMapped: object.material.toneMapped,
            shaderKey: object.material.customProgramCacheKey(),
            archivePrint: Boolean(object.material.map.userData.archivePrint),
            anisotropy: object.material.map.anisotropy, textureVersion: object.material.map.version,
            width: object.material.map.image.width, height: object.material.map.image.height,
          });
          if (object.userData.evidenceCardId) {
            const peers = object.parent.children.filter(peer => peer !== object && peer.isMesh && peer.layers.mask === 1
              && peer.material?.isMeshBasicMaterial && peer.material?.map === object.material.map
              && Math.abs(peer.position.z - object.position.z) < 1e-8);
            const backing = peers[0];
            printedBackings.push({ id: object.userData.evidenceCardId, count: peers.length,
              sharedMap: Boolean(backing && backing.material.map === object.material.map),
              sharedGeometry: Boolean(backing && backing.geometry === object.geometry),
              matchingScale: Boolean(backing && backing.scale.equals(object.scale)),
              depthWrite: Boolean(backing?.material.depthWrite), depthTest: Boolean(backing?.material.depthTest),
              textureId: object.material.map.uuid, geometryId: object.geometry.uuid,
            });
          }
          if (object.parent?.name === 'Pinned_Evidence_Card' && object.isMesh && object.material?.isMeshStandardMaterial)
            backings.push({ layer: object.layers.mask, depthWrite: object.material.depthWrite });
        });
        const qualityNode = document.querySelector('.rhine-scene[data-render-quality]') || document.querySelector('[data-render-quality]');
        return { prints, backings, printedBackings, quality: JSON.parse(qualityNode?.dataset.renderQuality || '{}'),
          maximumAnisotropy: mainRenderer?.capabilities.getMaxAnisotropy() };
      },
      linkState() {
        const board=mainScene.getObjectByName('Rhine_Evidence_Board'),pins=new Map(),links=[];board.updateWorldMatrix(true,true);
        board.traverse(object=>{if(object.userData.evidenceCardId){const pin=object.parent.getObjectByName('Evidence_Pushpin'),p=pin.position.clone();pin.getWorldPosition(p);board.worldToLocal(p);pins.set(object.userData.evidenceCardId,p);}});
        board.traverse(object=>{if(object.name==='Explicit_Evidence_Link'){
          const attr=object.geometry.attributes.position,average=start=>{let x=0,y=0;for(let i=0;i<5;i++){x+=attr.getX(start+i);y+=attr.getY(start+i);}return{x:x/5,y:y/5};};
          const a=average(0),b=average(attr.count-6),pa=pins.get(object.userData.from),pb=pins.get(object.userData.to);
          links.push({from:object.userData.from,to:object.userData.to,errorA:Math.hypot(a.x-pa.x,a.y-pa.y),errorB:Math.hypot(b.x-pb.x,b.y-pb.y)});
        }});return links;
      },
      room,
      projectBoard(x,y,z=.3) {
        const board=mainScene.getObjectByName('Rhine_Evidence_Board'),rect=mainRenderer.domElement.getBoundingClientRect();
        const p=board.position.clone().set(x,y,z);board.localToWorld(p);p.project(mainCamera);
        return {x:rect.left+(p.x+1)*rect.width/2,y:rect.top+(1-p.y)*rect.height/2};
      },
      resizeHandle() {
        const board=mainScene.getObjectByName('Rhine_Evidence_Board'), rect=mainRenderer.domElement.getBoundingClientRect();
        let handle; board.traverse(node=>{if(node.name==='Evidence_Paper_Resize_Handle'&&node.visible)handle=node;});
        if(!handle)return null;
        const p=handle.position.clone();handle.getWorldPosition(p);const local=board.worldToLocal(p.clone());p.project(mainCamera);
        return {x:rect.left+(p.x+1)*rect.width/2,y:rect.top+(1-p.y)*rect.height/2,local:{x:local.x,y:local.y,z:local.z}};
      },
      cameraFacing() {
        const board=mainScene.getObjectByName('Rhine_Evidence_Board');
        const normal=board.position.clone().set(0,0,1).applyQuaternion(board.quaternion);
        const view=mainCamera.position.clone();mainCamera.getWorldDirection(view);
        return view.dot(normal);
      },
      rememberRoom() { rememberedScene = mainScene; rememberedRenderer = mainRenderer; },
      traceTravel() { travelSamples.length = 0; sampleTravel(); tracing = true; },
      finishTravel() { tracing = false; return travelSamples.slice(); },
    };
  });
}
async function settle(page, draw = true) {
  await page.evaluate(() => window.boardProbe.run());
  await page.waitForFunction(() => window.rhineWorkbench?.stats().loaded && !window.rhineWorkbench.stats().movingCamera
    && window.rhineWorkbench.stats().renderedFrames > 65, undefined, { polling: 100 });
  const start = await page.evaluate(() => window.rhineWorkbench.stats().renderedFrames);
  await page.waitForFunction(frame => window.rhineWorkbench.stats().renderedFrames >= frame + 35, start, { polling: 100 });
  if (draw) {
    await page.evaluate(() => window.boardProbe.run(true));
    await page.waitForFunction(() => window.boardProbe.paused, undefined, { polling: 100 });
  }
}
async function capture(page, name) {
  const path = join(output, name + '.png'); await page.screenshot({ path });
  report.screenshots.push(path); console.log('SCREENSHOT', name);
}

try {
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1, reducedMotion: 'reduce' });
  await configure(page);
  await page.goto(new URL('?rhineView=board', preview).href, { waitUntil: 'domcontentloaded' });
  await settle(page, false);
  const stats = () => page.evaluate(() => window.rhineWorkbench.stats());
  const model = async () => (await stats()).board, board = async () => (await stats()).evidenceBoard;
  const data = () => page.evaluate(() => JSON.parse(localStorage.getItem('prts-rhine-evidence-board:v1:preview-local-v1'))?.cards);
  const current = async () => { const id = (await model()).selected; return (await board()).layout.find(card => card.id === id); };
  const mark = text => { report.checks.push(text); console.log('CHECK', text); };
  const shortcut = async key => { await page.evaluate(() => document.activeElement?.blur()); await page.keyboard.press(key); };
  const select = async id => {
    const p = (await page.evaluate(() => window.boardProbe.cardPoints())).find(card => card.id === id);
    assert(p); await page.mouse.click(p.x, p.y); assert.equal((await model()).selected, id);
  };
  const linksValid = async () => {
    const cards = await data(), ids = new Set(cards.map(card => card.id));
    for (const card of cards) for (const id of card.links || []) assert(ids.has(id), 'No dangling links');
    const endpoints = await page.evaluate(() => window.boardProbe.linkState());
    for (const link of endpoints) assert(link.errorA < 1e-5 && link.errorB < 1e-5, 'Ropes follow pins');
  };
  const resizeGesture = async (factor, finish = true) => {
    const card = await current(), handle = await page.evaluate(() => window.boardProbe.resizeHandle()); assert(handle);
    const target = await page.evaluate(({ card, handle, factor }) => window.boardProbe.projectBoard(
      card.x + (handle.local.x - card.x) * (2 * factor - 1), card.y + (handle.local.y - card.y) * (2 * factor - 1), handle.local.z), { card, handle, factor });
    await page.mouse.move(handle.x, handle.y); await page.mouse.down();
    await page.mouse.move(target.x, target.y, { steps: 8 });
    assert((await board()).resize?.moved, 'Corner gesture uses resize, not move');
    if (finish) await page.mouse.up();
  };
  await page.locator('.rhine-board-fullscreen-toggle').click(); await settle(page, false);
  await page.evaluate(() => window.boardProbe.rememberRoom());
  await select('preview:conclude');
  await page.locator('.rhine-evidence-collapse-tools').click();
  assert((await model()).editorCollapsed); assert.equal((await model()).selected, 'preview:conclude');
  const original = await current(), textures = await board();
  await resizeGesture(1.35, false);
  assert.equal((await model()).undoCount, 0); assert.equal((await board()).cardTextureUpdates, textures.cardTextureUpdates);
  assert.equal((await board()).textureCount, textures.textureCount);
  await page.mouse.up();
  const resized = await current(), id = (await model()).selected;
  assert(!id.startsWith('preview:')); assert(resized.scale > 1.3 && resized.scale < 1.4);
  assert.equal((await model()).undoCount, 1); await linksValid();
  await shortcut('Control+z'); assert.equal((await current()).scale, original.scale); assert.equal((await model()).selected, 'preview:conclude');
  await shortcut('Control+Shift+z'); assert.equal((await model()).selected, id); assert.equal((await current()).scale, resized.scale);
  mark('Selected corner resizes the paper directly; one gesture is one undo step, previews reuse textures, and undo/redo restores sample identities and all ropes.');

  const beforeCancel = await data(), historyBeforeCancel = (await model()).undoCount, resources = await board();
  await resizeGesture(.8, false); await shortcut('Escape'); await page.mouse.up();
  assert.equal((await board()).resize, null); assert.deepEqual(await data(), beforeCancel);
  assert.equal((await model()).undoCount, historyBeforeCancel); assert.equal((await current()).scale, resized.scale);
  assert.equal((await board()).cardTextureUpdates, resources.cardTextureUpdates);
  assert((await model()).editorCollapsed); assert((await model()).toolsOpen);
  mark('Escape cancels a corner drag without saving, closing the tools, changing selection, or uploading another paper texture.');

  // Paper centers remain draggable after adding the corner handle.
  const start = (await page.evaluate(() => window.boardProbe.cardPoints())).find(card => card.id === id);
  await page.mouse.move(start.x, start.y); await page.mouse.down(); await page.mouse.move(start.x - 50, start.y - 20, { steps: 5 }); await page.mouse.up();
  const moved = await current(); assert(Math.hypot(moved.x - resized.x, moved.y - resized.y) > .1);
  assert.equal(moved.scale, resized.scale); assert.equal((await model()).undoCount, historyBeforeCancel + 1);
  await shortcut('Control+z'); assert.deepEqual(await current(), resized);
  await shortcut('Control+y'); assert.deepEqual(await current(), moved);
  await linksValid();
  mark('Dragging the paper center still moves it; movement also supports undo/redo without changing its size.');

  // The selected item is already the starting point: no return to tools home or reselect.
  await page.locator('.rhine-evidence-collapse-tools').click();
  await page.locator('.rhine-evidence-connect-selected').click();
  assert.equal((await model()).tool.fromId, id);
  await shortcut('Escape'); assert.equal((await model()).selected, id); assert.equal((await model()).tool.mode, 'select');
  await shortcut('l'); assert.equal((await model()).tool.fromId, id);
  const linkCount = (await model()).links, beforeLink = await data();
  const target = (await page.evaluate(() => window.boardProbe.cardPoints())).find(card => card.id === 'preview:question');
  await page.mouse.click(target.x, target.y); assert.equal((await model()).links, linkCount + 1);
  assert.notEqual((await model()).selected, 'preview:question'); await linksValid();
  await shortcut('Control+z'); assert.deepEqual(await data(), beforeLink);
  await shortcut('Control+Shift+z'); assert.equal((await model()).links, linkCount + 1); await linksValid();
  mark('Selected-card connect and L start from that card; Escape preserves it, and connecting to a sample survives undo/redo with valid IDs.');

  const sourceId = (await model()).selected, source = (await data()).find(card => card.id === sourceId), countBeforeCopy = (await model()).cards;
  await shortcut('Control+d'); const copiedId = (await model()).selected;
  assert.equal((await model()).cards, countBeforeCopy + 1); assert.notEqual(copiedId, sourceId);
  const copied = (await data()).find(card => card.id === copiedId);
  assert.equal(copied.body, source.body); assert.equal(copied.sourceTitle, source.sourceTitle); assert.equal(copied.scale, source.scale); assert.deepEqual(copied.links, []);
  await shortcut('Delete'); assert.equal((await model()).cards, countBeforeCopy);
  await shortcut('Control+z'); assert.equal((await model()).selected, copiedId);
  await shortcut('Control+z'); assert.equal((await model()).cards, countBeforeCopy); assert.equal((await model()).selected, sourceId);
  await shortcut('Control+Shift+z'); await shortcut('Control+Shift+z'); assert.equal((await model()).cards, countBeforeCopy);
  mark('Copy preserves content and sources without adding accidental relationships; copy and delete each support reversible history.');

  await select(id);
  if ((await model()).editorCollapsed) await page.locator('.rhine-evidence-collapse-tools').click();
  const title = page.locator('.rhine-evidence-title-input'), beforeTitle = await title.inputValue(), beforeTextHistory = (await model()).undoCount;
  await title.focus(); await page.keyboard.press('End'); await page.keyboard.type('x'); await page.keyboard.press('Control+z');
  assert.equal(await title.inputValue(), beforeTitle); assert.equal((await model()).undoCount, beforeTextHistory);
  await title.fill(`${beforeTitle} · 核验`);
  await page.locator('.rhine-evidence-undo').click(); assert.equal(await title.inputValue(), beforeTitle);
  await page.locator('.rhine-evidence-redo').click(); assert.equal(await title.inputValue(), `${beforeTitle} · 核验`);
  mark('Typing keeps native text undo; board Undo flushes a pending draft as a recoverable operation and Redo brings it back.');

  // Hold a native range gesture past the old 250ms debounce boundary.
  const range = page.locator('.rhine-evidence-size-range'); const box = await range.boundingBox(); assert(box);
  const sliderHistory = (await model()).undoCount, beforeSlider = (await current()).scale;
  await page.mouse.move(box.x + box.width * .42, box.y + box.height / 2); await page.mouse.down();
  await page.mouse.move(box.x + box.width * .58, box.y + box.height / 2, { steps: 4 });
  await page.waitForTimeout(350); assert.equal((await model()).undoCount, sliderHistory);
  await page.mouse.move(box.x + box.width * .64, box.y + box.height / 2, { steps: 3 }); await page.mouse.up();
  assert.equal((await model()).undoCount, sliderHistory + 1);
  await shortcut('Control+z'); assert.equal((await current()).scale, beforeSlider);
  await shortcut('Control+Shift+z'); await linksValid();
  mark('Holding the size slider across a pause still commits one history step on release.');

  await page.mouse.move(1000, 1000); await settle(page, true); await capture(page, '01-direct-tools'); await page.evaluate(() => window.boardProbe.run());
  await page.setViewportSize({ width: 390, height: 844 }); await settle(page, false);
  const mobile = await page.evaluate(() => ({ points: window.boardProbe.cardPoints(), tools: document.querySelector('.rhine-evidence-tools').getBoundingClientRect().toJSON(), board: window.rhineWorkbench.stats().evidenceBoard }));
  assert(mobile.board.editorInset > .5);
  for (const point of mobile.points) assert(point.y > 0 && point.y < mobile.tools.top, 'Every paper center is above the mobile editor');
  report.mobileExpanded = mobile;
  await settle(page, true); await capture(page, '02-mobile-editor'); await page.evaluate(() => window.boardProbe.run());
  const selectedBeforeCollapse = (await model()).selected;
  await page.locator('.rhine-evidence-collapse-tools').click(); await settle(page, false);
  assert.equal((await model()).selected, selectedBeforeCollapse); assert((await model()).editorCollapsed);
  const compact = await page.locator('.rhine-evidence-tools').boundingBox(); assert(compact.height < 90);
  assert((await board()).editorInset < .15);
  await settle(page, true); await capture(page, '03-mobile-collapsed'); await page.evaluate(() => window.boardProbe.run());
  assert((await page.evaluate(() => window.boardProbe.room())).sameRenderer);
  mark('At 390px, the fullscreen camera fits papers above the editor; collapsing preserves selection and restores canvas space in the same renderer.');

  await page.locator('.rhine-evidence-close-tools').click(); await settle(page, false);
  const beforeFirstDrag = await stats(), sample = beforeFirstDrag.evidenceBoard.layout.find(card => card.id === 'preview:collect');
  const samplePoint = (await page.evaluate(() => window.boardProbe.cardPoints())).find(card => card.id === sample.id);
  await page.mouse.move(samplePoint.x, samplePoint.y); await page.mouse.down(); await settle(page, false);
  assert.equal((await model()).toolsOpen, false, 'Pressing to drag does not open an editor over the paper');
  const heldCamera = (await stats()).cameraPosition;
  assert(heldCamera.every((value, index) => Math.abs(value - beforeFirstDrag.cameraPosition[index]) < .001),
    'Holding a paper does not reframe the camera (allow subpixel damping residue)');
  await page.mouse.move(samplePoint.x + 18, samplePoint.y - 10, { steps: 5 }); await page.mouse.up();
  const movedSampleId = (await model()).selected, movedSample = await current();
  assert(!movedSampleId.startsWith('preview:')); assert(Math.abs(movedSample.x - sample.x) > .2);
  assert.equal((await model()).toolsOpen, false);
  await shortcut('Control+z'); assert.equal((await model()).selected, sample.id); assert.deepEqual(await current(), sample);
  await shortcut('Control+Shift+z'); assert.equal((await model()).selected, movedSampleId);
  await select(movedSampleId); await settle(page, false); assert((await model()).toolsOpen, 'A click still opens editing');
  await page.locator('.rhine-evidence-back-tools').click(); await page.locator('.rhine-evidence-tools-more > summary').click();
  const beforeClear = await data(); await page.locator('.rhine-evidence-clear-examples').click();
  assert.equal((await model()).examples, 0); assert((await data()).some(card => card.id === movedSampleId));
  await page.locator('.rhine-evidence-undo').click(); assert.deepEqual(await data(), beforeClear); await linksValid();
  mark('On narrow screens, a first drag leaves the editor closed and camera stable; a click opens it. Moved examples become user cards and survive clearing untouched samples.');

  const beforeAdd = await data(); await shortcut('n'); await settle(page, false);
  assert.equal((await model()).tool.mode, 'place');
  const emptySpot = await page.evaluate(() => window.boardProbe.projectBoard(0, -3.2));
  await page.mouse.click(emptySpot.x, emptySpot.y); assert.equal((await model()).cards, beforeAdd.length + 1);
  await shortcut('Control+z'); assert.deepEqual(await data(), beforeAdd);
  await shortcut('Control+Shift+z'); assert.equal((await model()).cards, beforeAdd.length + 1);
  await shortcut('Control+z'); assert.deepEqual(await data(), beforeAdd);
  mark('N places a new note on the board, and both the addition and its selection can be undone and redone.');

  await page.locator('.rhine-evidence-close-tools').click();
  await page.setViewportSize({ width: 1366, height: 900 }); await settle(page, false);
  await page.locator('.rhine-board-fullscreen-toggle').click(); await settle(page, false);
  await select(movedSampleId); await page.locator('.rhine-evidence-collapse-tools').click();
  const angledBefore = await current(), angledResources = await board();
  await resizeGesture(.85); const angledAfter = await current();
  assert(Math.abs(angledAfter.scale / angledBefore.scale - .85) < .015);
  assert.equal((await board()).cardTextureUpdates, angledResources.cardTextureUpdates); await linksValid();
  await settle(page, true); await capture(page, '04-perspective-resize'); await page.evaluate(() => window.boardProbe.run());
  mark('The corner handle also resizes correctly in the slanted shared scene with a CSS-scaled stage, without repainting the paper.');

  // A separate session cannot undo changes from this board; switching back preserves the saved content.
  const finalData = await data();
  const switchSession = sessionId => page.evaluate(sessionId => window.rhineWorkbench.update({ sessionId, running: false, searching: false, query: '', tool: '', sources: [], answer: '', records: [] }), sessionId);
  await switchSession('experience-other-session'); assert.equal((await model()).undoCount, 0); assert.equal((await model()).redoCount, 0);
  await switchSession('preview-local-v1'); assert.deepEqual(await data(), finalData);
  await page.reload({ waitUntil: 'domcontentloaded' }); await settle(page, false); assert.deepEqual(await data(), finalData);
  assert.equal((await model()).undoCount, 0);
  mark('Session changes isolate undo history, and board data survives switching and reloading.');
  assert.deepEqual(report.errors, []); report.final = await stats(); console.log('RESULT', JSON.stringify(report));
} finally {
  await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2)); await browser.close();
}
