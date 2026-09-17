import { test } from 'node:test'
import assert from 'node:assert/strict'
import { archiveColumns, columnFiles, fileLocation } from '../ui/rhine/original/data.ts'
import { selectionCell, fileAtCell, LOOP_COLUMNS, LOOP_ROWS } from '../ui/rhine/original/archive-loop.ts'
import { viewportLayout } from '../ui/rhine/original/viewport-layout.ts'
import { normalizeQuality, restoreQuality, qualityPresets } from '../ui/rhine/original/render-quality.ts'

test('原版五列八档案循环：末项到首项仍向前移动一格，不反向跳回', () => {
  assert.equal(archiveColumns.length, 5)
  assert.equal(LOOP_COLUMNS * LOOP_ROWS, 288)
  for (let lane = 0; lane < archiveColumns.length; lane++) {
    const files = columnFiles(lane)
    assert.equal(files.length, 8)
    const last = fileLocation(files.at(-1))
    const forward = selectionCell(files[0], last, { axis: 'row', direction: 1 })
    assert.equal(forward.row, last.row + 1)
    assert.equal(fileAtCell(forward), files[0])
    const previous = selectionCell(files.at(-1), fileLocation(files[0]), { axis: 'row', direction: -1 })
    assert.equal(previous.row, 11)
    assert.equal(fileAtCell(previous), files.at(-1))
  }
  const from = { lane: 4, row: 12 }
  const next = selectionCell(columnFiles(0)[0], from, { axis: 'lane', direction: 1 })
  assert.equal(next.lane, 5)
  assert.equal(fileAtCell(next), columnFiles(0)[0])
  const back = selectionCell(columnFiles(4)[0], { lane: 0, row: 12 }, { axis: 'lane', direction: -1 })
  assert.equal(back.lane, -1)
  assert.equal(fileAtCell(back), columnFiles(4)[0])
})

test('原版舞台比例与默认渲染参数保持原始值', () => {
  assert.deepEqual(viewportLayout(2560, 1440, false), { width: 1920, height: 1080, scale: 4 / 3, kind: 'desktop' })
  assert.deepEqual(normalizeQuality(undefined), qualityPresets.original)
  assert.equal(qualityPresets.original.aoSamples, 32)
  assert.equal(qualityPresets.original.shadows, 2048)
  assert.equal(qualityPresets.original.depthOfField, 100)
  assert.equal(qualityPresets.original.transmission, 1)
})

test('旧性能档恢复到原生比例抗锯齿；自定义及不完整配置不被当作旧预设', () => {
  const previous = { scale: 80, pixelRatio: 1, antialias: 'off', shadows: 1024,
    aoSamples: 0, aoResolution: 0.5, depthOfField: 0, transmission: 0.5, anisotropy: 4 }
  assert.deepEqual(restoreQuality(previous), { ...previous, scale: 100, antialias: 'smaa' })
  assert.equal(previous.scale, 80)
  for (const custom of [
    { ...previous, scale: 75 },
    { ...previous, antialias: 'smaa' },
    { ...previous, transmission: 0.75 },
    { scale: 80, pixelRatio: 1, antialias: 'off' },
    qualityPresets.high, qualityPresets.ultra, null,
  ]) assert.deepEqual(restoreQuality(custom), normalizeQuality(custom))
})
