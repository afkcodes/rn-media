import { beforeEach, describe, expect, it, vi } from 'vitest'

import { createAudioSession } from '../audio-session'
import { AudioSessionPresets } from '../presets'
import type { AudioSessionApi } from '../types'
import { wireAudioSession } from '../wire'
import {
  beginInterruption,
  endInterruption,
  FakeNativeAudioSession,
  FakePlayer,
} from './fakes'

let native: FakeNativeAudioSession
let session: AudioSessionApi
let player: FakePlayer

beforeEach(() => {
  native = new FakeNativeAudioSession()
  session = createAudioSession(native)
  player = new FakePlayer(1)
})

function wire(
  options: Parameters<typeof wireAudioSession>[1] = {}
): () => void {
  return wireAudioSession(player, { session, ...options })
}

describe('wireAudioSession — duck sequences', () => {
  it('ducks then restores the original volume when the interruption ends', () => {
    wire()

    native.emitInterruption(beginInterruption('duck'))
    expect(player.calls).toEqual(['setVolume(0.3)'])

    native.emitInterruption(endInterruption(true))
    expect(player.calls).toEqual(['setVolume(0.3)', 'setVolume(1)'])
    expect(player.getVolume()).toBe(1)
  })

  it('restores the volume even when the OS does not recommend resuming', () => {
    wire()

    native.emitInterruption(beginInterruption('duck'))
    native.emitInterruption(endInterruption(false))

    expect(player.getVolume()).toBe(1)
    // A duck is a volume change, never a pause — `play()` must not be called.
    expect(player.calls).not.toContain('play')
  })

  it('honours a custom duckVolume', () => {
    wire({ duckVolume: 0.05 })

    native.emitInterruption(beginInterruption('duck'))
    expect(player.getVolume()).toBe(0.05)
  })

  it('never raises the volume in the name of ducking', () => {
    player = new FakePlayer(0.1)
    wire({ duckVolume: 0.3 })

    native.emitInterruption(beginInterruption('duck'))
    expect(player.getVolume()).toBe(0.1)

    native.emitInterruption(endInterruption(true))
    expect(player.getVolume()).toBe(0.1)
  })

  it('does not lose the original volume when duck begins twice', () => {
    wire()

    native.emitInterruption(beginInterruption('duck'))
    native.emitInterruption(beginInterruption('duck'))
    native.emitInterruption(endInterruption(true))

    expect(player.getVolume()).toBe(1)
    expect(player.calls).toEqual(['setVolume(0.3)', 'setVolume(1)'])
  })
})

describe('wireAudioSession — pause sequences', () => {
  it('transient loss then resume: pause, then play', () => {
    wire()

    native.emitInterruption(beginInterruption('pause'))
    expect(player.calls).toEqual(['pause'])

    native.emitInterruption(endInterruption(true))
    expect(player.calls).toEqual(['pause', 'play'])
  })

  it('transient loss then a "do not resume" end: stays paused', () => {
    wire()

    native.emitInterruption(beginInterruption('pause'))
    native.emitInterruption(endInterruption(false))

    expect(player.calls).toEqual(['pause'])
  })

  it('permanent loss never resumes, even if an end says it should', () => {
    wire()

    native.emitInterruption(beginInterruption('pause', true))
    native.emitInterruption(endInterruption(true))

    expect(player.calls).toEqual(['pause'])
  })

  it('does not resume when resumeAfterInterruption is false', () => {
    wire({ resumeAfterInterruption: false })

    native.emitInterruption(beginInterruption('pause'))
    native.emitInterruption(endInterruption(true))

    expect(player.calls).toEqual(['pause'])
  })

  it('pauses only once when begin arrives twice', () => {
    wire()

    native.emitInterruption(beginInterruption('pause'))
    native.emitInterruption(beginInterruption('pause'))

    expect(player.calls).toEqual(['pause'])
  })

  it('ignores an end that never had a begin', () => {
    wire()

    native.emitInterruption(endInterruption(true))

    expect(player.calls).toEqual([])
  })
})

