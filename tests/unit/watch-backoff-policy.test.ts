import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import {
  createWatchLoopSignal,
  nextReconciliationIntervalMs,
} from '../../src/infrastructure/watch.js'

describe('nextReconciliationIntervalMs', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    try {
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  const nextInterval = (currentIntervalMs: number, changedCount = 0, maximumIntervalMs = 80): number => (
    nextReconciliationIntervalMs({
      currentIntervalMs,
      minimumIntervalMs: 20,
      maximumIntervalMs,
      changedCount,
    })
  )

  test('backs off from 20 to 40 on the first idle transition', () => {
    expect(nextInterval(20)).toBe(40)
  })

  test('backs off from 40 to 80 on the next idle transition', () => {
    expect(nextInterval(40)).toBe(80)
  })

  test('holds at the maximum across repeated idle transitions', () => {
    let currentIntervalMs = 80

    for (let step = 0; step < 3; step += 1) {
      currentIntervalMs = nextInterval(currentIntervalMs)
      expect(currentIntervalMs).toBe(80)
    }
  })

  test.each([20, 40, 80])('resets the %i ms rung after activity', (currentIntervalMs) => {
    expect(nextInterval(currentIntervalMs, 1)).toBe(20)
  })

  test('raises a current interval below the minimum to the floor', () => {
    expect(nextInterval(5)).toBe(20)
  })

  test('caps a doubling step at a non-power-of-two maximum', () => {
    expect(nextInterval(40, 0, 50)).toBe(50)
  })

  test.each([
    { initialIntervalMs: 20, idleSteps: 4, expected: [20, 40, 80, 80, 80] },
  ])('emits the exact idle rung sequence from $initialIntervalMs ms', ({ initialIntervalMs, idleSteps, expected }) => {
    const emitted = [initialIntervalMs]
    let currentIntervalMs = initialIntervalMs

    for (let step = 0; step < idleSteps; step += 1) {
      currentIntervalMs = nextInterval(currentIntervalMs)
      emitted.push(currentIntervalMs)
    }

    expect(emitted).toEqual(expected)
  })
})

describe('createWatchLoopSignal', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    try {
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.restoreAllMocks()
      vi.useRealTimers()
    }
  })

  test('wait resolves after its delay', async () => {
    const controller = new AbortController()
    const addEventListener = vi.spyOn(controller.signal, 'addEventListener')
    const removeEventListener = vi.spyOn(controller.signal, 'removeEventListener')
    const loopSignal = createWatchLoopSignal()
    const resolved = vi.fn()
    const waiting = loopSignal.wait(100, controller.signal).then(resolved)

    expect(vi.getTimerCount()).toBe(1)
    await vi.advanceTimersByTimeAsync(99)
    expect(resolved).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1)
    await waiting

    expect(resolved).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
    expect(addEventListener).toHaveBeenCalledTimes(1)
    expect(removeEventListener).toHaveBeenCalledTimes(1)
    expect(removeEventListener).toHaveBeenCalledWith('abort', addEventListener.mock.calls[0]?.[1])
  })

  test('wake resolves a pending wait early', async () => {
    const controller = new AbortController()
    const addEventListener = vi.spyOn(controller.signal, 'addEventListener')
    const removeEventListener = vi.spyOn(controller.signal, 'removeEventListener')
    const loopSignal = createWatchLoopSignal()
    const waiting = loopSignal.wait(100, controller.signal)

    expect(vi.getTimerCount()).toBe(1)
    loopSignal.wake()
    await waiting

    expect(vi.getTimerCount()).toBe(0)
    expect(addEventListener).toHaveBeenCalledTimes(1)
    expect(removeEventListener).toHaveBeenCalledTimes(1)
    expect(removeEventListener).toHaveBeenCalledWith('abort', addEventListener.mock.calls[0]?.[1])
  })

  test('a wake before a wait is consumed immediately by the next wait', async () => {
    const controller = new AbortController()
    const addEventListener = vi.spyOn(controller.signal, 'addEventListener')
    const removeEventListener = vi.spyOn(controller.signal, 'removeEventListener')
    const loopSignal = createWatchLoopSignal()

    loopSignal.wake()
    await loopSignal.wait(100, controller.signal)

    expect(vi.getTimerCount()).toBe(0)
    expect(addEventListener).not.toHaveBeenCalled()
    expect(removeEventListener).not.toHaveBeenCalled()
  })

  test('an already-aborted signal resolves immediately without scheduling a timer', async () => {
    const controller = new AbortController()
    controller.abort()
    const addEventListener = vi.spyOn(controller.signal, 'addEventListener')
    const removeEventListener = vi.spyOn(controller.signal, 'removeEventListener')
    const loopSignal = createWatchLoopSignal()

    await loopSignal.wait(100, controller.signal)

    expect(vi.getTimerCount()).toBe(0)
    expect(addEventListener).not.toHaveBeenCalled()
    expect(removeEventListener).not.toHaveBeenCalled()
  })

  test('aborting during a pending wait resolves it', async () => {
    const controller = new AbortController()
    const addEventListener = vi.spyOn(controller.signal, 'addEventListener')
    const removeEventListener = vi.spyOn(controller.signal, 'removeEventListener')
    const loopSignal = createWatchLoopSignal()
    const waiting = loopSignal.wait(100, controller.signal)

    expect(vi.getTimerCount()).toBe(1)
    controller.abort()
    await waiting

    expect(vi.getTimerCount()).toBe(0)
    expect(addEventListener).toHaveBeenCalledTimes(1)
    expect(removeEventListener).toHaveBeenCalledTimes(1)
    expect(removeEventListener).toHaveBeenCalledWith('abort', addEventListener.mock.calls[0]?.[1])
  })

  test('two sequential waits with the same deadline resolve in call order', async () => {
    const controller = new AbortController()
    const addEventListener = vi.spyOn(controller.signal, 'addEventListener')
    const removeEventListener = vi.spyOn(controller.signal, 'removeEventListener')
    const loopSignal = createWatchLoopSignal()
    const resolutionOrder: string[] = []

    const first = loopSignal.wait(100, controller.signal).then(() => resolutionOrder.push('first'))
    const second = loopSignal.wait(100, controller.signal).then(() => resolutionOrder.push('second'))

    expect(vi.getTimerCount()).toBe(2)
    await vi.advanceTimersByTimeAsync(100)
    await Promise.all([first, second])

    expect(resolutionOrder).toEqual(['first', 'second'])
    expect(vi.getTimerCount()).toBe(0)
    expect(addEventListener).toHaveBeenCalledTimes(2)
    expect(removeEventListener).toHaveBeenCalledTimes(2)
    expect(removeEventListener).toHaveBeenNthCalledWith(1, 'abort', addEventListener.mock.calls[0]?.[1])
    expect(removeEventListener).toHaveBeenNthCalledWith(2, 'abort', addEventListener.mock.calls[1]?.[1])
  })
})
