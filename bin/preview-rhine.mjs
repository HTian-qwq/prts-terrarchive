#!/usr/bin/env node
// A loopback-only, read-only preview using the same corpus API as the plugin.
import { createServer } from 'node:http'
import { readFile, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CorpusStore } from '../src/store.js'
import { buildApi } from '../src/ui.js'

const root = fileURLToPath(new URL('../', import.meta.url))
const releasesDir = resolve(process.env.PRTS_RHINE_RELEASES || join(root, 'data/releases'))
const port = Number(process.env.PORT || 4177)
const temporary = await mkdtemp(join(tmpdir(), 'prts-rhine-preview-'))
const store = new CorpusStore({ releasesDir, cursorSecretPath: join(temporary, 'cursor-secret.bin') })
await store.ready()
const api = buildApi({ store, effective: () => ({ enabledGames: ['arknights', 'endfield'] }) })
const files = new Map([
  ['/rhine/rhine.js', ['lib/rhine/rhine.js', 'text/javascript']],
  ['/rhine/rhine.css', ['lib/rhine/rhine.css', 'text/css']],
  ['/rhine/assets/archive-cassette.glb', ['lib/rhine/assets/archive-cassette.glb', 'model/gltf-binary']],
  ['/rhine/assets/archive-assembly.glb', ['lib/rhine/assets/archive-assembly.glb', 'model/gltf-binary']],
  ...['Light', 'Regular', 'Demibold', 'Bold'].map(weight => [`/rhine/fonts/MiSans-${weight}.woff2`, [`lib/rhine/fonts/MiSans-${weight}.woff2`, 'font/woff2']]),
  ['/rhine/fonts/NOTICE.txt', ['lib/rhine/fonts/NOTICE.txt', 'text/plain; charset=utf-8']],
  ['/rhine/fonts/MiSans-license.pdf', ['lib/rhine/fonts/MiSans-license.pdf', 'application/pdf']],
])
const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>莱茵生命 · 资料馆预览</title><link rel="stylesheet" href="/rhine/rhine.css"><style>html,body,#app{margin:0;width:100%;height:100%;overflow:hidden;background:#eeece4}.preview-label{position:fixed;z-index:50;bottom:2px;left:50%;transform:translateX(-50%);font:9px system-ui;color:#77766c;pointer-events:none;max-width:70vw;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}</style><body><main id="app"></main><span class="preview-label">本地预览 · 真实资料库</span><script src="/rhine/rhine.js"></script><script>
const snapshot={sessionId:'preview-local-v1',running:false,searching:false,query:'',tool:'',sources:[],answer:'',records:[]};
window.rhineWorkbench=window.__PRTS_RHINE__.mountRhineWorkbench(document.getElementById('app'),{
assetBase:'/rhine/',snapshot,agentAvailable:false,
api:async(endpoint,payload,signal)=>{const res=await fetch('/rpc',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({endpoint,payload}),signal});const body=await res.json();if(!res.ok)throw new Error(body.error||'请求失败');return body;},
askAgent:async()=>{throw new Error('这是资料馆独立预览。请在 Harness 会话中启用「莱茵生命资料馆」，即可将问题和摘录交给 Agent。');},
close:()=>{document.querySelector('.preview-label').textContent='独立预览没有对话窗口；在 Harness 中此按钮返回当前会话。';}
});
</script></body></html>`
const send = (res, status, body, type = 'application/json') => {
  const data = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body)
  res.writeHead(status, { 'content-type': type, 'x-content-type-options': 'nosniff',
    'cache-control': 'no-store', 'cross-origin-resource-policy': 'same-origin' })
  res.end(data)
}
const server = createServer(async (req, res) => {
  try {
    if (!['GET', 'HEAD', 'POST'].includes(req.method)) return send(res, 405, { error: 'Method not allowed' })
    const url = new URL(req.url, `http://127.0.0.1:${port}`)
    if (req.method === 'GET' && url.pathname === '/') return send(res, 200, html, 'text/html; charset=utf-8')
    const file = files.get(url.pathname)
    if (file && ['GET', 'HEAD'].includes(req.method)) {
      const bytes = await readFile(join(root, file[0]))
      return send(res, 200, req.method === 'HEAD' ? '' : bytes, file[1])
    }
    if (req.method !== 'POST' || url.pathname !== '/rpc') return send(res, 404, { error: 'Not found' })
    if (req.headers.origin && new URL(req.headers.origin).host !== req.headers.host) return send(res, 403, { error: 'Origin rejected' })
    let body = ''
    req.setEncoding('utf8')
    for await (const chunk of req) {
      body += chunk
      if (Buffer.byteLength(body) > 128 * 1024) return send(res, 413, { error: 'Request too large' })
    }
    const { endpoint, payload } = JSON.parse(body)
    const route = { 'archive.search': 'archive/search', read: 'read' }[endpoint]
    if (!route) return send(res, 404, { error: '此预览只开放搜索与读取' })
    const controller = new AbortController()
    res.on('close', () => { if (!res.writableEnded) controller.abort() })
    const result = await api.call('POST', '/api/prts-corpus/' + route, payload, { signal: controller.signal })
    if (!res.destroyed) send(res, result.status, result.json)
  } catch (error) {
    if (!res.destroyed) send(res, 500, { error: error.message || 'Preview request failed' })
  }
})
server.listen(port, '127.0.0.1', () => console.log(`Rhine preview: http://127.0.0.1:${port} · ${store.documents.size} documents · ${store.dataVersion}`))