describe('wireAudioSession — escalation between duck and pause', () => {
  it('duck escalating to pause restores the volume before pausing', () => {
    wire()

    native.emitInterruption(beginInterruption('duck'))
    native.emitInterruption(beginInterruption('pause'))

    expect(player.calls).toEqual(['setVolume(0.3)', 'setVolume(1)', 'pause'])
    expect(player.getVolume()).toBe(1)

    native.emitInterruption(endInterruption(true))
    expect(player.calls).toEqual([
      'setVolume(0.3)',
      'setVolume(1)',
      'pause',
      'play',
    ])
  })

  it('a duck arriving while already paused does not touch the volume', () => {
    wire()

    native.emitInterruption(beginInterruption('pause'))
    native.emitInterruption(beginInterruption('duck'))

    expect(player.calls).toEqual(['pause'])
    expect(player.getVolume()).toBe(1)

    native.emitInterruption(endInterruption(true))
    expect(player.calls).toEqual(['pause', 'play'])
  })
})

describe('wireAudioSession — becoming noisy', () => {
  it('pauses when the headphones are unplugged', () => {
    wire()

    native.emitBecomingNoisy()

    expect(player.calls).toEqual(['pause'])
  })

  it('restores a duck before pausing, and never auto-resumes afterwards', () => {
    wire()

    native.emitInterruption(beginInterruption('duck'))
    native.emitBecomingNoisy()
    expect(player.calls).toEqual(['setVolume(0.3)', 'setVolume(1)', 'pause'])

    native.emitInterruption(endInterruption(true))
    expect(player.calls).toEqual(['setVolume(0.3)', 'setVolume(1)', 'pause'])
  })

  it('drops the resume claim when it lands on top of an interruption pause', () => {
    wire()

    native.emitInterruption(beginInterruption('pause'))
    native.emitBecomingNoisy()
    // Already paused — no second pause() call.
    expect(player.calls).toEqual(['pause'])

    native.emitInterruption(endInterruption(true))
    expect(player.calls).toEqual(['pause'])
  })

  it('re-pauses on a repeat rather than going deaf to later interruptions', () => {
    wire()

    native.emitBecomingNoisy()
    native.emitBecomingNoisy()

    // The helper forgets it paused (so it can never auto-resume after a noisy
    // event), which costs one redundant, harmless `pause()` on a repeat. The
    // alternative — remembering — would make the helper ignore a *real*
    // interruption after the user manually pressed play again.
    expect(player.calls).toEqual(['pause', 'pause'])
  })

  it('still pauses on an interruption that follows a noisy event', () => {
    wire()

    native.emitBecomingNoisy()
    native.emitInterruption(beginInterruption('pause'))

    expect(player.calls).toEqual(['pause', 'pause'])
  })
})

describe('wireAudioSession — lifecycle', () => {
  it('subscribes to interruption and becomingNoisy, and unsubscribes on unwire', () => {
    const unwire = wire()
    expect(native.listenerCounts).toEqual({
      interruption: 1,
      becomingNoisy: 1,
      routeChange: 0,
    })

    unwire()
    expect(native.listenerCounts).toEqual({
      interruption: 0,
      becomingNoisy: 0,
      routeChange: 0,
    })
  })

  it('ignores events delivered after unwire', () => {
    const unwire = wire()
    unwire()

    native.emitInterruption(beginInterruption('pause'))
    native.emitBecomingNoisy()

    expect(player.calls).toEqual([])
  })

  it('unwire is idempotent', () => {
    const unwire = wire()
    unwire()
    expect(() => unwire()).not.toThrow()
  })

  it('applies the preset when one is given', () => {
    wire({ preset: AudioSessionPresets.speech })

    expect(native.configureCalls).toEqual([AudioSessionPresets.speech])
  })

  it('does not configure when no preset is given', () => {
    wire()

    expect(native.configureCalls).toEqual([])
  })

  it('routes a failing configure to onError instead of an unhandled rejection', async () => {
    const failure = new Error('nope')
    native.configureError = failure
    const onError = vi.fn()

    wire({ preset: AudioSessionPresets.music, onError })
    await Promise.resolve()
    await Promise.resolve()

    expect(onError).toHaveBeenCalledWith(failure)
  })

  it('keeps two independently wired players isolated', () => {
    const other = new FakePlayer(1)
    wire()
    wireAudioSession(other, { session, duckVolume: 0.5 })

    native.emitInterruption(beginInterruption('duck'))

    expect(player.getVolume()).toBe(0.3)
    expect(other.getVolume()).toBe(0.5)
  })
})
