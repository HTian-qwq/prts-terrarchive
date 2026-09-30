import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'
const host=process.env.PRTS_DSH_SOURCE_DIR
const root=fileURLToPath(new URL('../',import.meta.url))
test('native DSH tools, scoped events and domain storage preserve investigation receipts',{
  skip:!host&&'Set PRTS_DSH_SOURCE_DIR to run against DSH source',timeout:40000,
},()=>{
  const source=resolve(host)
  const result=spawnSync(process.execPath,['--import',join(source,'node_modules/tsx/dist/esm/index.mjs'),
    join(root,'test/fixtures/dsh-investigation-runtime.mts'),root,source],{
    cwd:source,env:{...process.env,TSX_TSCONFIG_PATH:join(source,'tsconfig.json')},encoding:'utf8',timeout:30000,
  })
  assert.equal(result.status,0,`${result.error||''}\n${result.stdout}\n${result.stderr}`)
  assert.match(result.stdout,/DSH native investigation compatibility passed/)
})
