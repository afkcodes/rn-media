import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PlayerError } from '../errors'
import { PlayerErrorException } from '../errors'
import type { LogEvent } from '../events'
import { Player } from '../player'
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
      'user-agent': 'rn-media (libmpv)',
      // mpv's own default readahead is 1000 h, capped only by the 150 MiB
      // `demuxer-max-bytes`; bounding it is what stops a paused radio stream
      // from downloading for hours. See DEFAULT_CACHE_SECS.
      'cache-secs': '30',
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
      [{ index: 0, previousIndex: -1 }],
      [{ index: 1, previousIndex: 0 }],
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

  // `wireAudioSession` (@rn-media/audio-session) requires this method on the
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
      ['loadfile', source, 'replace', 'demuxer=lavf'],
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
      'demuxer=hls',
    ])
  })

  it('applies to each playlist entry independently', async () => {
    const player = await createPlayer()
    await player.loadPlaylist(['a.mp3', HLS, 'c.m3u', 'd.flac'])
    expect(client.commands).toEqual([
      ['stop'],
      ['loadfile', 'a.mp3', 'append'],
      ['loadfile', HLS, 'append', 'demuxer=lavf'],
      ['loadfile', 'c.m3u', 'append', 'demuxer=lavf'],
      ['loadfile', 'd.flac', 'append'],
      ['playlist-play-index', '0'],
    ])
  })

  it('respects a caller-supplied demuxer across a whole playlist', async () => {
    const player = await createPlayer()
    await player.loadPlaylist(['a.mp3', HLS], {
      mpvOptions: { demuxer: 'lavf', 'cache-pause': 'no' },
    })
    expect(client.commands.slice(1, 3)).toEqual([
      ['loadfile', 'a.mp3', 'append', 'demuxer=lavf,cache-pause=no'],
      ['loadfile', HLS, 'append', 'demuxer=lavf,cache-pause=no'],
    ])
  })

  it('guards playlist.add too — same command, same hazard', async () => {
    const player = await createPlayer()
    await player.playlist.add(HLS)
    await player.playlist.add('b.mp3', { playNow: true })
    expect(client.commands).toEqual([
      ['loadfile', HLS, 'append', 'demuxer=lavf'],
      ['loadfile', 'b.mp3', 'append-play'],
    ])
  })
})

describe('Player — playlist API', () => {
  it('add appends, and append-play when asked', async () => {
    const player = await createPlayer()
    await player.playlist.add('a.mp3')
    await player.playlist.add('b.mp3', { playNow: true })
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
    player.observeProperty('metadata', 'string')
    expect(client.observations.get('metadata')).toBe('string')
    player.unobserveProperty('metadata')
    expect(client.observations.has('metadata')).toBe(false)
  })

  it('ignores unknown observed properties in the reducer', async () => {
    const player = await createPlayer()
    const before = player.state
    player.observeProperty('metadata', 'string')
    client.emit([propertyEvent('metadata', 'x')])
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
