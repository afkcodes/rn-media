import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PlayerError } from '../errors'
import { PlayerErrorException } from '../errors'
import type { LogEvent } from '../events'
import { LIVE_EOF_BUDGET_RESET_SECONDS, Player } from '../player'
import { MpvProperty, OBSERVED_PROPERTIES } from '../properties'
import type { PlayerState } from '../state'
import {
  FakeMpvClient,
  endFileEvent,
  logEvent,
  playbackRestartEvent,
  propertyEvent,
  seekEvent,
  startFileEvent,
  toneCapture,
} from './fake-mpv-client'

const URI = 'https://cdn.example.com/track.flac'

/** A controllable clock so every projection assertion is deterministic. */
class Clock {
  now = 1_000_000
  readonly read = (): number => this.now
  advance(ms: number): void {
    this.now += ms
  }
}

let client: FakeMpvClient
let clock: Clock

async function createPlayer(
  overrides: Parameters<typeof Player.create>[0] = {}
): Promise<Player> {
  return Player.create({
    createClient: () => client,
    now: clock.read,
    ...overrides,
  })
}

beforeEach(() => {
  client = new FakeMpvClient()
  clock = new Clock()
})

describe('Player.create', () => {
  it('initializes the core with the default log level, user agent and cache', async () => {
    await createPlayer()
    expect(client.initialized).toBe(true)
    expect(client.initOptions).toEqual({
      'log-level': 'warn',
      'user-agent': 'timbre (libmpv)',
      // mpv's own default readahead is 1000 h, capped only by the 150 MiB
      // `demuxer-max-bytes`; bounding it is what stops a paused radio stream
      // from downloading for hours. See DEFAULT_CACHE_SECS.
      'cache-secs': '30',
      // FFmpeg's own HTTP reconnection, on by default. `reconnect_at_eof` is
      // deliberately absent — see NetworkReconnectOptions for why enabling it
      // would turn every clean end-of-file into a four-second retry storm.
      'stream-lavf-o':
        'reconnect=1,reconnect_on_network_error=1,reconnect_streamed=1,reconnect_delay_max=5',
    })
  })

  it('maps TS log level names to the strings mpv actually accepts', async () => {
    // `verbose`/`debugging` are TS-side renames (macro collisions); mpv only
    // understands `v`/`debug`. Passing the TS name raw makes initialize throw.
    await createPlayer({ logLevel: 'debugging' })
    expect(client.initOptions?.['log-level']).toBe('debug')
    client = new FakeMpvClient()
    await createPlayer({ logLevel: 'verbose' })
    expect(client.initOptions?.['log-level']).toBe('v')
  })

  it('passes raw mpv options through and lets them override', async () => {
    await createPlayer({
      userAgent: 'my-app/1.0',
      mpvOptions: { 'cache-secs': '120', 'user-agent': 'raw-wins/2.0' },
    })
    expect(client.initOptions).toEqual({
      'log-level': 'warn',
      // The raw escape hatch beats both the typed option and our default.
      'cache-secs': '120',
      'user-agent': 'raw-wins/2.0',
      'stream-lavf-o':
        'reconnect=1,reconnect_on_network_error=1,reconnect_streamed=1,reconnect_delay_max=5',
    })
  })

  it('honours the typed userAgent option', async () => {
    await createPlayer({ userAgent: 'my-radio-app/3.1' })
    expect(client.initOptions?.['user-agent']).toBe('my-radio-app/3.1')
  })

  it('installs every observation from the table and no others', async () => {
    await createPlayer()
    expect([...client.observations.entries()].sort()).toEqual(
      OBSERVED_PROPERTIES.map((p) => [p.name, p.format] as const)
        .map((entry) => [...entry])
        .sort()
    )
  })

  it('never observes time-pos', async () => {
    await createPlayer()
    expect(client.observations.has(MpvProperty.timePos)).toBe(false)
  })

  it('registers exactly one batch listener', async () => {
    await createPlayer()
    expect(client.hasListener).toBe(true)
  })

  it('applies the initial volume, mute, rate and loop', async () => {
    await createPlayer({
      volume: 0.8,
      muted: true,
      rate: 1.5,
      loop: 'playlist',
    })
    expect(client.written.get(MpvProperty.volume)).toBe(80)
    expect(client.written.get(MpvProperty.mute)).toBe(true)
    expect(client.written.get(MpvProperty.speed)).toBe(1.5)
    expect(client.written.get(MpvProperty.loopFile)).toBe('no')
    expect(client.written.get(MpvProperty.loopPlaylist)).toBe('inf')
  })

  it('tears the core down and throws a typed error when init fails', async () => {
    client.initRejection =
      '[mpv:-5] mpv_set_option_string("nope"): option not found'
    await expect(createPlayer()).rejects.toBeInstanceOf(PlayerErrorException)
    expect(client.destroyCount).toBe(1)
  })
})

describe('Player — state and events', () => {
  it('reduces a batch and notifies once', async () => {
    const player = await createPlayer()
    const listener = vi.fn<(state: PlayerState) => void>()
    player.onStateChange(listener)

    client.emit([
      propertyEvent(MpvProperty.idleActive, false),
      startFileEvent(),
      propertyEvent(MpvProperty.playlistPos, 0),
      propertyEvent(MpvProperty.duration, 60),
    ])

    expect(listener).toHaveBeenCalledTimes(1)
    expect(player.state.status).toBe('loading')
    expect(player.state.duration).toBe(60)
  })

  it('does not notify when a batch changes nothing', async () => {
    const player = await createPlayer()
    const listener = vi.fn()
    player.onStateChange(listener)
    client.emit([logEvent('warn', 'ffmpeg', 'noise\n')])
    expect(listener).not.toHaveBeenCalled()
  })

  it('unsubscribes state listeners', async () => {
    const player = await createPlayer()
    const listener = vi.fn()
    const stop = player.onStateChange(listener)
    stop()
    client.emit([startFileEvent()])
    expect(listener).not.toHaveBeenCalled()
  })

  it('emits trackEnded for a natural end, not error', async () => {
    const player = await createPlayer()
    await player.load(URI)
    const ended = vi.fn()
    const failed = vi.fn()
    player.on('trackEnded', ended)
    player.on('error', failed)

    client.emit([startFileEvent(), propertyEvent(MpvProperty.playlistPos, 0)])
    client.emit([endFileEvent('endOfFile')])

    expect(ended).toHaveBeenCalledWith({ index: 0 })
    expect(failed).not.toHaveBeenCalled()
    expect(player.state.status).toBe('ended')
  })

  it('emits a typed error for a premature network end', async () => {
    const player = await createPlayer()
    await player.load(URI)
    const failed = vi.fn<(error: PlayerError) => void>()
    const ended = vi.fn()
    player.on('error', failed)
    player.on('trackEnded', ended)

    client.emit([startFileEvent()])
    client.emit([endFileEvent('error', 'loading failed')])

    expect(ended).not.toHaveBeenCalled()
    expect(failed).toHaveBeenCalledTimes(1)
    expect(failed.mock.calls[0]?.[0]).toMatchObject({
      code: 'network',
      uri: URI,
    })
    expect(player.state.error).toMatchObject({ code: 'network' })
  })

  it('emits trackChanged with both indices', async () => {
    const player = await createPlayer()
    const changed = vi.fn()
    player.on('trackChanged', changed)

    client.emit([propertyEvent(MpvProperty.playlistPos, 0)])
    client.emit([propertyEvent(MpvProperty.playlistPos, 1)])

    expect(changed.mock.calls).toEqual([
      [{ index: 0, previousIndex: -1, entryId: undefined, uri: undefined }],
      [{ index: 1, previousIndex: 0, entryId: undefined, uri: undefined }],
    ])
  })

  it('reports the new entry identity (entryId + uri) on trackChanged', async () => {
    const player = await createPlayer()
    const changed = vi.fn()
    player.on('trackChanged', changed)

    // mpv answers the per-index identity reads for the entry the cursor lands on.
    client.readable.set('playlist/1/filename', 'https://cdn/track-7.flac')
    client.readable.set('playlist/1/id', 42)
    client.emit([propertyEvent(MpvProperty.playlistPos, 1)])

    expect(changed.mock.calls).toEqual([
      [
        {
          index: 1,
          previousIndex: -1,
          entryId: 42,
          uri: 'https://cdn/track-7.flac',
        },
      ],
    ])
  })

  it('leaves the identity fields undefined when the cursor goes to -1', async () => {
    const player = await createPlayer()
    // Land on a real entry first, identity known.
    client.readable.set('playlist/0/filename', 'https://cdn/track-0.flac')
    client.readable.set('playlist/0/id', 7)
    client.emit([propertyEvent(MpvProperty.playlistPos, 0)])

    const changed = vi.fn()
    player.on('trackChanged', changed)
    // Cursor clears — there is no current entry, so nothing to identify.
    client.emit([propertyEvent(MpvProperty.playlistPos, -1)])

    expect(changed.mock.calls).toEqual([
      [{ index: -1, previousIndex: 0, entryId: undefined, uri: undefined }],
    ])
  })

  it('forwards log events', async () => {
    const player = await createPlayer()
    const logs: LogEvent[] = []
    player.on('log', (event) => logs.push(event))
    client.emit([logEvent('error', 'stream', 'connection lost\n')])
    expect(logs).toEqual([
      {
        kind: 'log',
        level: 'error',
        prefix: 'stream',
        text: 'connection lost\n',
      },
    ])
  })

  it('unsubscribes discrete listeners', async () => {
    const player = await createPlayer()
    const changed = vi.fn()
    player.on('trackChanged', changed)()
    client.emit([propertyEvent(MpvProperty.playlistPos, 3)])
    expect(changed).not.toHaveBeenCalled()
  })
})

/**
 * Regression cover for the gapless transition that used to lose `duration`,
 * `seekable` and `title` forever (observed on device 2026-08-11).
 *
 * mpv re-emits an observed property only when the value compares unequal, and
 * it walks a client's observers in registration order — `duration` before
 * `playlist-pos`. So on a gapless transition the new entry's duration is
 * delivered *before* the cursor change that used to drop it, and no second
 * event ever comes. The Player therefore reads the three file-scoped values
 * once, synchronously, whenever a batch moves the cursor.
 */
describe('Player — gapless track transitions', () => {
  /** Land on entry 0 of a two-entry playlist with every field known. */
  async function onFirstTrack(): Promise<Player> {
    const player = await createPlayer()
    await player.load(URI)
    client.readable.set(MpvProperty.timePos, 0)
    client.emit([
      propertyEvent(MpvProperty.idleActive, false),
      startFileEvent(),
      propertyEvent(MpvProperty.playlistPos, 0),
      propertyEvent(MpvProperty.playlistCount, 2),
      propertyEvent(MpvProperty.duration, 200),
      propertyEvent(MpvProperty.seekable, true),
      propertyEvent(MpvProperty.mediaTitle, 'First'),
      playbackRestartEvent(),
      propertyEvent(MpvProperty.pause, false),
      propertyEvent(MpvProperty.coreIdle, false),
    ])
    return player
  }

  /** What the core answers for the entry that just became current. */
  function nextEntry(values: {
    duration?: number
    seekable?: boolean
    title?: string
  }): void {
    for (const [name, value] of [
      [MpvProperty.duration, values.duration],
      [MpvProperty.seekable, values.seekable],
      [MpvProperty.mediaTitle, values.title],
    ] as const) {
      if (value === undefined) client.readable.delete(name)
      else client.readable.set(name, value)
    }
  }

  it('keeps a duration mpv delivered before the cursor moved', async () => {
    const player = await onFirstTrack()
    nextEntry({ duration: 137, seekable: true, title: 'Second' })

    // The exact order mpv produces on a gapless boundary: the new entry's
    // `duration` first (registered earlier), then `playlist-pos`.
    client.emit([
      propertyEvent(MpvProperty.duration, 137),
      propertyEvent(MpvProperty.playlistPos, 1),
    ])

    expect(player.state.playlist.index).toBe(1)
    expect(player.state.duration).toBe(137)
    expect(player.state.seekable).toBe(true)
    expect(player.state.title).toBe('Second')
    expect(player.state.isLive).toBe(false)
  })

  it('keeps the duration when the next track is exactly as long', async () => {
    const player = await onFirstTrack()
    // Equal values never produce a property-change event at all, so the batch
    // carries the cursor move and nothing else.
    nextEntry({ duration: 200, seekable: true, title: 'Second' })
    client.emit([propertyEvent(MpvProperty.playlistPos, 1)])

    expect(player.state.duration).toBe(200)
    expect(player.state.seekable).toBe(true)
    expect(player.state.title).toBe('Second')
  })

  it('reports unknown rather than stale when the reads come back empty', async () => {
    const player = await onFirstTrack()
    // A network entry mpv has not demuxed yet: the properties are unavailable.
    nextEntry({})
    client.emit([propertyEvent(MpvProperty.playlistPos, 1)])

    expect(player.state.duration).toBeUndefined()
    expect(player.state.seekable).toBeUndefined()
    expect(player.state.title).toBeUndefined()

    // none → value compares unequal, so mpv does emit these once it knows.
    client.emit([
      propertyEvent(MpvProperty.duration, 95),
      propertyEvent(MpvProperty.seekable, true),
      propertyEvent(MpvProperty.mediaTitle, 'Second'),
    ])
    expect(player.state.duration).toBe(95)
    expect(player.state.seekable).toBe(true)
    expect(player.state.title).toBe('Second')
  })

  it('leaves live behind when a stream is followed by a finite track', async () => {
    const player = await onFirstTrack()
    client.emit([propertyEvent(MpvProperty.seekable, false)])
    expect(player.state.isLive).toBe(true)
    expect(player.state.duration).toBeUndefined()

    nextEntry({ duration: 137, seekable: true, title: 'Second' })
    client.emit([propertyEvent(MpvProperty.playlistPos, 1)])

    expect(player.state.isLive).toBe(false)
    expect(player.state.seekable).toBe(true)
    expect(player.state.duration).toBe(137)
  })

  it('becomes live when a finite track is followed by a stream', async () => {
    const player = await onFirstTrack()
    expect(player.state.isLive).toBe(false)

    // mpv's `duration` on an unseekable stream is the cache length; adopting
    // it would be a lie, so liveness has to win over the one-shot read.
    nextEntry({ duration: 2.14, seekable: false, title: 'Radio' })
    client.emit([propertyEvent(MpvProperty.playlistPos, 1)])

    expect(player.state.isLive).toBe(true)
    expect(player.state.seekable).toBe(false)
    expect(player.state.duration).toBeUndefined()
    expect(player.state.title).toBe('Radio')
  })

  it('reads each property once per cursor change, and never otherwise', async () => {
    const player = await onFirstTrack()
    nextEntry({ duration: 137, seekable: true, title: 'Second' })
    const numbers = vi.spyOn(client, 'getPropertyNumber')
    const bools = vi.spyOn(client, 'getPropertyBool')
    const strings = vi.spyOn(client, 'getPropertyString')

    client.emit([
      propertyEvent(MpvProperty.demuxerCacheTime, 12),
      propertyEvent(MpvProperty.coreIdle, true),
    ])
    expect(numbers).not.toHaveBeenCalled()
    expect(bools).not.toHaveBeenCalled()
    expect(strings).not.toHaveBeenCalled()

    client.emit([
      propertyEvent(MpvProperty.duration, 137),
      propertyEvent(MpvProperty.playlistPos, 1),
      propertyEvent(MpvProperty.playlistPos, 1),
    ])
    expect(numbers.mock.calls).toEqual([
      [MpvProperty.duration],
      ['playlist/1/id'],
    ])
    expect(bools.mock.calls).toEqual([[MpvProperty.seekable]])
    // Five reads per cursor change, not three: `media-title` for the state,
    // `playlist/<new index>/filename` for the URI the error classification is
    // keyed on, and `playlist/<new index>/id` for the entry identity that
    // `trackChanged` reports. All one-shot, all riding the same already-paid
    // boundary, and the duplicate `playlist-pos` in this batch still buys only
    // one of each.
    expect(strings.mock.calls).toEqual([
      [MpvProperty.mediaTitle],
      ['playlist/1/filename'],
    ])
    expect(player.state.duration).toBe(137)
  })

  it('survives a core that throws mid-batch', async () => {
    const player = await onFirstTrack()
    for (const name of [
      MpvProperty.duration,
      MpvProperty.seekable,
      MpvProperty.mediaTitle,
    ]) {
      client.readErrors.set(name, '[mpv:-10] core is shutting down')
    }

    expect(() =>
      client.emit([propertyEvent(MpvProperty.playlistPos, 1)])
    ).not.toThrow()
    expect(player.state.playlist.index).toBe(1)
    expect(player.state.duration).toBeUndefined()
  })
})

