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
  PlayingAwareFakePlayer,
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

describe('wireAudioSession — a session that dies (iOS media services)', () => {
  // iOS emits `permanent: true` for exactly one condition: a media-services
  // failure. Both `mediaServicesWereLostNotification` and
  // `mediaServicesWereResetNotification` report it, so the *pair* can arrive —
  // and nothing is coming after them. Android's `AUDIOFOCUS_LOSS` is the same
  // shape, hence one set of tests for both.
  it('stops the player and keeps no resume claim across the lost/reset pair', () => {
    const aware = new PlayingAwareFakePlayer(true)
    wireAudioSession(aware, { session })

    // …WereLost
    native.emitInterruption(beginInterruption('pause', true))
    aware.reportPlaying(false)
    // …WereReset, moments later
    native.emitInterruption(beginInterruption('pause', true))

    // The second one has nothing left to stop — the player already said so.
    expect(aware.calls).toEqual(['pause'])
  })

  it('never resumes after a permanent loss, whatever arrives next', () => {
    const aware = new PlayingAwareFakePlayer(true)
    wireAudioSession(aware, { session })

    native.emitInterruption(beginInterruption('pause', true))
    aware.reportPlaying(false)
    native.emitInterruption(beginInterruption('pause', true))
    // A stray end (a real interruption that began before the reset) must not
    // restart audio: the claim was dropped with the session.
    native.emitInterruption(endInterruption(true))

    expect(aware.calls).toEqual(['pause'])
  })

  it('restores a duck before stopping when the session dies mid-duck', () => {
    wire()

    native.emitInterruption(beginInterruption('duck'))
    native.emitInterruption(beginInterruption('pause', true))

    expect(player.calls).toEqual(['setVolume(0.3)', 'setVolume(1)', 'pause'])
    expect(player.getVolume()).toBe(1)
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

describe('wireAudioSession — a user pause is sacred (#45)', () => {
  /** Wire a state-reporting player, like the real `Player`. */
  function wireAware(playing: boolean): PlayingAwareFakePlayer {
    const aware = new PlayingAwareFakePlayer(playing)
    wireAudioSession(aware, { session })
    return aware
  }

  it('paused before a transient loss → gain with shouldResume → still paused', () => {
    // The incident shape: pause manually, watch an Instagram reel (transient
    // focus steal), reel ends (focus gain, shouldResume=true). The music must
    // NOT start by itself.
    const aware = wireAware(false)

    native.emitInterruption(beginInterruption('pause'))
    // Nothing was playing: no pause call, and — critically — no claim.
    expect(aware.calls).toEqual([])

    native.emitInterruption(endInterruption(true))
    expect(aware.calls).toEqual([])
  })

  it('playing before the loss → auto-paused → gain resumes as before', () => {
    const aware = wireAware(true)

    native.emitInterruption(beginInterruption('pause'))
    expect(aware.calls).toEqual(['pause'])
    aware.reportPlaying(false) // the pause round-trips

    native.emitInterruption(endInterruption(true))
    expect(aware.calls).toEqual(['pause', 'play'])
  })

  it('survives transient-focus flapping: a re-loss lands before our own resume is reported', () => {
    // Measured on device: Instagram re-requests focus 14 ms after abandoning
    // it, faster than an mpv property round-trip. The helper must keep
    // treating the player as "ours to pause" until the player confirms.
    const aware = wireAware(true)

    native.emitInterruption(beginInterruption('pause')) // loss
    aware.reportPlaying(false)
    native.emitInterruption(endInterruption(true)) // gain → play()
    // No report yet: isPlaying() would still say false here.
    native.emitInterruption(beginInterruption('pause')) // re-loss, 14 ms later
    aware.reportPlaying(false)
    native.emitInterruption(endInterruption(true)) // re-gain

    expect(aware.calls).toEqual(['pause', 'play', 'pause', 'play'])
  })

  it('the echo of our own pause does not retire a pending resume', () => {
    // pause and play writes round-trip in order, so the pause's `playing:
    // false` echo can land *after* the wire's play() call. Only a `playing:
    // true` confirmation may retire the pending resume.
    const aware = wireAware(true)

    native.emitInterruption(beginInterruption('pause'))
    native.emitInterruption(endInterruption(true)) // play() before any echo
    aware.reportPlaying(false) // the earlier pause's late echo
    native.emitInterruption(beginInterruption('pause')) // flap re-loss
    native.emitInterruption(endInterruption(true))

    expect(aware.calls).toEqual(['pause', 'play', 'pause', 'play'])
  })

  it('a stale resume claim dies with the player’s next report', () => {
    const aware = wireAware(true)

    native.emitInterruption(beginInterruption('pause'))
    aware.reportPlaying(false)
    native.emitInterruption(endInterruption(true)) // resume
    aware.reportPlaying(true) // resume confirmed
    aware.reportPlaying(false) // ...and then the user pauses

    // A new interruption now finds a paused player and takes no claim.
    native.emitInterruption(beginInterruption('pause'))
    native.emitInterruption(endInterruption(true))

    expect(aware.calls).toEqual(['pause', 'play'])
  })

  it('user paused during a duck: the duck is restored but no resume is owed', () => {
    const aware = wireAware(true)

    native.emitInterruption(beginInterruption('duck'))
    expect(aware.calls).toEqual(['setVolume(0.3)'])
    aware.reportPlaying(false) // the user pauses mid-duck

    native.emitInterruption(beginInterruption('pause')) // duck escalates
    // Volume restored, but the paused player is not touched and not claimed.
    expect(aware.calls).toEqual(['setVolume(0.3)', 'setVolume(1)'])

    native.emitInterruption(endInterruption(true))
    expect(aware.calls).toEqual(['setVolume(0.3)', 'setVolume(1)'])
  })

  it('becoming noisy still pauses even when the player reports paused', () => {
    // "The headphones are gone" is not a resume-claim question; a redundant
    // pause is harmless and the conservative choice.
    const aware = wireAware(false)

    native.emitBecomingNoisy()

    expect(aware.calls).toEqual(['pause'])
  })

  it('a player without isPlaying keeps the old resume-always behaviour', () => {
    // `FakePlayer` has neither isPlaying nor onStateChange — the helper has
    // nothing to consult and must not break resume-after-call for it.
    wire()

    native.emitInterruption(beginInterruption('pause'))
    native.emitInterruption(endInterruption(true))

    expect(player.calls).toEqual(['pause', 'play'])
  })

  it('unwire removes the state subscription', () => {
    const aware = new PlayingAwareFakePlayer(true)
    const unwire = wireAudioSession(aware, { session })
    expect(aware.stateListenerCount).toBe(1)

    unwire()
    expect(aware.stateListenerCount).toBe(0)
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
