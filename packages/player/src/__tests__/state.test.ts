import { describe, expect, it } from 'vitest'
import type { PlayerEvent } from '../events'
import { toPlayerEvents } from '../events'
import { MpvProperty } from '../properties'
import type { PlayerState, ReducerContext } from '../state'
import {
  createInitialState,
  isPositionDiscontinuity,
  projectPosition,
  reducePlayerState,
  withResyncedAnchor,
} from '../state'
import type { MpvEvent } from '../specs/mpv-client.nitro'
import {
  endFileEvent,
  logEvent,
  playbackRestartEvent,
  propertyEvent,
  seekEvent,
  shutdownEvent,
  startFileEvent,
} from './fake-mpv-client'

const T0 = 1_000_000
const URI = 'https://cdn.example.com/track.flac'

/** Feed a batch of native events through the reducer at a fixed clock. */
function run(
  state: PlayerState,
  events: readonly MpvEvent[],
  context: Partial<ReducerContext> = {}
): PlayerState {
  const full: ReducerContext = { now: T0, uri: URI, ...context }
  return toPlayerEvents(events).reduce(
    (acc, event) => reducePlayerState(acc, event, full),
    state
  )
}

/** Drive the standard "load a network track and start playing" sequence. */
function loadedAndPlaying(now = T0): PlayerState {
  let state = createInitialState(now)
  state = run(
    state,
    [propertyEvent(MpvProperty.idleActive, false), startFileEvent()],
    {
      now,
    }
  )
  state = run(
    state,
    [
      // mpv publishes the playlist cursor first, then the entry's metadata —
      // a `playlist-pos` change deliberately drops the previous duration.
      propertyEvent(MpvProperty.playlistPos, 0),
      propertyEvent(MpvProperty.playlistCount, 1),
      propertyEvent(MpvProperty.duration, 180),
      playbackRestartEvent(),
      propertyEvent(MpvProperty.pause, false),
      propertyEvent(MpvProperty.coreIdle, false),
    ],
    { now, timePos: 0 }
  )
  return state
}

describe('createInitialState', () => {
  it('starts idle, silent-clock, unattenuated and empty', () => {
    const state = createInitialState(T0)
    expect(state).toMatchObject({
      status: 'idle',
      playing: false,
      rate: 1,
      volume: 1,
      muted: false,
      loop: 'off',
      playlist: { index: -1, count: 0 },
      seeking: false,
      isLive: false,
      coreIdle: true,
      idleActive: true,
      eofReached: false,
    })
    expect(state.seekable).toBeUndefined()
    expect(state.duration).toBeUndefined()
    expect(state.error).toBeUndefined()
    expect(state.positionAnchor).toEqual({
      position: 0,
      timestamp: T0,
      rate: 1,
    })
  })
})

describe('reducer — identity', () => {
  it('returns the same object when an event changes nothing', () => {
    const state = createInitialState(T0)
    const next = run(state, [
      propertyEvent(MpvProperty.pause, true),
      propertyEvent(MpvProperty.mute, false),
      logEvent('warn', 'ffmpeg', 'noise\n'),
      propertyEvent('some-unobserved-property', 42),
    ])
    expect(next).toBe(state)
  })

  it('never mutates the previous snapshot', () => {
    const before = loadedAndPlaying()
    const snapshot = JSON.parse(JSON.stringify(before)) as unknown
    run(before, [propertyEvent(MpvProperty.pause, true)], { now: T0 + 5000 })
    expect(JSON.parse(JSON.stringify(before))).toEqual(snapshot)
  })
})