describe('Player — position projection', () => {
  async function playing(): Promise<Player> {
    const player = await createPlayer()
    await player.load(URI)
    client.readable.set(MpvProperty.timePos, 0)
    client.emit([
      propertyEvent(MpvProperty.idleActive, false),
      startFileEvent(),
      propertyEvent(MpvProperty.playlistPos, 0),
      propertyEvent(MpvProperty.duration, 120),
      playbackRestartEvent(),
      propertyEvent(MpvProperty.pause, false),
      propertyEvent(MpvProperty.coreIdle, false),
    ])
    return player
  }

  it('reads time-pos exactly once per batch containing a playbackRestart', async () => {
    const player = await createPlayer()
    const spy = vi.spyOn(client, 'getPropertyNumber')
    client.emit([startFileEvent(), propertyEvent(MpvProperty.duration, 10)])
    expect(spy).not.toHaveBeenCalled()

    client.emit([playbackRestartEvent(), playbackRestartEvent()])
    expect(
      spy.mock.calls.filter(([name]) => name === MpvProperty.timePos)
    ).toHaveLength(1)
    expect(player.state.status).toBe('ready')
  })

  it('projects forward without any native call', async () => {
    const player = await createPlayer()
    await player.load(URI)
    client.readable.set(MpvProperty.timePos, 30)
    client.emit([
      propertyEvent(MpvProperty.idleActive, false),
      startFileEvent(),
      propertyEvent(MpvProperty.duration, 120),
      playbackRestartEvent(),
      propertyEvent(MpvProperty.pause, false),
      propertyEvent(MpvProperty.coreIdle, false),
    ])
    const spy = vi.spyOn(client, 'getPropertyNumber')
    clock.advance(4_000)
    expect(player.getPosition()).toBeCloseTo(34, 6)
    clock.advance(1_500)
    expect(player.getPosition()).toBeCloseTo(35.5, 6)
    expect(spy).not.toHaveBeenCalled()
  })

  it('freezes on pause and resumes without losing time', async () => {
    const player = await createPlayer()
    await player.load(URI)
    client.readable.set(MpvProperty.timePos, 0)
    client.emit([
      propertyEvent(MpvProperty.idleActive, false),
      startFileEvent(),
      propertyEvent(MpvProperty.duration, 120),
      playbackRestartEvent(),
      propertyEvent(MpvProperty.pause, false),
      propertyEvent(MpvProperty.coreIdle, false),
    ])
    clock.advance(10_000)
    client.emit([propertyEvent(MpvProperty.pause, true)])
    clock.advance(60_000)
    expect(player.getPosition()).toBeCloseTo(10, 6)
    client.emit([propertyEvent(MpvProperty.pause, false)])
    clock.advance(5_000)
    expect(player.getPosition()).toBeCloseTo(15, 6)
  })

  it('clamps to duration', async () => {
    const player = await playing()
    clock.advance(10_000_000)
    expect(player.getPosition()).toBe(120)
  })

  it('resyncPosition re-anchors from time-pos and notifies', async () => {
    const player = await playing()
    const listener = vi.fn()
    player.onStateChange(listener)
    clock.advance(3_000)
    client.readable.set(MpvProperty.timePos, 61.25)

    expect(player.resyncPosition()).toBe(61.25)
    expect(listener).toHaveBeenCalledTimes(1)
    clock.advance(1_000)
    expect(player.getPosition()).toBeCloseTo(62.25, 6)
  })

  it('resyncPosition falls back to the projection when time-pos is unavailable', async () => {
    const player = await playing()
    clock.advance(3_000)
    client.readable.delete(MpvProperty.timePos)
    expect(player.resyncPosition()).toBeCloseTo(3, 6)
  })
})

describe('Player — transport commands', () => {
  it('play/pause/toggle write the pause property', async () => {
    const player = await createPlayer()
    player.play()
    expect(client.written.get(MpvProperty.pause)).toBe(false)
    player.pause()
    expect(client.written.get(MpvProperty.pause)).toBe(true)

    client.emit([propertyEvent(MpvProperty.pause, false)])
    player.toggle()
    expect(client.written.get(MpvProperty.pause)).toBe(true)
    client.emit([propertyEvent(MpvProperty.pause, true)])
    player.toggle()
    expect(client.written.get(MpvProperty.pause)).toBe(false)
  })

  it('isPlaying mirrors the observed pause property, not the written one', async () => {
    // The wireAudioSession pause-latch contract (#45): isPlaying() answers
    // from the *observed* state, so it stays stale until the property
    // round-trips — which is exactly what the wire's resume-pending flag
    // compensates for.
    const player = await createPlayer()
    expect(player.isPlaying()).toBe(false)

    player.play()
    expect(player.isPlaying()).toBe(false) // written, not yet observed
    client.emit([propertyEvent(MpvProperty.pause, false)])
    expect(player.isPlaying()).toBe(true)

    client.emit([propertyEvent(MpvProperty.pause, true)])
    expect(player.isPlaying()).toBe(false)
  })

  it('seekTo issues an absolute exact seek and clamps negatives', async () => {
    const player = await createPlayer()
    await player.seekTo(42.5)
    await player.seekTo(-3)
    expect(client.commands).toEqual([
      ['seek', '42.5', 'absolute+exact'],
      ['seek', '0', 'absolute+exact'],
    ])
  })

  it('setRate clamps to mpv’s documented 0.01–100', async () => {
    const player = await createPlayer()
    player.setRate(2)
    expect(client.written.get(MpvProperty.speed)).toBe(2)
    player.setRate(0)
    expect(client.written.get(MpvProperty.speed)).toBe(0.01)
    player.setRate(1000)
    expect(client.written.get(MpvProperty.speed)).toBe(100)
  })

  it('setVolume converts 0..1 to mpv’s 0..100 and clamps', async () => {
    const player = await createPlayer()
    player.setVolume(0.25)
    expect(client.written.get(MpvProperty.volume)).toBe(25)
    player.setVolume(-1)
    expect(client.written.get(MpvProperty.volume)).toBe(0)
    player.setVolume(4)
    expect(client.written.get(MpvProperty.volume)).toBe(100)
  })

  // `wireAudioSession` (@afkcodes/timbre-audio-session) requires this method on the
  // structural player it ducks; the audio-session spec names our Player as a
  // supported target, so it is part of the cross-package contract.
  it('getVolume reads mpv back and converts 0..100 to 0..1', async () => {
    const player = await createPlayer()
    client.readable.set(MpvProperty.volume, 40)
    expect(player.getVolume()).toBeCloseTo(0.4)
  })

  it('getVolume reads through rather than trusting the snapshot', async () => {
    const player = await createPlayer()
    // No event batch has been delivered, so `state.volume` is still the
    // default — the read must not return it.
    client.readable.set(MpvProperty.volume, 10)
    expect(player.state.volume).not.toBeCloseTo(0.1)
    expect(player.getVolume()).toBeCloseTo(0.1)
  })

  it('getVolume falls back to the snapshot when mpv has no value', async () => {
    const player = await createPlayer()
    client.readable.delete(MpvProperty.volume)
    expect(player.getVolume()).toBe(player.state.volume)
  })

  it('setMuted writes the mute flag', async () => {
    const player = await createPlayer()
    player.setMuted(true)
    expect(client.written.get(MpvProperty.mute)).toBe(true)
  })

  it.each([
    ['off', 'no', 'no'],
    ['track', 'inf', 'no'],
    ['playlist', 'no', 'inf'],
  ] as const)(
    'setLoop(%s) writes loop-file=%s loop-playlist=%s',
    async (mode, file, list) => {
      const player = await createPlayer()
      player.setLoop(mode)
      expect(client.written.get(MpvProperty.loopFile)).toBe(file)
      expect(client.written.get(MpvProperty.loopPlaylist)).toBe(list)
    }
  )
})

describe('Player — loading', () => {
  it('load replaces the current file', async () => {
    const player = await createPlayer()
    await player.load(URI)
    expect(client.commands).toEqual([['loadfile', URI, 'replace']])
  })

  // mpv 0.38 inserted an `index` argument into `loadfile`, moving the per-file
  // option list from the third slot to the fourth:
  //   0.35  loadfile <url> [<flags> [<options>]]
  //   0.41  loadfile <url> [<flags> [<index> [<options>]]]
  // mpv's manual: "the third argument now needs to be set to -1 if the fourth
  // argument needs to be used". Get this wrong and nothing throws at build time
  // and nothing obvious throws at runtime — the option string is parsed as an
  // integer, the command fails, and HLS (which ALWAYS carries `demuxer=lavf`)
  // silently stops loading. So the argv shape is pinned here rather than only
  // implied by the assertions scattered through the HLS-guard tests.
  describe('loadfile argv shape (mpv >= 0.38 index argument)', () => {
    it('omits the index entirely when there are no per-file options', async () => {
      const player = await createPlayer()
      await player.load(URI)
      // A bare 3-argument loadfile means the same thing in every mpv version.
      expect(client.commands[0]).toEqual(['loadfile', URI, 'replace'])
    })

    it('puts -1 in the index slot whenever options follow', async () => {
      const player = await createPlayer()
      await player.load(URI, { startPosition: 12 })
      const [command, , , index, options] = client.commands[0] as string[]
      expect(command).toBe('loadfile')
      expect(index).toBe('-1')
      expect(options).toBe('start=12')
    })

    it('never lets an option string land in the index slot', async () => {
      const player = await createPlayer()
      await player.load('https://cdn.example.com/master.m3u8')
      await player.loadPlaylist(['x.m3u8'])
      await player.playlist.add('y.m3u8')
      const loadfiles = client.commands.filter((c) => c[0] === 'loadfile')
      expect(loadfiles).not.toHaveLength(0)
      for (const argv of loadfiles) {
        // Either 3 arguments (no options) or 5 (index + options); a 4-argument
        // loadfile is exactly the pre-0.38 shape this test exists to forbid.
        expect([3, 5]).toContain(argv.length)
        if (argv.length === 5) expect(argv[3]).toBe('-1')
      }
    })
  })

  it('load with autoPlay: false pauses first', async () => {
    const player = await createPlayer()
    await player.load(URI, { autoPlay: false })
    expect(client.written.get(MpvProperty.pause)).toBe(true)
  })

  it('load passes start position and per-file options', async () => {
    const player = await createPlayer()
    await player.load(URI, {
      startPosition: 30,
      mpvOptions: { 'cache-pause': 'no' },
    })
    expect(client.commands[0]).toEqual([
      'loadfile',
      URI,
      'replace',
      '-1',
      'start=30,cache-pause=no',
    ])
  })

  it('loadPlaylist stops, appends every entry, then jumps', async () => {
    const player = await createPlayer()
    await player.loadPlaylist(['a.mp3', 'b.mp3', 'c.mp3'], { startIndex: 1 })
    expect(client.commands).toEqual([
      ['stop'],
      ['loadfile', 'a.mp3', 'append'],
      ['loadfile', 'b.mp3', 'append'],
      ['loadfile', 'c.mp3', 'append'],
      ['playlist-play-index', '1'],
    ])
  })

  it('loadPlaylist defaults to index 0', async () => {
    const player = await createPlayer()
    await player.loadPlaylist(['a.mp3'])
    expect(client.commands.at(-1)).toEqual(['playlist-play-index', '0'])
  })

  it('loadPlaylist with no sources just stops', async () => {
    const player = await createPlayer()
    await player.loadPlaylist([])
    expect(client.commands).toEqual([['stop']])
  })

  it('maps a rejected load command onto the typed taxonomy', async () => {
    const player = await createPlayer()
    client.commandRejection =
      '[mpv:-17] command failed: unrecognized file format'
    await expect(player.load(URI)).rejects.toMatchObject({
      playerError: { code: 'unsupported-format' },
    })
  })
})

