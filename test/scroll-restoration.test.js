const assert = require('node:assert/strict')
const test = require('node:test')

const {
  createTimelineScrollRestorer,
  isSafeAutomaticActionControl,
} = require('../scroll-restoration.js')

function fakeControl({button = false, roleButton = false, insideLink = false} = {}) {
  return {
    matches(selector) {
      assert.equal(selector, 'button, [role="button"]')
      return button || roleButton
    },
    closest(selector) {
      assert.equal(selector, 'a[href]')
      return insideLink ? {} : null
    },
  }
}

test('automatic actions accept non-navigating buttons only', () => {
  assert.equal(isSafeAutomaticActionControl(fakeControl({button: true})), true)
  assert.equal(isSafeAutomaticActionControl(fakeControl({roleButton: true})), true)
  assert.equal(isSafeAutomaticActionControl(fakeControl()), false)
  assert.equal(
    isSafeAutomaticActionControl(fakeControl({roleButton: true, insideLink: true})),
    false
  )
})

function createHarness(overrides = {}) {
  let clock = 0
  let nextTimerId = 1
  let timers = new Map()
  let listeners = new Map()
  let currentPath = '/home'
  let currentUrl = '/home'
  let scrollY = 1400
  let timelineReady = true
  let anchor = {id: '/alice/status/123', top: 240}
  let anchorTop = null
  let scrollCalls = []

  function addEventListener(type, listener) {
    if (!listeners.has(type)) listeners.set(type, new Set())
    listeners.get(type).add(listener)
  }

  function removeEventListener(type, listener) {
    listeners.get(type)?.delete(listener)
  }

  function setTimer(callback, delay) {
    let id = nextTimerId++
    timers.set(id, {callback, time: clock + delay})
    return id
  }

  function clearTimer(id) {
    timers.delete(id)
  }

  function advance(milliseconds) {
    let end = clock + milliseconds
    while (true) {
      let next = Array.from(timers.entries())
        .filter(([, timer]) => timer.time <= end)
        .sort((a, b) => a[1].time - b[1].time || a[0] - b[0])[0]
      if (!next) break
      let [id, timer] = next
      timers.delete(id)
      clock = timer.time
      timer.callback()
    }
    clock = end
  }

  function dispatch(type, event = {}) {
    for (let listener of Array.from(listeners.get(type) ?? [])) listener(event)
  }

  let restorer = createTimelineScrollRestorer({
    isTweetPath: path => /^\/[^/]+\/status\/\d+/.test(path),
    getCurrentPath: () => currentPath,
    getCurrentUrl: () => currentUrl,
    getScrollY: () => scrollY,
    getAnchor: () => anchor,
    findAnchorTop: id => id == anchor?.id ? anchorTop : null,
    isTimelineReady: () => timelineReady,
    scrollTo: y => {
      scrollCalls.push(['to', y])
      scrollY = y
    },
    scrollBy: y => {
      scrollCalls.push(['by', y])
      scrollY += y
      if (anchorTop != null) anchorTop -= y
    },
    addEventListener,
    removeEventListener,
    setTimer,
    clearTimer,
    now: () => clock,
    minimumDuration: 300,
    stableDuration: 100,
    maximumDuration: 1000,
    startDelay: 20,
    retryDelay: 20,
    preserveMinimumDuration: 100,
    preserveStableDuration: 40,
    preserveMaximumDuration: 400,
    ...overrides,
  })

  return {
    restorer,
    advance,
    dispatch,
    get scrollCalls() { return scrollCalls },
    set currentPath(value) { currentPath = value },
    set currentUrl(value) { currentUrl = value },
    set scrollY(value) { scrollY = value },
    set timelineReady(value) { timelineReady = value },
    set anchor(value) { anchor = value },
    set anchorTop(value) { anchorTop = value },
  }
}

function leaveTimeline(harness) {
  assert.equal(harness.restorer.capture('/alice/status/123'), true)
  harness.currentPath = '/alice/status/123'
  harness.currentUrl = '/alice/status/123'
}

function popBackToTimeline(harness) {
  harness.currentUrl = '/home'
  assert.equal(harness.restorer.onPopState(), true)
}

test('popstate never scrolls the stale tweet page', () => {
  let harness = createHarness()
  leaveTimeline(harness)
  popBackToTimeline(harness)

  harness.advance(500)

  assert.equal(harness.restorer.isBusy(), true)
  assert.deepEqual(harness.scrollCalls, [])
})

test('restores only after the source route has been processed', () => {
  let harness = createHarness()
  leaveTimeline(harness)
  popBackToTimeline(harness)

  assert.equal(harness.restorer.onPageProcessed(), false)
  harness.currentPath = '/home'
  harness.scrollY = 0
  assert.equal(harness.restorer.onPageProcessed(), true)
  harness.advance(20)

  assert.deepEqual(harness.scrollCalls, [['to', 1400]])
})

test('restores the same tweet anchor to the same viewport offset', () => {
  let harness = createHarness()
  leaveTimeline(harness)
  popBackToTimeline(harness)
  harness.currentPath = '/home'
  harness.scrollY = 1000
  harness.anchorTop = 580

  harness.restorer.onPageProcessed()
  harness.advance(20)

  assert.deepEqual(harness.scrollCalls, [['by', 340]])
})

