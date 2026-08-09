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
    expect(client.initOptions?.['replaygain']).toBe('track')
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
  ])('rejects %s at create time, before a core exists', async (_label, gain) => {
    await expect(createPlayer({ replayGain: gain })).rejects.toMatchObject({
      playerError: { code: 'invalid-state' },
    })
    expect(client.initialized).toBe(false)
    expect(client.destroyCount).toBe(0)
  })

  it.each([
    ['bad mode', { mode: 'loud' as never }],
    ['preamp out of range', { mode: 'track' as const, preamp: 200 }],
    ['fallback out of range', { mode: 'track' as const, fallback: -500 }],
  ])('rejects %s at runtime without writing anything', async (_label, gain) => {
    const player = await createPlayer()
    expect(() => player.setReplayGain(gain)).toThrowError(PlayerErrorException)
    expect(client.written.has('replaygain')).toBe(false)
  })

  it.each([-150, 150, 0])('accepts preamp %s (mpv’s boundary)', async (preamp) => {
    const player = await createPlayer()
    player.setReplayGain({ mode: 'track', preamp })
    expect(client.written.get('replaygain-preamp')).toBe(preamp)
  })

  it.each([-200, 60])('accepts fallback %s (mpv’s boundary)', async (fallback) => {
    const player = await createPlayer()
    player.setReplayGain({ mode: 'track', fallback })
    expect(client.written.get('replaygain-fallback')).toBe(fallback)
  })
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
  /** Seed the fake with mpv's documented `metadata/list/…` sub-properties. */
  function seedMetadata(entries: ReadonlyArray<readonly [string, string]>) {
    client.readable.set(MpvProperty.metadataCount, entries.length)
    entries.forEach(([key, value], index) => {
      client.readable.set(`metadata/list/${index}/key`, key)
      client.readable.set(`metadata/list/${index}/value`, value)
    })
  }

  it('observes `metadata` as a string change-edge', async () => {
    await createPlayer()
    // The value is never parsed — mpv's manual says a raw string read of the
    // map "doesn't work" — but the observation is what tells us it changed.
    expect(client.observations.get(MpvProperty.metadata)).toBe('string')
  })

  it('builds the map from metadata/list, never from the map property', async () => {
    const player = await createPlayer()
    seedMetadata([
      ['title', 'Windowlicker'],
      ['artist', 'Aphex Twin'],
      ['icy-title', 'Aphex Twin - Windowlicker'],
    ])
    const spy = vi.spyOn(client, 'getPropertyString')

    expect(player.getMetadata()).toEqual({
      'title': 'Windowlicker',
      'artist': 'Aphex Twin',
      'icy-title': 'Aphex Twin - Windowlicker',
    })
    expect(spy.mock.calls.map(([name]) => name)).not.toContain(
      MpvProperty.metadata
    )
  })

  it('returns an empty map when nothing is loaded', async () => {
    const player = await createPlayer()
    // mpv reports the whole property unavailable without a demuxer, which the
    // native binding turns into `undefined`.
    expect(player.getMetadata()).toEqual({})
  })

  it.each([0, -1, Number.NaN])(
    'returns an empty map for a count of %s',
    async (count) => {
      const player = await createPlayer()
      client.readable.set(MpvProperty.metadataCount, count)
      expect(player.getMetadata()).toEqual({})
    }
  )

  it('skips entries whose key vanished mid-walk', async () => {
    const player = await createPlayer()
    seedMetadata([
      ['title', 'A'],
      ['artist', 'B'],
    ])
    // The walk is not atomic; a key that is gone answers PROPERTY_NOT_FOUND.
    client.readErrors.set(
      'metadata/list/1/key',
      '[mpv:-8] mpv_get_property("metadata/list/1/key", STRING): property not found'
    )
    expect(player.getMetadata()).toEqual({ title: 'A' })
  })

  it('treats a missing value as an empty string, not a missing key', async () => {
    const player = await createPlayer()
    client.readable.set(MpvProperty.metadataCount, 1)
    client.readable.set('metadata/list/0/key', 'comment')
    expect(player.getMetadata()).toEqual({ comment: '' })
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
    const numbers = vi.spyOn(client, 'getPropertyNumber')
    const strings = vi.spyOn(client, 'getPropertyString')
    client.emit([propertyEvent(MpvProperty.metadata, '{"title":"A"}')])
    expect(numbers.mock.calls.map(([name]) => name)).not.toContain(
      MpvProperty.metadataCount
    )
    expect(strings).not.toHaveBeenCalled()
  })

  it('skips the emission rather than throwing when the read fails', async () => {
    const player = await createPlayer()
    const changed = vi.fn()
    player.on('metadataChanged', changed)
    client.readErrors.set(
      MpvProperty.metadataCount,
      '[mpv:-9] mpv_get_property("metadata/list/count", INT64): property format error'
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
