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
      room,
      projectBoard(x,y,z=.3) {
        const board=mainScene.getObjectByName('Rhine_Evidence_Board'),rect=mainRenderer.domElement.getBoundingClientRect();
        const p=board.position.clone().set(x,y,z);board.localToWorld(p);p.project(mainCamera);
        return {x:rect.left+(p.x+1)*rect.width/2,y:rect.top+(1-p.y)*rect.height/2};
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
 const page=await browser.newPage({viewport:{width:1920,height:1080},deviceScaleFactor:1,reducedMotion:'reduce'});
 await configure(page);await page.goto(new URL('?rhineView=board',preview).href,{waitUntil:'domcontentloaded'});await settle(page,false);
 const stats=()=>page.evaluate(()=>window.rhineWorkbench.stats());
 const board=async()=>(await stats()).evidenceBoard;
 const model=async()=>(await stats()).board;
 const point=(x,y)=>page.evaluate(([x,y])=>window.boardProbe.projectBoard(x,y),[x,y]);
 const card=async(id)=>(await page.evaluate(()=>window.boardProbe.cardPoints())).find(p=>p.id===id);
 const click=async(p)=>{assert(p);await page.mouse.click(p.x,p.y);};
 const move=async(p)=>{assert(p);await page.mouse.move(p.x,p.y);};
 const saved=()=>page.evaluate(()=>JSON.stringify({...localStorage}));
 const mark=text=>{report.checks.push(text);console.log('CHECK',text);};
 const home=async()=>{if(!await page.locator('.rhine-evidence-back-tools').isHidden())await page.locator('.rhine-evidence-back-tools').click();};
 const checkProjection=async(label)=>{
  const result=await page.evaluate(()=>{
   const toolbar=document.querySelector('.rhine-board-toolbar'),style=getComputedStyle(toolbar),errors=[];
   for(const [x,y,bx,by]of [[0,0,3.67,4.32],[320,0,7.37,4.32],[320,45,7.37,3.80],[0,45,3.67,3.80]]){
    const dot=document.createElement('i');Object.assign(dot.style,{position:'absolute',left:`${x-parseFloat(style.borderLeftWidth)}px`,top:`${y-parseFloat(style.borderTopWidth)}px`,width:'0',height:'0'});toolbar.append(dot);
    const rect=dot.getBoundingClientRect(),target=window.boardProbe.projectBoard(bx,by,.181);errors.push(Math.hypot(rect.x-target.x,rect.y-target.y));dot.remove();
   }
   const rect=toolbar.getBoundingClientRect();return {errors,rect:rect.toJSON(),transform:style.transform,docked:toolbar.classList.contains('is-docked')};
  });assert(!result.docked);assert(Math.max(...result.errors)<.2,`${label} four corners remain on the board: ${JSON.stringify(result)}`);
  report.checks.push(label+': all four label corners agree with the actual 3D board to < 0.2 CSS px.');console.log('PROJECT',label,JSON.stringify(result));
 };
 const draw=async(name)=>{await settle(page,true);await capture(page,name);await page.evaluate(()=>window.boardProbe.run());};
 assert.equal((await board()).capacity,12);assert.equal((await board()).chalkMeshes,11);
 await checkProjection('oblique');await draw('01-board-tabs');
 await page.locator('.rhine-board-chalk-hit').click();assert((await model()).toolsOpen);
 await draw('02-chalk-tools');
 const oldBox=await page.locator('.rhine-evidence-tools').boundingBox(),heading=await page.locator('.rhine-evidence-tools-heading').boundingBox();
 await page.mouse.move(heading.x+75,heading.y+20);await page.mouse.down();await page.mouse.move(heading.x+205,heading.y-150,{steps:5});await page.mouse.up();
 const newBox=await page.locator('.rhine-evidence-tools').boundingBox();assert(newBox.x>oldBox.x+80);assert(newBox.y<oldBox.y-100);
 mark('Physical chalk entry opens one floating toolbox; its header drags within the viewport.');
 const initialSaved=await saved(),initialCount=(await model()).cards;
 await page.locator('[data-template=tag]').click();assert.equal((await model()).tool.mode,'place');
 const target=await point(-.4,-3.2);await move(target);assert((await board()).placementPreview);
 const versions=await page.evaluate(()=>window.boardProbe.printState().prints.map(p=>p.textureVersion));
 for(let n=0;n<12;n++)await page.mouse.move(target.x+n,target.y+n*.2);
 assert.deepEqual(await page.evaluate(()=>window.boardProbe.printState().prints.map(p=>p.textureVersion)),versions);
 assert.equal(await saved(),initialSaved);
 await page.keyboard.press('Escape');assert.equal((await model()).tool.mode,'select');assert.equal((await model()).cards,initialCount);
 mark('Placement previews move without saving cards or redrawing their textures; Escape cancels.');
 await page.locator('[data-template=tag]').click();await move(target);await page.mouse.down();await page.mouse.move(target.x+60,target.y);await move(target);await page.mouse.up();assert.equal((await model()).cards,initialCount);
 await click(target);assert.equal((await model()).cards,initialCount+1);assert.equal((await model()).tool.mode,'select');
 await page.locator('.rhine-evidence-title-input').fill('特里蒙 / 待核对');await page.locator('.rhine-evidence-body-input').fill('交叉核对万星园的时间与能源记录。');await page.locator('.rhine-evidence-save').click();
 assert.match(await saved(),/特里蒙/);
 const tagId=(await model()).selected,tag=(await board()).layout.find(v=>v.id===tagId);assert.equal(tag.presentation,'tag');assert.equal(tag.textureWidth,512);
 mark('A click places a compact keyword label; a drag that returns to its origin never places a card. Content persists.');
 await home();await page.locator('[data-template=note]').click();await click(await point(-3.8,2.5));assert.equal((await model()).cards,initialCount+2);
 await page.locator('.rhine-evidence-title-input').fill('能量井读数');await page.locator('.rhine-evidence-save').click();
 const noteId=(await model()).selected;assert.equal((await board()).layout.find(v=>v.id===noteId).presentation,'compact');
 await home();await page.locator('[data-tool=connect]').click();await click(await card('preview:question'));
 assert.equal((await model()).tool.mode,'connect');assert.equal((await model()).tool.fromId,'preview:question');
 const links=(await model()).links,builds=(await board()).linkRebuilds,prints=await page.evaluate(()=>window.boardProbe.printState().prints.map(p=>p.textureVersion));
 await move(await card('preview:conclude'));assert((await board()).connectionPreview);
 assert.equal((await board()).linkRebuilds,builds);assert.deepEqual(await page.evaluate(()=>window.boardProbe.printState().prints.map(p=>p.textureVersion)),prints);
 await click(await card('preview:conclude'));assert.equal((await model()).links,links+1);assert.equal((await model()).tool.mode,'select');assert.equal((await model()).examples,4);
 mark('Direct linking previews with one dynamic line; committing promotes both example endpoints and saves one relationship.');
 await page.locator('.rhine-evidence-connections').evaluate(el=>el.open=true);
 await page.locator('.rhine-evidence-link-remove').last().click();assert.equal((await model()).links,links);assert((await model()).canUndo);
 await page.locator('.rhine-evidence-undo').click();assert.equal((await model()).links,links+1);
 await page.locator('.rhine-evidence-attributes').evaluate(el=>el.open=true);await page.locator('.rhine-evidence-remove').click();assert.equal((await model()).cards,initialCount+1);
 await page.locator('.rhine-evidence-undo').click();assert.equal((await model()).cards,initialCount+2);
 mark('Disconnect and card removal both support undo.');
 await page.locator('.rhine-evidence-close-tools').click();
 const persisted=await saved();for(let n=0;n<7;n++)await page.locator('.rhine-board-zoom-in').click();await settle(page,false);
 assert.equal((await board()).zoom,3);assert(await page.locator('.rhine-board-tools-fallback').isVisible());
 const docked=await page.locator('.rhine-board-toolbar').boundingBox();assert(docked.x>=0&&docked.y>=0&&docked.x+docked.width<=1920&&docked.y+docked.height<=1080);
 assert.equal(await saved(),persisted);mark('At 300%, corner controls dock inside the viewport and retain a tools entry when the chalk box is offscreen.');
 await page.locator('.rhine-board-reset').click();await settle(page,false);
 await page.locator('.rhine-board-fullscreen-toggle').click();await settle(page,false);assert((await board()).fullscreen);
 await page.locator('.rhine-board-chalk-hit').click();await home();await page.locator('[data-template=question]').click();await page.keyboard.press('Escape');assert((await board()).fullscreen);assert((await model()).toolsOpen);
 await page.keyboard.press('Escape');assert((await board()).fullscreen);assert(!(await model()).toolsOpen);
 await checkProjection('fullscreen');await draw('03-fullscreen-tags');await page.keyboard.press('Escape');await settle(page,false);assert(!(await board()).fullscreen);
 mark('Fullscreen preserves the same board; Escape cancels a tool, then closes the toolbox, then exits fullscreen.');
 await page.reload({waitUntil:'domcontentloaded'});await settle(page,false);assert.equal((await model()).cards,initialCount+2);assert.match(await saved(),/特里蒙/);
 mark('New labels, notes and example-to-user link changes survive a reload.');
 await page.setViewportSize({width:390,height:844});await settle(page,false);
 const smallbar=await page.locator('.rhine-board-toolbar').boundingBox();assert(smallbar.x>=0&&smallbar.x+smallbar.width<=391);
 if(await page.locator('.rhine-board-chalk-hit').isVisible())await page.locator('.rhine-board-chalk-hit').click();else await page.locator('.rhine-board-tools-fallback').click();
 const drawer=await page.locator('.rhine-evidence-tools').boundingBox();assert(drawer.x>=0&&drawer.x+drawer.width<=391&&drawer.y>=0&&drawer.y+drawer.height<=845);
 await checkProjection('portrait');await draw('04-narrow-tools');mark('At 390 px, board controls remain reachable and the tools fit a bottom drawer.');
 report.final=await stats();assert.deepEqual(report.errors,[]);
 console.log('RESULT',JSON.stringify(report));
} finally { await writeFile(join(output,'report.json'),JSON.stringify(report,null,2));await browser.close(); }