describe('reducer — full lifecycle: load → ready → play → seek → ended', () => {
  it('walks the whole status machine', () => {
    const statuses: string[] = []
    let state = createInitialState(T0)
    statuses.push(state.status)

    // 1. loadfile → mpv leaves idle and starts the entry.
    state = run(state, [
      propertyEvent(MpvProperty.idleActive, false),
      startFileEvent(),
    ])
    statuses.push(state.status)
    expect(state.duration).toBeUndefined()

    // 2. metadata arrives, then playback restarts at 0 → ready.
    state = run(
      state,
      [
        propertyEvent(MpvProperty.playlistPos, 0),
        propertyEvent(MpvProperty.playlistCount, 1),
        propertyEvent(MpvProperty.duration, 180),
        playbackRestartEvent(),
        propertyEvent(MpvProperty.pause, false),
        propertyEvent(MpvProperty.coreIdle, false),
      ],
      { now: T0 + 500, timePos: 0 }
    )
    statuses.push(state.status)
    expect(state.playing).toBe(true)
    expect(state.duration).toBe(180)

    // 3. ten seconds of playback, then a seek to 100s.
    state = run(
      state,
      [seekEvent(), propertyEvent(MpvProperty.seeking, true)],
      {
        now: T0 + 10_500,
      }
    )
    statuses.push(state.status)
    expect(state.seeking).toBe(true)
    expect(projectPosition(state, T0 + 12_000)).toBeCloseTo(10, 3)

    state = run(
      state,
      [propertyEvent(MpvProperty.seeking, false), playbackRestartEvent()],
      { now: T0 + 10_800, timePos: 100 }
    )
    statuses.push(state.status)
    expect(projectPosition(state, T0 + 10_800)).toBe(100)

    // 4. natural end of file.
    state = run(state, [endFileEvent('endOfFile')], { now: T0 + 20_000 })
    statuses.push(state.status)
    expect(state.positionAnchor.position).toBe(180)
    expect(projectPosition(state, T0 + 99_999)).toBe(180)

    expect(statuses).toEqual([
      'idle',
      'loading',
      'ready',
      'ready',
      'ready',
      'ended',
    ])
  })
})

describe('reducer — error mid-load', () => {
  it('goes loading → error and keeps the typed error', () => {
    let state = createInitialState(T0)
    state = run(state, [startFileEvent()])
    expect(state.status).toBe('loading')

    state = run(state, [endFileEvent('error', 'loading failed')], {
      now: T0 + 300,
    })
    expect(state.status).toBe('error')
    expect(state.error).toMatchObject({ code: 'network', uri: URI })
  })

  it('classifies a local load failure differently', () => {
    let state = run(createInitialState(T0), [startFileEvent()])
    state = run(state, [endFileEvent('error', 'unrecognized file format')], {
      uri: '/sdcard/x.xyz',
    })
    expect(state.error).toMatchObject({ code: 'unsupported-format' })
  })

  it('does not let a late idle-active erase the error', () => {
    let state = run(createInitialState(T0), [startFileEvent()])
    state = run(state, [endFileEvent('error', 'loading failed')])
    state = run(state, [propertyEvent(MpvProperty.idleActive, true)])
    expect(state.status).toBe('error')
    expect(state.error).toBeDefined()
  })

  it('clears the error on the next startFile', () => {
    let state = run(createInitialState(T0), [startFileEvent()])
    state = run(state, [endFileEvent('error', 'loading failed')])
    state = run(state, [startFileEvent()])
    expect(state.status).toBe('loading')
    expect(state.error).toBeUndefined()
  })

  it('clears the error when playback restarts anyway', () => {
    let state = run(createInitialState(T0), [startFileEvent()])
    state = run(state, [endFileEvent('error', 'loading failed')])
    state = run(state, [playbackRestartEvent()], { timePos: 0 })
    expect(state.status).toBe('ready')
    expect(state.error).toBeUndefined()
  })
})

