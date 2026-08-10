import { describe, expect, it, vi } from 'vitest'

import { BaseMediaHandler, CompositeMediaHandler } from '../handler'
import { createMediaService } from '../media-service'
import type { MediaHandler, MediaServiceApi } from '../types'
import { FakeNativeMediaSession, RecordingHandler } from './fakes'

async function ready(): Promise<{
  native: FakeNativeMediaSession
  handler: RecordingHandler
  service: MediaServiceApi
}> {
  const native = new FakeNativeMediaSession()
  const handler = new RecordingHandler()
  const service = await createMediaService(native).init(() => handler)
  return { native, handler, service }
}

describe('setSleepTimer', () => {
  it('passes a validated duration to native', async () => {
    const { native, service } = await ready()
    service.setSleepTimer(45)
    expect(native.sleepTimers).toEqual([45])
  })

  it('re-arming replaces rather than stacks (native contract, asserted here)', async () => {
    const { native, service } = await ready()
    service.setSleepTimer(60)
    service.setSleepTimer(30)
    expect(native.sleepTimers).toEqual([60, 30])
    expect(service.getSleepTimerRemaining()).toBe(30)
  })

  it('rejects nonsense before it reaches native', async () => {
    const { native, service } = await ready()
    for (const value of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => service.setSleepTimer(value)).toThrowError(/seconds/)
    }
    expect(native.sleepTimers).toEqual([])
  })

  it('refuses to arm before init() resolved', () => {
    const service = createMediaService(new FakeNativeMediaSession())
    expect(() => service.setSleepTimer(30)).toThrowError(/setSleepTimer\(\)/)
    expect(() => service.cancelSleepTimer()).toThrowError(
      /cancelSleepTimer\(\)/
    )
    expect(() => service.getSleepTimerRemaining()).toThrowError(
      /getSleepTimerRemaining\(\)/
    )
  })
})

describe('cancelSleepTimer', () => {
  it('forwards to native and clears the remaining time', async () => {
    const { native, service } = await ready()
    service.setSleepTimer(120)
    expect(service.getSleepTimerRemaining()).toBe(120)

    service.cancelSleepTimer()
    expect(native.cancelSleepTimerCalls).toBe(1)
    expect(service.getSleepTimerRemaining()).toBeUndefined()
  })
})

describe('getSleepTimerRemaining', () => {
  it('is undefined when no timer is armed', async () => {
    const { service } = await ready()
    expect(service.getSleepTimerRemaining()).toBeUndefined()
  })
})

describe('onSleepTimer', () => {
  it('reaches the handler when the platform timer fires', async () => {
    const { native, handler, service } = await ready()
    service.setSleepTimer(45)

    native.fireSleepTimer()

    expect(handler.calls).toEqual(['onSleepTimer'])
    // Native fired it, so the arm is spent.
    expect(service.getSleepTimerRemaining()).toBeUndefined()
  })

  it('does NOT pause from JS — the native side already did', async () => {
    const { native, handler, service } = await ready()
    service.setSleepTimer(45)
    native.fireSleepTimer()
    // The whole ordering contract in one assertion: if this package ever
    // started pausing from JS, the pause would arrive twice and late.
    expect(handler.calls).not.toContain('pause')
  })

  it('reports a throwing handler instead of letting it escape', async () => {
    const onHandlerError = vi.fn()
    const native = new FakeNativeMediaSession()
    const handler = new RecordingHandler()
    handler.throwWith = new Error('boom')
    await createMediaService(native).init(() => handler, { onHandlerError })

    native.fireSleepTimer()

    expect(onHandlerError).toHaveBeenCalledWith('onSleepTimer', handler.throwWith)
  })

  it('is a no-op on BaseMediaHandler, and delegates through a decorator', () => {
    expect(new BaseMediaHandler().onSleepTimer()).toBeUndefined()

    const inner = new RecordingHandler()
    class Decorated extends CompositeMediaHandler {}
    new Decorated(inner).onSleepTimer()
    expect(inner.calls).toEqual(['onSleepTimer'])
  })
})

/* -------------------------------------------------------------------------- */
/*                            onPlaybackResumption                            */
/* -------------------------------------------------------------------------- */

describe('onPlaybackResumption', () => {
  it('reaches the handler when native says the runtime was revived', async () => {
    const { native, handler } = await ready()

    native.emit().onPlaybackResumption()

    expect(handler.calls).toEqual(['onPlaybackResumption'])
  })

  it('reports a throwing handler instead of letting it escape', async () => {
    const onHandlerError = vi.fn()
    const native = new FakeNativeMediaSession()
    const handler = new RecordingHandler()
    handler.throwWith = new Error('boom')
    await createMediaService(native).init(() => handler, { onHandlerError })

    native.emit().onPlaybackResumption()

    expect(onHandlerError).toHaveBeenCalledWith(
      'onPlaybackResumption',
      handler.throwWith
    )
  })

  it('is optional: a handler that omits it is not a crash', async () => {
    const native = new FakeNativeMediaSession()
    // A structural handler — what a player-agnostic consumer may legitimately
    // write without extending BaseMediaHandler. Adding an informational
    // callback to the interface must never break one of these, which is the
    // whole reason `onPlaybackResumption?` is optional (same call as
    // `onSleepTimer?`).
    const bare: MediaHandler = {
      play: () => {},
      pause: () => {},
      stop: () => {},
      seekTo: () => {},
      skipToNext: () => {},
      skipToPrevious: () => {},
      skipToQueueItem: () => {},
      setRate: () => {},
      onTaskRemoved: () => {},
      customAction: () => {},
      getChildren: () => Promise.resolve([]),
      getMediaItem: () => Promise.resolve(undefined),
    }
    expect('onPlaybackResumption' in bare).toBe(false)
    const onHandlerError = vi.fn()
    await createMediaService(native).init(() => bare, { onHandlerError })

    expect(() => native.emit().onPlaybackResumption()).not.toThrow()
    expect(() => native.emit().onSleepTimer()).not.toThrow()
    expect(onHandlerError).not.toHaveBeenCalled()
  })

  it('is a no-op on BaseMediaHandler, and delegates through a decorator', () => {
    expect(new BaseMediaHandler().onPlaybackResumption()).toBeUndefined()

    const inner = new RecordingHandler()
    class Decorated extends CompositeMediaHandler {}
    new Decorated(inner).onPlaybackResumption()
    expect(inner.calls).toEqual(['onPlaybackResumption'])
  })
})