describe('Player — m3u8 playlist-demuxer guard', () => {
  const HLS = 'https://stream.example.com/fip/fip.m3u8'

  it.each([
    HLS,
    'https://stream.example.com/fip/fip.m3u8?token=abc&x=1',
    'https://stream.example.com/fip/fip.m3u8#t=10',
    'https://stream.example.com/legacy/stream.m3u',
    'https://stream.example.com/UPPER/MASTER.M3U8',
    '/sdcard/local.m3u8',
  ])('forces demuxer=lavf for %s', async (source) => {
    const player = await createPlayer()
    await player.load(source)
    expect(client.commands).toEqual([
      ['loadfile', source, 'replace', '-1', 'demuxer=lavf'],
    ])
  })

  it.each([
    'https://ice1.example.com/groovesalad-128-mp3',
    'https://cdn.example.com/track.mp3',
    'https://cdn.example.com/track.mp3?list=m3u8',
    'https://cdn.example.com/m3u8/track.flac',
    'https://cdn.example.com/track.m3u8.mp3',
  ])('leaves %s untouched', async (source) => {
    const player = await createPlayer()
    await player.load(source)
    expect(client.commands).toEqual([['loadfile', source, 'replace']])
  })

  it('merges the guard with start position and other per-file options', async () => {
    const player = await createPlayer()
    await player.load(HLS, {
      startPosition: 30,
      mpvOptions: { 'cache-pause': 'no' },
    })
    expect(client.commands[0]).toEqual([
      'loadfile',
      HLS,
      'replace',
      '-1',
      'start=30,demuxer=lavf,cache-pause=no',
    ])
  })

  it('respects a caller-supplied demuxer', async () => {
    const player = await createPlayer()
    await player.load(HLS, { mpvOptions: { demuxer: 'hls' } })
    expect(client.commands[0]).toEqual([
      'loadfile',
      HLS,
      'replace',
      '-1',
      'demuxer=hls',
    ])
  })

  it('applies to each playlist entry independently', async () => {
    const player = await createPlayer()
    await player.loadPlaylist(['a.mp3', HLS, 'c.m3u', 'd.flac'])
    expect(client.commands).toEqual([
      ['stop'],
      ['loadfile', 'a.mp3', 'append'],
      ['loadfile', HLS, 'append', '-1', 'demuxer=lavf'],
      ['loadfile', 'c.m3u', 'append', '-1', 'demuxer=lavf'],
      ['loadfile', 'd.flac', 'append'],
      ['playlist-play-index', '0'],
    ])
  })

  it('respects a caller-supplied demuxer across a whole playlist', async () => {
    const player = await createPlayer()
    await player.loadPlaylist(['a.mp3', HLS], {
      mpvOptions: { 'demuxer': 'lavf', 'cache-pause': 'no' },
    })
    expect(client.commands.slice(1, 3)).toEqual([
      ['loadfile', 'a.mp3', 'append', '-1', 'demuxer=lavf,cache-pause=no'],
      ['loadfile', HLS, 'append', '-1', 'demuxer=lavf,cache-pause=no'],
    ])
  })

  it('guards playlist.add too — same command, same hazard', async () => {
    const player = await createPlayer()
    await player.playlist.add(HLS)
    await player.playlist.add('b.mp3', { play: true })
    expect(client.commands).toEqual([
      ['loadfile', HLS, 'append', '-1', 'demuxer=lavf'],
      ['loadfile', 'b.mp3', 'append-play'],
    ])
  })
})

describe('Player — playlist API', () => {
  it('add appends, and append-play when asked', async () => {
    const player = await createPlayer()
    await player.playlist.add('a.mp3')
    await player.playlist.add('b.mp3', { play: true })
    expect(client.commands).toEqual([
      ['loadfile', 'a.mp3', 'append'],
      ['loadfile', 'b.mp3', 'append-play'],
    ])
  })

  it('remove uses playlist-remove', async () => {
    const player = await createPlayer()
    await player.playlist.remove(2)
    expect(client.commands).toEqual([['playlist-remove', '2']])
  })

  it('move adjusts for mpv’s off-by-one target on downward moves', async () => {
    const player = await createPlayer()
    await player.playlist.move(0, 3)
    await player.playlist.move(3, 0)
    await player.playlist.move(2, 2)
    expect(client.commands).toEqual([
      ['playlist-move', '0', '4'],
      ['playlist-move', '3', '0'],
      ['playlist-move', '2', '2'],
    ])
  })

  it('jumpTo uses playlist-play-index, not the playlist-pos property', async () => {
    const player = await createPlayer()
    await player.playlist.jumpTo(4)
    expect(client.commands).toEqual([['playlist-play-index', '4']])
    expect(client.written.has(MpvProperty.playlistPos)).toBe(false)
  })

  it('jumpTo clears pause, because mpv leaves it alone on a jump', async () => {
    // Regression: a player loaded with `autoPlay: false` used to jump to an
    // entry, open it, buffer it and never make a sound.
    const player = await createPlayer()
    await player.playlist.jumpTo(1)
    expect(client.written.get(MpvProperty.pause)).toBe(false)
  })

  it('jumpTo honours autoPlay: false by leaving pause untouched', async () => {
    const player = await createPlayer()
    await player.playlist.jumpTo(1, { autoPlay: false })
    expect(client.written.has(MpvProperty.pause)).toBe(false)
  })

  it('next/previous/clear map to mpv commands', async () => {
    const player = await createPlayer()
    await player.playlist.next()
    await player.playlist.previous()
    await player.playlist.clear()
    expect(client.commands).toEqual([
      ['playlist-next', 'weak'],
      ['playlist-prev', 'weak'],
      ['playlist-clear'],
    ])
  })
})

