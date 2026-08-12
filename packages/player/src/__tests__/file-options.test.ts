import { beforeEach, describe, expect, it } from 'vitest'
import { PlayerErrorException } from '../errors'
import { Player } from '../player'
import { FakeMpvClient } from './fake-mpv-client'

let client: FakeMpvClient

async function createPlayer(): Promise<Player> {
  return Player.create({ createClient: () => client, now: () => 1_000 })
}

/** The per-file option string of the nth `loadfile`, or `undefined`. */
function fileOptions(index: number): string | undefined {
  const argv = client.commands.filter(([name]) => name === 'loadfile')[index]
  // `loadfile <url> <flags> [<index> [<options>]]` — options are last, and only
  // present when the command carries five arguments.
  return argv?.length === 5 ? argv[4] : undefined
}

beforeEach(() => {
  client = new FakeMpvClient()
})

describe('loadPlaylist — startPosition applies to one entry (audit defect 1)', () => {
  it('starts only the startIndex entry at the offset', async () => {
    const player = await createPlayer()
    // The session-restore call, verbatim from the audit.
    await player.loadPlaylist(
      ['a.mp3', 'b.mp3', 'c.mp3', 'd.mp3', 'e.mp3', 'f.mp3'],
      {
        startIndex: 5,
        startPosition: 120,
      }
    )

    expect(client.commands).toEqual([
      ['stop'],
      ['loadfile', 'a.mp3', 'append'],
      ['loadfile', 'b.mp3', 'append'],
      ['loadfile', 'c.mp3', 'append'],
      ['loadfile', 'd.mp3', 'append'],
      ['loadfile', 'e.mp3', 'append'],
      ['loadfile', 'f.mp3', 'append', '-1', 'start=120'],
      ['playlist-play-index', '5'],
    ])
  })

  it('starts entry 0 at the offset when no startIndex is given', async () => {
    const player = await createPlayer()
    await player.loadPlaylist(['a.mp3', 'b.mp3'], { startPosition: 42 })
    expect(fileOptions(0)).toBe('start=42')
    expect(fileOptions(1)).toBeUndefined()
  })

  it('still applies every other per-file option to every entry', async () => {
    const player = await createPlayer()
    await player.loadPlaylist(['a.mp3', 'b.mp3'], {
      startIndex: 1,
      startPosition: 30,
      mpvOptions: { 'cache-pause': 'no' },
    })
    expect(fileOptions(0)).toBe('cache-pause=no')
    expect(fileOptions(1)).toBe('start=30,cache-pause=no')
  })

  it('leaves the documented escape hatch working — a raw `start` is per entry', async () => {
    const player = await createPlayer()
    await player.loadPlaylist(['a.mp3', 'b.mp3'], {
      mpvOptions: { start: '120' },
    })
    expect(fileOptions(0)).toBe('start=120')
    expect(fileOptions(1)).toBe('start=120')
  })

  it('refuses to combine startPosition with shuffle', async () => {
    const player = await createPlayer()
    await expect(
      player.loadPlaylist(['a.mp3', 'b.mp3'], {
        shuffle: true,
        startPosition: 30,
      })
    ).rejects.toThrow(PlayerErrorException)
  })
})

describe('per-file option escaping (audit defect 4)', () => {
  it('escapes a value containing a comma instead of corrupting the list', async () => {
    const player = await createPlayer()
    await player.load('a.mp3', {
      mpvOptions: { 'http-header-fields': 'Authorization: a,b' },
    })
    // Unescaped this read `http-header-fields=Authorization: a,b`, which mpv
    // parses as one option plus the garbage key `b`.
    expect(fileOptions(0)).toBe('http-header-fields=%18%Authorization: a,b')
  })

  it('escapes decimals, quotes, brackets and a leading percent', async () => {
    const player = await createPlayer()
    await player.load('a.mp3', {
      startPosition: 30.5,
      mpvOptions: { a: '"q"', b: '[x]', c: '%50%' },
    })
    expect(fileOptions(0)).toBe('start=%4%30.5,a=%3%"q",b=%3%[x],c=%4%%50%')
  })

  it('leaves plain values unescaped, so nothing that worked before changed', async () => {
    const player = await createPlayer()
    await player.load('a.m3u8', { startPosition: 30, mpvOptions: { x: 'no' } })
    expect(fileOptions(0)).toBe('start=30,demuxer=lavf,x=no')
  })

  it('escapes keys too', async () => {
    const player = await createPlayer()
    await player.load('a.mp3', { mpvOptions: { 'weird key': 'v' } })
    expect(fileOptions(0)).toBe('%9%weird key=v')
  })
})

