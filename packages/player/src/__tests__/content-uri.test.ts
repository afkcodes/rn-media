/**
 * Android `content://` → `fd://`: the rewrite, its cache, and the seam it
 * plugs into.
 *
 * Everything here is device-independent on purpose. The one thing that needs a
 * device — whether libmpv can actually read a descriptor a `ContentProvider`
 * opened, and whether that descriptor is seekable — is on-device evidence in
 * the report, not something a fake can answer. What a fake *can* pin down is
 * the property the prefetcher depends on: **one descriptor per URI, and the
 * same URL every time it is asked**. A rewrite that minted a fresh descriptor
 * per call would compile, pass a smoke test, and silently defeat prefetching
 * on every track (mpv compares the prefetch and play-time URLs byte-for-byte).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CONTENT_URI_FD_LIMIT,
  ContentUriResolver,
  type ContentUriOpener,
  isContentUri,
} from '../content-uri'
import { PlayerErrorException } from '../errors'
import { Player } from '../player'
import { setContentUriOpener } from '../content-uri'
import { FakeMpvClient } from './fake-mpv-client'

/**
 * Let every queued microtask settle — resolve-ahead is dispatched from a
 * microtask and each resolution adds a couple of promise hops. Same shape (and
 * same reason) as `source-resolver.test.ts`'s helper.
 */
async function settle(): Promise<void> {
  for (let turn = 0; turn < 8; turn += 1) {
    await Promise.resolve()
  }
}

const AUDIO = 'content://media/external/audio/media/42'
const OTHER = 'content://media/external/audio/media/43'

/** A platform opener that hands out ascending descriptors and records closes. */
function fakeOpener(): ContentUriOpener & {
  readonly opened: string[]
  readonly closed: number[]
  fail?: string
} {
  let next = 7
  const opened: string[] = []
  const closed: number[] = []
  return {
    opened,
    closed,
    open(uri: string): number {
      if (this.fail !== undefined) throw new Error(this.fail)
      opened.push(uri)
      next += 1
      return next
    },
    close(fd: number): void {
      closed.push(fd)
    },
  }
}

describe('isContentUri', () => {
  it('recognises the scheme, case-insensitively', () => {
    expect(isContentUri(AUDIO)).toBe(true)
    expect(isContentUri('CONTENT://media/external/audio/media/42')).toBe(true)
    // Android's `Uri.parse` lower-cases the scheme, so a URI that arrived from
    // an intent extra in mixed case is the same document — missing it would
    // mean handing mpv something it cannot open.
    expect(isContentUri('Content://x/y')).toBe(true)
  })

  it('leaves everything else alone', () => {
    for (const uri of [
      'https://example.com/a.mp3',
      'file:///sdcard/a.mp3',
      '/sdcard/a.mp3',
      'fd://9',
      '',
      'contentx://a',
    ]) {
      expect(isContentUri(uri)).toBe(false)
    }
  })
})

