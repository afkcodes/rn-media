# Recipe: cast to a speaker

Casting is a URL handoff, not an output route: mpv can never *be* the thing
driving a Chromecast, so `@afkcodes/timbre-cast` pauses your player, hands the receiver
the queue as URLs, and lets it fetch and decode them. Every surface keeps
rendering from the same three `media-session` channels, now mirroring the
receiver instead of mpv.

```tsx
import { Player } from '@afkcodes/timbre-player'
import {
  Cast, CastButton, useIsCasting, wireCastHandoff,
  type CastHandoffQueueItem, type CastReceiverSnapshot,
} from '@afkcodes/timbre-cast'

const player = await Player.create()
let currentIndex = 0
const items: CastHandoffQueueItem[] = (await catalogue.tracks('album:1')).map((t) => ({
  id: t.id,
  url: t.streamUrl,        // what the receiver fetches — resolve signed URLs here
  mimeType: 'audio/mpeg',
  metadata: { title: t.title, artist: t.artist, artworkUrl: t.coverUrl },
}))

// The same three channels, now fed by the receiver instead of mpv. `at` is the
// receiver's anchor timestamp: project it locally, never poll.
const publishReceiverState = (s: CastReceiverSnapshot): void =>
  service.setPlaybackState({
    status: s.playing ? 'playing' : 'paused',
    position: { value: Math.round(s.position * 1000), at: s.at, rate: s.rate },
    queueIndex: s.itemIndex,
    capabilities: ['play', 'pause', 'seek', 'skipToNext', 'skipToPrevious'],
  })

const handoff = wireCastHandoff(
  // Structural on both sides — the adapter imports nothing from @afkcodes/timbre-player.
  { play: () => player.play(), pause: () => player.pause(), seekTo: (s) => player.seekTo(s),
    skipToIndex: (i) => player.playlist.jumpTo(i, { autoPlay: false }),
    getPosition: () => player.getPosition(), isPlaying: () => player.state.playing },
  { snapshot: () => ({ items, index: currentIndex, position: player.getPosition(),
                       playWhenReady: player.state.playing }),
    onReceiverState: publishReceiverState,
    onItemsSkipped: (skipped) => console.warn(`${skipped.length} track(s) cannot cast`) },
)

const [device] = await Cast.getCastDevices()
if (device !== undefined) await handoff.castTo(device.id)  // or the user taps the
await handoff.stopCasting()   // button below — same machine. Back to local, at the
                              // receiver's position.

function CastRow() {
  const casting = useIsCasting()   // 'transferring' counts — no flicker mid-transfer
  return <CastButton style={{ width: 32, height: 32 }}
                     tintColor={casting ? '#1db954' : '#e7e7ea'} />
}
```

## Setup

| Platform | What you add |
|---|---|
| Android | A `meta-data` block in the manifest, or one Expo plugin entry |
| iOS | Two `Info.plist` keys, `platform :ios, '16.0'`, and Xcode 26+ to build |

## Constraints this shape runs into

| Constraint | What to do |
|---|---|
| The receiver decodes far less than mpv | Ask `canCastMedia(item)` per track and grey the route out, instead of failing at load |
| `service.setRemotePlayback({ volume })` declares playback remote | It points the app's volume control and the hardware keys at the receiver on Android; on iOS it is a documented no-op |
| `<CastButton/>` is the platform's own button | On Android 13+ a tap opens the system output switcher; it hides itself when there is nothing to cast to |
| The handoff lives in `@afkcodes/timbre-cast` | `media-session` stays player-agnostic and cast-free in both directions |
| Header auth does not travel | The Default Media Receiver cannot attach headers. Signed-query URLs work |

Codec ceilings, live-stream rules and every failure mode:
[`@afkcodes/timbre-cast`](../../packages/cast/README.md) ·
[design doc](../design/cast.md).
