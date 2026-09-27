import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFile, mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const hostDir = process.env.PRTS_DSH_SOURCE_DIR ? resolve(process.env.PRTS_DSH_SOURCE_DIR) : null
const playwrightModule = process.env.PRTS_PLAYWRIGHT_MODULE

test('all skins keep official plugin pages, dialogs and old/new conversations readable and interactive', {
  skip: !hostDir || !playwrightModule ? 'Set PRTS_DSH_SOURCE_DIR and PRTS_PLAYWRIGHT_MODULE' : false,
}, async (t) => {
  const hostRequire = createRequire(resolve(hostDir, 'package.json'))
  const webRequire = createRequire(resolve(hostDir, 'apps/web/package.json'))
  const { build } = createRequire(hostRequire.resolve('tsx/package.json'))('esbuild')
  // Real Host page, atoms and CSS Modules, with an in-memory inventory. No npm
  // installs, accounts or Agent requests are made by this renderer regression.
  const { outputFiles } = await build({
    absWorkingDir: hostDir, bundle: true, write: false, outdir: '/tmp/prts-skin-pages',
    format: 'iife', platform: 'browser', jsx: 'automatic',
    tsconfig: resolve(hostDir, 'tsconfig.base.json'), nodePaths: [resolve(hostDir, 'node_modules')],
    loader: { '.woff': 'dataurl', '.woff2': 'dataurl', '.ttf': 'dataurl' },
    // Keep real atoms while excluding unrelated barrel side effects (Markdown,
    // code viewers and site icon dictionaries are not used by this page).
    plugins: [{ name: 'plugin-page-atoms', setup(builder) {
      builder.onLoad({ filter: /ui-settings-general\/src\/client\/SettingsRoot\.tsx$/ }, async args => ({
        contents: (await readFile(args.path,'utf8')) + '\nexport { SettingsPanel }', loader:'tsx',
        resolveDir:resolve(hostDir,'packages/client/ui-settings-general/src/client'),
      }))
      builder.onLoad({ filter: /ui-primitives\/src\/index\.ts$/ }, () => ({
        contents: ['Button.tsx','Input.tsx','Modal.tsx','StateDot.tsx','Switch.tsx','Tag.tsx',
          'TerminalBlock.tsx','Toast.tsx','useAnchoredPosition.ts','useDismissOnOutsidePointer.ts',
          'useModalLayer.ts','ConnectionIndicator.tsx','Tooltip.tsx','FishLogo.tsx',
          'icons/index.tsx','plugin-artwork.tsx'].map(file => `export * from './${file}'`).join('\n'),
        resolveDir: resolve(hostDir,'packages/client/ui-primitives/src'), loader: 'ts',
      }))
    } }],
    alias: { react: webRequire.resolve('react'), 'react-dom': webRequire.resolve('react-dom'),
      'react-dom/client': webRequire.resolve('react-dom/client'),
      'react/jsx-runtime': webRequire.resolve('react/jsx-runtime') },
    define: { 'process.env.NODE_ENV': '"production"' },
    stdin: { resolveDir: hostDir, loader: 'tsx', contents: `
      import React, { useState } from 'react';
      import { createRoot } from 'react-dom/client';
      import { PluginManagerPage } from './packages/client/ui-plugin-manager/src/client/PluginManagerPage.tsx';
      import { zh } from './packages/client/ui-plugin-manager/src/client/locales.ts';
      import { ConversationPanel } from './packages/client/ui-conversation/src/client/skeleton/ConversationPanel.tsx';
      import { ConversationMainPanel } from './packages/client/ui-conversation/src/client/skeleton/ConversationMainPanel.tsx';
      import { Button } from './packages/client/ui-primitives/src/Button.tsx';
      import { Input } from './packages/client/ui-primitives/src/Input.tsx';
      import { SettingsPanel } from './packages/client/ui-settings-general/src/client/SettingsRoot.tsx';
      import { HeroShell } from './packages/client/ui-conversation/src/client/skeleton/EmptyHero.tsx';
      import inputCss from './packages/client/ui-conversation/src/client/skeleton/InputBar.module.css';
      import frameCss from './packages/client/ui-layout/src/client/AppFrame.module.css';
      import chatCss from './packages/client/ui-conversation/src/client/skeleton/ConversationRoot.module.css';
      import './packages/client/ui-theme/src/styles/design-platform.css';
      import './packages/client/ui-theme/src/styles/base.css';
      window.fixtureReact = React;
      const t = (key, params = {}) => Object.entries(params).reduce((s,[k,v]) => s.replaceAll('{'+k+'}',v), zh[key] || key);
      const noop = () => {};
      const install = { open:false, spec:'', phase:'idle', inputError:null, subject:null, runs:[], detailsOpen:false,
        registries:null, registry:{kind:'offered',registry:null}, registryOpen:false, registryError:false, attempts:null,
        installed:null, restartRequired:false, failure:null, approvedBuilds:[], enabling:false };
      function App() {
        const [panel, setPanel] = useState('plugins'), [legacy, setLegacy] = useState(false);
        const [phase, setPhase] = useState('hero'), [narrow, setNarrow] = useState(false);
        const [settings,setSettings]=useState(false), [section,setSection]=useState('general');
        const [view, setView] = useState({kind:'list'});
        const [state,setState] = useState({ status:'ready',busy:[],notice:null,confirm:null,highlight:null,install,
          packages:[{ name:'prts-terrarchive',version:'0.2.0',installed:true,optional:false,enabled:true,
            meta:{description:'本地与云端资料检索、原文阅读和莱茵生命资料馆'},
            rows:[{rowId:'prts',entryId:'prts',moduleName:'prts-terrarchive',enabled:true,phase:'active'}] }] });
        const patchInstall = patch => setState(s=>({...s,install:{...s.install,...patch}}));
        window.fixture = { setPanel,setLegacy,setPhase,setNarrow,setSettings };
        const page = <PluginManagerPage
          t={t} resolveText={text=> typeof text === 'string' ? text : text?.['zh-CN'] || ''}
          useConfigurations={select=>select({view:{namespaces:[]}})}
          usePluginManager={select=>select(state)} useStore={select=>select({view})} actions={{setView}}
          useConfigLedger={select=>select({items:[{id:'shell',label:'终端'}],bundles:new Set(),rows:new Set()})}
          ensure={noop} refresh={()=>window.refreshes=(window.refreshes||0)+1} clearHighlight={noop}
          openInstall={()=>patchInstall({open:true})} closeInstall={()=>patchInstall({open:false})}
          editInstallSpec={spec=>patchInstall({spec})} runInstall={noop} dismissNotice={noop}
          setEnabled={(name,enabled)=>setState(s=>({...s,packages:s.packages.map(p=>p.name===name?{...p,enabled}:p)}))}
          renderSlot={(name,owner)=>name==='plugins.item'?(owner.view==='summary'?'限制终端命令的运行时间和输出。':<label>输出长度 <input aria-label="输出长度" defaultValue="10000"/></label>):null}
        />;
        const renderSlot = name => name==='main.conversation'
          ? <div data-slot={legacy?'conversation':'main.conversation'} style={{display:'contents'}}><ConversationMainPanel
              useSession={select=>select(undefined)} useSessions={select=>select({byId:{}})}
              useConversation={select=>select(undefined)} renderSlot={()=>null}
              renderFactorySlot={()=> <div className={chatCss.body} data-conversation-content>
                <div className={chatCss.scrollBody} data-conversation-scroll>
                  <div className={chatCss.composerSeat} data-composer-seat>
                    <div data-chain-overlay-fallback="conversation.composer"><div className={chatCss.composerStack}>
                    {phase==='hero'&&<><HeroShell t={key=>key} renderSlot={name=><span data-slot={name}>DSH</span>}/><div className={chatCss.heroWorkspaceRow}>默认工作区</div></>}
                    <div className={inputCss.root}><div className={inputCss.card} data-composer-card>
                      <textarea aria-label="输入问题" placeholder="输入问题"/>
                      <Button onClick={()=>window.sent=(window.sent||0)+1}>发送</Button>
                    </div></div></div></div>
                  </div>
                </div>
              </div>}
            /></div> : null;
        React.useEffect(()=>{const el=document.querySelector('[data-slot="main.conversation"]>[data-phase], [data-slot="conversation"]>[data-phase]');if(el)el.dataset.phase=phase;},[phase,panel,legacy]);
        return <><div data-slot="root"><div className={frameCss.frame} style={{gridTemplateColumns:narrow?'60px minmax(0,1fr) 0px':'280px minmax(0,1fr) 0px'}}>
          <div className={frameCss.sidebarCol}><nav style={{padding:16,display:'grid',gap:24,color:'var(--dsw-alias-label-primary)'}}>
            <span data-slot="sidebar.brand.name"><b>DeepSeek Harness</b></span>
            <button onClick={()=>setPanel('chat')}><span>新会话</span></button>
            <button onClick={()=>setPanel('plugins')}><span id="plugin-nav">插件</span></button>
            <span id="workspace">默认工作区</span>
          </nav></div>
          <div className={frameCss.centerCol}><div data-slot="main" style={{display:'contents'}}>
            {panel==='plugins'?page:<ConversationPanel renderSlot={renderSlot}/>}
          </div></div>
          <div className={frameCss.rightbarCol} data-rightbar-col/>
          <div className={frameCss.overlayLayer} data-shell-overlay><div data-slot="shell.overlay">
            <main className="aic-root" style={{animation:'none'}}><div className="aic-map"/><div className="aic-start-brand">AIC / PRTS</div></main>
          </div></div>
        </div></div>{settings&&<SettingsPanel rows={[{id:'general',label:'通用设置'},{id:'models',label:'模型'}]}
          activeId={section} onSelect={setSection} onClose={()=>setSettings(false)}
          renderSlot={name=><div data-slot={name}>{name==='settings.header'?'设置':name==='settings.close'?'关闭设置':
            name==='settings.section'?<label>名称 <Input aria-label="设置名称" defaultValue="PRTS" style={{width:"100%",minWidth:0,boxSizing:"border-box"}}/></label>:null}</div>}/>}</>;
      }
      createRoot(document.getElementById('root')).render(<App/>);
    ` },
  })
  const { chromium } = await import(pathToFileURL(resolve(playwrightModule)).href)
  const browser = await chromium.launch({ headless: true,
    ...(process.env.PRTS_BROWSER_EXECUTABLE ? { executablePath: process.env.PRTS_BROWSER_EXECUTABLE } : {}) })
  t.after(() => browser.close())
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } })
  const errors = []
  page.on('pageerror', error => { errors.push(error.message); console.error(error.stack) })
  const sheets = new Map()
  for (const skin of ['common','prts-agent','endfield-aic','rhine-lab']) {
    sheets.set(skin, await readFile(new URL(`../lib/skins/${skin}.css`, import.meta.url), 'utf8'))
  }
  await page.route('http://skins.test/**', route => {
    const key = new URL(route.request().url()).pathname.split('/').at(-1)?.replace('.css','')
    return route.fulfill({contentType:'text/css; charset=utf-8',body:sheets.get(key)||''})
  })
  await page.goto('http://skins.test/')
  await page.setContent('<!doctype html><meta charset="utf-8"><div id="root"></div><style>html,body,#root,[data-slot="root"]{height:100%;margin:0}body{font-family:Arial,sans-serif}button,textarea,input{font:inherit}nav button{background:var(--dsw-alias-button-elevated-fill);color:inherit;border:1px solid var(--dsw-alias-border-l2);padding:10px}body:not([data-prts-skin="endfield-aic"]) .aic-root{display:none}</style>')
  for (const file of outputFiles) {
    if (file.path.endsWith('.css')) await page.addStyleTag({content:file.text})
    if (file.path.endsWith('.js')) await page.addScriptTag({content:file.text})
  }
  await page.waitForSelector('[data-plugin-panel]')
  await page.evaluate(() => { window.__ModuleLoader__ = { load: ({factory}) => { window.plugin = factory(() => window.fixtureReact) } } })
  await page.addScriptTag({content:await readFile(new URL('../lib/client.js', import.meta.url),'utf8')})
  await page.evaluate(() => {
    window.plugin.apply({
      theme:{ overrideTokens(_id,tokens){
        for(const [key,value] of Object.entries(tokens)) document.body.style.setProperty(key,value.light)
        return ()=>{for(const key of Object.keys(tokens))document.body.style.removeProperty(key)}
      }}, slots:{ inject:()=>()=>{},register:()=>()=>{} },
      effect:fn=>fn(),sessions:{},connection:{rpc:{call:async()=>({})}},
    })
    window.setSkin = skin => window.plugin.__skinStateForTest.setSkin(skin)
  })
  const screenshotDir = process.env.PRTS_SKIN_SCREENSHOTS
  if (screenshotDir) await mkdir(screenshotDir,{recursive:true})
  for (const skin of ['harness','prts-agent','endfield-aic','rhine-lab']) {
    await t.test(`${skin}: list, detail, install dialog and navigation`, async () => {
      await page.evaluate(skin=>window.setSkin(skin),skin)
      await page.evaluate(()=>window.fixture.setPanel('plugins'))
      await page.waitForSelector('[data-plugin-panel]')
      const before = await page.evaluate(()=>window.refreshes||0)
      await page.getByRole('button',{name:'刷新',exact:true}).click()
      assert.equal(await page.evaluate(()=>window.refreshes),before+1)
      if(skin==='prts-agent') {
        assert.notEqual(await page.locator('#workspace').evaluate(el=>getComputedStyle(el).color),'rgba(0, 0, 0, 0)', 'sidebar must not retain scene-only text masking')
        assert.match(await page.locator('[data-slot="sidebar.brand.name"]').evaluate(el=>getComputedStyle(el,'::before').color),/247, 247, 244/)
        assert.match(await page.locator('nav').evaluate(el=>getComputedStyle(el.parentElement).backgroundImage),/23, 26, 29/)
      }
      const paper = await page.locator('[data-plugin-panel]').evaluate(el=>getComputedStyle(el).backgroundColor)
      assert.equal(paper,{harness:'rgba(0, 0, 0, 0)','prts-agent':'rgb(246, 247, 244)','endfield-aic':'rgb(20, 24, 27)','rhine-lab':'rgb(235, 232, 226)'}[skin])
      // Canonical skins must remain legible if the Host preference is dark.
      const addButton = page.getByRole('button',{name:'添加插件',exact:true})
      const buttonPalette = () => addButton.evaluate(el => {
        const css=getComputedStyle(el)
        return {foreground:css.color,background:css.backgroundColor}
      })
      const lightPalette=await buttonPalette()
      await page.evaluate(()=>document.body.setAttribute('data-ds-dark-theme',''))
      const darkPalette=await buttonPalette()
      if(skin!=='harness')assert.deepEqual(darkPalette,lightPalette,`${skin}: primary button is independent from Host scheme`)
      assert.notEqual(darkPalette.foreground,darkPalette.background)
      await page.evaluate(()=>document.body.removeAttribute('data-ds-dark-theme'))
      if(screenshotDir)await page.screenshot({path:resolve(screenshotDir,`${skin}-plugins.png`)})
      // The actual switch must remain separately clickable from the card link.
      const toggle=page.locator('[data-plugin-package] [role="switch"]')
      await toggle.click()
      assert.equal(await toggle.getAttribute('aria-checked'),'false')
      await toggle.click()
      assert.equal(await toggle.getAttribute('aria-checked'),'true')
      await page.locator('[data-plugin-package] button').first().click()
      await page.waitForSelector('[data-plugin-detail]')
      await page.getByRole('button',{name:'返回插件列表'}).click()
      await page.locator('[data-plugin-item] button').first().click()
      await page.getByLabel('输出长度').fill('20000')
      await page.getByRole('button',{name:'返回插件列表'}).click()
      await page.getByRole('button',{name:'添加插件',exact:true}).click()
      await page.getByRole('dialog').waitFor()
      if(screenshotDir)await page.screenshot({path:resolve(screenshotDir,`${skin}-install.png`)})
      await page.getByRole('dialog').locator('input[type="text"]').fill('example-plugin')
      await page.getByRole('button',{name:'关闭',exact:true}).click()
      await page.getByRole('dialog').waitFor({state:'hidden'})
      await page.setViewportSize({width:390,height:760})
      await page.evaluate(()=>window.fixture.setNarrow(true))
      await addButton.click()
      const dialogBox=await page.getByRole('dialog').boundingBox()
      assert.ok(dialogBox.x>=0&&dialogBox.x+dialogBox.width<=390&&dialogBox.y>=0&&dialogBox.y+dialogBox.height<=760)
      await page.getByRole('button',{name:'关闭',exact:true}).click()
      await page.setViewportSize({width:1600,height:1000})
      await page.evaluate(()=>window.fixture.setNarrow(false))
      await page.getByRole('button',{name:'新会话',exact:true}).click()
      await page.waitForSelector('[data-composer-seat]')
      for(const width of [1600,390]) {
        await page.setViewportSize({width,height:760})
        await page.evaluate(()=>window.fixture.setSettings(true))
        await page.getByRole('dialog',{name:/设置$/}).waitFor()
        await page.getByRole('button',{name:'模型',exact:true}).click()
        await page.getByLabel('设置名称').fill('PRTS settings')
        const box=await page.getByRole('dialog',{name:/设置$/}).boundingBox()
        assert.ok(box.x>=0&&box.x+box.width<=width&&box.y>=0&&box.y+box.height<=760,`${skin}: settings inside viewport`)
        const field=await page.getByLabel('设置名称').boundingBox()
        assert.ok(field.x>=box.x&&field.x+field.width<=box.x+box.width,`${skin}: settings input is not clipped`)
        if(width===390&&skin!=='harness')assert.ok(field.width>=160,`${skin}: settings content remains usable`)
        if(screenshotDir)await page.screenshot({path:resolve(screenshotDir,`${skin}-settings-${width}.png`)})
        await page.keyboard.press('Escape')
        await page.getByRole('dialog').waitFor({state:'hidden'})
      }
      // Check each Host generation with the same official Conversation CSS.
      for(const legacy of [false,true]) {
        await page.evaluate(legacy=>{
          window.fixture.setLegacy(legacy)
          // Current Windows Host publishes a caption band; legacy Web Hosts do not.
          document.documentElement.toggleAttribute('data-windows-titlebar',!legacy)
          document.documentElement.style.setProperty('--dsh-windows-titlebar-height','32px')
        },legacy)
        for(const width of [1600,640,390]) {
          await page.setViewportSize({width,height:900})
          await page.evaluate(width=>window.fixture.setNarrow(width<980),width)
          for(const phase of ['hero','active']) {
            await page.evaluate(phase=>window.fixture.setPhase(phase),phase)
            // The plugin follows Host geometry through MutationObserver + rAF.
            await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))))
            const input=page.getByRole('textbox',{name:'输入问题'})
            await input.fill(`${skin}/${legacy}/${phase}`)
            const box=await input.boundingBox()
            assert.ok(box.y>=0&&box.y+box.height<=900&&box.x>=0&&box.x+box.width<=width,`${skin}/${legacy}/${phase}/${width}: input inside viewport ${JSON.stringify(box)}`)
            await page.getByRole('button',{name:'发送',exact:true}).click()
            if(skin==='prts-agent'&&phase==='hero') {
              const mark=await page.locator('.prts-hero-wordmark svg').boundingBox()
              assert.ok(mark.x>=0&&mark.x+mark.width<=width,`PRTS wordmark must fit at ${width}`)
            }
            if(screenshotDir&&!legacy&&phase==='hero'&&[1600,390].includes(width))await page.screenshot({path:resolve(screenshotDir,`${skin}-composer-${width}.png`)})
          }
        }
      }
      await page.setViewportSize({width:1600,height:1000})
      await page.evaluate(()=>{window.fixture.setNarrow(false);window.fixture.setPanel('plugins')})
    })
  }
  assert.deepEqual(errors,[])
})