describe('ContentUriResolver', () => {
  it('rewrites a content URI to mpv’s fd:// protocol', () => {
    const opener = fakeOpener()
    const resolver = new ContentUriResolver(opener)
    expect(resolver.resolve(AUDIO)).toBe('fd://8')
    expect(opener.opened).toEqual([AUDIO])
  })

  it('passes every other URI through untouched, opening nothing', () => {
    const opener = fakeOpener()
    const resolver = new ContentUriResolver(opener)
    for (const uri of ['https://x/a.mp3', 'file:///a.mp3', '/a.mp3']) {
      expect(resolver.resolve(uri)).toBe(uri)
    }
    expect(opener.opened).toEqual([])
  })

  it('mints ONE descriptor per URI — the prefetch guarantee', () => {
    const opener = fakeOpener()
    const resolver = new ContentUriResolver(opener)
    // The prefetch pass, then the play-time pass, then a replay. mpv compares
    // the URLs byte-for-byte to decide whether the prefetched stream can be
    // reused; a second descriptor here would produce `fd://9` and drop it.
    const first = resolver.resolve(AUDIO)
    const second = resolver.resolve(AUDIO)
    const third = resolver.resolve(AUDIO)
    expect(second).toBe(first)
    expect(third).toBe(first)
    expect(opener.opened).toEqual([AUDIO])
    expect(resolver.openCount).toBe(1)
  })

  it('gives different URIs different descriptors', () => {
    const opener = fakeOpener()
    const resolver = new ContentUriResolver(opener)
    expect(resolver.resolve(AUDIO)).toBe('fd://8')
    expect(resolver.resolve(OTHER)).toBe('fd://9')
  })

  it('throws a typed load-failed when the provider refuses', () => {
    const opener = fakeOpener()
    opener.fail = 'no read grant for this process'
    const resolver = new ContentUriResolver(opener)
    try {
      resolver.resolve(AUDIO)
      expect.unreachable('resolve should have thrown')
    } catch (thrown) {
      expect(thrown).toBeInstanceOf(PlayerErrorException)
      const error = (thrown as PlayerErrorException).playerError
      expect(error.code).toBe('load-failed')
      // Not retryable: an expired grant or a deleted row answers the same way
      // every time, and the taxonomy says so rather than hoping.
      expect(error.retryable).toBe(false)
      expect(error.message).toContain(AUDIO)
      expect(error.message).toContain('no read grant')
    }
    // Nothing cached, so a later attempt (after the app re-takes the grant)
    // really does ask again.
    expect(resolver.openCount).toBe(0)
  })

  it('closes every descriptor on destroy, once', () => {
    const opener = fakeOpener()
    const resolver = new ContentUriResolver(opener)
    resolver.resolve(AUDIO)
    resolver.resolve(OTHER)
    resolver.destroy()
    expect(opener.closed).toEqual([8, 9])
    resolver.destroy()
    expect(opener.closed).toEqual([8, 9])
  })

  it('stops rewriting after destroy rather than handing out a closed fd', () => {
    const opener = fakeOpener()
    const resolver = new ContentUriResolver(opener)
    resolver.resolve(AUDIO)
    resolver.destroy()
    expect(resolver.resolve(AUDIO)).toBe(AUDIO)
    expect(opener.opened).toEqual([AUDIO])
  })

  it('bounds the descriptor table, closing the oldest', () => {
    const opener = fakeOpener()
    const resolver = new ContentUriResolver(opener)
    for (let index = 0; index <= CONTENT_URI_FD_LIMIT; index += 1) {
      resolver.resolve(`content://media/external/audio/media/${String(index)}`)
    }
    expect(resolver.openCount).toBe(CONTENT_URI_FD_LIMIT)
    // The first descriptor minted is the first released — and only it.
    expect(opener.closed).toEqual([8])
  })
})

