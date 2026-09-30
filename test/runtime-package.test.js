import test from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkRuntime } from '../bin/check-runtime.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))

test('all shipped Host entries and legacy preset expressions load without node_modules', () => {
  assert.deepEqual(checkRuntime(root).entries.sort(), ['.', './composition', './presets', './skill', './tools'])
})

test('the package check catches missing bundled files and accidental external imports even in an installed checkout', t => {
  const temporary = mkdtempSync(join(tmpdir(), 'prts-runtime-regression-'))
  t.after(() => rmSync(temporary, { recursive: true, force: true }))
  const fixture = join(temporary, 'node_modules/prts-terrarchive')
  mkdirSync(fixture, { recursive: true })
  for (const path of ['package.json', 'src', 'presets', 'contracts', 'resources', 'lib']) {
    cpSync(join(root, path), join(fixture, path), { recursive: true })
  }
  assert.equal(checkRuntime(fixture).entries.length, 5, 'an installed package can be verified too')
  symlinkSync(join(root, 'node_modules'), join(fixture, 'node_modules'), 'junction')
  const composition = join(fixture, 'presets/composition.js')
  const original = readFileSync(composition, 'utf8')
  writeFileSync(composition, original.replace("'../lib/runtime/yaml.js'", "'js-yaml'"))
  assert.throws(() => checkRuntime(fixture), /Cannot find package 'js-yaml'/)
  writeFileSync(composition, original)
  rmSync(join(fixture, 'lib/runtime/zod.js'))
  assert.throws(() => checkRuntime(fixture), /Cannot find module .*lib[\\/]runtime[\\/]zod\.js/)
})