describe('Player — playlist.add positions', () => {
  const HLS = 'https://stream.example.com/fip/fip.m3u8'

  /** mpv's answer to `playlist-count`, i.e. the bound `position` is checked against. */
  function queueOf(count: number): void {
    client.readable.set(MpvProperty.playlistCount, count)
  }

  it('maps every position × play cell to one mpv action', async () => {
    const player = await createPlayer()
    queueOf(4)

    await player.playlist.add('a.mp3')
    await player.playlist.add('b.mp3', { play: true })
    await player.playlist.add('c.mp3', { position: 'next' })
    await player.playlist.add('d.mp3', { position: 'next', play: true })
    await player.playlist.add('e.mp3', { position: 2 })
    await player.playlist.add('f.mp3', { position: 2, play: true })

    expect(client.commands).toEqual([
      ['loadfile', 'a.mp3', 'append'],
      ['loadfile', 'b.mp3', 'append-play'],
      ['loadfile', 'c.mp3', 'insert-next'],
      ['loadfile', 'd.mp3', 'insert-next-play'],
      // The index is `loadfile`'s THIRD argument (mpv 0.38+), not a separate
      // command and not a `playlist-move`.
      ['loadfile', 'e.mp3', 'insert-at', '2'],
      ['loadfile', 'f.mp3', 'insert-at-play', '2'],
    ])
  })

  it('is one command per add — never the old append + playlist-move pair', async () => {
    const player = await createPlayer()
    queueOf(3)
    await player.playlist.add('a.mp3', { position: 0 })
    expect(client.commands).toHaveLength(1)
    expect(client.commands[0]?.[0]).toBe('loadfile')
  })

  it('carries per-file options after a real index, with no -1 placeholder', async () => {
    const player = await createPlayer()
    queueOf(3)
    await player.playlist.add(HLS, { position: 1 })
    // `insert-at` uses the index slot for real, so the placeholder that exists
    // only to skip it must NOT appear.
    expect(client.commands).toEqual([
      ['loadfile', HLS, 'insert-at', '1', 'demuxer=lavf'],
    ])
  })

  it('still writes the -1 placeholder for insert-next with options', async () => {
    const player = await createPlayer()
    await player.playlist.add(HLS, { position: 'next' })
    expect(client.commands).toEqual([
      ['loadfile', HLS, 'insert-next', '-1', 'demuxer=lavf'],
    ])
  })

  it('accepts 0 and the end of the queue as insertion points', async () => {
    const player = await createPlayer()
    queueOf(3)
    await player.playlist.add('head.mp3', { position: 0 })
    await player.playlist.add('tail.mp3', { position: 3 })
    expect(client.commands).toEqual([
      ['loadfile', 'head.mp3', 'insert-at', '0'],
      ['loadfile', 'tail.mp3', 'insert-at', '3'],
    ])
  })

  it('rejects an index past the end instead of letting mpv append', async () => {
    const player = await createPlayer()
    queueOf(3)
    await expect(player.playlist.add('x.mp3', { position: 4 })).rejects.toThrow(
      /past the end of a 3-entry playlist/u
    )
    // Nothing reached mpv: a rejected argument costs no playlist mutation.
    expect(client.commands).toEqual([])
  })

  it('rejects non-integer, negative and non-finite indices', async () => {
    const player = await createPlayer()
    queueOf(5)
    for (const position of [1.5, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(player.playlist.add('x.mp3', { position })).rejects.toThrow(
        /non-negative integer playlist index/u
      )
    }
    expect(client.commands).toEqual([])
  })

  it('rejects a position that is neither a number nor `next`', async () => {
    const player = await createPlayer()
    await expect(
      // A JavaScript caller (or a value out of JSON) can still get here.
      player.playlist.add('x.mp3', {
        position: 'later' as unknown as 'next',
      })
    ).rejects.toThrow(/must be 'next' or a playlist index/u)
    expect(client.commands).toEqual([])
  })

  it('bounds the index against mpv, not against the last broadcast snapshot', async () => {
    const player = await createPlayer()
    // The snapshot still says "empty" — no batch has arrived — while mpv
    // already has five entries. An `add` issued from a command handler runs
    // exactly there, and must not be rejected for it.
    expect(player.state.playlist.count).toBe(0)
    queueOf(5)
    await player.playlist.add('x.mp3', { position: 5 })
    expect(client.commands).toEqual([['loadfile', 'x.mp3', 'insert-at', '5']])
  })

  it('falls back to the snapshot when mpv cannot answer playlist-count', async () => {
    const player = await createPlayer()
    client.readErrors.set(MpvProperty.playlistCount, '[mpv:-10] boom')
    // Snapshot count is 0, so only the head of an empty queue is left — which
    // is what an append would do anyway.
    await player.playlist.add('x.mp3', { position: 0 })
    await expect(player.playlist.add('y.mp3', { position: 1 })).rejects.toThrow(
      /past the end of a 0-entry playlist/u
    )
  })

  it('throws a typed invalid-state error, not a bare TypeError', async () => {
    const player = await createPlayer()
    const error = await player.playlist
      .add('x.mp3', { position: -1 })
      .catch((thrown: unknown) => thrown)
    expect(error).toBeInstanceOf(PlayerErrorException)
    expect((error as PlayerErrorException).playerError.code).toBe(
      'invalid-state'
    )
  })
})

describe('Player — prefetchStarted', () => {
  it('registers the native listener at create, before anything can load', async () => {
    await createPlayer()
    expect(client.hasPrefetchListener).toBe(true)
  })

  it('delivers uri and entryId to subscribers', async () => {
    const player = await createPlayer()
    const seen: unknown[] = []
    player.on('prefetchStarted', (event) => seen.push(event))
    client.emitPrefetchStarted({ uri: 'https://cdn/next.mp3', entryId: 7 })
    expect(seen).toEqual([{ uri: 'https://cdn/next.mp3', entryId: 7 }])
  })

  it('delivers without an entryId on a binary that has no entry-id property', async () => {
    const player = await createPlayer()
    const seen: unknown[] = []
    player.on('prefetchStarted', (event) => seen.push(event))
    client.emitPrefetchStarted({ uri: 'https://cdn/next.mp3' })
    expect(seen).toEqual([{ uri: 'https://cdn/next.mp3' }])
  })

  it('fans out to every listener and stops on unsubscribe', async () => {
    const player = await createPlayer()
    const first: string[] = []
    const second: string[] = []
    const stop = player.on('prefetchStarted', (e) => first.push(e.uri))
    player.on('prefetchStarted', (e) => second.push(e.uri))

    client.emitPrefetchStarted({ uri: 'a' })
    stop()
    client.emitPrefetchStarted({ uri: 'b' })

    expect(first).toEqual(['a'])
    expect(second).toEqual(['a', 'b'])
  })

  it('is harmless with nobody listening — the common case', async () => {
    await createPlayer()
    expect(() => {
      client.emitPrefetchStarted({ uri: 'a', entryId: 1 })
    }).not.toThrow()
  })

  it('delivers nothing after destroy', async () => {
    const player = await createPlayer()
    const seen: string[] = []
    player.on('prefetchStarted', (e) => seen.push(e.uri))
    player.destroy()
    client.emitPrefetchStarted({ uri: 'a' })
    expect(seen).toEqual([])
  })

  it('needs no resolver — a plain player still hears the boundary', async () => {
    const player = await createPlayer({ prefetchPlaylist: true })
    const seen: string[] = []
    player.on('prefetchStarted', (e) => seen.push(e.uri))
    // No `setSourceResolver` anywhere: the hooks are registered by the core,
    // not by the resolver, so this arrives regardless.
    expect(client.resolverInstalled).toBe(false)
    client.emitPrefetchStarted({ uri: 'https://cdn/next.mp3', entryId: 3 })
    expect(seen).toEqual(['https://cdn/next.mp3'])
  })
})

describe('Player — shuffle', () => {
  it('shuffle/unshuffle map to the mpv commands', async () => {
    const player = await createPlayer()
    await player.playlist.shuffle()
    await player.playlist.unshuffle()
    expect(client.commands).toEqual([
      ['playlist-shuffle'],
      ['playlist-unshuffle'],
    ])
  })

  it('loadPlaylist shuffles after appending and before the jump', async () => {
    // Order is the whole point: mpv shuffles every entry, so it must happen
    // while nothing is playing yet, and the jump must come after it.
    const player = await createPlayer()
    await player.loadPlaylist(['a.mp3', 'b.mp3', 'c.mp3'], { shuffle: true })
    expect(client.commands).toEqual([
      ['stop'],
      ['loadfile', 'a.mp3', 'append'],
      ['loadfile', 'b.mp3', 'append'],
      ['loadfile', 'c.mp3', 'append'],
      ['playlist-shuffle'],
      ['playlist-play-index', '0'],
    ])
  })

  it('does not shuffle when the option is absent or false', async () => {
    const player = await createPlayer()
    await player.loadPlaylist(['a.mp3'])
    await player.loadPlaylist(['a.mp3'], { shuffle: false })
    expect(client.commands.some(([name]) => name === 'playlist-shuffle')).toBe(
      false
    )
  })

  it('rejects shuffle combined with startIndex', async () => {
    const player = await createPlayer()
    await expect(
      player.loadPlaylist(['a.mp3', 'b.mp3'], { shuffle: true, startIndex: 1 })
    ).rejects.toMatchObject({ playerError: { code: 'invalid-state' } })
    expect(client.commands).toEqual([])
  })

  it('rejects shuffle with an explicit startIndex of 0 too', async () => {
    // `startIndex: 0` looks harmless but still asks for a guarantee the shuffle
    // destroys, so it is rejected rather than quietly reinterpreted.
    const player = await createPlayer()
    await expect(
      player.loadPlaylist(['a.mp3'], { shuffle: true, startIndex: 0 })
    ).rejects.toBeInstanceOf(PlayerErrorException)
  })

  it('does not shuffle an empty playlist', async () => {
    const player = await createPlayer()
    await player.loadPlaylist([], { shuffle: true })
    expect(client.commands).toEqual([['stop']])
  })
})

describe('Player — ReplayGain', () => {
  it('maps every field onto the mpv options at init', async () => {
    await createPlayer({
      replayGain: { mode: 'album', preamp: -3.5, clip: false, fallback: -6 },
    })
    expect(client.initOptions).toMatchObject({
      'replaygain': 'album',
      'replaygain-preamp': '-3.5',
      // `clip` is mpv's "allow clipping" flag, not "prevent clipping": `no`
      // keeps mpv's automatic peak limiting on (player/audio.c).
      'replaygain-clip': 'no',
      'replaygain-fallback': '-6',
    })
  })

  it('emits only the fields that were given', async () => {
    await createPlayer({ replayGain: { mode: 'track' } })
    expect(client.initOptions?.replaygain).toBe('track')
    expect(client.initOptions).not.toHaveProperty('replaygain-preamp')
    expect(client.initOptions).not.toHaveProperty('replaygain-clip')
    expect(client.initOptions).not.toHaveProperty('replaygain-fallback')
  })

  it('writes replaygain-clip=yes only when clipping is explicitly allowed', async () => {
    await createPlayer({ replayGain: { mode: 'track', clip: true } })
    expect(client.initOptions?.['replaygain-clip']).toBe('yes')
  })

  it('lets raw mpvOptions win over the typed option', async () => {
    await createPlayer({
      replayGain: { mode: 'album', preamp: 3 },
      mpvOptions: { 'replaygain': 'no', 'replaygain-preamp': '0' },
    })
    expect(client.initOptions).toMatchObject({
      'replaygain': 'no',
      'replaygain-preamp': '0',
    })
  })

  it('sets the properties at runtime, only for the fields given', async () => {
    const player = await createPlayer()
    player.setReplayGain({ mode: 'album', preamp: 2 })
    expect(client.written.get('replaygain')).toBe('album')
    expect(client.written.get('replaygain-preamp')).toBe(2)
    expect(client.written.has('replaygain-clip')).toBe(false)
    expect(client.written.has('replaygain-fallback')).toBe(false)

    player.setReplayGain({ mode: 'no', clip: true, fallback: -9 })
    expect(client.written.get('replaygain')).toBe('no')
    expect(client.written.get('replaygain-clip')).toBe(true)
    expect(client.written.get('replaygain-fallback')).toBe(-9)
  })

  it.each([
    ['bad mode', { mode: 'loud' as never }],
    ['preamp above mpv’s range', { mode: 'track' as const, preamp: 151 }],
    ['preamp below mpv’s range', { mode: 'track' as const, preamp: -151 }],
    ['non-finite preamp', { mode: 'track' as const, preamp: Number.NaN }],
    ['fallback above mpv’s range', { mode: 'track' as const, fallback: 61 }],
    ['fallback below mpv’s range', { mode: 'track' as const, fallback: -201 }],
  ])(
    'rejects %s at create time, before a core exists',
    async (_label, gain) => {
      await expect(createPlayer({ replayGain: gain })).rejects.toMatchObject({
        playerError: { code: 'invalid-state' },
      })
      expect(client.initialized).toBe(false)
      expect(client.destroyCount).toBe(0)
    }
  )

  it.each([
    ['bad mode', { mode: 'loud' as never }],
    ['preamp out of range', { mode: 'track' as const, preamp: 200 }],
    ['fallback out of range', { mode: 'track' as const, fallback: -500 }],
  ])('rejects %s at runtime without writing anything', async (_label, gain) => {
    const player = await createPlayer()
    expect(() => player.setReplayGain(gain)).toThrowError(PlayerErrorException)
    expect(client.written.has('replaygain')).toBe(false)
  })

  it.each([-150, 150, 0])(
    'accepts preamp %s (mpv’s boundary)',
    async (preamp) => {
      const player = await createPlayer()
      player.setReplayGain({ mode: 'track', preamp })
      expect(client.written.get('replaygain-preamp')).toBe(preamp)
    }
  )

  it.each([-200, 60])(
    'accepts fallback %s (mpv’s boundary)',
    async (fallback) => {
      const player = await createPlayer()
      player.setReplayGain({ mode: 'track', fallback })
      expect(client.written.get('replaygain-fallback')).toBe(fallback)
    }
  )
})

describe('Player — prefetch and cache options', () => {
  it('maps prefetchPlaylist onto mpv’s yes/no flag', async () => {
    await createPlayer({ prefetchPlaylist: true })
    expect(client.initOptions?.['prefetch-playlist']).toBe('yes')
    client = new FakeMpvClient()
    await createPlayer({ prefetchPlaylist: false })
    expect(client.initOptions?.['prefetch-playlist']).toBe('no')
  })

  it('omits prefetch-playlist entirely when the option is unset', async () => {
    await createPlayer()
    expect(client.initOptions).not.toHaveProperty('prefetch-playlist')
  })

  it('lets raw mpvOptions win over prefetchPlaylist', async () => {
    await createPlayer({
      prefetchPlaylist: true,
      mpvOptions: { 'prefetch-playlist': 'no' },
    })
    expect(client.initOptions?.['prefetch-playlist']).toBe('no')
  })

  it.each<['no' | 'yes' | 'weak']>([['no'], ['yes'], ['weak']])(
    'passes gaplessAudio %s through as mpv’s choice value',
    async (mode) => {
      await createPlayer({ gaplessAudio: mode })
      expect(client.initOptions?.['gapless-audio']).toBe(mode)
    }
  )

  it('omits gapless-audio entirely when the option is unset, leaving mpv’s `weak` default', async () => {
    await createPlayer()
    expect(client.initOptions).not.toHaveProperty('gapless-audio')
  })

  it('lets raw mpvOptions win over gaplessAudio', async () => {
    await createPlayer({
      gaplessAudio: 'yes',
      mpvOptions: { 'gapless-audio': 'no' },
    })
    expect(client.initOptions?.['gapless-audio']).toBe('no')
  })

  it('rejects an unknown gaplessAudio mode before a core exists', async () => {
    await expect(
      createPlayer({ gaplessAudio: 'always' as never })
    ).rejects.toMatchObject({ playerError: { code: 'invalid-state' } })
    expect(client.initialized).toBe(false)
    expect(client.destroyCount).toBe(0)
  })

  it('overrides the 30 s cache default with cacheSecs', async () => {
    await createPlayer({ cacheSecs: 120 })
    expect(client.initOptions?.['cache-secs']).toBe('120')
  })

  it('lets raw mpvOptions win over cacheSecs', async () => {
    await createPlayer({ cacheSecs: 120, mpvOptions: { 'cache-secs': '5' } })
    expect(client.initOptions?.['cache-secs']).toBe('5')
  })

  it('accepts 0, which is mpv’s lower bound', async () => {
    await createPlayer({ cacheSecs: 0 })
    expect(client.initOptions?.['cache-secs']).toBe('0')
  })

  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects cacheSecs %s before a core exists',
    async (cacheSecs) => {
      await expect(createPlayer({ cacheSecs })).rejects.toMatchObject({
        playerError: { code: 'invalid-state' },
      })
      expect(client.initialized).toBe(false)
    }
  )
})

describe('Player — metadata', () => {
  /** Seed the fake with the tag map mpv answers a `metadata` node read with. */
  function seedMetadata(entries: ReadonlyArray<readonly [string, string]>) {
    client.readableMaps.set(MpvProperty.metadata, Object.fromEntries(entries))
  }

  it('observes `metadata` as a string change-edge', async () => {
    await createPlayer()
    // The value is never parsed — mpv's manual says a raw string read of the
    // map "doesn't work" — but the observation is what tells us it changed.
    expect(client.observations.get(MpvProperty.metadata)).toBe('string')
  })

  it('builds the whole map from ONE node read', async () => {
    const player = await createPlayer()
    seedMetadata([
      ['title', 'Windowlicker'],
      ['artist', 'Aphex Twin'],
      ['icy-title', 'Aphex Twin - Windowlicker'],
    ])
    const strings = vi.spyOn(client, 'getPropertyString')
    const numbers = vi.spyOn(client, 'getPropertyNumber')

    expect(player.getMetadata()).toEqual({
      'title': 'Windowlicker',
      'artist': 'Aphex Twin',
      'icy-title': 'Aphex Twin - Windowlicker',
    })
    // The point of the whole change: three tags, one blocking round-trip into
    // mpv's core — not `2N + 1` of them, and none as a string.
    expect(client.mapReads).toEqual([MpvProperty.metadata])
    expect(strings).not.toHaveBeenCalled()
    expect(numbers).not.toHaveBeenCalled()
  })

  it('returns an empty map when nothing is loaded', async () => {
    const player = await createPlayer()
    // mpv reports the whole property unavailable without a demuxer, which the
    // native binding turns into `undefined`.
    expect(player.getMetadata()).toEqual({})
  })

  it('returns an empty map for an entry with no tags', async () => {
    const player = await createPlayer()
    seedMetadata([])
    expect(player.getMetadata()).toEqual({})
  })

  it('reads a single tag through metadata/by-key', async () => {
    const player = await createPlayer()
    client.readable.set('metadata/by-key/icy-title', 'Now: Boards of Canada')
    expect(player.getMetadataValue('icy-title')).toBe('Now: Boards of Canada')
  })

  it('returns undefined for a tag mpv does not have', async () => {
    const player = await createPlayer()
    client.readErrors.set(
      'metadata/by-key/nope',
      '[mpv:-8] mpv_get_property("metadata/by-key/nope", STRING): property not found'
    )
    expect(player.getMetadataValue('nope')).toBeUndefined()
  })

  it('still throws for any other mpv failure', async () => {
    const player = await createPlayer()
    client.readErrors.set(
      'metadata/by-key/title',
      '[mpv:-9] mpv_get_property("metadata/by-key/title", STRING): property format error'
    )
    expect(() => player.getMetadataValue('title')).toThrowError(
      PlayerErrorException
    )
  })

  it('emits metadataChanged once per batch, for either trigger', async () => {
    const player = await createPlayer()
    seedMetadata([['title', 'A']])
    const changed = vi.fn()
    player.on('metadataChanged', changed)

    client.emit([
      propertyEvent(MpvProperty.metadata, '{"title":"A"}'),
      propertyEvent(MpvProperty.mediaTitle, 'A'),
    ])

    expect(changed).toHaveBeenCalledTimes(1)
    expect(changed).toHaveBeenCalledWith({ title: 'A' })
  })

  it('emits on a media-title-only change (ICY now-playing)', async () => {
    const player = await createPlayer()
    seedMetadata([['icy-title', 'Track 2']])
    const changed = vi.fn()
    player.on('metadataChanged', changed)
    client.emit([propertyEvent(MpvProperty.mediaTitle, 'Track 2')])
    expect(changed).toHaveBeenCalledWith({ 'icy-title': 'Track 2' })
  })

  it('does not emit for unrelated property changes', async () => {
    const player = await createPlayer()
    const changed = vi.fn()
    player.on('metadataChanged', changed)
    client.emit([propertyEvent(MpvProperty.volume, 50)])
    expect(changed).not.toHaveBeenCalled()
  })

  it('reads nothing while nobody is listening', async () => {
    await createPlayer()
    const strings = vi.spyOn(client, 'getPropertyString')
    client.emit([propertyEvent(MpvProperty.metadata, '{"title":"A"}')])
    expect(client.mapReads).toEqual([])
    expect(strings).not.toHaveBeenCalled()
  })

  it('skips the emission rather than throwing when the read fails', async () => {
    const player = await createPlayer()
    const changed = vi.fn()
    player.on('metadataChanged', changed)
    client.readErrors.set(
      MpvProperty.metadata,
      '[mpv:-9] mpv_get_property("metadata", NODE): property format error'
    )
    expect(() =>
      client.emit([propertyEvent(MpvProperty.mediaTitle, 'x')])
    ).not.toThrow()
    expect(changed).not.toHaveBeenCalled()
  })

  it('unsubscribes metadata listeners', async () => {
    const player = await createPlayer()
    seedMetadata([['title', 'A']])
    const changed = vi.fn()
    player.on('metadataChanged', changed)()
    client.emit([propertyEvent(MpvProperty.mediaTitle, 'A')])
    expect(changed).not.toHaveBeenCalled()
  })
})