describe('reducer — buffering transitions', () => {
  it('enters buffering when the core goes idle while playing', () => {
    let state = loadedAndPlaying()
    expect(state.status).toBe('ready')

    state = run(state, [propertyEvent(MpvProperty.coreIdle, true)], {
      now: T0 + 4_000,
    })
    expect(state.status).toBe('buffering')
  })

  it('does not report buffering when merely paused', () => {
    let state = loadedAndPlaying()
    state = run(
      state,
      [
        propertyEvent(MpvProperty.pause, true),
        propertyEvent(MpvProperty.coreIdle, true),
      ],
      { now: T0 + 4_000 }
    )
    expect(state.status).toBe('ready')
    expect(state.playing).toBe(false)
  })

  it('does not report buffering after EOF was reached', () => {
    let state = loadedAndPlaying()
    state = run(
      state,
      [
        propertyEvent(MpvProperty.eofReached, true),
        propertyEvent(MpvProperty.coreIdle, true),
      ],
      { now: T0 + 4_000 }
    )
    expect(state.status).toBe('ready')
  })

  it('freezes and resumes the projection across a buffering gap', () => {
    let state = loadedAndPlaying()
    // 5s of playback, then a 30s stall, then playback resumes.
    state = run(state, [propertyEvent(MpvProperty.coreIdle, true)], {
      now: T0 + 5_000,
    })
    expect(state.status).toBe('buffering')
    expect(projectPosition(state, T0 + 35_000)).toBeCloseTo(5, 3)

    state = run(state, [propertyEvent(MpvProperty.coreIdle, false)], {
      now: T0 + 35_000,
    })
    expect(state.status).toBe('ready')
    // No jump: the 30s stall is not counted as playback.
    expect(projectPosition(state, T0 + 35_000)).toBeCloseTo(5, 3)
    expect(projectPosition(state, T0 + 40_000)).toBeCloseTo(10, 3)
  })

  it('returns to idle when idle-active goes true', () => {
    let state = loadedAndPlaying()
    state = run(state, [propertyEvent(MpvProperty.idleActive, true)], {
      now: T0 + 1_000,
    })
    expect(state.status).toBe('idle')
  })
})

describe('reducer — position projection maths', () => {
  it('advances at wall-clock rate while playing', () => {
    const state = loadedAndPlaying()
    expect(projectPosition(state, T0)).toBe(0)
    expect(projectPosition(state, T0 + 1_000)).toBeCloseTo(1, 6)
    expect(projectPosition(state, T0 + 2_500)).toBeCloseTo(2.5, 6)
  })

  it('freezes while paused', () => {
    let state = loadedAndPlaying()
    state = run(state, [propertyEvent(MpvProperty.pause, true)], {
      now: T0 + 3_000,
    })
    expect(projectPosition(state, T0 + 3_000)).toBeCloseTo(3, 6)
    expect(projectPosition(state, T0 + 60_000)).toBeCloseTo(3, 6)
  })

  it('resumes from the frozen position after unpause', () => {
    let state = loadedAndPlaying()
    state = run(state, [propertyEvent(MpvProperty.pause, true)], {
      now: T0 + 3_000,
    })
    state = run(state, [propertyEvent(MpvProperty.pause, false)], {
      now: T0 + 63_000,
    })
    expect(projectPosition(state, T0 + 63_000)).toBeCloseTo(3, 6)
    expect(projectPosition(state, T0 + 65_000)).toBeCloseTo(5, 6)
  })

  it('applies a rate change from the moment it happened, not retroactively', () => {
    let state = loadedAndPlaying()
    // 10s at 1x …
    state = run(state, [propertyEvent(MpvProperty.speed, 2)], {
      now: T0 + 10_000,
    })
    expect(state.rate).toBe(2)
    expect(projectPosition(state, T0 + 10_000)).toBeCloseTo(10, 6)
    // … then 10s at 2x = 20 more seconds of media.
    expect(projectPosition(state, T0 + 20_000)).toBeCloseTo(30, 6)
  })

  it('handles a fractional rate', () => {
    let state = loadedAndPlaying()
    state = run(state, [propertyEvent(MpvProperty.speed, 0.5)], { now: T0 })
    expect(projectPosition(state, T0 + 10_000)).toBeCloseTo(5, 6)
  })

  it('clamps to duration', () => {
    const state = loadedAndPlaying()
    expect(projectPosition(state, T0 + 10_000_000)).toBe(180)
  })

  it('clamps to zero and tolerates a clock that went backwards', () => {
    const state = loadedAndPlaying()
    expect(projectPosition(state, T0 - 5_000)).toBe(0)
  })

  it('does not clamp when the duration is unknown', () => {
    let state = createInitialState(T0)
    state = run(state, [
      propertyEvent(MpvProperty.idleActive, false),
      startFileEvent(),
    ])
    state = run(
      state,
      [
        playbackRestartEvent(),
        propertyEvent(MpvProperty.pause, false),
        propertyEvent(MpvProperty.coreIdle, false),
      ],
      { timePos: 0 }
    )
    expect(state.duration).toBeUndefined()
    expect(projectPosition(state, T0 + 3_600_000)).toBeCloseTo(3600, 3)
  })

  it('freezes while seeking even though playing stays true', () => {
    let state = loadedAndPlaying()
    state = run(state, [seekEvent()], { now: T0 + 2_000 })
    expect(state.playing).toBe(true)
    expect(projectPosition(state, T0 + 50_000)).toBeCloseTo(2, 6)
  })

  it('prefers the injected time-pos over extrapolation on playbackRestart', () => {
    let state = loadedAndPlaying()
    state = run(state, [seekEvent()], { now: T0 + 2_000 })
    state = run(state, [playbackRestartEvent()], {
      now: T0 + 2_100,
      timePos: 42,
    })
    expect(state.positionAnchor.position).toBe(42)
  })

  it('falls back to extrapolation when time-pos is unavailable', () => {
    let state = loadedAndPlaying()
    state = run(state, [playbackRestartEvent()], { now: T0 + 6_000 })
    expect(state.positionAnchor.position).toBeCloseTo(6, 6)
  })

  it('clamps an out-of-range time-pos to duration', () => {
    let state = loadedAndPlaying()
    state = run(state, [playbackRestartEvent()], {
      now: T0 + 100,
      timePos: 9_999,
    })
    expect(state.positionAnchor.position).toBe(180)
  })
})

