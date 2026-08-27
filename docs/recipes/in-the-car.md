# Recipe: in the car

Android Auto and CarPlay are the same feature seen twice: a **tree** the car
browses and a **tap** that plays. One handler serves both. Nothing here is
platform-specific except the two lines of iOS config at the end.

```tsx
import { Player } from '@afkcodes/timbre-player'
import {
  BaseMediaHandler, BrowseError, BROWSE_ROOT, MediaService, useCarConnection,
  type BrowseItem, type MediaItem, type SearchFocus,
} from '@afkcodes/timbre-media-session'

const player = await Player.create({ prefetchPlaylist: true })

const toMediaItem = (t: {
  id: string; title: string; artist: string; coverUrl: string
}): MediaItem => ({ id: t.id, title: t.title, artist: t.artist, artworkUri: t.coverUrl })

class Handler extends BaseMediaHandler {
  // The root's children are the car's tabs: at most four, browsable only.
  async getChildren(parentId: string): Promise<BrowseItem[]> {
    if (!(await auth.isSignedIn())) {
      // The car draws its sign-in screen, with a button that opens this URL.
      throw new BrowseError('authenticationExpired', 'Sign in to browse your library',
        { label: 'Sign in', url: 'myapp://signin' })
    }
    if (parentId === BROWSE_ROOT) {
      return [
        { id: 'albums', title: 'Albums', browsable: true, childStyle: 'grid', mediaType: 'folderAlbums' },
        { id: 'artists', title: 'Artists', browsable: true, mediaType: 'folderArtists' },
        { id: 'recent', title: 'Recent', browsable: true },
      ]
    }
    if (parentId === 'albums') {
      return (await catalogue.albums()).map((a) => ({
        id: `album:${a.id}`, title: a.title, subtitle: a.artist,
        artworkUri: a.coverUrl,           // https is served to Auto via content:// for you
        browsable: true, playable: true,  // opens the track list and plays from the top
      }))
    }
    if (parentId.startsWith('album:')) {
      return (await catalogue.tracks(parentId.slice(6))).map((t) => ({
        id: `track:${t.id}`, title: t.title, subtitle: t.artist,
        artworkUri: t.coverUrl, playable: true, explicit: t.explicit,
      }))
    }
    return []                       // an unknown parent is an empty list, never an error
  }

  // The car tapped something playable (or voice picked it). Build the queue,
  // broadcast, play — your next broadcast is the acknowledgement.
  async playFromMediaId(id: string) {
    const tracks = id.startsWith('album:')
      ? await catalogue.tracks(id.slice(6))
      : [await catalogue.track(id.slice(6))]
    await player.loadPlaylist(tracks.map((t) => t.streamUrl))
    service.setQueue(tracks.map(toMediaItem))
    player.play()
  }

  // "Play some jazz" — Android Auto / Assistant. `query` can be '' ("play something").
  async playFromSearch(query: string, focus: SearchFocus) {
    const [hit] = query === '' ? await catalogue.recent(1) : await catalogue.search(query, focus)
    if (hit !== undefined) await this.playFromMediaId(`track:${hit.id}`)
  }

  // Auto's search tab. CarPlay audio apps have no search template, so iOS never calls it.
  async search(query: string): Promise<BrowseItem[]> {
    return (await catalogue.search(query)).map((t) => ({
      id: `track:${t.id}`, title: t.title, subtitle: t.artist, playable: true,
    }))
  }
}

const service = await MediaService.init(() => new Handler())

// A download finished, the library synced — tell the car that list is stale.
downloads.on('complete', () => service.invalidateBrowse('recent'))

// In the UI: hide the mini-player while the car is driving playback.
function MiniPlayer() {
  const car = useCarConnection()          // { kind: 'none' | 'androidAuto' | 'automotiveOs' | 'carPlay' }
  return car.kind === 'none' ? <Bar /> : null
}
```

## Setup

| Platform | What you add |
|---|---|
| Android | Nothing. The car manifest entry merges from the library |
| iOS | A UIScene app and Apple's `com.apple.developer.carplay-audio` entitlement. Expo: `["@afkcodes/timbre-media-session", { "carPlay": true }]`. Bare: the two snippets in the [package README](../../packages/media-session/README.md#carplay) |

## Constraints this shape runs into

| Constraint | What to do |
|---|---|
| The root is at most four browsable items | Extra or playable root entries are dropped and reported as `browseRootRejected` |
| Artwork must be `content://` on Android | Pass an ordinary `https://` URL; the package downloads, downscales and serves it |
| A browse error is a screen, not an exception | Throw `BrowseError` and the car draws its sign-in or upgrade screen |
| A tap is `playFromMediaId`, never `play` | The duplicate `play()` media3 synthesises after a browse tap is swallowed |
| `search` is never called on iOS | CarPlay audio apps have no search template. A missing surface, not a missing feature |
| Cold browse from a killed process needs `android.playbackResumption: true` | Without it the car sees the last cached lists until the app is opened |

Field-by-field rendering, the car's own rules and the Desktop Head Unit setup:
[Android Auto](../../packages/media-session/README.md#android-auto) ·
[CarPlay](../../packages/media-session/README.md#carplay).