describe('Player — raw escape hatches', () => {
  it('forwards arbitrary commands', async () => {
    const player = await createPlayer()
    await player.command(['script-message', 'hello'])
    expect(client.commands).toEqual([['script-message', 'hello']])
  })

  it('reads and writes arbitrary properties', async () => {
    const player = await createPlayer()
    client.readable.set('mpv-version', 'mpv 0.35.1')
    expect(player.getPropertyString('mpv-version')).toBe('mpv 0.35.1')
    expect(player.getPropertyNumber('mpv-version')).toBeUndefined()
    player.setPropertyBool('shuffle', true)
    player.setPropertyNumber('cache-secs', 30)
    player.setPropertyString('af', 'lavfi=[loudnorm]')
    expect(client.written.get('shuffle')).toBe(true)
    expect(client.written.get('cache-secs')).toBe(30)
    expect(client.written.get('af')).toBe('lavfi=[loudnorm]')
  })

  it('adds and removes extra observations', async () => {
    const player = await createPlayer()
    player.observeProperty('chapter-metadata', 'string')
    expect(client.observations.get('chapter-metadata')).toBe('string')
    player.unobserveProperty('chapter-metadata')
    expect(client.observations.has('chapter-metadata')).toBe(false)
  })

  it('ignores unknown observed properties in the reducer', async () => {
    const player = await createPlayer()
    const before = player.state
    player.observeProperty('chapter-metadata', 'string')
    client.emit([propertyEvent('chapter-metadata', 'x')])
    expect(player.state).toBe(before)
  })

  it('exposes the raw handle', async () => {
    const player = await createPlayer()
    expect(player.getRawHandle()).toBe(0xdeadbeefn)
  })

  it('maps a throwing property write onto the taxonomy', async () => {
    const player = await createPlayer()
    client.setPropertyRejection =
      '[mpv:-8] mpv_set_property("nope"): property not found'
    expect(() => player.setPropertyNumber('nope', 1)).toThrowError(
      PlayerErrorException
    )
    try {
      player.setPropertyNumber('nope', 1)
    } catch (thrown) {
      expect((thrown as PlayerErrorException).playerError).toMatchObject({
        code: 'mpv',
        errno: -8,
      })
    }
  })
})

describe('Player — destroy', () => {
  it('is idempotent and destroys the client once', async () => {
    const player = await createPlayer()
    player.destroy()
    player.destroy()
    player.destroy()
    expect(client.destroyCount).toBe(1)
    expect(player.destroyed).toBe(true)
  })

  it('makes the batch listener return false (back-pressure detach)', async () => {
    const player = await createPlayer()
    expect(client.emit([startFileEvent()])).toBe(true)
    player.destroy()
    expect(client.emit([startFileEvent()])).toBe(false)
    expect(client.listenerReturns).toEqual([true, false])
  })

  it('keeps returning true while alive, even for an empty batch', async () => {
    await createPlayer()
    expect(client.emit([])).toBe(true)
  })

  it('drops all listeners', async () => {
    const player = await createPlayer()
    const stateListener = vi.fn()
    const errorListener = vi.fn()
    player.onStateChange(stateListener)
    player.on('error', errorListener)
    player.destroy()
    client.emit([endFileEvent('error', 'loading failed')])
    expect(stateListener).not.toHaveBeenCalled()
    expect(errorListener).not.toHaveBeenCalled()
  })

  it('throws a disposed error from every method afterwards', async () => {
    const player = await createPlayer()
    player.destroy()

    const sync: Array<[string, () => unknown]> = [
      ['play', () => player.play()],
      ['pause', () => player.pause()],
      ['toggle', () => player.toggle()],
      ['setRate', () => player.setRate(1)],
      ['setVolume', () => player.setVolume(1)],
      ['getVolume', () => player.getVolume()],
      ['setMuted', () => player.setMuted(true)],
      ['setLoop', () => player.setLoop('off')],
      ['setReplayGain', () => player.setReplayGain({ mode: 'track' })],
      ['getMetadata', () => player.getMetadata()],
      ['getMetadataValue', () => player.getMetadataValue('title')],
      ['getPropertyString', () => player.getPropertyString('x')],
      ['getPropertyNumber', () => player.getPropertyNumber('x')],
      ['getPropertyBool', () => player.getPropertyBool('x')],
      ['setPropertyString', () => player.setPropertyString('x', 'y')],
      ['setPropertyNumber', () => player.setPropertyNumber('x', 1)],
      ['setPropertyBool', () => player.setPropertyBool('x', true)],
      ['observeProperty', () => player.observeProperty('x', 'bool')],
      ['unobserveProperty', () => player.unobserveProperty('x')],
      ['getRawHandle', () => player.getRawHandle()],
      ['resyncPosition', () => player.resyncPosition()],
    ]
    for (const [name, call] of sync) {
      expect(call, name).toThrowError(PlayerErrorException)
    }

    const async_: Array<Promise<unknown>> = [
      player.load(URI),
      player.loadPlaylist([URI]),
      player.seekTo(1),
      player.command(['stop']),
      player.playlist.add('a'),
      player.playlist.remove(0),
      player.playlist.move(0, 1),
      player.playlist.jumpTo(0),
      player.playlist.next(),
      player.playlist.previous(),
      player.playlist.clear(),
      player.playlist.shuffle(),
      player.playlist.unshuffle(),
    ]
    for (const promise of async_) {
      await expect(promise).rejects.toMatchObject({
        playerError: { code: 'disposed' },
      })
    }
  })

  it('survives destroy while a load is in flight', async () => {
    const player = await createPlayer()
    const pending = player.load(URI)
    player.destroy()
    await expect(pending).resolves.toBeUndefined()
    expect(player.destroyed).toBe(true)
    // A batch arriving after teardown must not resurrect anything.
    expect(client.emit([playbackRestartEvent(), seekEvent()])).toBe(false)
  })

  it('still reports the last known position after destroy', async () => {
    const player = await createPlayer()
    client.readable.set(MpvProperty.timePos, 12)
    client.emit([
      propertyEvent(MpvProperty.idleActive, false),
      startFileEvent(),
      playbackRestartEvent(),
    ])
    player.destroy()
    expect(player.getPosition()).toBe(12)
  })

  it('swallows a throwing client destroy to stay idempotent', async () => {
    const player = await createPlayer()
    vi.spyOn(client, 'destroy').mockImplementation(() => {
      throw new Error('[mpv:-20] boom')
    })
    expect(() => player.destroy()).not.toThrow()
    expect(player.destroyed).toBe(true)
  })
})

describe('Player — visualizer wiring', () => {
  it('registers the capture listener at create time', async () => {
    await createPlayer()
    // Free to register: no sampler thread, no mpv tap and no FFT table exist
    // until something subscribes, so an app that never draws a spectrum never
    // pays for one.
    expect(client.hasVisualizerListener).toBe(true)
    expect(client.visualizerCalls).toHaveLength(0)
  })

  it('reports the visualizer as available when mpv has the PCM tap', async () => {
    const player = await createPlayer()
    expect(player.visualizer.capabilities.fft).toBe(true)
    expect(player.visualizer.capabilities.waveform).toBe(true)
  })

  it('reports it unavailable when the linked libmpv has no `pcm-tap`', async () => {
    // Exactly what an unpatched binary answers. This is the whole capability
    // probe: one property read, the same on both platforms, no `Platform.OS`.
    client.readErrors.set(
      MpvProperty.pcmTap,
      '[mpv:-8] mpv_get_property("pcm-tap", DOUBLE): property not found'
    )
    const player = await createPlayer()
    expect(player.visualizer.capabilities.fft).toBe(false)
    expect(() => player.visualizer.subscribe(() => {})).toThrow(
      /rn-media forks/
    )
  })

  it('never asks mpv for an Android audio session', async () => {
    await createPlayer()
    // The old route needed one to attach `android.media.audiofx.Visualizer`.
    // Tapping mpv needs nothing, so no such option may reach mpv — on iOS it
    // would be rejected outright.
    expect(client.initOptions?.['audiotrack-session-id']).toBeUndefined()
  })

  it('routes native captures to the controller', async () => {
    const player = await createPlayer()
    const listener = vi.fn()
    player.visualizer.subscribe(listener, { bands: 8 })
    client.emitCapture(toneCapture(4, 0.5, { bins: 33 }))
    expect(listener).toHaveBeenCalledTimes(1)
    expect(listener.mock.calls[0]![0].bands).toHaveLength(8)
  })

  it('keeps the native listener attached by answering true', async () => {
    const player = await createPlayer()
    player.visualizer.subscribe(() => {})
    // The return value is the back-pressure signal; `false` would detach the
    // listener permanently and the visualizer would die after one frame.
    expect(client.emitCapture(toneCapture(4, 0.5, { bins: 33 }))).toBe(true)
  })

  it('disarms the tap on destroy', async () => {
    const player = await createPlayer()
    player.visualizer.subscribe(() => {})
    expect(client.visualizerRunning).toBe(true)
    player.destroy()
    expect(client.visualizerRunning).toBe(false)
    expect(
      client.visualizerCalls.filter((c) => c.kind === 'stop')
    ).toHaveLength(1)
  })

  it('costs nothing until something subscribes', async () => {
    const player = await createPlayer()
    await player.load(URI)
    player.play()
    expect(client.visualizerCalls).toHaveLength(0)
  })
})

describe('Player — queue contents (playlist.entries)', () => {
  /** mpv's `playlist` node, as the fake will hand it back. */
  function queue(...uris: readonly string[]): {
    readonly uri: string
    readonly entryId: number
    readonly current: boolean
  }[] {
    return uris.map((uri, index) => ({
      uri,
      entryId: 100 + index,
      current: index === 0,
    }))
  }

  it('reads the whole queue in ONE native call, whatever its length', () => {
    // The budget is the point: an `N + 1` walk of `playlist/N/filename` is what
    // this replaced, and it was issued at track boundaries where mpv's core is
    // least able to answer.
    client.playlist = queue('a.mp3', 'b.mp3', 'c.mp3', 'd.mp3', 'e.mp3')
    return createPlayer().then((player) => {
      const entries = player.playlist.entries()
      expect(entries).toHaveLength(5)
      expect(client.playlistReads).toBe(1)
      expect(entries[2]).toEqual({ uri: 'c.mp3', entryId: 102, current: false })
    })
  })

  it('reports which entry is current', async () => {
    client.playlist = [
      { uri: 'a.mp3', entryId: 7, current: false },
      { uri: 'b.mp3', entryId: 8, current: true },
    ]
    const player = await createPlayer()
    expect(player.playlist.entries().map((e) => e.current)).toEqual([
      false,
      true,
    ])
  })

  it('returns [] for an idle core rather than throwing', async () => {
    const player = await createPlayer()
    expect(player.playlist.entries()).toEqual([])
  })

  it('never observes the playlist node', async () => {
    // It is a pull, not a feed: putting a variable-size array on the bridge on
    // every queue edit is exactly what this design avoids.
    await createPlayer()
    expect(client.observations.has(MpvProperty.playlist)).toBe(false)
  })

  it('hands out a frozen snapshot — mpv is the record, this is a photograph', async () => {
    client.playlist = queue('a.mp3', 'b.mp3')
    const player = await createPlayer()
    const entries = player.playlist.entries()
    expect(Object.isFrozen(entries)).toBe(true)
  })

  it('throws a typed disposed error after destroy', async () => {
    const player = await createPlayer()
    player.destroy()
    expect(() => player.playlist.entries()).toThrow(PlayerErrorException)
  })

  it('surfaces an mpv read failure as a typed error', async () => {
    client.readErrors.set(MpvProperty.playlist, '[mpv:-11] property error')
    const player = await createPlayer()
    expect(() => player.playlist.entries()).toThrowError(
      expect.objectContaining({
        playerError: expect.objectContaining({ code: 'mpv' }),
      })
    )
  })

  it('shuffle returns the permutation mpv actually produced', async () => {
    // mpv's `playlist-shuffle` reports nothing about what it did; before this
    // returned anything, an app could only re-read the playlist or guess.
    client.playlist = queue('a.mp3', 'b.mp3', 'c.mp3')
    const player = await createPlayer()
    client.commandRejection = undefined
    const shuffled = await player.playlist.shuffle()
    expect(shuffled.map((e) => e.uri)).toEqual(['a.mp3', 'b.mp3', 'c.mp3'])
    // Read AFTER the command, not before — otherwise it is a prediction.
    expect(client.commands).toEqual([['playlist-shuffle']])
    expect(client.playlistReads).toBe(1)
  })

  it('unshuffle returns the restored order', async () => {
    client.playlist = queue('a.mp3', 'b.mp3')
    const player = await createPlayer()
    const restored = await player.playlist.unshuffle()
    expect(restored.map((e) => e.entryId)).toEqual([100, 101])
  })

  it('does not read the playlist when the shuffle command failed', async () => {
    const player = await createPlayer()
    client.commandRejection = '[mpv:-12] command failed'
    await expect(player.playlist.shuffle()).rejects.toBeInstanceOf(
      PlayerErrorException
    )
    expect(client.playlistReads).toBe(0)
  })
})

