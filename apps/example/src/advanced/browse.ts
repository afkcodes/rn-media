/**
 * The car browse tree — what Android Auto and CarPlay show when this app is
 * opened in a car.
 *
 * Data and pure functions only. It knows the demo catalogue and nothing about
 * the player, which is what lets it be unit-tested in Node and what makes the
 * *shape* of the answer — four tabs, browsable-only roots, ids the car hands
 * back verbatim — the visible part of the demo.
 *
 * ## What "play" means in this app, and why
 * `car.md` §4 describes `playFromMediaId` as building the queue from the tapped
 * node. This app deliberately does the smaller thing — it **jumps within the
 * queue it already has** — because its queue is not a library: `engine.ts`
 * hands mpv one playlist (`TRACKS`) at startup, and three other subsystems are
 * indexed against it (the `QueueMirror` mirrors mpv's playlist, persistence
 * restores an *index* into it, the cast handoff copies it entry by entry).
 * Rebuilding it on every browse tap would demo a queue-management story this
 * app does not have, and break three that it does. The browse tree is
 * therefore a set of *views* over the demo queue, which is the honest shape for
 * a fixed catalogue — and the library contract being exercised (ids out, id
 * back, app decides what plays, broadcast acknowledges) is identical either
 * way.
 */
import { BROWSE_ROOT, BrowseError, type BrowseItem } from '@afkcodes/timbre-media-session'
import { TRACKS, type Track } from '../data/tracks'

/** Tab ids. Opaque to the car; meaningful only here. */
export const LIBRARY = 'library'
export const ALBUMS = 'albums'
export const ARTISTS = 'artists'
export const RECENT = 'recent'

const ALBUM_PREFIX = 'album:'
const ARTIST_PREFIX = 'artist:'
const TRACK_PREFIX = 'track:'

/** How many entries the Recent tab shows. */
const RECENT_LIMIT = 6

export function trackId(track: Track): string {
  return TRACK_PREFIX + track.id
}

/** The `TRACKS` entry a browse id points at, or `undefined`. */
export function trackFor(id: string): Track | undefined {
  if (!id.startsWith(TRACK_PREFIX)) return undefined
  const key = id.slice(TRACK_PREFIX.length)
  return TRACKS.find((track) => track.id === key)
}

/** Its index in the loaded queue — what `playFromMediaId` jumps to. */
export function queueIndexFor(id: string): number | undefined {
  const direct = TRACKS.findIndex((track) => trackId(track) === id)
  if (direct !== -1) return direct
  // An album or artist node plays from its first entry, which is what tapping
  // a folder means on both platforms.
  const first = childrenOf(id)[0]
  if (first === undefined) return undefined
  const nested = TRACKS.findIndex((track) => trackId(track) === first.id)
  return nested === -1 ? undefined : nested
}

/* -------------------------------------------------------------------------- */
/*                                  The tree                                  */
/* -------------------------------------------------------------------------- */

function albumsOf(): string[] {
  return [...new Set(TRACKS.map((track) => track.album ?? 'Unknown album'))]
}

function artistsOf(): string[] {
  return [...new Set(TRACKS.map((track) => track.artist ?? 'Unknown artist'))]
}

function toBrowseItem(track: Track): BrowseItem {
  return {
    id: trackId(track),
    title: track.title,
    subtitle: track.artist,
    artworkUri: track.artworkUri,
    playable: true,
    // The library serves https covers; the Android half rewrites them to its
    // own `content://` provider, because Auto renders nothing else.
    mediaType: track.isLive === true ? 'radioStation' : 'music',
  }
}

/**
 * The four root tabs.
 *
 * Exactly four, and all four browsable — the cap the library enforces (and
 * reports) is `MAX_ROOT_TABS`, and a fifth here would be dropped with a
 * `browseRootRejected` session error. Kept at the limit on purpose: it is the
 * shape a real music app ships, and the one the DHU pass checks.
 */
function rootTabs(): BrowseItem[] {
  return [
    {
      id: LIBRARY,
      title: 'Library',
      browsable: true,
      mediaType: 'folderMixed',
      childStyle: 'list',
    },
    {
      id: ALBUMS,
      title: 'Albums',
      browsable: true,
      mediaType: 'folderAlbums',
      // The one grid in the tree: album art is the point of an album list, and
      // it is what proves the `content://` artwork provider on a head unit.
      childStyle: 'grid',
    },
    {
      id: ARTISTS,
      title: 'Artists',
      browsable: true,
      mediaType: 'folderArtists',
      childStyle: 'list',
    },
    {
      id: RECENT,
      title: 'Recent',
      browsable: true,
      mediaType: 'folderMixed',
      childStyle: 'list',
    },
  ]
}