describe('withResyncedAnchor', () => {
  it('re-anchors on an authoritative reading', () => {
    const state = loadedAndPlaying()
    const next = withResyncedAnchor(state, 55.5, T0 + 12_000)
    expect(next.positionAnchor).toEqual({
      position: 55.5,
      timestamp: T0 + 12_000,
      rate: 1,
    })
    expect(projectPosition(next, T0 + 13_000)).toBeCloseTo(56.5, 6)
  })

  it('clamps and keeps identity when nothing changes', () => {
    const state = loadedAndPlaying()
    expect(withResyncedAnchor(state, 0, T0)).toBe(state)
    expect(withResyncedAnchor(state, 500, T0 + 1).positionAnchor.position).toBe(
      180
    )
  })
})

describe('reducer — track changes and playlists', () => {
  it('resets file-scoped state and anchor on a playlist-pos change', () => {
    let state = loadedAndPlaying()
    state = run(state, [propertyEvent(MpvProperty.mediaTitle, 'First')], {
      now: T0,
    })
    expect(state.title).toBe('First')

    state = run(state, [propertyEvent(MpvProperty.playlistPos, 1)], {
      now: T0 + 30_000,
    })
    expect(state.playlist.index).toBe(1)
    expect(state.duration).toBeUndefined()
    expect(state.bufferedPosition).toBeUndefined()
    expect(state.title).toBeUndefined()
    expect(state.positionAnchor).toEqual({
      position: 0,
      timestamp: T0 + 30_000,
      rate: 1,
    })
  })

  it('adopts the injected track-change reads on a cursor move', () => {
    // The reducer never reads mpv itself: a cursor change takes the entry's
    // duration/seekable/title from the context, because mpv does not republish
    // them after the change (see ReducerContext.trackChange).
    let state = loadedAndPlaying()
    state = run(state, [propertyEvent(MpvProperty.mediaTitle, 'First')])

    state = run(state, [propertyEvent(MpvProperty.playlistPos, 1)], {
      now: T0 + 30_000,
      trackChange: { duration: 137, seekable: true, title: 'Second' },
    })
    expect(state.duration).toBe(137)
    expect(state.seekable).toBe(true)
    expect(state.title).toBe('Second')
    // The cache position is the one field that repairs itself — mpv publishes
    // `demuxer-cache-time` continuously — so it is still simply dropped.
    expect(state.bufferedPosition).toBeUndefined()
  })

  it('drops a field the reads could not answer for', () => {
    let state = loadedAndPlaying()
    state = run(state, [propertyEvent(MpvProperty.mediaTitle, 'First')])

    state = run(state, [propertyEvent(MpvProperty.playlistPos, 1)], {
      now: T0 + 30_000,
      trackChange: { duration: 137 },
    })
    expect(state.duration).toBe(137)
    expect(state.seekable).toBeUndefined()
    expect(state.title).toBeUndefined()
  })

  it('lets injected seekability suppress an injected live duration', () => {
    let state = loadedAndPlaying()
    state = run(state, [propertyEvent(MpvProperty.seekable, true)])

    state = run(state, [propertyEvent(MpvProperty.playlistPos, 1)], {
      now: T0 + 30_000,
      // On an unseekable stream mpv's duration is the cache length.
      trackChange: { duration: 2.14, seekable: false, title: 'Radio' },
    })
    expect(state.isLive).toBe(true)
    expect(state.duration).toBeUndefined()
    expect(state.title).toBe('Radio')
  })

  it('maps mpv’s -1 sentinel to index -1', () => {
    let state = loadedAndPlaying()
    state = run(state, [propertyEvent(MpvProperty.playlistPos, -1)])
    expect(state.playlist.index).toBe(-1)
  })

  it('treats an unavailable playlist-pos as no current entry', () => {
    let state = loadedAndPlaying()
    state = run(state, [propertyEvent(MpvProperty.playlistPos)])
    expect(state.playlist.index).toBe(-1)
  })

  it('tracks playlist-count independently', () => {
    const state = run(createInitialState(T0), [
      propertyEvent(MpvProperty.playlistCount, 7),
    ])
    expect(state.playlist).toEqual({ index: -1, count: 7 })
  })

  it('ignores a redirect end-file entirely', () => {
    const state = loadedAndPlaying()
    expect(run(state, [endFileEvent('redirect')], { now: T0 + 1 })).toBe(state)
  })

  it('returns to idle on a stop end-file', () => {
    let state = loadedAndPlaying()
    state = run(state, [endFileEvent('stop')], { now: T0 + 1_000 })
    expect(state.status).toBe('idle')
    expect(state.error).toBeUndefined()
  })
})