describe('the built-in rewrite through the source-resolver seam', () => {
  let client: FakeMpvClient

  beforeEach(() => {
    client = new FakeMpvClient()
    setContentUriOpener(undefined)
  })

  /** Install a fake platform opener for the life of one test. */
  function installOpener(): ReturnType<typeof fakeOpener> {
    const opener = fakeOpener()
    setContentUriOpener(opener)
    return opener
  }

  it('is dormant until a content:// URI is actually loaded', async () => {
    installOpener()
    const player = await Player.create({ createClient: () => client })
    await player.load('https://example.com/a.mp3')
    // No `install`: mpv's load hooks stay answered natively, so an ordinary
    // player never crosses into JavaScript at a load boundary.
    expect(client.resolverCalls).toEqual([])
    player.destroy()
  })

  it('arms on the first content:// load and answers the hook with fd://', async () => {
    const opener = installOpener()
    const player = await Player.create({ createClient: () => client })
    await player.load(AUDIO)
    await settle()

    expect(client.resolverCalls.some((call) => call.kind === 'install')).toBe(
      true
    )
    expect(client.resolvedSources.get(AUDIO)).toBe('fd://8')
    expect(opener.opened).toEqual([AUDIO])
    player.destroy()
    // Ownership is the player's, and destroy is where it ends.
    expect(opener.closed).toEqual([8])
  })

  it('answers the play-time hook with the SAME url the prefetch pass got', async () => {
    installOpener()
    const player = await Player.create({ createClient: () => client })
    await player.load(AUDIO)
    await settle()

    // The prefetch pass carries an entryId; the play-time pass does not. Both
    // must produce the same string or mpv drops the prefetched stream.
    client.emitResolutionRequest({ uri: AUDIO, entryId: 1 })
    await settle()
    client.emitResolutionRequest({ uri: AUDIO })
    await settle()

    const answers = client.resolverCalls.filter(
      (call) => call.kind === 'complete'
    )
    expect(answers.length).toBeGreaterThanOrEqual(2)
    for (const answer of answers) {
      if (answer.kind !== 'complete') continue
      expect(answer.resolved).toBe('fd://8')
    }
    player.destroy()
  })

  it('composes with the app’s resolver instead of replacing it', async () => {
    installOpener()
    const seen: string[] = []
    const player = await Player.create({ createClient: () => client })
    player.setSourceResolver(({ uri }) => {
      seen.push(uri)
      // The documented contract for every resolver: a URI it did not mint goes
      // back unchanged.
      return uri.startsWith('library://') ? 'https://cdn/x.mp3' : uri
    })
    await player.load(AUDIO)
    await settle()

    expect(client.resolvedSources.get(AUDIO)).toBe('fd://8')
    // The built-in stage ran first, so what reached the app's resolver is
    // already the fd URL — which it passed through, as documented.
    expect(seen).toEqual(['fd://8'])
    player.destroy()
  })

  it('also rewrites a content:// URI the app’s resolver produced', async () => {
    installOpener()
    const player = await Player.create({ createClient: () => client })
    player.setSourceResolver(({ uri }) =>
      uri === 'library://track-1' ? AUDIO : uri
    )
    // `library://` does not arm the built-in by itself, so a resolver that can
    // produce a content URI needs the second pass to be armed some other way —
    // here, by the queue also holding one.
    await player.loadPlaylist([AUDIO, 'library://track-1'])
    await settle()

    // The SAME descriptor, because the app's resolver produced the same
    // document: the cache is keyed on the `content://` URI, not on the logical
    // one that led to it.
    expect(client.resolvedSources.get('library://track-1')).toBe('fd://8')
    player.destroy()
  })

  it('reports a provider failure on the typed error channel and lets mpv fail honestly', async () => {
    const opener = installOpener()
    opener.fail = 'no such document'
    const errors: unknown[] = []
    const player = await Player.create({ createClient: () => client })
    player.on('error', (error) => errors.push(error))
    await player.load(AUDIO)
    await settle()

    expect(errors).toHaveLength(1)
    expect(errors[0]).toMatchObject({ code: 'load-failed', uri: AUDIO })
    // Nothing cached, and mpv is handed nothing — it opens the logical URI and
    // fails on its own terms rather than being given a URL we do not trust.
    expect(client.resolvedSources.has(AUDIO)).toBe(false)
    player.destroy()
  })

  it('keeps the built-in armed when the app removes its own resolver', async () => {
    installOpener()
    const player = await Player.create({ createClient: () => client })
    player.setSourceResolver((request) => request.uri)
    await player.load(AUDIO)
    await settle()
    client.resolverCalls.length = 0

    player.setSourceResolver(null)

    // The app's resolver is gone; the rewrite it never asked for is not.
    expect(client.resolverCalls.some((call) => call.kind === 'uninstall')).toBe(
      false
    )
    client.emitResolutionRequest({ uri: AUDIO })
    await settle()
    const answer = client.resolverCalls.find(
      (call) => call.kind === 'complete'
    )
    expect(answer).toMatchObject({ resolved: 'fd://8' })
    player.destroy()
  })

  it('does nothing at all when the platform has no opener (iOS, older binary)', async () => {
    setContentUriOpener(undefined)
    const create = vi.fn(() => client)
    const player = await Player.create({ createClient: create })
    await player.load(AUDIO)
    // No hook armed, no rewrite, no throw: the URI reaches mpv unchanged and
    // fails the way it always did.
    expect(client.resolverCalls).toEqual([])
    expect(client.commands.at(-1)?.[1]).toBe(AUDIO)
    player.destroy()
  })
})