/**
 * The children of any node, with no I/O and no player.
 *
 * @param recent ids most recently played, newest first — see
 * {@link noteRecentlyPlayed}.
 */
export function childrenOf(
  parentId: string,
  recent: readonly string[] = recentlyPlayed
): BrowseItem[] {
  if (parentId === BROWSE_ROOT) return rootTabs()

  if (parentId === LIBRARY) return TRACKS.map(toBrowseItem)

  if (parentId === ALBUMS) {
    return albumsOf().map((album) => ({
      id: ALBUM_PREFIX + album,
      title: album,
      subtitle: TRACKS.find((track) => track.album === album)?.artist,
      artworkUri: TRACKS.find((track) => track.album === album)?.artworkUri,
      browsable: true,
      // Browsable *and* playable: tapping the row plays the album, tapping the
      // chevron opens it. Both cars allow it, and it is the behaviour a driver
      // expects from an album.
      playable: true,
      mediaType: 'folderAlbums',
    }))
  }

  if (parentId === ARTISTS) {
    return artistsOf().map((artist) => ({
      id: ARTIST_PREFIX + artist,
      title: artist,
      subtitle: `${TRACKS.filter((track) => track.artist === artist).length} tracks`,
      browsable: true,
      playable: true,
      mediaType: 'folderArtists',
    }))
  }

  if (parentId === RECENT) {
    return recent
      .slice(0, RECENT_LIMIT)
      .map((id) => trackFor(id))
      .filter((track): track is Track => track !== undefined)
      .map(toBrowseItem)
  }

  if (parentId.startsWith(ALBUM_PREFIX)) {
    const album = parentId.slice(ALBUM_PREFIX.length)
    return TRACKS.filter((track) => (track.album ?? 'Unknown album') === album).map(
      toBrowseItem
    )
  }

  if (parentId.startsWith(ARTIST_PREFIX)) {
    const artist = parentId.slice(ARTIST_PREFIX.length)
    return (
      TRACKS.filter((track) => (track.artist ?? 'Unknown artist') === artist)
        // One heading per album, which is what `group` is for — and it groups a
        // *run*, not a set: contiguous items sharing it are drawn under one
        // header, so `[a, a, b, a]` renders three.
        .map((track) => ({ ...toBrowseItem(track), group: track.album }))
    )
  }

  return []
}

/** One node by id, for `getMediaItem`. */
export function itemFor(id: string): BrowseItem | undefined {
  const track = trackFor(id)
  if (track !== undefined) return toBrowseItem(track)
  return rootTabs()
    .concat(childrenOf(ALBUMS), childrenOf(ARTISTS))
    .find((item) => item.id === id)
}

/**
 * Substring match over title and artist — the demo's stand-in for a real
 * catalogue query.
 *
 * An empty query answers everything: that is what Assistant sends for "play
 * music", and an empty result there would be a worse answer than the whole
 * library.
 */
export function searchTracks(query: string): BrowseItem[] {
  const needle = query.trim().toLowerCase()
  if (needle === '') return TRACKS.map(toBrowseItem)
  return TRACKS.filter((track) =>
    [track.title, track.artist, track.album]
      .filter((value): value is string => typeof value === 'string')
      .some((value) => value.toLowerCase().includes(needle))
  ).map(toBrowseItem)
}

/* -------------------------------------------------------------------------- */
/*                          Recent, and the sign-in demo                      */
/* -------------------------------------------------------------------------- */

let recentlyPlayed: string[] = []

/** Newest first, de-duplicated, bounded. */
export function noteRecentlyPlayed(id: string): void {
  const track = trackFor(id) ?? trackFor(childrenOf(id)[0]?.id ?? '')
  if (track === undefined) return
  const key = trackId(track)
  recentlyPlayed = [key, ...recentlyPlayed.filter((it) => it !== key)].slice(
    0,
    RECENT_LIMIT
  )
}

export function recentIds(): readonly string[] {
  return recentlyPlayed
}

let signInRequired = false

/**
 * The "Simulate sign-in required" toggle.
 *
 * The one browse behaviour that cannot be demonstrated by browsing: a car's
 * error screen, with a resolution button that opens the phone. Android Auto
 * renders it because `authenticationExpired` is one of the two codes media3
 * replicates into the platform playback state — see `BrowseError`'s docs for
 * the other three, which show as an empty list there and as an alert on
 * CarPlay.
 */
export function setSignInRequired(required: boolean): void {
  signInRequired = required
}

export function isSignInRequired(): boolean {
  return signInRequired
}

/** Throws when the toggle is on. Called at the top of every browse method. */
export function assertSignedIn(): void {
  if (!signInRequired) return
  throw new BrowseError(
    'authenticationExpired',
    'Your session has expired. Sign in on your phone to browse your library.',
    { label: 'Sign in', url: 'rnmedia://signin' }
  )
}