describe('reducer — live streams (seekable === false)', () => {
  /**
   * The batch an unseekable Icecast stream actually produces, as recorded
   * on-device: `seekable=false`, and a `duration` that is really the demuxer
   * cache length.
   */
  function liveStream(now = T0): PlayerState {
    let state = createInitialState(now)
    state = run(
      state,
      [propertyEvent(MpvProperty.idleActive, false), startFileEvent()],
      { now }
    )
    return run(
      state,
      [
        propertyEvent(MpvProperty.playlistPos, 0),
        propertyEvent(MpvProperty.playlistCount, 1),
        propertyEvent(MpvProperty.seekable, false),
        propertyEvent(MpvProperty.duration, 1.93),
        playbackRestartEvent(),
        propertyEvent(MpvProperty.pause, false),
        propertyEvent(MpvProperty.coreIdle, false),
      ],
      { now, timePos: 0 }
    )
  }

  it('is not live before mpv has published seekable', () => {
    let state = createInitialState(T0)
    expect(state.isLive).toBe(false)
    expect(state.seekable).toBeUndefined()

    // The whole load, right up to the moment before `seekable` arrives.
    state = run(state, [
      propertyEvent(MpvProperty.idleActive, false),
      startFileEvent(),
      propertyEvent(MpvProperty.playlistPos, 0),
      propertyEvent(MpvProperty.duration, 1.93),
    ])
    expect(state.isLive).toBe(false)
    // Nothing has said this is live yet, so the duration is taken at face
    // value — the honest default.
    expect(state.duration).toBe(1.93)
  })

  it('flips to live and suppresses the cache-length duration', () => {
    const state = liveStream()
    expect(state.seekable).toBe(false)
    expect(state.isLive).toBe(true)
    expect(state.duration).toBeUndefined()
    expect(state.status).toBe('ready')
    expect(state.playing).toBe(true)
  })

  it('suppresses a duration that arrived before seekable did', () => {
    let state = run(createInitialState(T0), [
      propertyEvent(MpvProperty.idleActive, false),
      startFileEvent(),
      propertyEvent(MpvProperty.duration, 1.93),
    ])
    expect(state.duration).toBe(1.93)
    state = run(state, [propertyEvent(MpvProperty.seekable, false)])
    expect(state.isLive).toBe(true)
    expect(state.duration).toBeUndefined()
  })

  it('keeps swallowing the duration as the cache grows', () => {
    let state = liveStream()
    // 1.93 → 2.14 → … forever, several times a second on the real stream.
    for (const cacheLength of [2.14, 2.36, 2.51, 3.0]) {
      const before = state
      state = run(state, [propertyEvent(MpvProperty.duration, cacheLength)], {
        now: T0 + 1_000,
      })
      expect(state.duration).toBeUndefined()
      // And it must not even churn snapshot identity — a new object per
      // cache tick would put every subscriber back on a timer.
      expect(state).toBe(before)
    }
  })

  it('projects position without clamping while live', () => {
    const state = liveStream()
    expect(state.duration).toBeUndefined()
    // Two hours in: with the raw 1.93s "duration" this would have clamped.
    expect(projectPosition(state, T0 + 7_200_000)).toBeCloseTo(7200, 3)
  })

  it('does not anchor at a duration when a live stream ends', () => {
    let state = liveStream()
    state = run(state, [endFileEvent('endOfFile')], { now: T0 + 30_000 })
    expect(state.status).toBe('ended')
    expect(state.positionAnchor.position).toBeCloseTo(30, 3)
  })

  it('leaves a finite, seekable track completely alone', () => {
    let state = createInitialState(T0)
    state = run(state, [
      propertyEvent(MpvProperty.idleActive, false),
      startFileEvent(),
    ])
    state = run(
      state,
      [
        propertyEvent(MpvProperty.playlistPos, 0),
        propertyEvent(MpvProperty.seekable, true),
        propertyEvent(MpvProperty.duration, 180),
        playbackRestartEvent(),
        propertyEvent(MpvProperty.pause, false),
        propertyEvent(MpvProperty.coreIdle, false),
      ],
      { timePos: 0 }
    )
    expect(state.seekable).toBe(true)
    expect(state.isLive).toBe(false)
    expect(state.duration).toBe(180)
    expect(projectPosition(state, T0 + 10_000_000)).toBe(180)
  })

  it('resets isLive when the playlist moves to a finite track', () => {
    let state = liveStream()
    expect(state.isLive).toBe(true)

    // mpv publishes the new cursor first; seekability follows with the entry.
    state = run(state, [propertyEvent(MpvProperty.playlistPos, 1)], {
      now: T0 + 60_000,
    })
    expect(state.isLive).toBe(false)
    expect(state.seekable).toBeUndefined()

    state = run(
      state,
      [
        propertyEvent(MpvProperty.seekable, true),
        propertyEvent(MpvProperty.duration, 240),
      ],
      { now: T0 + 60_000 }
    )
    expect(state.isLive).toBe(false)
    expect(state.duration).toBe(240)
  })

  it('resets isLive on the next startFile', () => {
    let state = liveStream()
    state = run(state, [startFileEvent()], { now: T0 + 5_000 })
    expect(state.isLive).toBe(false)
    expect(state.seekable).toBeUndefined()
    expect(state.duration).toBeUndefined()
  })

  it('drops liveness when mpv reports seekable unavailable', () => {
    let state = liveStream()
    state = run(state, [propertyEvent(MpvProperty.seekable)])
    expect(state.seekable).toBeUndefined()
    expect(state.isLive).toBe(false)
  })

  it('never calls the idle core live, even with a stale false', () => {
    let state = liveStream()
    state = run(state, [propertyEvent(MpvProperty.idleActive, true)], {
      now: T0 + 1_000,
    })
    expect(state.status).toBe('idle')
    expect(state.isLive).toBe(false)
  })

  it('goes back to live when a finite track is followed by a stream', () => {
    let state = loadedAndPlaying()
    state = run(state, [propertyEvent(MpvProperty.seekable, true)])
    expect(state.isLive).toBe(false)

    state = run(state, [propertyEvent(MpvProperty.playlistPos, 1)], {
      now: T0 + 10_000,
    })
    state = run(state, [propertyEvent(MpvProperty.seekable, false)], {
      now: T0 + 10_000,
    })
    expect(state.isLive).toBe(true)
    expect(state.duration).toBeUndefined()
  })

  it('keeps snapshot identity when seekable is re-published unchanged', () => {
    const state = liveStream()
    expect(run(state, [propertyEvent(MpvProperty.seekable, false)])).toBe(state)
  })
})

