void function(root, factory) {
  let createTimelineScrollRestorer = factory()

  if (typeof module == 'object' && module.exports) {
    module.exports = {createTimelineScrollRestorer}
  }
  if (root) {
    root.createCpftTimelineScrollRestorer = createTimelineScrollRestorer
  }
}(typeof globalThis == 'object' ? globalThis : this, function() {
  const DEFAULTS = {
    startDelay: 120,
    retryDelay: 100,
    minimumDuration: 3000,
    stableDuration: 1000,
    maximumDuration: 8000,
    snapshotLifetime: 30 * 60 * 1000,
    tolerance: 2,
  }

  const NAVIGATION_KEYS = new Set([
    'ArrowDown',
    'ArrowLeft',
    'ArrowRight',
    'ArrowUp',
    'End',
    'Home',
    'PageDown',
    'PageUp',
    ' ',
  ])

  /**
   * Restores a virtual timeline only after its route has been processed again.
   * All browser and DOM access is injected so the navigation lifecycle can be
   * tested without a browser.
   */
  function createTimelineScrollRestorer(options) {
    let {
      isTweetPath,
      getCurrentPath,
      getCurrentUrl,
      getScrollY,
      getAnchor,
      findAnchorTop,
      isTimelineReady,
      scrollTo,
      scrollBy,
      addEventListener,
      removeEventListener,
      setTimer = setTimeout,
      clearTimer = clearTimeout,
      now = Date.now,
      log = () => {},
      onFinish = () => {},
      ...overrides
    } = options
    let settings = {...DEFAULTS, ...overrides}

    let snapshot = null
    let phase = 'idle'
    let timer = null
    let startedAt = 0
    let stableSince = null
    let listeningForUserInput = false

    function clearScheduledStep() {
      if (timer != null) {
        clearTimer(timer)
        timer = null
      }
    }

    function removeUserInputListeners() {
      if (!listeningForUserInput) return
      listeningForUserInput = false
      removeEventListener('wheel', onUserInput, true)
      removeEventListener('pointerdown', onUserInput, true)
      removeEventListener('touchstart', onUserInput, true)
      removeEventListener('keydown', onKeyDown, true)
    }

    function finish(reason, {keepSnapshot = false} = {}) {
      let wasBusy = phase == 'pending' || phase == 'active'
      clearScheduledStep()
      removeUserInputListeners()
      phase = keepSnapshot && snapshot ? 'captured' : 'idle'
      if (!keepSnapshot) snapshot = null
      stableSince = null
      if (wasBusy) {
        log(`timeline scroll restoration finished: ${reason}`)
        onFinish(reason)
      }
    }

    function cancel(reason = 'cancelled') {
      finish(reason)
    }

    function onUserInput() {
      cancel('user input')
    }

    function onKeyDown(event) {
      if (NAVIGATION_KEYS.has(event.key)) onUserInput()
    }

    function addUserInputListeners() {
      if (listeningForUserInput) return
      listeningForUserInput = true
      addEventListener('wheel', onUserInput, true)
      addEventListener('pointerdown', onUserInput, true)
      addEventListener('touchstart', onUserInput, true)
      addEventListener('keydown', onKeyDown, true)
    }

    function routeMatchesSnapshot() {
      return snapshot != null &&
        getCurrentUrl() == snapshot.sourceUrl &&
        getCurrentPath() == snapshot.sourcePath &&
        !isTweetPath(getCurrentPath())
    }

    function scheduleStep(delay = settings.retryDelay) {
      if (timer != null || phase != 'active') return
      timer = setTimer(() => {
        timer = null
        restoreStep()
      }, delay)
    }

    function restoreStep() {
      if (phase != 'active' || !snapshot) return
      if (!routeMatchesSnapshot()) {
        finish('route changed')
        return
      }

      let elapsed = now() - startedAt
      if (elapsed >= settings.maximumDuration) {
        finish('timeout')
        return
      }
      if (!isTimelineReady()) {
        stableSince = null
        scheduleStep()
        return
      }

      let corrected = false
      let anchorTop = snapshot.anchorId == null ? null : findAnchorTop(snapshot.anchorId)
      if (typeof anchorTop == 'number' && Number.isFinite(anchorTop)) {
        let delta = anchorTop - snapshot.anchorTop
        if (Math.abs(delta) > settings.tolerance) {
          scrollBy(delta)
          corrected = true
        }
      } else {
        let delta = getScrollY() - snapshot.scrollY
        if (Math.abs(delta) > settings.tolerance) {
          scrollTo(snapshot.scrollY)
          corrected = true
        }
      }

      if (corrected) {
        stableSince = null
      } else if (stableSince == null) {
        stableSince = now()
      }

      if (elapsed >= settings.minimumDuration &&
          stableSince != null && now() - stableSince >= settings.stableDuration) {
        finish('stable')
        return
      }
      scheduleStep()
    }

    function capture(destinationPath) {
      if (!isTweetPath(destinationPath) || isTweetPath(getCurrentPath())) return false

      clearScheduledStep()
      removeUserInputListeners()
      let anchor = getAnchor(destinationPath)
      snapshot = {
        sourcePath: getCurrentPath(),
        sourceUrl: getCurrentUrl(),
        scrollY: getScrollY(),
        anchorId: anchor?.id ?? null,
        anchorTop: anchor?.top ?? 0,
        capturedAt: now(),
      }
      phase = 'captured'
      log('captured timeline scroll position', snapshot)
      return true
    }

    function onPopState() {
      if (!snapshot) return false
      if (now() - snapshot.capturedAt > settings.snapshotLifetime) {
        cancel('expired')
        return false
      }
      if (getCurrentUrl() != snapshot.sourceUrl) {
        if (phase == 'pending' || phase == 'active') {
          finish('different history entry', {keepSnapshot: true})
        }
        return false
      }

      clearScheduledStep()
      phase = 'pending'
      addUserInputListeners()
      log('waiting for the source timeline route to be processed')
      return true
    }

    function onPageProcessed() {
      if (phase != 'pending' && phase != 'active') return false
      if (!routeMatchesSnapshot()) return false
      if (phase == 'pending') {
        phase = 'active'
        startedAt = now()
        stableSince = null
        log('restoring timeline scroll position')
      }
      scheduleStep(settings.startDelay)
      return true
    }

    function isBusy() {
      return phase == 'pending' || phase == 'active'
    }

    return {
      cancel,
      capture,
      isBusy,
      onPageProcessed,
      onPopState,
    }
  }

  return createTimelineScrollRestorer
})