describe('typed per-source headers', () => {
  it('compiles onto an escaped http-header-fields option', async () => {
    const player = await createPlayer()
    await player.load('https://jellyfin.example/Audio/1/stream', {
      headers: { Authorization: 'MediaBrowser Token="abc"' },
    })
    expect(fileOptions(0)).toBe(
      'http-header-fields=%39%Authorization: MediaBrowser Token="abc"'
    )
  })

  it('escapes both layers for a comma-bearing header — the proving case', async () => {
    const player = await createPlayer()
    await player.load('https://example.com/a.mp3', {
      headers: {
        Authorization: 'Bearer abc',
        Accept: 'audio/flac, audio/mpeg',
      },
    })
    // Inner layer: `\,` inside the item so mpv's string-list parser keeps the
    // header whole. Outer layer: `%n%` so the file-option parser keeps the
    // whole list as one value. The byte count covers the escaped form.
    const value = 'Authorization: Bearer abc,Accept: audio/flac\\, audio/mpeg'
    expect(fileOptions(0)).toBe(
      `http-header-fields=%${String(value.length)}%${value}`
    )
  })

  it('carries headers on a queued entry too', async () => {
    const player = await createPlayer()
    await player.playlist.add('https://example.com/b.mp3', {
      headers: { Authorization: 'Bearer xyz' },
      startPosition: 10,
    })
    expect(client.commands[0]).toEqual([
      'loadfile',
      'https://example.com/b.mp3',
      'append',
      '-1',
      'start=10,http-header-fields=%25%Authorization: Bearer xyz',
    ])
  })

  it('applies headers to every entry of a playlist', async () => {
    const player = await createPlayer()
    await player.loadPlaylist(['a.mp3', 'b.mp3'], {
      headers: { 'X-Token': 'k' },
    })
    expect(fileOptions(0)).toBe('http-header-fields=%10%X-Token: k')
    expect(fileOptions(1)).toBe('http-header-fields=%10%X-Token: k')
  })

  it('lets a raw http-header-fields win, and does not emit both', async () => {
    const player = await createPlayer()
    await player.load('a.mp3', {
      headers: { 'X-Typed': 'no' },
      mpvOptions: { 'http-header-fields': 'X-Raw: yes' },
    })
    expect(fileOptions(0)).toBe('http-header-fields=%10%X-Raw: yes')
  })

  it('emits nothing for an empty header map', async () => {
    const player = await createPlayer()
    await player.load('a.mp3', { headers: {} })
    expect(fileOptions(0)).toBeUndefined()
  })

  it('rejects an injectable header before mpv sees it', async () => {
    const player = await createPlayer()
    await expect(
      player.load('a.mp3', { headers: { 'X-Evil': 'a\r\nX-Injected: 1' } })
    ).rejects.toThrow(PlayerErrorException)
    // Nothing was issued: the load failed at the boundary, not half-way.
    expect(client.commands).toEqual([])
  })

  it('combines with the m3u8 demuxer guard', async () => {
    const player = await createPlayer()
    await player.load('https://example.com/master.m3u8', {
      headers: { 'X-Token': 'k' },
    })
    expect(fileOptions(0)).toBe(
      'demuxer=lavf,http-header-fields=%10%X-Token: k'
    )
  })
})