describe('reducer — scalar properties', () => {
  it('normalises mpv volume 0-100 to 0..1', () => {
    const state = run(createInitialState(T0), [
      propertyEvent(MpvProperty.volume, 80),
    ])
    expect(state.volume).toBe(0.8)
  })

  it('accepts mpv amplification above 100 without clamping the report', () => {
    const state = run(createInitialState(T0), [
      propertyEvent(MpvProperty.volume, 130),
    ])
    expect(state.volume).toBe(1.3)
  })

  it('tracks mute', () => {
    expect(
      run(createInitialState(T0), [propertyEvent(MpvProperty.mute, true)]).muted
    ).toBe(true)
  })

  it('tracks demuxer-cache-time as the buffered position', () => {
    let state = run(createInitialState(T0), [
      propertyEvent(MpvProperty.demuxerCacheTime, 42.5),
    ])
    expect(state.bufferedPosition).toBe(42.5)
    state = run(state, [propertyEvent(MpvProperty.demuxerCacheTime)])
    expect(state.bufferedPosition).toBeUndefined()
  })

  describe('buffer clock quantisation', () => {
    /** A state that is buffered to 42.5 s of a 180 s entry. */
    function buffered(): PlayerState {
      return run(createInitialState(T0), [
        propertyEvent(MpvProperty.duration, 180),
        propertyEvent(MpvProperty.seekable, true),
        propertyEvent(MpvProperty.demuxerCacheTime, 42.5),
      ])
    }

    it('ignores sub-second movement', () => {
      const state = buffered()
      // mpv republishes this at ~4-6 Hz forever; each accepted value is a new
      // state object and a full listener fan-out.
      for (const value of [42.6, 42.9, 43.4, 42.0]) {
        expect(
          run(state, [propertyEvent(MpvProperty.demuxerCacheTime, value)])
        ).toBe(state)
      }
    })

    it('publishes once the value moved a whole second', () => {
      const state = buffered()
      const next = run(state, [
        propertyEvent(MpvProperty.demuxerCacheTime, 43.5),
      ])
      expect(next).not.toBe(state)
      // Unrounded: what is quantised is how often it changes, not its value.
      expect(next.bufferedPosition).toBe(43.5)
    })

    it('publishes a backwards jump of a whole second (a seek reset the cache)', () => {
      const next = run(buffered(), [
        propertyEvent(MpvProperty.demuxerCacheTime, 10),
      ])
      expect(next.bufferedPosition).toBe(10)
    })

    it('always publishes the moment the buffer reaches the duration', () => {
      const state = run(buffered(), [
        propertyEvent(MpvProperty.demuxerCacheTime, 179.6),
      ])
      expect(state.bufferedPosition).toBe(179.6)

      // Only 0.4 s more, but it is the end of a finite entry: "fully buffered"
      // is a state, and nothing further will ever arrive to report it.
      const next = run(state, [
        propertyEvent(MpvProperty.demuxerCacheTime, 180),
      ])
      expect(next.bufferedPosition).toBe(180)
    })

    it('does not special-case the end for a live entry', () => {
      // No duration (mpv's is a cache length on an unseekable stream, which the
      // reducer suppresses), so only the one-second rule applies.
      const state = run(createInitialState(T0), [
        propertyEvent(MpvProperty.idleActive, false),
        propertyEvent(MpvProperty.seekable, false),
        propertyEvent(MpvProperty.duration, 30),
        propertyEvent(MpvProperty.demuxerCacheTime, 12),
      ])
      expect(state.isLive).toBe(true)
      expect(
        run(state, [propertyEvent(MpvProperty.demuxerCacheTime, 30)])
      ).not.toBe(state)
      expect(
        run(state, [propertyEvent(MpvProperty.demuxerCacheTime, 12.5)])
      ).toBe(state)
    })

    it('adopts the first value of an entry whatever it is', () => {
      // After a track change `bufferedPosition` is dropped, so there is no
      // previous value to compare against and the entry must not start blind.
      const state = run(createInitialState(T0), [
        propertyEvent(MpvProperty.demuxerCacheTime, 0.25),
      ])
      expect(state.bufferedPosition).toBe(0.25)
    })
  })

  it('drops duration when mpv reports it unavailable', () => {
    let state = run(createInitialState(T0), [
      propertyEvent(MpvProperty.duration, 12),
    ])
    expect(state.duration).toBe(12)
    state = run(state, [propertyEvent(MpvProperty.duration)])
    expect(state.duration).toBeUndefined()
  })

  it.each([
    [['no', 'no'], 'off'],
    [['0', 'no'], 'off'],
    [['no', '1'], 'off'],
    [['inf', 'no'], 'track'],
    [['3', 'no'], 'track'],
    [['no', 'inf'], 'playlist'],
    [['no', 'force'], 'playlist'],
    [['no', '2'], 'playlist'],
    [['inf', 'inf'], 'track'],
  ] as const)('derives loop mode %s → %s', ([file, playlist], expected) => {
    const state = run(createInitialState(T0), [
      propertyEvent(MpvProperty.loopFile, file),
      propertyEvent(MpvProperty.loopPlaylist, playlist),
    ])
    expect(state.loop).toBe(expected)
    expect(state.loopRaw).toEqual({ file, playlist })
  })
})

describe('reducer — shutdown', () => {
  it('parks the player when the core shuts down', () => {
    let state = loadedAndPlaying()
    state = run(state, [shutdownEvent()], { now: T0 + 9_000 })
    expect(state).toMatchObject({
      status: 'idle',
      playing: false,
      idleActive: true,
      coreIdle: true,
      seeking: false,
    })
    expect(state.positionAnchor.position).toBeCloseTo(9, 6)
  })
})

describe('isPositionDiscontinuity', () => {
  it('only playbackRestart warrants a time-pos read', () => {
    const events: PlayerEvent[] = toPlayerEvents([
      startFileEvent(),
      seekEvent(),
      playbackRestartEvent(),
      endFileEvent('endOfFile'),
      propertyEvent(MpvProperty.pause, true),
      shutdownEvent(),
    ])
    expect(events.map(isPositionDiscontinuity)).toEqual([
      false,
      false,
      true,
      false,
      false,
      false,
    ])
  })
})