describe('Player — queueChanged', () => {
  it('fires with reason "resized" when playlist-count moves', async () => {
    const player = await createPlayer()
    const seen: unknown[] = []
    player.on('queueChanged', (event) => seen.push(event))

    client.emit([propertyEvent(MpvProperty.playlistCount, 3)])
    expect(seen).toEqual([{ count: 3, reason: 'resized' }])
  })

  it('does not fire when the count is republished unchanged', async () => {
    const player = await createPlayer()
    client.emit([propertyEvent(MpvProperty.playlistCount, 3)])
    const seen: unknown[] = []
    player.on('queueChanged', (event) => seen.push(event))
    client.emit([propertyEvent(MpvProperty.playlistCount, 3)])
    expect(seen).toEqual([])
  })

  it('fires with reason "reordered" for move/shuffle/unshuffle', async () => {
    // A reorder changes no observed property at all — `playlist-count` is
    // identical — so these are the only honest source of the event.
    const player = await createPlayer()
    client.emit([propertyEvent(MpvProperty.playlistCount, 4)])
    const seen: unknown[] = []
    player.on('queueChanged', (event) => seen.push(event))

    await player.playlist.move(0, 2)
    await player.playlist.shuffle()
    await player.playlist.unshuffle()
    expect(seen).toEqual([
      { count: 4, reason: 'reordered' },
      { count: 4, reason: 'reordered' },
      { count: 4, reason: 'reordered' },
    ])
  })

  it('does not fire "reordered" when mpv rejected the command', async () => {
    const player = await createPlayer()
    const seen: unknown[] = []
    player.on('queueChanged', (event) => seen.push(event))
    client.commandRejection = '[mpv:-12] nope'
    await expect(player.playlist.move(0, 1)).rejects.toBeInstanceOf(
      PlayerErrorException
    )
    expect(seen).toEqual([])
  })
})

describe('Player — setPrefetchPlaylist', () => {
  it('writes mpv’s prefetch-playlist property', async () => {
    const player = await createPlayer()
    player.setPrefetchPlaylist(true)
    expect(client.written.get(MpvProperty.prefetchPlaylist)).toBe(true)
    player.setPrefetchPlaylist(false)
    expect(client.written.get(MpvProperty.prefetchPlaylist)).toBe(false)
  })

  it('rejects a non-boolean with a typed invalid-state error', async () => {
    const player = await createPlayer()
    expect(() =>
      (
        player as unknown as { setPrefetchPlaylist: (v: unknown) => void }
      ).setPrefetchPlaylist('yes')
    ).toThrowError(
      expect.objectContaining({
        playerError: expect.objectContaining({ code: 'invalid-state' }),
      })
    )
    expect(client.written.has(MpvProperty.prefetchPlaylist)).toBe(false)
  })

  it('throws disposed after destroy', async () => {
    const player = await createPlayer()
    player.destroy()
    expect(() => player.setPrefetchPlaylist(true)).toThrow(PlayerErrorException)
  })
})

describe('Player — networkReconnect (FFmpeg reconnection)', () => {
  const DEFAULTS =
    'reconnect=1,reconnect_on_network_error=1,reconnect_streamed=1,reconnect_delay_max=5'

  it('is on by default and never sets reconnect_at_eof', async () => {
    // `reconnect_at_eof` is unguarded on `is_streamed` in FFmpeg's
    // `http.c:1871`, so enabling it globally turns every clean end-of-file into
    // a retry storm ending in EIO — i.e. "the song finished" becomes "the song
    // failed". It is opt-in through the raw escape hatch only.
    await createPlayer()
    const value = client.initOptions?.[MpvProperty.streamLavfO]
    expect(value).toBe(DEFAULTS)
    expect(value).not.toContain('reconnect_at_eof')
  })

  it('honours a custom maxDelaySeconds', async () => {
    await createPlayer({ networkReconnect: { maxDelaySeconds: 20 } })
    expect(client.initOptions?.[MpvProperty.streamLavfO]).toContain(
      'reconnect_delay_max=20'
    )
  })

  it('writes nothing at all when disabled, leaving FFmpeg’s own defaults', async () => {
    await createPlayer({ networkReconnect: { enabled: false } })
    expect(client.initOptions).not.toHaveProperty(MpvProperty.streamLavfO)
  })

  it('lets a raw stream-lavf-o replace the whole list', async () => {
    await createPlayer({
      networkReconnect: { maxDelaySeconds: 20 },
      mpvOptions: { 'stream-lavf-o': 'reconnect=1,reconnect_at_eof=1' },
    })
    expect(client.initOptions?.[MpvProperty.streamLavfO]).toBe(
      'reconnect=1,reconnect_at_eof=1'
    )
  })

  it('rejects a maxDelaySeconds outside FFmpeg’s own range, before any core exists', async () => {
    // mpv silently ignores an unparseable AVOption, so an unchecked value would
    // not fail — it would just not apply.
    for (const bad of [-1, 1.5, 4295, Number.NaN]) {
      await expect(
        createPlayer({ networkReconnect: { maxDelaySeconds: bad } })
      ).rejects.toMatchObject({ playerError: { code: 'invalid-state' } })
    }
    expect(client.initialized).toBe(false)
  })
})

describe('Player — retry before skip', () => {
  /** Put the cursor on `index` with a queue of `count`, then clear the log. */
  function atEntry(index: number, count = 3): void {
    client.emit([
      propertyEvent(MpvProperty.playlistCount, count),
      propertyEvent(MpvProperty.playlistPos, index),
    ])
    client.commands.length = 0
  }

  /** The `end-file` a dropped network stream produces. */
  const NETWORK_FAILURE = endFileEvent('error', 'loading failed')

  async function playingNetworkPlayer(
    overrides: Parameters<typeof Player.create>[0] = {}
  ): Promise<Player> {
    const player = await createPlayer(overrides)
    await player.loadPlaylist([URI, 'b.mp3', 'c.mp3'])
    client.emit([startFileEvent(), propertyEvent(MpvProperty.pause, false)])
    atEntry(0)
    return player
  }

  it('re-attempts the same entry instead of letting the queue advance', async () => {
    const player = await playingNetworkPlayer()
    const retries: unknown[] = []
    const errors: unknown[] = []
    player.on('retrying', (event) => retries.push(event))
    player.on('error', (error) => errors.push(error))

    client.emit([NETWORK_FAILURE])

    expect(retries).toEqual([
      {
        index: 0,
        attempt: 1,
        maxAttempts: 2,
        error: expect.objectContaining({ code: 'network', retryable: true }),
      },
    ])
    // No `error` event: nothing has finally failed yet. That is the feature.
    expect(errors).toEqual([])
    expect(client.commands).toEqual([['playlist-play-index', '0']])
  })

  it('issues the re-attempt immediately, with no timer to freeze', async () => {
    // JS timers freeze with the screen off (ARCHITECTURE, Platform truths), so
    // a backoff written here would silently become "retry on next unlock".
    // Spaced retrying is FFmpeg's job; this layer only decides to stay put.
    vi.useFakeTimers()
    try {
      const player = await playingNetworkPlayer()
      client.emit([NETWORK_FAILURE])
      // Nothing advanced the clock, and the command is already out.
      expect(client.commands).toEqual([['playlist-play-index', '0']])
      expect(vi.getTimerCount()).toBe(0)
      player.destroy()
    } finally {
      vi.useRealTimers()
    }
  })

  it('preserves playback intent across the re-attempt', async () => {
    const player = await createPlayer()
    await player.loadPlaylist([URI], { autoPlay: false })
    client.emit([startFileEvent(), propertyEvent(MpvProperty.pause, true)])
    atEntry(0, 1)
    client.written.delete(MpvProperty.pause)

    client.emit([NETWORK_FAILURE])
    // It was paused, so the jump must not start playing behind the user's back.
    expect(client.written.has(MpvProperty.pause)).toBe(false)
    expect(client.commands).toEqual([['playlist-play-index', '0']])
  })

  it('stops after maxAttempts and lets the advance stand, with the count', async () => {
    const player = await playingNetworkPlayer()
    const retries: unknown[] = []
    const errors: { error: PlayerError; attempts: number }[] = []
    player.on('retrying', (event) => retries.push(event))
    player.on('error', (error, info) =>
      errors.push({ error, attempts: info.attempts })
    )

    client.emit([NETWORK_FAILURE]) // attempt 1
    client.emit([NETWORK_FAILURE]) // attempt 2
    client.emit([NETWORK_FAILURE]) // budget spent

    expect(retries).toHaveLength(2)
    expect(errors).toHaveLength(1)
    expect(errors[0]?.attempts).toBe(2)
    expect(errors[0]?.error.code).toBe('network')
    // Two jumps, and none for the give-up: mpv already advanced, and that is
    // deliberately left alone.
    expect(client.commands).toEqual([
      ['playlist-play-index', '0'],
      ['playlist-play-index', '0'],
    ])
  })

  it('resets the budget once the entry actually plays', async () => {
    const player = await playingNetworkPlayer()
    const retries: unknown[] = []
    player.on('retrying', (event) => retries.push(event))

    client.emit([NETWORK_FAILURE]) // attempt 1
    client.emit([startFileEvent(), playbackRestartEvent()]) // it played
    client.emit([NETWORK_FAILURE]) // a fresh generation

    expect(retries.map((r) => (r as { attempt: number }).attempt)).toEqual([
      1, 1,
    ])
  })

  it('gives each entry its own budget', async () => {
    const player = await playingNetworkPlayer()
    const retries: { index: number; attempt: number }[] = []
    player.on('retrying', (event) => retries.push(event))

    client.emit([NETWORK_FAILURE])
    atEntry(1)
    client.emit([NETWORK_FAILURE])

    expect(retries).toEqual([
      expect.objectContaining({ index: 0, attempt: 1 }),
      expect.objectContaining({ index: 1, attempt: 1 }),
    ])
  })

  it('a user skip during a retry cancels it', async () => {
    const player = await playingNetworkPlayer()
    const retries: unknown[] = []
    const errors: { attempts: number }[] = []
    player.on('retrying', (event) => retries.push(event))
    player.on('error', (_error, info) => errors.push(info))

    client.emit([NETWORK_FAILURE]) // attempt 1
    await player.playlist.next() // the user has said what they want
    client.emit([NETWORK_FAILURE]) // still entry 0 as far as the cursor knows

    // The generation was dropped, so this is attempt 1 again — not attempt 2 —
    // and the count reported alongside any later error starts from zero too.
    expect(retries).toHaveLength(2)
    expect(retries[1]).toMatchObject({ attempt: 1 })
    expect(errors).toEqual([])
  })

  it.each([
    ['playlist.jumpTo', (p: Player) => p.playlist.jumpTo(2)],
    ['playlist.previous', (p: Player) => p.playlist.previous()],
    ['playlist.add', (p: Player) => p.playlist.add('d.mp3')],
    ['playlist.remove', (p: Player) => p.playlist.remove(2)],
    ['playlist.clear', (p: Player) => p.playlist.clear()],
    ['playlist.move', (p: Player) => p.playlist.move(0, 1)],
    ['playlist.shuffle', (p: Player) => p.playlist.shuffle()],
    ['playlist.unshuffle', (p: Player) => p.playlist.unshuffle()],
    // Both stop flavours: the retry reset is stop's own, not keep-playlist's.
    ['stop', (p: Player) => p.stop()],
    ['stop({clearPlaylist})', (p: Player) => p.stop({ clearPlaylist: true })],
    // Network URIs on purpose: a non-network source classifies as
    // `load-failed`, which is not retryable, and the test would pass for the
    // wrong reason.
    ['load', (p: Player) => p.load('https://cdn.example.com/other.mp3')],
    [
      'loadPlaylist',
      (p: Player) => p.loadPlaylist(['https://cdn.example.com/other.mp3']),
    ],
  ])('%s ends the retry generation', async (_name, act) => {
    const player = await playingNetworkPlayer()
    const retries: { attempt: number }[] = []
    player.on('retrying', (event) => retries.push(event))

    client.emit([NETWORK_FAILURE])
    await act(player)
    client.emit([NETWORK_FAILURE])

    expect(retries.map((r) => r.attempt)).toEqual([1, 1])
  })

  it('never retries a non-retryable failure', async () => {
    const player = await playingNetworkPlayer()
    const retries: unknown[] = []
    const errors: { attempts: number }[] = []
    player.on('retrying', (event) => retries.push(event))
    player.on('error', (_error, info) => errors.push(info))

    client.emit([endFileEvent('error', 'unrecognized file format')])

    expect(retries).toEqual([])
    expect(errors).toEqual([{ attempts: 0 }])
    expect(client.commands).toEqual([])
  })

  it('retries an audio-output init failure — the one transient mpv errno', async () => {
    const player = await playingNetworkPlayer()
    const retries: unknown[] = []
    player.on('retrying', (event) => retries.push(event))
    client.emit([endFileEvent('error', 'audio output initialization failed')])
    expect(retries).toHaveLength(1)
  })

  it('retry: { maxAttempts: 0 } restores mpv’s own advance-on-failure', async () => {
    const player = await playingNetworkPlayer({ retry: { maxAttempts: 0 } })
    const retries: unknown[] = []
    const errors: { attempts: number }[] = []
    player.on('retrying', (event) => retries.push(event))
    player.on('error', (_error, info) => errors.push(info))

    client.emit([NETWORK_FAILURE])

    expect(retries).toEqual([])
    expect(errors).toEqual([{ attempts: 0 }])
    expect(client.commands).toEqual([])
  })

  it('rejects a bad maxAttempts before any core exists', async () => {
    for (const bad of [-1, 1.5, Number.NaN]) {
      await expect(
        createPlayer({ retry: { maxAttempts: bad } })
      ).rejects.toMatchObject({ playerError: { code: 'invalid-state' } })
    }
    expect(client.initialized).toBe(false)
  })

  it('is safe when a listener destroys the player mid-retry', async () => {
    const player = await playingNetworkPlayer()
    player.on('retrying', () => {
      player.destroy()
    })
    expect(() => client.emit([NETWORK_FAILURE])).not.toThrow()
    // The jump was not issued into a dead core.
    expect(client.commands).toEqual([])
  })

  it('is safe when a state listener destroys the player before the fan-out', async () => {
    const player = await playingNetworkPlayer()
    player.onStateChange((state) => {
      if (state.status === 'error') player.destroy()
    })
    expect(() => client.emit([NETWORK_FAILURE])).not.toThrow()
    expect(client.commands).toEqual([])
  })

  it('does not retry when there is no current entry to jump back to', async () => {
    const player = await createPlayer()
    const retries: unknown[] = []
    const errors: unknown[] = []
    player.on('retrying', (event) => retries.push(event))
    player.on('error', (error) => errors.push(error))
    // `playlist-pos` is still -1: `playlist-play-index -1` is a different
    // operation entirely, not a re-attempt.
    client.emit([NETWORK_FAILURE])
    expect(retries).toEqual([])
    expect(errors).toHaveLength(1)
  })
})

