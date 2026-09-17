import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ArchiveNavigationLimiter, ARCHIVE_NAVIGATION_INTERVAL_MS, MAX_RETURNING_ARCHIVE_FILES } from '../ui/rhine/archive-navigation-limit.ts'
import { damp } from '../ui/rhine/original/motion.ts'

test('first navigation is immediate; repeated input cannot postpone the next allowed step', () => {
  const limit = new ArchiveNavigationLimiter()
  assert.equal(limit.tryAccept(0), true)
  for (let ms = 1; ms < ARCHIVE_NAVIGATION_INTERVAL_MS; ms++) assert.equal(limit.tryAccept(ms), false)
  assert.equal(limit.tryAccept(ARCHIVE_NAVIGATION_INTERVAL_MS), true)
  assert.equal(limit.stats().accepted, 2)
  assert.equal(limit.stats().rateLimited, ARCHIVE_NAVIGATION_INTERVAL_MS - 1)
  assert.equal(limit.stats().queued, 0)
})

test('a 30Hz key-repeat stream is limited across direction changes with no extra work after release', () => {
  const limit = new ArchiveNavigationLimiter(), moves = []
  for (let i = 0; i < 300; i++) {
    const now = i * 1000 / 30
    if (limit.tryAccept(now)) moves.push({ now, axis: i % 2 ? 'lane' : 'row', direction: i % 3 ? 1 : -1 })
  }
  assert(moves.length <= Math.ceil(10000 / ARCHIVE_NAVIGATION_INTERVAL_MS))
  for (let i = 1; i < moves.length; i++) assert(moves[i].now - moves[i - 1].now >= ARCHIVE_NAVIGATION_INTERVAL_MS)
  const before = limit.stats().accepted
  // Long inactivity accumulates neither queued input nor a burst of tokens.
  assert(limit.tryAccept(60_000))
  for (let i = 0; i < 100; i++) assert.equal(limit.tryAccept(60_000), false)
  assert.equal(limit.stats().accepted, before + 1)
  assert.equal(limit.stats().queued, 0)
})

test('unfinished return animations block further input even after the time limit expires', () => {
  const limit = new ArchiveNavigationLimiter()
  assert(limit.tryAccept(0, 0))
  assert.equal(limit.tryAccept(1000, MAX_RETURNING_ARCHIVE_FILES), false)
  assert.equal(limit.tryAccept(90000, MAX_RETURNING_ARCHIVE_FILES + 5), false)
  assert(limit.tryAccept(90001, MAX_RETURNING_ARCHIVE_FILES - 1), 'a rejected attempt must not move the cooldown')
  assert.equal(limit.stats().busyLimited, 2)
})

test('real return spring at 5FPS stays bounded under 100Hz input and resumes after returns settle', () => {
  const limit = new ArchiveNavigationLimiter(), outgoing = []
  let maximum = 0, lift = { value: .4, velocity: 0 }
  for (let now = 0; now < 20_000; now += 10) {
    if (now % 200 === 0) {
      // Match the scene's capped dt: a slow renderer cannot advance by the entire wall interval.
      damp(lift, .4, 4.2, .05)
      for (const spring of outgoing) damp(spring, 0, 4.5, .05)
      for (let i = outgoing.length - 1; i >= 0; i--) if (outgoing[i].value < .0001) outgoing.splice(i, 1)
    }
    if (limit.tryAccept(now, outgoing.length)) {
      if (lift.value > .0001) outgoing.push({ ...lift })
      lift = { value: 0, velocity: 0 }
    }
    maximum = Math.max(maximum, outgoing.length)
  }
  assert.equal(maximum, MAX_RETURNING_ARCHIVE_FILES)
  assert(limit.stats().busyLimited > 0)
  assert(limit.stats().accepted > MAX_RETURNING_ARCHIVE_FILES, 'navigation must recover when returns finish')
})
