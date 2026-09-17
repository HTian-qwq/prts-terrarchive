import { chromium } from '/home/cloudstack/ai-data/prts.chat/deepseek-harness/node_modules/.pnpm/playwright@1.61.1/node_modules/playwright/index.mjs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { writeFile } from 'node:fs/promises';
const require=createRequire(import.meta.url), viteRequire=createRequire(require.resolve('vite/package.json'));
const {build}=await import(pathToFileURL(viteRequire.resolve('esbuild')).href);
const code=await build({stdin:{resolveDir:process.cwd(),contents:`
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { CopyShader } from 'three/addons/shaders/CopyShader.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { ArchiveLabelRenderer } from './ui/rhine/original/label-renderer.ts';
window.runDepthProbe=()=>{
 const renderer=new THREE.WebGLRenderer({preserveDrawingBuffer:true});renderer.setPixelRatio(2);renderer.setSize(512,256);renderer.info.autoReset=false;
 document.body.append(renderer.domElement);
 const scene=new THREE.Scene();scene.background=new THREE.Color('white');
 const camera=new THREE.PerspectiveCamera(30,2,.1,100);camera.position.z=3;camera.updateMatrixWorld();
 const composer=new EffectComposer(renderer);composer.setPixelRatio(1);composer.setSize(512,256);
 composer.addPass(new RenderPass(scene,camera));composer.addPass(new ShaderPass(CopyShader));composer.addPass(new OutputPass());
 const print=new ArchiveLabelRenderer();print.attach(composer);
 const backing=new THREE.Mesh(new THREE.PlaneGeometry(2,1),new THREE.MeshBasicMaterial({color:'blue'}));scene.add(backing);
 const map=new THREE.DataTexture(new Uint8Array([255,0,0,255]),1,1);map.needsUpdate=true;
 const labels=[-.5,.5].map((x,i)=>{const mesh=new THREE.Mesh(new THREE.PlaneGeometry(.6,.6),print.createMaterial(map));mesh.layers.set(1);mesh.position.set(x,0,i===0?-.2:.2);scene.add(mesh);return mesh;});
 function read(){renderer.info.reset();print.prepare(scene);composer.render();print.render(renderer,scene,camera);
  const gl=renderer.getContext();const pixels=labels.map(mesh=>{const p=mesh.position.clone().project(camera),pixel=new Uint8Array(4);gl.readPixels(Math.round((p.x*.5+.5)*1024),Math.round((p.y*.5+.5)*512),1,1,gl.RGBA,gl.UNSIGNED_BYTE,pixel);return [...pixel];});return {pixels,calls:renderer.info.render.calls,triangles:renderer.info.render.triangles};}
 const first=read(),second=read();labels[0].position.z=.2;const revealed=read();
 print.dispose();print.dispose();for(const pass of composer.passes)pass.dispose();composer.dispose();renderer.dispose();map.dispose();
 return {first,second,revealed};
};`},bundle:true,write:false,format:'iife',platform:'browser',target:'es2022'});
const browser=await chromium.launch({headless:true,executablePath:'/home/cloudstack/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome',args:['--no-sandbox','--disable-dev-shm-usage','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
const errors=[];try{
 const page=await browser.newPage();page.on('pageerror',e=>errors.push(e.message));page.on('console',e=>{if(e.type()==='error')errors.push(e.text());});
 await page.setContent('<body style="margin:0"></body>');await page.addScriptTag({content:code.outputFiles[0].text});const report=await page.evaluate(()=>window.runDepthProbe());
 for(const frame of [report.first,report.second]){if(!(frame.pixels[0][2]>240&&frame.pixels[0][0]<10&&frame.pixels[1][0]>240&&frame.pixels[1][2]<10))throw new Error('Occlusion failed: '+JSON.stringify(report));}
 if(report.revealed.pixels.some(p=>p[0]<240||p[2]>10))throw new Error('Reveal failed: '+JSON.stringify(report));
 if(errors.length)throw new Error(errors.join('\n'));
 await writeFile(new URL('depth.json',import.meta.url),JSON.stringify({report,errors},null,2));console.log(JSON.stringify(report));
}finally{await browser.close();}
