import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ArchiveRefill } from '../ui/rhine/original/archive-refill.ts'

test('the rear cassette travels one full slot into a vacancy without popping at either handoff', () => {
  const motion = new ArchiveRefill()
  const hole = { lane: 2, row: 12 }
  motion.remove(hole)
  assert.equal(motion.vacant(hole), true)
  assert.equal(motion.blocks(2), true)
  motion.update(0, [])
  assert.equal(motion.vacant(hole), false)
  assert.equal(motion.row(hole), 11, 'replacement starts at the existing rear cassette, not at the empty slot')
  assert.equal(motion.row({ lane: 2, row: 11 }), 10)
  assert.equal(motion.row({ lane: 2, row: 13 }), 13, 'the front row stays put')
  assert.equal(motion.row({ lane: 3, row: 12 }), 12, 'other lanes stay put')
  let previous = 11
  for (let i = 0; i < 86; i++) {
    motion.update(0.01, [])
    const current = motion.row(hole)
    assert(current >= previous && current - previous < 0.025, 'continuous forward motion with bounded speed')
    assert.equal(current - motion.row({ lane: 2, row: 11 }), 1, 'rear cassettes keep their spacing')
    previous = current
  }
  motion.update(0.01, [])
  assert.equal(motion.row(hole), 12)
  assert.equal(motion.active, false, 'the completed motion hands back to the ordinary grid')
})

test('parallel readers retain their slots, then multiple vacancies close together without overlapping', () => {
  const motion = new ArchiveRefill()
  motion.remove({ lane: 2, row: 12 })
  motion.update(1, [{ lane: 2, row: 10 }])
  assert.equal(motion.stats()[0].phase, 'waiting')
  assert.equal(motion.vacant({ lane: 2, row: 12 }), true)
  motion.remove({ lane: 2, row: 10 })
  motion.remove({ lane: 2, row: 12 }) // duplicate release does not double the gap
  motion.update(0, [])
  const start = Array.from({ length: 9 }, (_, index) => motion.row({ lane: 2, row: 6 + index }))
  assert(!start.includes(10) && !start.includes(12))
  assert.equal(new Set(start).size, start.length)
  for (let frame = 0; frame < 70; frame++) {
    motion.update(1 / 60, [])
    const positions = Array.from({ length: 9 }, (_, index) => motion.row({ lane: 2, row: 6 + index }))
    for (let index = 1; index < positions.length; index++) assert(positions[index] - positions[index - 1] >= 1 - 1e-9)
  }
  assert.equal(motion.active, false)
})

test('infinite-track rebasing preserves the motion; reduced motion and reset finish cleanly', () => {
  const motion = new ArchiveRefill()
  motion.remove({ lane: 2052, row: 2060 })
  motion.update(0, [])
  motion.update(0.3, [])
  const before = motion.row({ lane: 2052, row: 2060 })
  motion.rebase({ lane: 2050, row: 2048 })
  assert(Math.abs(motion.row({ lane: 2, row: 12 }) - (before - 2048)) < 1e-10)
  motion.update(0, [], true)
  assert.equal(motion.active, false)
  assert.equal(motion.row({ lane: 2, row: 12 }), 12)
  motion.remove({ lane: 2, row: 12 })
  motion.clear()
  assert.equal(motion.active, false)
  assert.equal(motion.vacant({ lane: 2, row: 12 }), false)
})
