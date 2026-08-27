# Recipe: a music player

Queue, gapless, lock screen, shuffle and repeat, artwork, and a session that
comes back after Android kills the process.

One module, imported for its side effects from `index.js`. That import is what
makes [playback
resumption](../../packages/media-session/README.md#playback-resumption-after-process-death)
possible.

```ts
// src/playback.ts
import { AppState } from 'react-native'
import { Player } from '@timbre/player'
import { AudioSession, AudioSessionPresets, wireAudioSession } from '@timbre/audio-session'
import {
  BaseMediaHandler,
  MediaService,
  applyPersisted,
  restorePersisted,
  withPersistence,
  type MediaItem,
  type MediaRepeatMode,
  type PersistedMediaService,
  type SessionError,
} from '@timbre/media-session'
import { storage, type Track } from './library'

let player: Player
let service: PersistedMediaService
let queue: readonly Track[] = []
let shuffleEnabled = false

const toItem = (t: Track): MediaItem => ({
  id: t.id,                      // the catalogue id — never `${id}-${index}`
  title: t.title,
  artist: t.artist,
  album: t.album,
  artworkUri: t.artworkUri,      // cover art comes from your library, not the file
  duration: t.durationMs,
})

class Handler extends BaseMediaHandler {
  override play(): void { player.play() }
  override pause(): void { player.pause() }
  override async stop(): Promise<void> { await player.stop() }   // queue survives
  override async seekTo(positionMs: number): Promise<void> {
    await player.seekTo(positionMs / 1000)                       // ms in, seconds out
  }
  override async skipToNext(): Promise<void> { await player.playlist.next() }
  override async skipToPrevious(): Promise<void> {
    await player.playlist.previous()          // restarts the track past 3 s
  }
  override async skipToQueueItem(index: number): Promise<void> {
    await player.playlist.jumpTo(index)
  }
  override onSetRepeatMode(mode: MediaRepeatMode): void {
    player.setLoop(mode === 'one' ? 'track' : mode === 'all' ? 'playlist' : 'off')
    broadcast()                               // a toggle moves nothing until you re-broadcast
  }
  override async onSetShuffle(enabled: boolean): Promise<void> {
    shuffleEnabled = enabled
    const byUri = new Map(queue.map((t) => [t.url, t]))
    const entries = enabled
      ? await player.playlist.shuffle()        // mpv permutes and hands back the new order
      : await player.playlist.unshuffle()      // one level of undo, and only one
    queue = entries.flatMap((e) => byUri.get(e.uri) ?? [])
    service.setQueue(queue.map(toItem))
    broadcast()
  }
  override onTaskRemoved(): void { service.save() }
  override onSessionError(error: SessionError): void {
    if (error.severity === 'fatal') console.error(`[session] ${error.code}`, error.message)
  }
}

function broadcast(): void {
  const s = player.state
  service.setPlaybackState({
    status: s.error ? 'error' : s.status === 'buffering' ? 'buffering'
          : s.playing ? 'playing' : 'paused',
    // An anchor, in milliseconds. Every surface projects value + elapsed × rate
    // locally, so the lock-screen scrubber moves with no bridge traffic.
    position: s.positionAnchorMs,
    controls: ['repeatMode', 'skipToPrevious', 'pause', 'skipToNext', 'shuffle'],
    capabilities: [
      'play', 'pause', 'stop', 'seek', 'skipToNext', 'skipToPrevious',
      'skipToQueueItem', 'setRepeatMode', 'setShuffle',
    ],
    compactControlIndices: [1, 2, 3],   // the ≤3 collapsed notification slots
    queueIndex: s.playlist.index,
    repeatMode: s.loop === 'track' ? 'one' : s.loop === 'playlist' ? 'all' : 'off',
    shuffleEnabled,
    errorMessage: s.error?.message,
  })
}

export async function start(): Promise<void> {
  player = await Player.create({
    prefetchPlaylist: true,
    replayGain: { mode: 'album', fallback: -6 },
  })

  wireAudioSession(player, {
    preset: AudioSessionPresets.music,  // configures the session; activating is still yours
    duckVolume: 0.3,
    resumeAfterInterruption: true,
  })

  service = withPersistence(
    await MediaService.init(() => new Handler(), {
      android: {
        notificationChannelId: 'playback',
        notificationChannelName: 'Playback',
        notificationIcon: 'ic_notification',
        notificationColor: 0xff1db954,   // ARGB — include the alpha byte
        playbackResumption: true,        // also needs the MediaButtonReceiver
      },
    }),
    storage,
  )

  player.onStateChange(broadcast)
  player.on('trackChanged', ({ index }) => {
    const track = queue[index]
    if (track !== undefined) service.setMediaItem(toItem(track))
  })

  // Autosave checkpoints every 30 s while playing. Android freezes JS timers
  // once the Activity is gone, which is the instant this fires.
  AppState.addEventListener('change', (next) => {
    if (next !== 'active') service.save()
  })

  const restored = await restorePersisted(storage)
  if (restored.status === 'restored') applyPersisted(service, restored.session)
  // Restored state is always paused. Resume from a user gesture, never here.
}

export async function playAlbum(tracks: readonly Track[], startIndex = 0): Promise<void> {
  queue = tracks
  await AudioSession.activate()                     // before play(), always
  service.setQueue(tracks.map(toItem))
  const first = tracks[startIndex]
  if (first !== undefined) service.setMediaItem(toItem(first))
  await player.loadPlaylist(tracks.map((t) => t.url), { startIndex })
}
```

```js
// index.js — the import is the requirement, not a nicety
import './src/playback'
import App from './App'
```

## An EQ screen over the same player

One hook carries the curve, the presets, the persistence and the single `af`
write.

```tsx
import { useEqualizer, type Player } from '@timbre/player'
import { Pressable, Text, View } from 'react-native'
import { Slider } from './ui'
import { storage } from './library'

export function EqualizerScreen({ player }: { player: Player | undefined }) {
  const eq = useEqualizer(player, { storage })      // omit `storage` for session-only
  return (
    <View>
      {eq.presets.map((p) => (
        <Pressable key={p.id} onPress={() => eq.applyPreset(p)}>
          <Text>{p.id === eq.preset?.id ? `● ${p.name}` : p.name}</Text>
        </Pressable>
      ))}
      {eq.bands.map((band, index) => (
        <Slider
          key={band.frequency}
          value={band.gainDb}
          minimumValue={eq.gainRangeDb.min}
          maximumValue={eq.gainRangeDb.max}
          onSlidingComplete={(db: number) => eq.setBandGain(index, db)}
        />
      ))}
    </View>
  )
}
```

## Constraints this shape runs into

| Constraint | What to do |
|---|---|
| `controls` are buttons in order; `capabilities` are the commands your handler services | Declare a capability for every control you ask for — media3 never invokes a handler for an undeclared command. [Detail](../../packages/media-session/README.md#broadcast-rules) |
| Commands are native-first | The notification's pause button moves the native state machine first and calls your handler after; nothing on any surface changes until your next `broadcast()` |
| `rate: 0` is how "paused" is expressed | `state.positionAnchorMs` applies it for you |
| `player.stop()` keeps the queue | mpv's own `stop` clears it; this library inverts the default. Pass `{ clearPlaylist: true }` for the destructive version |
| `MediaItem.id` is derived from the track | `restorePersisted` matches by id, so an id uniquified per insertion does not exist after a cold start. Duplicates in a queue are legal |
| `playbackResumption` needs a manifest half | media3's `MediaButtonReceiver`, or `["@timbre/media-session", { "playbackResumption": true }]` under Expo prebuild |

Full depth:
[persistence](../../packages/media-session/README.md#surviving-process-death-withpersistence) ·
[resumption](../../packages/media-session/README.md#playback-resumption-after-process-death) ·
[filters and EQ](../../packages/player/README.md#audio-filters-and-eq).