test('waits for a delayed virtual timeline without touching stale DOM', () => {
  let harness = createHarness()
  leaveTimeline(harness)
  popBackToTimeline(harness)
  harness.currentPath = '/home'
  harness.scrollY = 0
  harness.timelineReady = false

  harness.restorer.onPageProcessed()
  harness.advance(200)
  assert.deepEqual(harness.scrollCalls, [])

  harness.timelineReady = true
  harness.advance(20)
  assert.deepEqual(harness.scrollCalls, [['to', 1400]])
})

test('absolute fallback is never repeated while a virtual anchor is missing', () => {
  let harness = createHarness()
  leaveTimeline(harness)
  popBackToTimeline(harness)
  harness.currentPath = '/home'
  harness.scrollY = 0

  harness.restorer.onPageProcessed()
  harness.advance(20)
  assert.deepEqual(harness.scrollCalls, [['to', 1400]])

  // X can reset scroll while it remounts the feed. Repeating the absolute
  // fallback caused the visible bouncing captured in the screen recording.
  harness.scrollY = 0
  harness.advance(200)
  assert.deepEqual(harness.scrollCalls, [['to', 1400]])
})

test('never falls back to absolute scroll after the Tweet anchor was seen', () => {
  let harness = createHarness()
  leaveTimeline(harness)
  popBackToTimeline(harness)
  harness.currentPath = '/home'
  harness.anchorTop = 580

  harness.restorer.onPageProcessed()
  harness.advance(20)
  assert.deepEqual(harness.scrollCalls, [['by', 340]])

  harness.anchorTop = null
  harness.scrollY = 0
  harness.advance(200)
  assert.deepEqual(harness.scrollCalls, [['by', 340]])
})

test('user input cancels restoration immediately', () => {
  let harness = createHarness()
  leaveTimeline(harness)
  popBackToTimeline(harness)
  harness.currentPath = '/home'
  harness.scrollY = 0
  harness.restorer.onPageProcessed()

  harness.dispatch('wheel')
  harness.advance(500)

  assert.equal(harness.restorer.isBusy(), false)
  assert.deepEqual(harness.scrollCalls, [])
})

test('an unrelated history entry does not trigger restoration', () => {
  let harness = createHarness()
  leaveTimeline(harness)
  harness.currentUrl = '/notifications'

  assert.equal(harness.restorer.onPopState(), false)
  harness.currentPath = '/notifications'
  harness.restorer.onPageProcessed()
  harness.advance(500)

  assert.deepEqual(harness.scrollCalls, [])
})

test('nested Tweet navigation keeps the original timeline snapshot', () => {
  let harness = createHarness()
  leaveTimeline(harness)

  // Open another Tweet from the first Tweet, then Back to the first one.
  assert.equal(harness.restorer.capture('/bob/status/456'), false)
  harness.currentUrl = '/alice/status/123'
  assert.equal(harness.restorer.onPopState(), false)

  // A second Back reaches the original timeline and restores it.
  popBackToTimeline(harness)
  harness.currentPath = '/home'
  harness.scrollY = 0
  harness.restorer.onPageProcessed()
  harness.advance(20)

  assert.deepEqual(harness.scrollCalls, [['to', 1400]])
})

test('going Forward before the timeline renders does not scroll either route', () => {
  let harness = createHarness()
  leaveTimeline(harness)
  popBackToTimeline(harness)

  harness.currentUrl = '/alice/status/123'
  assert.equal(harness.restorer.onPopState(), false)
  harness.currentPath = '/alice/status/123'
  harness.advance(500)

  assert.equal(harness.restorer.isBusy(), false)
  assert.deepEqual(harness.scrollCalls, [])
})

test('automatic actions can remain paused until restoration stabilises', () => {
  let harness = createHarness()
  leaveTimeline(harness)
  popBackToTimeline(harness)
  harness.currentPath = '/home'
  harness.scrollY = 0

  assert.equal(harness.restorer.isBusy(), true)
  harness.restorer.onPageProcessed()
  harness.advance(20)
  harness.anchorTop = 240
  harness.advance(450)

  assert.equal(harness.restorer.isBusy(), false)
  assert.deepEqual(harness.scrollCalls, [['to', 1400]])
})

test('loading new posts preserves the visible Tweet anchor', () => {
  let harness = createHarness()
  harness.anchorTop = 240

  assert.equal(harness.restorer.preserveAnchorDuring(() => {
    // Simulate new posts being inserted above the visible Tweet.
    harness.anchorTop = 740
  }), true)
  assert.equal(harness.restorer.isBusy(), true)

  harness.advance(20)
  assert.deepEqual(harness.scrollCalls, [['by', 500]])
  harness.advance(200)
  assert.equal(harness.restorer.isBusy(), false)
})

test('user input cancels automatic anchor preservation', () => {
  let harness = createHarness()
  harness.anchorTop = 240

  harness.restorer.preserveAnchorDuring(() => {
    harness.anchorTop = 740
  })
  harness.dispatch('pointerdown')
  harness.advance(200)

  assert.equal(harness.restorer.isBusy(), false)
  assert.deepEqual(harness.scrollCalls, [])
})
