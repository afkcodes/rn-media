import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  AudioSession,
  createAudioSession,
  narrowInterruptionEvent,
} from '../audio-session'
import { AudioSessionPresets } from '../presets'
import type { AudioSessionApi } from '../types'
import {
  beginInterruption,
  endInterruption,
  FakeNativeAudioSession,
} from './fakes'

let native: FakeNativeAudioSession
let session: AudioSessionApi

beforeEach(() => {
  native = new FakeNativeAudioSession()
  session = createAudioSession(native)
})

describe('narrowInterruptionEvent', () => {
  it('keeps type and permanent on a begin event, and drops shouldResume', () => {
    expect(narrowInterruptionEvent(beginInterruption('duck'))).toEqual({
      begin: true,
      type: 'duck',
      permanent: false,
    })
    expect(narrowInterruptionEvent(beginInterruption('pause', true))).toEqual({
      begin: true,
      type: 'pause',
      permanent: true,
    })
  })

  it('keeps only shouldResume on an end event', () => {
    expect(narrowInterruptionEvent(endInterruption(true))).toEqual({
      begin: false,
      shouldResume: true,
    })
    expect(narrowInterruptionEvent(endInterruption(false))).toEqual({
      begin: false,
      shouldResume: false,
    })
  })
})

describe('createAudioSession', () => {
  it('delegates configure/activate/deactivate to the native module', async () => {
    await session.configure(AudioSessionPresets.music)
    expect(native.configureCalls).toEqual([AudioSessionPresets.music])

    native.activateResult = false
    await expect(session.activate()).resolves.toBe(false)
    expect(native.activateCalls).toBe(1)

    await session.deactivate()
    expect(native.deactivateCalls).toBe(1)
  })

  it('propagates a native configure rejection', async () => {
    native.configureError = new Error('setCategory failed')
    await expect(session.configure(AudioSessionPresets.music)).rejects.toThrow(
      'setCategory failed'
    )
  })

  it('delivers narrowed interruption events', () => {
    const listener = vi.fn()
    session.addListener('interruption', listener)

    native.emitInterruption(beginInterruption('duck'))
    native.emitInterruption(endInterruption(true))

    expect(listener.mock.calls).toEqual([
      [{ begin: true, type: 'duck', permanent: false }],
      [{ begin: false, shouldResume: true }],
    ])
  })

  it('delivers becomingNoisy and routeChange events', () => {
    const noisy = vi.fn()
    const route = vi.fn()
    session.addListener('becomingNoisy', noisy)
    session.addListener('routeChange', route)

    native.emitBecomingNoisy()
    native.emitRouteChange({ reason: 'oldDeviceUnavailable' })

    expect(noisy).toHaveBeenCalledTimes(1)
    expect(route).toHaveBeenCalledWith({ reason: 'oldDeviceUnavailable' })
  })

  it('removes exactly the listener that was added', () => {
    const first = vi.fn()
    const second = vi.fn()
    const unsubFirst = session.addListener('interruption', first)
    session.addListener('interruption', second)

    unsubFirst()
    native.emitInterruption(beginInterruption('pause'))

    expect(first).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledTimes(1)
    expect(native.listenerCounts.interruption).toBe(1)
  })

  it('has an idempotent unsubscribe', () => {
    const listener = vi.fn()
    const unsub = session.addListener('interruption', listener)
    const other = session.addListener('interruption', vi.fn())

    unsub()
    unsub()
    // The second call must not have removed `other` by re-using a recycled id.
    expect(native.listenerCounts.interruption).toBe(1)
    other()
  })

  it('throws on an unknown event name', () => {
    expect(() =>
      // @ts-expect-error — deliberately outside the typed event map
      session.addListener('nope', () => {})
    ).toThrow(/Unknown event "nope"/)
  })
})

describe('AudioSession singleton', () => {
  it('does not construct the native hybrid object at import time', () => {
    // The vitest stub throws if `createHybridObject` is ever reached; simply
    // touching the module (done at the top of this file) must not trip it.
    expect(typeof AudioSession.addListener).toBe('function')
  })

  it('constructs it lazily — and therefore only on first use', () => {
    expect(() => AudioSession.activate()).toThrow(
      /Tests must inject a fake native module/
    )
  })
})

describe('AudioSessionPresets', () => {
  it('music ducks, speech pauses', () => {
    expect(AudioSessionPresets.music.android.willPauseWhenDucked).toBe(false)
    expect(AudioSessionPresets.speech.android.willPauseWhenDucked).toBe(true)
  })

  it('tags the content type on both platforms', () => {
    expect(AudioSessionPresets.music.android.contentType).toBe('music')
    expect(AudioSessionPresets.music.ios.mode).toBe('defaultMode')
    expect(AudioSessionPresets.speech.android.contentType).toBe('speech')
    expect(AudioSessionPresets.speech.ios.mode).toBe('spokenAudio')
  })

  it('uses the long-form-audio route sharing policy so AirPlay 2 works', () => {
    expect(AudioSessionPresets.music.ios.routeSharingPolicy).toBe(
      'longFormAudio'
    )
    expect(AudioSessionPresets.speech.ios.routeSharingPolicy).toBe(
      'longFormAudio'
    )
  })

  // The presets are process-wide shared objects: a caller that mutated one
  // would change what every other caller gets configured with.
  it('is deeply frozen, nested config objects and arrays included', () => {
    for (const preset of [
      AudioSessionPresets,
      AudioSessionPresets.music,
      AudioSessionPresets.music.ios,
      AudioSessionPresets.music.ios.categoryOptions,
      AudioSessionPresets.music.android,
      AudioSessionPresets.speech,
      AudioSessionPresets.speech.ios,
      AudioSessionPresets.speech.ios.categoryOptions,
      AudioSessionPresets.speech.android,
    ]) {
      expect(Object.isFrozen(preset)).toBe(true)
    }
  })

  it('rejects mutation of a nested value in strict mode', () => {
    expect(() => {
      // @ts-expect-error — `satisfies` keeps the literal type (`false`), so TS
      // already rejects this. The runtime freeze is what stops the same write
      // arriving from untyped JS.
      AudioSessionPresets.music.android.willPauseWhenDucked = true
    }).toThrow(TypeError)
    expect(AudioSessionPresets.music.android.willPauseWhenDucked).toBe(false)
  })
})
