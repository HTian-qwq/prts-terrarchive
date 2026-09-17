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
 const stats=()=>page.evaluate(()=>window.rhineWorkbench.stats()),board=async()=>(await stats()).evidenceBoard,model=async()=>(await stats()).board;
 const data=()=>page.evaluate(()=>JSON.parse(localStorage.getItem('prts-rhine-evidence-board:v1:preview-local-v1'))?.cards);
 const select=async id=>{const p=(await page.evaluate(()=>window.boardProbe.cardPoints())).find(c=>c.id===id);assert(p);await page.mouse.click(p.x,p.y);assert.equal((await model()).selected,id);};
 const range=page.locator('.rhine-evidence-size-range');
 const current=async()=>{const selected=(await model()).selected;return(await board()).layout.find(c=>c.id===selected);};
 const checkBounds=card=>{const a=card.rotation*Math.PI/180;for(const x of[-card.width/2,card.width/2])for(const y of[-card.height/2,card.height/2]){const xx=card.x+x*Math.cos(a)-y*Math.sin(a),yy=card.y+x*Math.sin(a)+y*Math.cos(a);assert(xx>=-7.55-1e-6&&xx<=7.55+1e-6&&yy>=-3.82-1e-6&&yy<=3.90+1e-6);}};
 const mark=text=>{report.checks.push(text);console.log('CHECK',text);};
 await page.locator('.rhine-board-fullscreen-toggle').click();await settle(page,false);
 const initial=await board();await select('preview:conclude');const base=await current();assert.equal(base.scale,1);
 await range.focus();await page.keyboard.press('Home');assert.equal((await current()).scale,.5);assert.equal(await page.locator('.rhine-evidence-size-value').textContent(),'50%');
 const id=(await model()).selected;assert(!id.startsWith('preview:'));assert.equal((await model()).examples,5);assert.equal((await current()).width,base.width*.5);assert.equal((await current()).height,base.height*.5);
 assert.equal((await data()).find(c=>c.id===id).scale,.5);assert.equal((await board()).zoom,initial.zoom);
 mark('Keyboard slider resizing changes only the chosen paper to 50%, promotes its example identity safely and preserves the camera zoom.');
 const resources=await board();
 const sizePreview=await range.evaluate(el=>{const key='prts-rhine-evidence-board:v1:preview-local-v1',before=localStorage.getItem(key);for(const scale of[.66,.81,1.08,1.31,1.59,1.7,1.5]){el.value=String(scale);el.dispatchEvent(new Event('input',{bubbles:true}));}return{before,after:localStorage.getItem(key),board:window.rhineWorkbench.stats().evidenceBoard};});
 assert.equal(sizePreview.before,sizePreview.after);assert.equal(sizePreview.board.cardTextureUpdates,resources.cardTextureUpdates);assert.equal(sizePreview.board.cardTexturePixels,resources.cardTexturePixels);assert.equal(sizePreview.board.textureCount,resources.textureCount);
 await range.dispatchEvent('change');assert.equal((await data()).find(c=>c.id===id).scale,1.5);
 const resized=await current();assert.equal(resized.width,base.width*1.5);assert.equal(resized.height,base.height*1.5);checkBounds(resized);
 const links=await page.evaluate(()=>window.boardProbe.linkState());assert(links.length>0);for(const link of links)assert(link.errorA<1e-5&&link.errorB<1e-5);report.linkErrors=links;
 for(const other of initial.layout.filter(c=>c.id!=='preview:conclude'))assert.deepEqual((await board()).layout.find(c=>c.id===other.id),other);
 mark('Continuous sizing previews without writing storage or redrawing/reallocating paper textures; all red strings stay attached to their pins and other papers keep their sizes.');
 await page.mouse.move(1000,1000);await settle(page,true);await capture(page,'01-paper-size-150');await page.evaluate(()=>window.boardProbe.run());
 await page.locator('.rhine-evidence-size-reset').click();assert.equal((await current()).scale,1);assert.equal((await current()).width,base.width);assert(await page.locator('.rhine-evidence-size-reset').isDisabled());
 await page.locator('.rhine-evidence-size-up').click();assert.equal((await current()).scale,1.1);
 await page.locator('.rhine-evidence-title-input').fill('科学应当看向谁 · 核对');
 await page.locator('.rhine-evidence-size-down').click();assert.equal((await current()).scale,1);assert.equal((await data()).find(c=>c.id===id).title,'科学应当看向谁 · 核对');
 await range.evaluate(el=>{el.value='0.75';el.dispatchEvent(new Event('input',{bubbles:true}));});
 await page.locator('.rhine-evidence-close-tools').click();assert.equal((await data()).find(c=>c.id===id).scale,.75);
 mark('Plus/minus, original-size reset and closing during a resize preserve the paper and pending text edits.');
 await select('preview:verify');const sourceBefore=await page.locator('.rhine-evidence-body-input').inputValue();
 await range.focus();await page.keyboard.press('End');assert.equal((await current()).scale,2);checkBounds(await current());assert(await page.locator('.rhine-evidence-size-up').isDisabled());
 const sourceId=(await model()).selected,source=(await data()).find(c=>c.id===sourceId);assert.equal(source.body,sourceBefore);assert(source.sourceTitle.includes('CW-8'));assert.equal((await model()).links,7);
 const ids=new Set((await data()).map(c=>c.id));for(const c of await data())for(const target of c.links||[])assert(ids.has(target));
 mark('At 200%, the source card is kept inside the board and its complete body, source identity and relationships survive.');
 await range.evaluate(el=>{el.value='1.25';el.dispatchEvent(new Event('input',{bubbles:true}));});
 const switchSession=id=>page.evaluate(sessionId=>window.rhineWorkbench.update({sessionId,running:false,searching:false,query:'',tool:'',sources:[],answer:'',records:[]}),id);
 await switchSession('resize-other-session');assert.equal((await model()).cards,6);assert((await board()).layout.every(c=>c.scale===1));await switchSession('preview-local-v1');assert.equal((await board()).layout.find(c=>c.id===sourceId).scale,1.25);
 await page.reload({waitUntil:'domcontentloaded'});await settle(page,false);assert.equal((await board()).layout.find(c=>c.id===id).scale,.75);assert.equal((await board()).layout.find(c=>c.id===sourceId).scale,1.25);
 mark('Switching sessions flushes pending size changes, and different paper sizes survive a reload.');
 await page.locator('.rhine-board-fullscreen-toggle').click();await settle(page,false);await select(id);await page.setViewportSize({width:390,height:844});await settle(page,false);
 await range.scrollIntoViewIfNeeded();await range.focus();await page.keyboard.press('Home');assert.equal((await current()).scale,.5);await settle(page,true);await capture(page,'02-paper-size-mobile');await page.evaluate(()=>window.boardProbe.run());
 await page.locator('.rhine-scene canvas').dispatchEvent('webglcontextlost',{cancelable:true});await page.waitForSelector('.rhine-scene-unavailable');await page.locator('.rhine-evidence-size-up').click();assert.equal((await current()).scale,.6);assert.equal((await data()).find(c=>c.id===id).scale,.6);
 mark('The same size control works in the mobile drawer and after WebGL becomes unavailable.');
 assert.deepEqual(report.errors,[]);report.final=await board();console.log('RESULT',JSON.stringify(report));
} finally {await writeFile(join(output,'report.json'),JSON.stringify(report,null,2));await browser.close();}
