import { chromium } from '/home/cloudstack/ai-data/prts.chat/deepseek-harness/node_modules/.pnpm/playwright@1.61.1/node_modules/playwright/index.mjs';
const browser=await chromium.launch({headless:true,executablePath:'/home/cloudstack/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome',args:['--no-sandbox','--disable-dev-shm-usage']});
try{
 const context=await browser.newContext({viewport:{width:640,height:480},deviceScaleFactor:1});const page=await context.newPage();await page.setContent('<p>DPR event probe</p>');const cdp=await context.newCDPSession(page);
 await page.evaluate(()=>{window.events=[];window.query=matchMedia('(resolution: 1dppx)');query.addEventListener('change',e=>events.push({type:'mq',matches:e.matches,dpr:devicePixelRatio}));window.addEventListener('resize',()=>events.push({type:'resize',dpr:devicePixelRatio}));let frames=0;window.probeState=()=>({dpr:devicePixelRatio,initialQuery:query.matches,freshOne:matchMedia('(resolution: 1dppx)').matches,freshTwo:matchMedia('(resolution: 2dppx)').matches,frames,events:[...events]});const tick=()=>{frames++;requestAnimationFrame(tick);};requestAnimationFrame(tick);});
 console.log('initial',await page.evaluate(()=>probeState()));
 await cdp.send('Emulation.setDeviceMetricsOverride',{width:640,height:480,deviceScaleFactor:2,mobile:false});await page.waitForTimeout(1000);console.log('dpr2_only',await page.evaluate(()=>probeState()));
 await cdp.send('Emulation.setDeviceMetricsOverride',{width:641,height:480,deviceScaleFactor:2,mobile:false});await page.waitForTimeout(500);console.log('dpr2_width',await page.evaluate(()=>probeState()));
 await cdp.send('Emulation.setDeviceMetricsOverride',{width:641,height:480,deviceScaleFactor:1,mobile:false});await page.waitForTimeout(1000);console.log('dpr1_only',await page.evaluate(()=>probeState()));
}finally{await browser.close();}
