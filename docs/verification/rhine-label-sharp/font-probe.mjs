import { chromium } from '/home/cloudstack/ai-data/prts.chat/deepseek-harness/node_modules/.pnpm/playwright@1.61.1/node_modules/playwright/index.mjs';
import { writeFile } from 'node:fs/promises';
const browser=await chromium.launch({headless:true,executablePath:'/home/cloudstack/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome',args:['--no-sandbox','--disable-dev-shm-usage']});
try{
 const page=await browser.newPage({viewport:{width:1100,height:500}});
 await page.route('http://127.0.0.1:4177/',r=>r.fulfill({contentType:'text/html',body:'<link rel="stylesheet" href="/rhine/rhine.css"><body style="background:#eeeae0"><canvas id="c" width="1100" height="500"></canvas></body>'}));
 await page.goto('http://127.0.0.1:4177/');
 const report=await page.evaluate(async()=>{
  const faces=await Promise.all([document.fonts.load('600 150px MiSans','阿米娅 / 干员档案'),document.fonts.load('700 150px MiSans','阿米娅 / 干员档案')]);
  const c=document.querySelector('canvas').getContext('2d'),rows=['600 48px MiSans','700 48px MiSans','600 24px MiSans','700 24px MiSans','600 14px MiSans','700 14px MiSans'];
  c.fillStyle='#eeeae0';c.fillRect(0,0,1100,500);c.fillStyle='#161913';
  for(let i=0;i<rows.length;i++){c.font=rows[i];c.fillText('阿米娅 / 干员档案   切尔诺伯格事件',20,65+i*72);c.font='16px sans-serif';c.fillText(rows[i],850,65+i*72);}
  return {faces:faces.map(group=>group.map(face=>({family:face.family,weight:face.weight,status:face.status}))),check600:document.fonts.check('600 150px MiSans','阿米娅'),check700:document.fonts.check('700 150px MiSans','阿米娅')};
 });
 await page.screenshot({path:new URL('fonts.png',import.meta.url).pathname});await writeFile(new URL('fonts.json',import.meta.url),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}finally{await browser.close();}