describe('Player — retryLiveEof (a live stream’s clean close)', () => {
  /** mpv's *clean* end of file — no error number, no error string. */
  const CLEAN_END = endFileEvent('endOfFile')

  /**
   * A playing entry that mpv has declared unseekable, which is the *only* input
   * to `isLive` — see `withLiveness`.
   *
   * `readable` is set as well as the property event because a track change
   * re-reads `seekable` synchronously (`#readTrackChange`); leaving mpv's own
   * answer unset would drop liveness the moment the cursor moves, which is not
   * what a device does.
   */
  async function playingStream(
    overrides: Parameters<typeof Player.create>[0] = {},
    { live = true }: { live?: boolean } = {}
  ): Promise<Player> {
    const player = await createPlayer(overrides)
    await player.loadPlaylist([URI, 'b.mp3', 'c.mp3'])
    client.readable.set(MpvProperty.seekable, !live)
    client.emit([
      startFileEvent(),
      propertyEvent(MpvProperty.pause, false),
      propertyEvent(MpvProperty.playlistCount, 3),
      propertyEvent(MpvProperty.playlistPos, 0),
      propertyEvent(MpvProperty.seekable, !live),
    ])
    expect(player.state.isLive).toBe(live)
    client.commands.length = 0
    return player
  }

  /** What mpv publishes when a re-attempt actually reconnects. */
  function reconnected(): void {
    client.emit([
      startFileEvent(),
      playbackRestartEvent(),
      propertyEvent(MpvProperty.seekable, false),
    ])
  }

  it('re-attempts a live entry that ended cleanly, instead of ending the track', async () => {
    const player = await playingStream({ retry: { retryLiveEof: true } })
    const retries: unknown[] = []
    const ended: unknown[] = []
    const errors: unknown[] = []
    player.on('retrying', (event) => retries.push(event))
    player.on('trackEnded', (event) => ended.push(event))
    player.on('error', (error) => errors.push(error))

    client.emit([CLEAN_END])

    expect(retries).toEqual([
      {
        index: 0,
        attempt: 1,
        maxAttempts: 2,
        // Synthesised: mpv reported a clean end, so there is no error string to
        // classify. `network`/`retryable` is what it *is* — see `liveEofError`.
        error: expect.objectContaining({
          code: 'network',
          retryable: true,
          raw: 'eof',
        }),
      },
    ])
    // Neither of the two things a clean end normally produces: the track has
    // not ended, and nothing has failed.
    expect(ended).toEqual([])
    expect(errors).toEqual([])
    expect(client.commands).toEqual([['playlist-play-index', '0']])
  })

  it('is off by default: the same clean end is a trackEnded', async () => {
    const player = await playingStream()
    const retries: unknown[] = []
    const ended: unknown[] = []
    player.on('retrying', (event) => retries.push(event))
    player.on('trackEnded', (event) => ended.push(event))

    client.emit([CLEAN_END])

    expect(retries).toEqual([])
    expect(ended).toEqual([{ index: 0 }])
    expect(client.commands).toEqual([])
  })

  it('never touches a finite entry, however loudly it is asked to', async () => {
    // A seekable entry that reaches its end has ended. This is the guarantee
    // that makes the option safe to turn on for a mixed queue.
    const player = await playingStream(
      { retry: { retryLiveEof: true } },
      { live: false }
    )
    const retries: unknown[] = []
    const ended: unknown[] = []
    player.on('retrying', (event) => retries.push(event))
    player.on('trackEnded', (event) => ended.push(event))

    client.emit([CLEAN_END])

    expect(retries).toEqual([])
    expect(ended).toEqual([{ index: 0 }])
    expect(client.commands).toEqual([])
  })

  it('is bounded: maxAttempts re-attempts, then the end stands as an end', async () => {
    // The documented trade: a broadcast that genuinely ended costs a few extra
    // connects, and then the queue moves on exactly as it always did.
    const player = await playingStream({ retry: { retryLiveEof: true } })
    const retries: { attempt: number }[] = []
    const ended: unknown[] = []
    const errors: unknown[] = []
    player.on('retrying', (event) => retries.push(event))
    player.on('trackEnded', (event) => ended.push(event))
    player.on('error', (error) => errors.push(error))

    client.emit([CLEAN_END]) // attempt 1
    client.emit([CLEAN_END]) // attempt 2
    client.emit([CLEAN_END]) // budget spent

    expect(retries.map((r) => r.attempt)).toEqual([1, 2])
    // Still `trackEnded`, never `error`: a clean end is not a failure, and
    // giving up on re-attempting it does not make it one.
    expect(ended).toEqual([{ index: 0 }])
    expect(errors).toEqual([])
    expect(client.commands).toEqual([
      ['playlist-play-index', '0'],
      ['playlist-play-index', '0'],
    ])
  })

  it('a reconnect that plays only briefly does NOT refill the budget', async () => {
    // The bug this rule exists to prevent: with the ordinary "reset on
    // playbackRestart" rule, a server that hangs up after a second would clear
    // its budget on every reconnect and re-attempt forever.
    const player = await playingStream({ retry: { retryLiveEof: true } })
    const retries: { attempt: number }[] = []
    const ended: unknown[] = []
    player.on('retrying', (event) => retries.push(event))
    player.on('trackEnded', (event) => ended.push(event))

    client.emit([CLEAN_END]) // attempt 1
    reconnected()
    clock.advance((LIVE_EOF_BUDGET_RESET_SECONDS - 1) * 1000)
    client.emit([CLEAN_END]) // attempt 2 — same generation
    reconnected()
    clock.advance((LIVE_EOF_BUDGET_RESET_SECONDS - 1) * 1000)
    client.emit([CLEAN_END]) // budget spent

    expect(retries.map((r) => r.attempt)).toEqual([1, 2])
    expect(ended).toEqual([{ index: 0 }])
  })

  it('sustained playback refills the budget, so an hourly dropout keeps recovering', async () => {
    const player = await playingStream({ retry: { retryLiveEof: true } })
    const retries: { attempt: number }[] = []
    player.on('retrying', (event) => retries.push(event))

    client.emit([CLEAN_END]) // attempt 1
    reconnected()
    clock.advance(LIVE_EOF_BUDGET_RESET_SECONDS * 1000)
    client.emit([CLEAN_END]) // a fresh generation, not attempt 2

    expect(retries.map((r) => r.attempt)).toEqual([1, 1])
  })

  it('anchors the sustained clock to the first restart, not the last', async () => {
    // A second `playbackRestart` (a stall recovering, a seek in a stream that
    // turned out to be seekable) must not keep pushing the deadline out.
    const player = await playingStream({ retry: { retryLiveEof: true } })
    const retries: { attempt: number }[] = []
    player.on('retrying', (event) => retries.push(event))

    client.emit([CLEAN_END]) // attempt 1
    reconnected()
    clock.advance((LIVE_EOF_BUDGET_RESET_SECONDS - 1) * 1000)
    client.emit([playbackRestartEvent()])
    clock.advance(2000)
    client.emit([CLEAN_END])

    // 31 s since the first restart: the generation is over, so this is a new
    // attempt 1 rather than attempt 2.
    expect(retries.map((r) => r.attempt)).toEqual([1, 1])
  })

  it('shares one budget with the ordinary retry path', async () => {
    // An entry that alternates clean closes and hard failures is one unhealthy
    // entry, not two independent problems with a budget each.
    const player = await playingStream({ retry: { retryLiveEof: true } })
    const retries: { attempt: number }[] = []
    const errors: { attempts: number }[] = []
    player.on('retrying', (event) => retries.push(event))
    player.on('error', (_error, info) => errors.push(info))

    client.emit([CLEAN_END]) // attempt 1, live path
    client.emit([endFileEvent('error', 'loading failed')]) // attempt 2, error path
    client.emit([endFileEvent('error', 'loading failed')]) // spent

    expect(retries.map((r) => r.attempt)).toEqual([1, 2])
    expect(errors).toEqual([{ attempts: 2 }])
  })

  it('a user skip cancels a live re-attempt, like any other', async () => {
    const player = await playingStream({ retry: { retryLiveEof: true } })
    const retries: { attempt: number }[] = []
    player.on('retrying', (event) => retries.push(event))

    client.emit([CLEAN_END])
    await player.playlist.next()
    client.emit([CLEAN_END])

    expect(retries.map((r) => r.attempt)).toEqual([1, 1])
  })

  it('respects maxAttempts: 0', async () => {
    const player = await playingStream({
      retry: { maxAttempts: 0, retryLiveEof: true },
    })
    const retries: unknown[] = []
    const ended: unknown[] = []
    player.on('retrying', (event) => retries.push(event))
    player.on('trackEnded', (event) => ended.push(event))

    client.emit([CLEAN_END])

    expect(retries).toEqual([])
    expect(ended).toEqual([{ index: 0 }])
  })

  it('rejects a non-boolean retryLiveEof before any core exists', async () => {
    await expect(
      createPlayer({
        retry: { retryLiveEof: 'yes' as unknown as boolean },
      })
    ).rejects.toMatchObject({ playerError: { code: 'invalid-state' } })
    expect(client.initialized).toBe(false)
  })
})

describe('Player — clearError', () => {
  it('clears a settled error and moves status to idle', async () => {
    const player = await createPlayer({ retry: { maxAttempts: 0 } })
    await player.load(URI)
    client.emit([startFileEvent(), endFileEvent('error', 'loading failed')])
    expect(player.state.status).toBe('error')
    expect(player.state.error?.code).toBe('network')

    const states: PlayerState[] = []
    player.onStateChange((state) => states.push(state))
    expect(player.clearError()).toBe(true)

    expect(player.state.error).toBeUndefined()
    expect(player.state.status).toBe('idle')
    expect(states).toHaveLength(1)
  })

  it('is a no-op with no error, and notifies nobody', async () => {
    const player = await createPlayer()
    const states: PlayerState[] = []
    player.onStateChange((state) => states.push(state))
    expect(player.clearError()).toBe(false)
    expect(states).toEqual([])
  })

  it('clears state only — it never suppresses a later error event', async () => {
    const player = await createPlayer({ retry: { maxAttempts: 0 } })
    await player.load(URI)
    const errors: unknown[] = []
    player.on('error', (error) => errors.push(error))

    client.emit([startFileEvent(), endFileEvent('error', 'loading failed')])
    player.clearError()
    client.emit([startFileEvent(), endFileEvent('error', 'loading failed')])

    expect(errors).toHaveLength(2)
    expect(player.state.status).toBe('error')
  })

  it('auto-clears on the next successful playback restart, without being asked', async () => {
    const player = await createPlayer({ retry: { maxAttempts: 0 } })
    await player.load(URI)
    client.emit([startFileEvent(), endFileEvent('error', 'loading failed')])
    expect(player.state.error).toBeDefined()

    client.emit([playbackRestartEvent()])
    expect(player.state.error).toBeUndefined()
    expect(player.state.status).toBe('ready')
  })

  it('auto-clears when the next entry starts loading', async () => {
    const player = await createPlayer({ retry: { maxAttempts: 0 } })
    await player.load(URI)
    client.emit([startFileEvent(), endFileEvent('error', 'loading failed')])
    client.emit([startFileEvent()])
    expect(player.state.error).toBeUndefined()
    expect(player.state.status).toBe('loading')
  })

  it('throws disposed after destroy', async () => {
    const player = await createPlayer()
    player.destroy()
    expect(() => player.clearError()).toThrow(PlayerErrorException)
  })
})

describe('Player — current-entry URI tracking (filed defect)', () => {
  const LOCAL = '/sdcard/Music/local.flac'
  const REMOTE = 'https://cdn.example.com/remote.mp3'

  /** Move the cursor, with mpv answering the one-shot reads for that entry. */
  function moveTo(index: number, uri: string, seekable = true): void {
    client.readable.set(`playlist/${index}/filename`, uri)
    client.readable.set(MpvProperty.seekable, seekable)
    client.emit([propertyEvent(MpvProperty.playlistPos, index)])
  }

  it('classifies against the entry that is playing, not the one that was loaded', async () => {
    const player = await createPlayer({ retry: { maxAttempts: 0 } })
    const errors: PlayerError[] = []
    player.on('error', (error) => errors.push(error))

    // A mixed queue: entry 0 local, entry 1 remote. `loadPlaylist` remembers
    // entry 0 — which used to be the URI every later failure was judged by.
    await player.loadPlaylist([LOCAL, REMOTE])
    moveTo(0, LOCAL)
    moveTo(1, REMOTE)

    client.emit([startFileEvent(), endFileEvent('error', 'loading failed')])

    expect(errors[0]).toMatchObject({ code: 'network', uri: REMOTE })
    // …and it is retryable *because* it is a network entry, which is the whole
    // point: the retry layer reads this flag.
    expect(errors[0]?.retryable).toBe(true)
  })

  it('follows the cursor back to a local entry', async () => {
    const player = await createPlayer({ retry: { maxAttempts: 0 } })
    const errors: PlayerError[] = []
    player.on('error', (error) => errors.push(error))

    await player.loadPlaylist([REMOTE, LOCAL])
    moveTo(0, REMOTE)
    moveTo(1, LOCAL)

    client.emit([startFileEvent(), endFileEvent('error', 'loading failed')])
    expect(errors[0]?.code).toBe('load-failed')
    expect(errors[0]?.retryable).toBe(false)
  })

  it('classifies an end-file in the same batch as the entry that ended', async () => {
    // The ordering trap: a batch can carry the previous entry's failure and the
    // next entry's cursor move together. The failure belongs to the old URI.
    const player = await createPlayer({ retry: { maxAttempts: 0 } })
    const errors: PlayerError[] = []
    player.on('error', (error) => errors.push(error))

    await player.loadPlaylist([REMOTE, LOCAL])
    moveTo(0, REMOTE)

    client.readable.set('playlist/1/filename', LOCAL)
    client.emit([
      endFileEvent('error', 'loading failed'),
      propertyEvent(MpvProperty.playlistPos, 1),
    ])
    expect(errors[0]).toMatchObject({ code: 'network', uri: REMOTE })
  })

  it('keeps the last known URI when mpv cannot answer the read', async () => {
    const player = await createPlayer({ retry: { maxAttempts: 0 } })
    const errors: PlayerError[] = []
    player.on('error', (error) => errors.push(error))

    await player.load(REMOTE)
    // No `playlist/1/filename` seeded: a failed/unavailable read must not
    // downgrade classification to "unknown".
    client.emit([propertyEvent(MpvProperty.playlistPos, 1)])
    client.emit([startFileEvent(), endFileEvent('error', 'loading failed')])
    expect(errors[0]).toMatchObject({ uri: REMOTE })
  })

  it('reads the new entry’s filename once per cursor change', async () => {
    const player = await createPlayer()
    await player.load(REMOTE)
    const reads = vi.spyOn(client, 'getPropertyString')
    moveTo(2, LOCAL)
    expect(
      reads.mock.calls.filter(([name]) => name.startsWith('playlist/'))
    ).toEqual([['playlist/2/filename']])
    expect(player.state.playlist.index).toBe(2)
  })
})

describe('Player — stop', () => {
  it('keeps the queue by default — the transport button, not mpv’s clear', async () => {
    const player = await createPlayer()
    await player.stop()
    expect(client.commands).toEqual([['stop', 'keep-playlist']])
  })

  it('clears the queue only when asked', async () => {
    const player = await createPlayer()
    await player.stop({ clearPlaylist: true })
    expect(client.commands).toEqual([['stop']])
  })

  it('leaves the kept queue with no current entry and no skip either way', async () => {
    const player = await createPlayer()
    await player.load(URI)
    client.emit([
      startFileEvent(),
      propertyEvent(MpvProperty.playlistPos, 1),
      propertyEvent(MpvProperty.playlistCount, 3),
      playbackRestartEvent(),
    ])
    expect(player.state.hasNext).toBe(true)
    expect(player.state.hasPrevious).toBe(true)

    await player.stop()
    // mpv ends the entry with reason `stop` and leaves no entry "current":
    // `playlist-pos` reads -1 while the playlist itself survives.
    client.emit([
      endFileEvent('stop'),
      propertyEvent(MpvProperty.playlistPos, -1),
    ])

    expect(player.state.status).toBe('idle')
    expect(player.state.playlist).toEqual({ index: -1, count: 3 })
    // Nothing is loaded, so there is nothing relative to skip from — the way
    // back into the queue is `playlist.jumpTo(i)`, not `play()`.
    expect(player.state.hasNext).toBe(false)
    expect(player.state.hasPrevious).toBe(false)
  })

  it('settles to idle and leaves the player usable', async () => {
    const player = await createPlayer()
    await player.load(URI)
    client.emit([startFileEvent(), playbackRestartEvent()])
    await player.stop()
    client.emit([endFileEvent('stop')])
    expect(player.state.status).toBe('idle')
    expect(player.destroyed).toBe(false)

    await player.load(URI)
    expect(client.commands.at(-1)?.[0]).toBe('loadfile')
  })

  it('throws once destroyed', async () => {
    const player = await createPlayer()
    player.destroy()
    await expect(player.stop()).rejects.toThrow(PlayerErrorException)
  })
})

describe('Player — seekBy', () => {
  it('issues a relative exact seek', async () => {
    const player = await createPlayer()
    await player.seekBy(15)
    await player.seekBy(-15)
    expect(client.commands).toEqual([
      ['seek', '15', 'relative+exact'],
      ['seek', '-15', 'relative+exact'],
    ])
  })

  it('rejects a non-finite delta rather than sending garbage to mpv', async () => {
    const player = await createPlayer()
    await expect(player.seekBy(Number.NaN)).rejects.toThrow(
      PlayerErrorException
    )
    expect(client.commands).toEqual([])
  })
})

describe('Player — pitch', () => {
  it('writes mpv’s pitch property', async () => {
    const player = await createPlayer()
    player.setPitch(1.5)
    expect(client.written.get(MpvProperty.pitch)).toBe(1.5)
  })

  it('takes a ratio, so semitones are a caller-side power of two', async () => {
    const player = await createPlayer()
    const semitones = (n: number): number => 2 ** (n / 12)
    player.setPitch(semitones(7))
    // mpv's own worked example for a perfect fifth.
    expect(client.written.get(MpvProperty.pitch)).toBeCloseTo(1.498307, 5)
  })

  it('validates against mpv’s range instead of clamping', async () => {
    const player = await createPlayer()
    // Clamping `0` to `0.01` would hide a caller bug behind an inaudible
    // sub-sonic pitch; mpv's own domain is the contract.
    expect(() => player.setPitch(0)).toThrow(PlayerErrorException)
    expect(() => player.setPitch(101)).toThrow(PlayerErrorException)
    expect(() => player.setPitch(Number.NaN)).toThrow(PlayerErrorException)
    expect(client.written.has(MpvProperty.pitch)).toBe(false)
  })

  it('does not touch speed — the two are independent', async () => {
    const player = await createPlayer()
    player.setRate(1.5)
    player.setPitch(2)
    expect(client.written.get(MpvProperty.speed)).toBe(1.5)
    expect(client.written.get(MpvProperty.pitch)).toBe(2)
  })

  it('publishes the observed value in state', async () => {
    const player = await createPlayer()
    expect(player.state.pitch).toBe(1)
    client.emit([propertyEvent(MpvProperty.pitch, 0.5)])
    expect(player.state.pitch).toBe(0.5)
  })
})

describe('Player — audio channels', () => {
  it('forces a mono downmix through mpv’s own channel negotiation', async () => {
    const player = await createPlayer()
    player.setAudioChannels('mono')
    // No filter chain involved: `pan` is not compiled into these binaries and
    // is not needed for this.
    expect(client.written.get(MpvProperty.audioChannels)).toBe('mono')
    expect(client.written.has(MpvProperty.audioFilters)).toBe(false)
  })

  it('accepts every documented mode and rejects anything else', async () => {
    const player = await createPlayer()
    for (const mode of ['auto-safe', 'auto', 'stereo', 'mono'] as const) {
      player.setAudioChannels(mode)
      expect(client.written.get(MpvProperty.audioChannels)).toBe(mode)
    }
    expect(() => player.setAudioChannels('5.1' as 'mono')).toThrow(
      PlayerErrorException
    )
  })
})

describe('Player — restart-or-previous', () => {
  /** A player playing `index` of a 3-entry queue, `seconds` in. */
  async function playingAt(seconds: number, index = 1): Promise<Player> {
    const player = await createPlayer()
    await player.loadPlaylist(['a.mp3', 'b.mp3', 'c.mp3'])
    client.readable.set(MpvProperty.timePos, seconds)
    client.readable.set(MpvProperty.seekable, true)
    client.emit([
      propertyEvent(MpvProperty.playlistCount, 3),
      propertyEvent(MpvProperty.playlistPos, index),
      propertyEvent(MpvProperty.pause, false),
      playbackRestartEvent(),
    ])
    client.commands.length = 0
    return player
  }

  it('goes back when barely into the entry', async () => {
    const player = await playingAt(1)
    await player.playlist.previous()
    expect(client.commands).toEqual([['playlist-prev', 'weak']])
  })

  it('restarts when past the threshold', async () => {
    const player = await playingAt(10)
    await player.playlist.previous()
    expect(client.commands).toEqual([['seek', '0', 'absolute+exact']])
  })

  it('honours a custom threshold', async () => {
    const player = await playingAt(10)
    await player.playlist.previous({ restartThreshold: 30 })
    expect(client.commands).toEqual([['playlist-prev', 'weak']])
  })

  it('always moves at threshold 0', async () => {
    const player = await playingAt(600)
    await player.playlist.previous({ restartThreshold: 0 })
    expect(client.commands).toEqual([['playlist-prev', 'weak']])
  })

  it('always moves on a live stream, which has no 0 to return to', async () => {
    const player = await createPlayer()
    client.readable.set(MpvProperty.timePos, 600)
    client.emit([
      propertyEvent(MpvProperty.playlistCount, 2),
      propertyEvent(MpvProperty.playlistPos, 1),
      propertyEvent(MpvProperty.seekable, false),
      propertyEvent(MpvProperty.pause, false),
      playbackRestartEvent(),
    ])
    expect(player.state.isLive).toBe(true)
    client.commands.length = 0
    await player.playlist.previous()
    expect(client.commands).toEqual([['playlist-prev', 'weak']])
  })

  it('rejects a nonsensical threshold', async () => {
    const player = await createPlayer()
    await expect(
      player.playlist.previous({ restartThreshold: -1 })
    ).rejects.toThrow(PlayerErrorException)
  })
})

describe('Player — queueEnded', () => {
  /** Play the entry at `index` of a `count`-entry queue and end it cleanly. */
  async function endEntry(
    index: number,
    count: number,
    loop?: 'track' | 'playlist'
  ): Promise<{ ended: number; queueEnded: number }> {
    const player = await createPlayer()
    let ended = 0
    let queueEnded = 0
    player.on('trackEnded', () => (ended += 1))
    player.on('queueEnded', () => (queueEnded += 1))
    client.emit([
      propertyEvent(MpvProperty.playlistCount, count),
      propertyEvent(MpvProperty.playlistPos, index),
      ...(loop === 'playlist'
        ? [propertyEvent(MpvProperty.loopPlaylist, 'inf')]
        : loop === 'track'
          ? [propertyEvent(MpvProperty.loopFile, 'inf')]
          : []),
      startFileEvent(),
      playbackRestartEvent(),
    ])
    client.emit([endFileEvent('endOfFile')])
    return { ended, queueEnded }
  }

  it('fires after the last entry ends', async () => {
    expect(await endEntry(2, 3)).toEqual({ ended: 1, queueEnded: 1 })
  })

  it('does not fire mid-queue', async () => {
    expect(await endEntry(0, 3)).toEqual({ ended: 1, queueEnded: 0 })
  })

  it('does not fire when the queue is about to repeat', async () => {
    expect(await endEntry(2, 3, 'playlist')).toEqual({
      ended: 1,
      queueEnded: 0,
    })
  })

  it('fires for a single-entry queue', async () => {
    expect(await endEntry(0, 1)).toEqual({ ended: 1, queueEnded: 1 })
  })

  it('does not fire when the last entry failed', async () => {
    const player = await createPlayer({ retry: { maxAttempts: 0 } })
    let queueEnded = 0
    player.on('queueEnded', () => (queueEnded += 1))
    await player.load(URI)
    client.emit([
      propertyEvent(MpvProperty.playlistCount, 1),
      propertyEvent(MpvProperty.playlistPos, 0),
      startFileEvent(),
    ])
    client.emit([endFileEvent('error', 'loading failed')])
    // "The queue finished" and "the queue gave up" are different facts.
    expect(queueEnded).toBe(0)
    expect(player.state.status).toBe('error')
  })
})

describe('Player — seek discontinuity events', () => {
  it('pairs a seek with its completion, carrying before and after', async () => {
    const player = await createPlayer()
    const started: unknown[] = []
    const completed: unknown[] = []
    player.on('seekStarted', (event) => started.push(event))
    player.on('seekCompleted', (event) => completed.push(event))

    client.readable.set(MpvProperty.timePos, 30)
    client.emit([
      startFileEvent(),
      propertyEvent(MpvProperty.pause, false),
      playbackRestartEvent(),
    ])
    started.length = 0
    completed.length = 0

    client.readable.set(MpvProperty.timePos, 90)
    client.emit([seekEvent()])
    expect(started).toEqual([{ reason: 'seek', from: 30 }])
    expect(completed).toEqual([])

    client.emit([playbackRestartEvent()])
    expect(completed).toEqual([{ reason: 'seek', position: 90 }])
  })

  it('reports a queue advance as auto-advance', async () => {
    const player = await createPlayer()
    const events: string[] = []
    player.on('seekStarted', (event) => events.push(`start:${event.reason}`))
    player.on('seekCompleted', (event) =>
      events.push(`done:${event.reason}@${String(event.position)}`)
    )

    client.readable.set(MpvProperty.timePos, 0)
    client.emit([
      propertyEvent(MpvProperty.playlistCount, 2),
      propertyEvent(MpvProperty.playlistPos, 1),
      playbackRestartEvent(),
    ])
    expect(events).toEqual(['start:auto-advance', 'done:auto-advance@0'])
  })

  it('does not glue a seek that never landed onto the next entry', async () => {
    const player = await createPlayer()
    const completed: unknown[] = []
    player.on('seekCompleted', (event) => completed.push(event))

    client.emit([startFileEvent(), playbackRestartEvent()])
    completed.length = 0
    client.emit([seekEvent()])
    // The entry failed instead of restarting.
    client.emit([endFileEvent('error', 'loading failed')])
    client.emit([playbackRestartEvent()])
    expect(completed).toEqual([])
  })

  it('says nothing for a restart nobody announced', async () => {
    const player = await createPlayer()
    const completed: unknown[] = []
    player.on('seekCompleted', (event) => completed.push(event))
    client.emit([playbackRestartEvent()])
    expect(completed).toEqual([])
  })
})

describe('Player — getCommonMetadata', () => {
  it('normalises the same single node read getMetadata uses', async () => {
    const player = await createPlayer()
    client.readableMaps.set(MpvProperty.metadata, {
      TITLE: 'Ghosts',
      ARTIST: 'Japan',
      TRACKNUMBER: '4/9',
      DATE: '1981-03-27',
    })
    expect(player.getCommonMetadata()).toEqual({
      title: 'Ghosts',
      artist: 'Japan',
      trackNumber: 4,
      trackCount: 9,
      year: 1981,
    })
    expect(client.mapReads).toEqual([MpvProperty.metadata])
  })

  it('is empty when nothing is loaded', async () => {
    const player = await createPlayer()
    expect(player.getCommonMetadata()).toEqual({})
  })

  it('throws once destroyed', async () => {
    const player = await createPlayer()
    player.destroy()
    expect(() => player.getCommonMetadata()).toThrow(PlayerErrorException)
  })
})
