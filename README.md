# rn-media

[![Android CI](https://img.shields.io/github/actions/workflow/status/afkcodes/rn-media/android-build.yml?branch=main&label=Android%20CI&logo=android&logoColor=white)](https://github.com/afkcodes/rn-media/actions/workflows/android-build.yml)
[![iOS CI](https://img.shields.io/github/actions/workflow/status/afkcodes/rn-media/ios-build.yml?branch=main&label=iOS%20CI&logo=apple&logoColor=white)](https://github.com/afkcodes/rn-media/actions/workflows/ios-build.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![React Native ≥ 0.82](https://img.shields.io/badge/React%20Native-%E2%89%A5%200.82-61dafb?logo=react&logoColor=white)](#requirements)

**React Native audio playback built on [libmpv](https://mpv.io), with a
player-agnostic media-session layer** — lock screen, notification, Bluetooth and
background playback that keep working after the app's UI is gone. Independent
packages, no cross-dependencies: a libmpv player, an audio-focus arbiter, a media
session that drives lock screens for *any* player, and a Chromecast sender.
Powered by [Nitro Modules](https://nitro.margelo.com) — the C++ core binds
libmpv's client API directly, no bridge layer. Lineage: Flutter's
[`audio_service`](https://pub.dev/packages/audio_service) /
[`audio_session`](https://pub.dev/packages/audio_session) / media-kit.

> **Status: v0.1, pre-release — nothing is on npm yet.** The install line below is
> what it will be; today the packages are consumed from this workspace (see
> [Roadmap](#roadmap)). The Android stack is verified end-to-end on a physical
> device — audio output, notification controls round-tripping to JS, playback
> surviving Activity destruction, and the whole session coming back from a process
> the OS had killed. iOS is **built by CI** and its shipped binaries are inspected
> assertion-by-assertion, but it has never run on a device. APIs may still change.

<p align="center">
  <img src="docs/assets/demo.gif" width="330"
       alt="The example app: a live Shoutcast stream with ICY now-playing, the same session in the notification shade and on the lock screen, then seeking, an EQ preset and stop." /><br>
  <sub><a href="apps/example">The example app</a> on a physical Android 16 device — live Shoutcast → notification
  shade → lock screen, whose play button drives the same handler → seek → EQ
  preset → stop. <a href="docs/assets/demo.mp4">Source video</a>.</sub>
</p>

## Quick start

```sh
npm install @rn-media/player @rn-media/audio-session @rn-media/media-session react-native-nitro-modules
cd ios && pod install   # downloads + verifies the pinned libmpv xcframeworks
```

```ts
import { Player } from '@rn-media/player'
import { BaseMediaHandler, MediaService } from '@rn-media/media-session'

const track = { id: 'a1', title: 'Anthem', url: 'https://cdn.example/1.flac', durationMs: 214_000 }
const next = { id: 'a2', title: 'Coda', url: 'https://cdn.example/2.flac', durationMs: 190_000 }

const player = await Player.create({ prefetchPlaylist: true })
await player.loadPlaylist([track.url, next.url])   // one mpv playlist — gapless
player.play()                                      // …and that is audio playing

class Handler extends BaseMediaHandler {           // every remote surface lands here
  // onSetRepeatMode, onSetShuffle, onSleepTimer, customAction: all defaulted.
  override play() { player.play() }
  override pause() { player.pause() }
  override async seekTo(ms: number) { await player.seekTo(ms / 1000) }
  override async skipToNext() { await player.playlist.next() }
  override async skipToPrevious() { await player.playlist.previous() }
}
const service = await MediaService.init(() => new Handler(), {
  android: { notificationChannelId: 'playback', notificationChannelName: 'Playback' },
})
service.setMediaItem({ id: track.id, title: track.title, duration: track.durationMs })
player.onStateChange((s) => service.setPlaybackState({
  status: s.playing ? 'playing' : 'paused',
  // A position ANCHOR in ms, not a stream: every surface projects it locally.
  position: { value: player.getPosition() * 1000, at: Date.now(), rate: s.playing ? s.rate : 0 },
  controls: ['skipToPrevious', 'pause', 'skipToNext'],
  capabilities: ['play', 'pause', 'seek', 'skipToNext', 'skipToPrevious'],
}))
```

That is a gapless queue on the lock screen and in the notification shade.
[Setup](#requirements) is one `Info.plist` key on iOS and nothing on Android.
The four [recipes](#recipes) below take this to whole apps — persistence, focus,
live streams, chapters, signed URLs — and the [API](#api) lists every export.

## Which packages do I need?

They are four separate installs with no dependencies on each other. Take the rows
that describe your app and ignore the rest.

| You want | Install |
|---|---|
| Audio playback, a gapless queue, EQ, chapters, a visualizer | [`@rn-media/player`](packages/player/README.md) |
| …that keeps playing in the background, on the lock screen and in the notification | **+** [`@rn-media/media-session`](packages/media-session/README.md) |
| …that ducks for navigation prompts, pauses for calls and stops when the headphones come out | **+** [`@rn-media/audio-session`](packages/audio-session/README.md) |
| …that can hand off to a Chromecast | **+** [`@rn-media/cast`](packages/cast/README.md) |
| …that the car can browse — Android Auto tabs, CarPlay templates, voice "play X" | already in `media-session`: implement `getChildren` + `playFromMediaId` ([recipe](#in-the-car)) |
| A lock screen for a player that is **not** ours — RNTP, `expo-audio`, a TTS engine | `media-session` **alone** |
| Focus / interruption handling for someone else's player | `audio-session` **alone** |

Both session packages take their player through a *structural* interface, so
nothing forces you to adopt the engine to use the session layer, or the other way
round.

## Why this exists

| | [track-player](https://rntp.dev) | [expo-audio](https://docs.expo.dev/versions/latest/sdk/audio/) | [rn-video](https://github.com/TheWidlarzGroup/react-native-video) | [queue-player](https://ghenry22.github.io/react-native-queue-player/) | **rn-media** |
|---|---|---|---|---|---|
| Engine | ExoPlayer / AVPlayer | ExoPlayer / AVPlayer | ExoPlayer / AVPlayer | not documented | **libmpv 0.41.0 + FFmpeg 8.1.2 — our own build** |
| One identical engine on both platforms | ❌ two engines | ❌ | ❌ | — | ✅ 103 mpv options a side, **101 identical** (the two that differ are the platform's audio device) |
| Formats | platform codecs | platform codecs | platform codecs | not documented | everything FFmpeg decodes — MP3, AAC/M4A, FLAC, OGG/Opus, HLS, ICY/Icecast, TrueHD, legacy-charset tags |
| Multiple players | ❌ singleton | ✅ | ✅ | ❌ singleton | ✅ one mpv core each |
| Session layer works with *any* player | ❌ | ❌ | ❌ | ❌ | ✅ (`@rn-media/media-session` is player-agnostic) |
| Gapless queue | ⚠️ | ✅ | ❌ | ✅ | ✅ 25 ms handover, measured on-device |
| Signed / expiring URLs stay gapless | ❌ | ❌ | ❌ | ❌ | ✅ resolver runs at **prefetch** time — our own mpv patch |
| EQ / DSP | ❌ | ❌ | ❌ | ✅ 10-band | ✅ 16 ffmpeg filters, 22 tuned EQ presets |
| Casting (Chromecast / AirPlay) | ❌ (V5, commercial: Chromecast/Android + AirPlay/iOS, platform-split) | ❌ | ❌ app-side | ✅ | ✅ Chromecast, both platforms — session handoff, receiver-side queue, live streams; Android device-verified, iOS CI-verified |
| Android Auto / CarPlay | ⚠️ controls only — no browse tree, no play-from-search ([source](docs/comparison.md#android-auto)) | ❌ | ❌ | ✅ | ✅ browse tree + voice on Auto, CarPlay templates (Auto device pass pending — see ARCHITECTURE §31) |
| DRM (Widevine/FairPlay) | ⚠️ announced | ❌ | ✅ | not documented | ❌ libmpv cannot ([Limitations](#limitations)) |
| Native binary it adds | ≈none (platform codecs) | ≈none | ≈none | — | 3.63 MB downloaded for `arm64-v8a`, ≈7.1 MB for the iOS device slice ([Requirements](#requirements)) |

The other eight rows — background sessions, headers, pitch, chapters, sleep timer,
visualizer, crossfade, remote volume — and the sourcing for every cell are in
**[docs/comparison.md](docs/comparison.md)**. It adds up to music apps with
**non-DRM audio**: indie catalogs, self-hosted libraries, podcasts, radio,
audiobooks. The row we pay for is the last one.

Different job:
[`react-native-audio-api`](https://github.com/software-mansion/react-native-audio-api)
implements the **Web Audio API**, an audio *graph* for synthesis and per-sample
DSP — a paradigm this library does not attempt, and one that composes with it,
since `@rn-media/media-session` takes any player structurally.

## Recipes

Four apps, not four snippets. Each one is code that runs; the caveats under it are
only the ones that bite in *that* shape of app.

### A music player

Queue, gapless, lock screen, shuffle + repeat, artwork, and a session that comes
back after Android kills the process. One module, imported for its side effects
from `index.js` — which is [what makes playback resumption
possible](packages/media-session/README.md#playback-resumption-after-process-death).

```ts
// src/playback.ts
import { AppState } from 'react-native'
import { Player } from '@rn-media/player'
import { AudioSession, AudioSessionPresets, wireAudioSession } from '@rn-media/audio-session'
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
} from '@rn-media/media-session'
import { storage, type Track } from './library'

let player: Player
let service: PersistedMediaService
let queue: readonly Track[] = []
let shuffleEnabled = false

const toItem = (t: Track): MediaItem => ({
  id: t.id,                      // the CATALOGUE id — never `${id}-${index}`
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
    await player.playlist.previous()          // restarts the track past 3 s, like ⏮ should
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
      ? await player.playlist.shuffle()        // mpv permutes; it hands back the new order
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
    // An ANCHOR, in milliseconds. Every surface projects value + elapsed × rate
    // locally, so the lock-screen scrubber moves with zero bridge traffic.
    position: {
      value: Math.round(player.getPosition() * 1000),
      at: Date.now(),
      rate: s.playing ? s.rate : 0,
    },
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
    prefetchPlaylist: true,             // 25 ms handover instead of 644 ms + an underrun
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
        playbackResumption: true,        // needs the MediaButtonReceiver, see below
      },
    }),
    storage,
  )

  player.onStateChange(broadcast)
  player.on('trackChanged', ({ index }) => {
    const track = queue[index]
    if (track !== undefined) service.setMediaItem(toItem(track))
  })

  // Autosave checkpoints every 30 s while playing — but Android freezes JS
  // timers once the Activity is gone, and this fires at exactly that instant.
  AppState.addEventListener('change', (next) => {
    if (next !== 'active') service.save()
  })

  const restored = await restorePersisted(storage)
  if (restored.status === 'restored') applyPersisted(service, restored.session)
  // Restored state is always PAUSED. Resume from a user gesture, never from here.
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

An EQ screen over the same player is one hook — the curve, the presets, the
persistence and the single `af` write:

```tsx
import { useEqualizer, type Player } from '@rn-media/player'
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

**What bites here.** `controls` are the buttons you want, in order;
`capabilities` are the commands your handler will service, and media3 never
invokes a handler for one you did not declare. Commands are **native-first**: the
notification's pause button moves the native state machine first and calls your
handler after, so nothing on any surface changes until your next `broadcast()` —
and `rate: 0` is how "paused" is expressed. `player.stop()` keeps the queue (mpv's
own `stop` clears it; we inverted the default). `MediaItem.id` must be derived
from the track, never uniquified per insertion — `restorePersisted` matches by id,
and `track-7#2` does not exist after a cold start. `playbackResumption` also needs
media3's `MediaButtonReceiver` in your manifest (or `["@rn-media/media-session",
{ "playbackResumption": true }]` under Expo prebuild). Full depth:
[controls vs capabilities](packages/media-session/README.md#controls-vs-capabilities) ·
[persistence](packages/media-session/README.md#surviving-process-death-withpersistence) ·
[resumption](packages/media-session/README.md#playback-resumption-after-process-death) ·
[filters and EQ](packages/player/README.md#audio-filters-and-eq).

### A radio app

Live streams have no duration, no scrubber and no end — and a server that hangs up
is not the same event as a song finishing. All three are first-class here.

```ts
import { Player, type Metadata } from '@rn-media/player'
import { BaseMediaHandler, MediaService, type MediaItem } from '@rn-media/media-session'

const player = await Player.create({
  // Real Shoutcast hosts 401 the literal `libmpv`, which is why the default UA
  // is `rn-media (libmpv)`. Say who you are anyway.
  userAgent: 'MyRadio/1.0 (+https://example.com)',
  cacheSecs: 30,                                 // mpv's own default is ~1000 HOURS
  networkReconnect: { maxDelaySeconds: 20 },     // native, inside libavformat
  retry: { maxAttempts: 3, retryLiveEof: true }, // re-attempt a POLITE hang-up too
})

// Three commands is the whole handler: a station has nowhere to skip to.
class Handler extends BaseMediaHandler {
  override play(): void { player.play() }
  override pause(): void { player.pause() }
  override async stop(): Promise<void> { await player.stop() }
}
const service = await MediaService.init(() => new Handler(), {
  android: { notificationChannelId: 'radio', notificationChannelName: 'Radio' },
})

await player.load(station.url)
player.play()

// The song on air. mpv folds ICY `StreamTitle` into `media-title`, so it rides
// PlayerState — which means it reaches the notification and the lock screen.
player.onStateChange((s) => {
  const item: MediaItem = {
    id: station.id,
    title: s.title ?? station.name,   // the song, when the station sends one
    artist: s.title === undefined ? undefined : station.name,
    artworkUri: station.logoUri,
    isLive: true,                     // drops the scrubber even if a duration shows up
  }
  service.setMediaItem(item)
  service.setPlaybackState({
    status: s.playing ? 'playing' : s.status === 'buffering' ? 'buffering' : 'paused',
    position: { value: 0, at: Date.now(), rate: 0 },   // live: there is no position
    controls: [s.playing ? 'pause' : 'play', 'stop'],
    capabilities: ['play', 'pause', 'stop'],           // no 'seek' — nothing to seek to
  })
})

// The STATION, as opposed to the song: a separate route, and opt-in because
// building the tag map is a read into mpv's core.
player.on('metadataChanged', (tags: Metadata) => {
  setStationLine(tags['icy-name'], tags['icy-genre'], tags['icy-br'])
})

// A retry is not a failure. `retrying` fires while NO `error` event does.
player.on('retrying', ({ attempt, maxAttempts }) => banner(`Reconnecting ${attempt}/${maxAttempts}`))
player.on('error', (e, { attempts }) => banner(`Gave up after ${attempts}: ${e.message}`))
```

**What bites here.** `state.isLive` is `true` and `state.duration` is `undefined`
— mpv's perpetually-growing cache length is suppressed rather than published as a
duration, so a scrubber never appears and never lies. `useProgress` still works;
its `duration` is simply `undefined`. Position `0` is the honest anchor: an offset
into a live stream has nothing to seek back to, which is also why
[persistence saves `0` for a live entry](packages/media-session/README.md#the-position-is-always-restored-paused).
Reconnection is two layers with different jobs: FFmpeg's native retry (attempts at
0 s, 1 s and 3 s under the default `maxDelaySeconds: 5`) answers "can this
connection be re-made", and the player's `retry` answers "should the queue move
on". `retryLiveEof` is the third case — a server that closes *cleanly*, which
neither layer treats as an error by default because on a finite file the clean
close **is** the end of the track. `MediaItem.isLive: true` is what drops the
scrubber on both platforms;
[ICY, both routes](packages/player/README.md#two-routes-to-a-title-and-which-one-you-want) ·
[network failures](packages/player/README.md#recovering-from-network-failures).

### A podcast / audiobook player

Chapters, speed, ±30 s, a sleep timer that survives the screen going off, and
resuming exactly where the listener stopped.

```ts
import { Player } from '@rn-media/player'
import { BaseMediaHandler, MediaService, type MediaServiceApi } from '@rn-media/media-session'

const player = await Player.create({ rate: 1.0 })

class Handler extends BaseMediaHandler {
  override play(): void { player.play() }
  override pause(): void { player.pause() }
  override async seekTo(ms: number): Promise<void> { await player.seekTo(ms / 1000) }
  override setRate(rate: number): void { player.setRate(rate) }   // the lock-screen rate control
  override onSleepTimer(): void { clearBadge() }  // already paused — this is a notification
}

const service: MediaServiceApi = await MediaService.init(() => new Handler(), {
  jumpForwardSeconds: 30,     // BOTH platforms; resolved natively into an absolute
  jumpBackwardSeconds: 15,    // seek, so there is no jump handler to write
  ios: { supportedPlaybackRates: [0.8, 1, 1.25, 1.5, 1.75, 2] },
  android: { notificationChannelId: 'podcast', notificationChannelName: 'Podcasts' },
})

// Resume where they stopped. `startPosition` is seconds, applied by mpv at open —
// not a seek after the fact, so there is no audible jump.
await player.load(episode.url, { startPosition: progress.get(episode.id) ?? 0 })

// Chapters come from the file (m4b, chaptered MP3/Opus) and need no parsing.
const chapters = player.getChapters()            // [{ title?, start }] — start is seconds
player.on('chapterChanged', ({ index }) => setChapterUi(index))
function jumpToChapter(i: number): void { player.setChapter(i) }

// Speed is pitch-corrected and composes with everything: mpv's scaletempo2 sits
// downstream of the filter chain, and ReplayGain is volume-domain.
function setSpeed(rate: number): void { player.setRate(rate) }

// ±30 s from your OWN UI. seekBy is immune to projection error — use it for
// buttons rather than getPosition() + 30.
const forward = () => player.seekBy(30)
const back = () => player.seekBy(-15)

// Two sleep-timer modes, both on a NATIVE timer, because a JS timer stops firing
// once the Activity is gone — which is exactly when a sleep timer matters.
service.setSleepTimer(30 * 60)      // pause in 30 minutes
service.setSleepTimerToTrackEnd()   // pause when THIS episode ends (re-armed on
                                    // every broadcast from duration − position)
service.cancelSleepTimer()

const timer = service.getSleepTimer()
if (timer?.mode === 'trackEnd') {
  // A trackEnd timer may legitimately have no number yet — a live item, or a
  // duration that has not arrived. getSleepTimerRemaining() alone cannot tell
  // that apart from "not armed"; this can.
  badge(timer.remainingSeconds ?? 'end of episode')
}

// Save the position on every discontinuity you care about, not on a tick.
player.on('seekCompleted', ({ position }) => progress.set(episode.id, position))
player.on('trackEnded', () => progress.delete(episode.id))
```

Broadcast `capabilities: ['play', 'pause', 'seek', 'setRate']` and
`controls: ['rewind', 'play', 'fastForward']` to put the ±30 s pair on the
notification and the lock screen instead of next/previous.

**What bites here.** `fastForward` / `rewind` are resolved **natively** into an
absolute `seekTo` on both platforms, so your handler only ever implements
`seekTo`; the interval is the `jumpForwardSeconds` / `jumpBackwardSeconds` pair
(15/15 by default — podcast apps set 30). `ios.supportedPlaybackRates` has no
Android twin: media3 takes an arbitrary float and draws no rate control, so there
is no list to hand it. `getChapters()` reads mpv's chapter table — a file with no
chapters returns `[]`, it is never an error. And the iOS sleep timer has one
honest edge: iOS suspends a backgrounded process shortly after its audio *stops*,
so a timer armed over silence may never fire; armed while audio plays — the case
that matters — it does.
[Sleep timer](packages/media-session/README.md#sleep-timer-native) ·
[jump intervals](packages/media-session/README.md#jump-intervals).

### A self-hosted library client (Plex / Jellyfin / Subsonic shape)

Your queue is a list of *your* ids. What mpv has to open is a URL your server
mints on demand, sometimes behind a token, sometimes signed and expiring in
minutes. The source resolver is the seam — and because our fork fires it at
**prefetch** time too, a queue of signed URLs is still gapless.

```ts
import { Player, type SourceResolver } from '@rn-media/player'

/**
 * `myapp://track/<id>` → whatever the server says is playable right now.
 *
 * The POST-an-id-get-a-URL shape: the queue holds ids, the server mints a
 * session URL per track, and neither the queue nor persistence ever contains a
 * URL that can expire.
 */
const resolveSource: SourceResolver = async ({ uri, entryId }) => {
  if (!uri.startsWith('myapp://track/')) return uri      // pass anything else through
  const id = uri.slice('myapp://track/'.length)

  const response = await fetch(`${server}/api/playback`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ trackId: id, maxBitrate: 320 }),
  })
  if (!response.ok) throw new Error(`playback ${id}: HTTP ${response.status}`)
  const { url } = (await response.json()) as { url: string }

  // `entryId` is present ONLY on the prefetch path. Its absence means this call
  // is holding mpv's core — the line to watch when a transition felt slow.
  console.log(`[resolve] ${id} ${entryId === undefined ? '(play-time)' : '(prefetch)'}`)
  return url
}

const player = await Player.create({
  prefetchPlaylist: true,
  sourceResolver: resolveSource,
  resolverTimeoutMs: 8_000,     // how long a play-time MISS may hold mpv. 0 = never hold
  resolverTtlMs: 5 * 60_000,    // how long one answer is replayed. Keep it INSIDE the
                                // URL's real expiry, and long enough to cover a track
})

// The queue is logical: your ids, not URLs. Nothing here expires, so it
// persists and restores cleanly.
const tracks = await catalogue.tracks('album:1')
await player.loadPlaylist(
  tracks.map((t) => `myapp://track/${t.id}`),
  {
    // Per-SOURCE auth, typed and escaped through both of mpv's list layers.
    // It belongs to the entry, so a resolver rewriting the URL does not lose it.
    headers: { Authorization: `Bearer ${token}`, 'X-Emby-Token': token },
  },
)

// A resolver that throws surfaces as a typed `load-failed`, caches nothing, and
// is retried on the next queue movement. It is never silent.
player.on('error', (e) => { if (e.code === 'load-failed') showRetry(e.message) })

// Swap it at runtime — a token refresh, or switching servers. `null` removes it.
player.setSourceResolver(resolveSource)
```

**Determinism is the whole contract.** mpv opens each entry **twice** — once
speculatively on the prefetch path, once for real — and reuses the prefetched
stream only if the two URLs are **byte-identical** (`open_demux_reentrant`, mpv
0.41.0 `player/loadfile.c:1223`). A resolver that mints a fresh nonce per call
therefore *defeats* prefetching: mpv drops the prefetched stream, joins the opener
thread on its core thread at the boundary, and opens cold — 644 ms instead of
25 ms, with an audible underrun. The library removes most of that hazard by
caching the first answer per URI and replaying it for `resolverTtlMs`. So: **mint
once per track, not once per call**, and size the TTL to sit inside your
signature's real lifetime while still covering one track. If a signature is
shorter than a track, sign per track anyway and let the stream outlive the URL —
mpv has already opened it.

**Slow is fine; missing is what costs.** Resolution runs *ahead*: the current and
next entries are resolved as soon as the queue moves — read from mpv's own
playlist, so it follows `next()`, repeat and shuffle rather than guessing — and
the answers are pushed into a native cache. A resolved entry costs a map lookup
and one property write, with no JavaScript anywhere near mpv's core. Only a **miss
at play time** holds mpv, and only for `resolverTimeoutMs`; on timeout the
original URI is used and mpv fails the load on its own terms, arriving as an
ordinary typed `error`.

**Two more things this shape needs.** Header auth belongs to the entry, not the
URL, so it survives the rewrite — but headers and casting do not mix: the Default
Media Receiver cannot attach them (`canCastMedia` returns `{ castable: false,
reason: 'headers' }`), which is why signed-query URLs cast and Bearer tokens do
not. And on stock libmpv only the play-time half of the resolver exists; the
prefetch hook is [our patch](docs/engine.md).
[Full contract](packages/player/README.md#dynamic-source-resolution-signed-urls-transcode-sessions).

### In the car

Android Auto and CarPlay are the same feature seen twice: a **tree** the car
browses and a **tap** that plays. One handler serves both — nothing here is
platform-specific except the two lines of iOS config at the end.

```tsx
import { Player } from '@rn-media/player'
import {
  BaseMediaHandler, BrowseError, BROWSE_ROOT, MediaService, useCarConnection,
  type BrowseItem, type MediaItem, type SearchFocus,
} from '@rn-media/media-session'

const player = await Player.create({ prefetchPlaylist: true })

const toMediaItem = (t: {
  id: string; title: string; artist: string; coverUrl: string
}): MediaItem => ({ id: t.id, title: t.title, artist: t.artist, artworkUri: t.coverUrl })

class Handler extends BaseMediaHandler {
  // The root's children are the car's TABS: at most four, browsable only.
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
        artworkUri: a.coverUrl,        // https is fine — served to Auto via content:// for you
        browsable: true, playable: true,  // opens the track list AND plays from the top
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

Android needs **nothing else** — the car manifest entry merges from the library.
CarPlay needs a UIScene app and Apple's entitlement, which the Expo plugin
writes: `["@rn-media/media-session", { "carPlay": true }]` (bare RN: the two
snippets in the [package README](packages/media-session/README.md#carplay)).
The car's rules, what each field becomes on each platform, and the Desktop Head
Unit recipe are all there too.

## Cast to a speaker

Casting is a **URL handoff, not an output route**: mpv can never *be* the thing
driving a Chromecast, so `@rn-media/cast` doesn't try — it pauses your player,
hands the receiver the queue as URLs, and lets it fetch and decode them. Every
surface keeps rendering from the same three `media-session` channels, now
mirroring the receiver instead of mpv. No second UI, no new fan-out path.

```tsx
import { Player } from '@rn-media/player'
import {
  Cast, CastButton, useIsCasting, wireCastHandoff,
  type CastHandoffQueueItem, type CastReceiverSnapshot,
} from '@rn-media/cast'

const player = await Player.create()
let currentIndex = 0
const items: CastHandoffQueueItem[] = (await catalogue.tracks('album:1')).map((t) => ({
  id: t.id,
  url: t.streamUrl,        // what the RECEIVER fetches — resolve signed URLs here
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
  // Structural on both sides — the adapter imports nothing from @rn-media/player.
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

`<CastButton/>` is the platform's own button as a real native view — on Android
13+ a tap opens the **system** output switcher (observed on an Android 16 device;
13-15 is the SDK's documented behaviour, not something we have run) — and it hides
itself when there is nothing to cast to. `service.setRemotePlayback({ volume })`
declares playback remote, which points the app's volume control — and the hardware
keys, on screen or with the screen off — at the receiver; on iOS the call is a
documented no-op because iOS gives no app the volume buttons. `wireCastHandoff`
lives in `@rn-media/cast`, not `media-session`, which stays player-agnostic and
cast-free in both directions.

Setup is a manifest `meta-data` block on Android and two `Info.plist` keys on iOS,
or one Expo plugin entry — and **Xcode 26+** to build. Codec ceilings
(`canCastMedia(item)` answers per track), live-stream rules and every device-found
failure mode: [`@rn-media/cast`](packages/cast/README.md) ·
[design doc](docs/design/cast.md).

## API

Every signature below is the real one, read from the packages' exports. Depth,
caveats and the error taxonomy live in each package README.

### `@rn-media/player` — lifecycle and loading

| | what it does | notes |
|---|---|---|
| `Player.create(options?: PlayerOptions): Promise<Player>` | Builds one mpv core and initialises it | Options out of mpv's range throw before a core is created |
| `player.destroy(): void` | Terminates the core and frees everything | Idempotent; every method afterwards throws `disposed` |
| `player.destroyed: boolean` | Whether `destroy()` has run | |
| `usePlayer(options?: UsePlayerOptions): { player, error }` | `create` on mount, `destroy` on unmount | `options.setup?: (p: Player) => void \| Promise<void>` runs once, after create |
| `createMpvClient(): MpvClient` | The raw binding, no `Player` wrapper | [docs/engine.md](docs/engine.md#reaching-into-mpv) |
| `load(source: string, options?: LoadOptions): Promise<void>` | Replaces the queue with one entry | `{ autoPlay?, startPosition?, headers?, mpvOptions? }` |
| `loadPlaylist(sources: readonly string[], options?: LoadPlaylistOptions): Promise<void>` | One mpv playlist — this is what gapless *is* | adds `{ startIndex?, shuffle? }`; `shuffle` + `startPosition` together throw |
| `setSourceResolver(resolver: SourceResolver \| null): void` | Install, replace or remove the resolver at any time | `(req: { uri, entryId? }) => string \| Promise<string>` |
| `setScreenStateSource(source: ScreenStateSource): void` / `getScreenStateSource()` | Replace the display-state signal the visualizer gates on | For an external display or a head unit — not for turning the gate off |

Multiple players are first-class — each `Player.create()` is its own mpv core.
`PlayerOptions`: `volume`, `rate`, `loop`, `muted`, `cacheSecs` (30 s, bounding
mpv's readahead against its ~1000-hour ceiling), `prefetchPlaylist`,
`gaplessAudio`, `userAgent` (defaults to `rn-media (libmpv)` because real
Shoutcast hosts 401 the literal `libmpv`), `replayGain`, `networkReconnect`,
`retry`, `sourceResolver`, `resolverTimeoutMs`, `resolverTtlMs`, `logLevel`,
`mpvOptions`. `headers` is the typed form of mpv's `http-header-fields`, escaped
through both of mpv's list layers and rejecting CR/LF/NUL/colon — mpv writes those
into the request verbatim, which is request splitting, not formatting — and it
belongs to the **entry**, so a resolver rewriting the URL does not lose it.
`.m3u8`/`.m3u` sources force `demuxer=lavf` (caller-overridable), so mpv's
playlist demuxer cannot explode your queue into segment entries.

### `@rn-media/player` — playback

| | what it does | notes |
|---|---|---|
| `play(): void` / `pause(): void` / `toggle(): void` | | Synchronous — they set mpv's `pause` property |
| `isPlaying(): boolean` | `state.playing` as a method | What makes a `Player` satisfy `audio-session`'s player contract |
| `seekTo(seconds: number): Promise<void>` | Absolute seek | |
| `seekBy(delta: number): Promise<void>` | Relative seek | Immune to projection error — use it for ±15 s buttons |
| `stop(options?: { clearPlaylist?: boolean }): Promise<void>` | Stops playback; **the queue survives** | mpv's own `stop` clears it; we invert that default. `{ clearPlaylist: true }` is the destructive opt-in |
| `setRate(rate: number): void` | Pitch-corrected speed | |
| `setPitch(ratio: number): void` | Transpose, independent of rate | A frequency **ratio**, not semitones: `2 ** (n / 12)` is the twelve-tone version |
| `getVolume(): number` / `setVolume(v: number): void` | `0..1` | |
| `setMuted(muted: boolean): void` | | |
| `setLoop(mode: LoopMode): void` | `'off' \| 'track' \| 'playlist'` | |
| `setAudioChannels(mode: AudioChannelMode): void` | `'auto-safe' \| 'auto' \| 'stereo' \| 'mono'` | Accessibility downmix; `'auto-safe'` restores |
| `setPrefetchPlaylist(enabled: boolean): void` | Open the next entry early, at runtime | Measured: 25 ms handover with it, 644 ms and an audible underrun without |

### `@rn-media/player` — queue (`player.playlist.*`)

| | what it does | notes |
|---|---|---|
| `entries(): readonly PlaylistEntry[]` | `{ uri, entryId, current }[]`, read from mpv | Synchronous, one node read — a pull, not a subscription |
| `add(source: string, options?: PlaylistAddOptions): Promise<void>` | Insert one entry | See the position table below |
| `remove(index: number): Promise<void>` | | |
| `move(from: number, to: number): Promise<void>` | | Ordinary array semantics |
| `jumpTo(index: number, options?: { autoPlay?: boolean }): Promise<void>` | Play that entry | `{ autoPlay: false }` stays paused |
| `next(): Promise<void>` | | |
| `previous(options?: { restartThreshold?: number }): Promise<void>` | The ⏮ button | Past the threshold (3 s) it restarts the track instead of moving back |
| `clear(): Promise<void>` | | Keeps the entry that is playing |
| `shuffle(): Promise<readonly PlaylistEntry[]>` | mpv `playlist-shuffle` | Returns the new order |
| `unshuffle(): Promise<readonly PlaylistEntry[]>` | Undoes it — **once** | mpv keeps one level of history |

`PlaylistAddOptions` extends the per-source options (`headers`, `startPosition`,
`mpvOptions`) with:

| `position` | where the entry lands |
|---|---|
| omitted | the end of the queue |
| `'next'` | immediately after the current entry |
| `number` | that exact index; outside `0 … count` **throws** rather than clamping |
| plus `play: true` | …and starts it if nothing is playing |

Insertion is one command, not two: `position` compiles onto mpv's own
`insert-next` / `insert-at` load actions, so the queue is never briefly wrong the
way an append-then-move pair leaves it.

### `@rn-media/player` — state, metadata and chapters

| | what it does | notes |
|---|---|---|
| `player.state: PlayerState` | Immutable snapshot | `status`, `playing`, `duration`, `isLive`, `rate`, `pitch`, `volume`, `muted`, `loop`, `playlist: { index, count }`, `hasNext`, `hasPrevious`, `chapter`, `title`, `seeking`, `seekable`, `bufferedPosition`, `bufferingPercent`, `positionAnchor`, `error`, … |
| `onStateChange(fn: (s: PlayerState) => void): Unsubscribe` | Fires only on real changes | |
| `getPosition(): number` | Seconds, **projected locally** | No bridge traffic, no timers |
| `resyncPosition(): number` | Re-reads mpv and re-anchors | For when you suspect drift |
| `clearError(): boolean` | Dismiss `state.error` | Returns whether there was one |
| `getMetadata(): Metadata` | mpv's typed tag map | `Readonly<Record<string, string>>` — one node read, no string parsing |
| `getMetadataValue(key: string): string \| undefined` | One tag, case-insensitive | `'icy-title'` is how radio now-playing arrives |
| `getCommonMetadata(): CommonMetadata` | The same tags normalised | title/artist/album/trackNumber/year/… |
| `getChapters(): readonly ChapterEntry[]` | `{ title?, start }[]`, `start` in seconds | Podcasts, m4b audiobooks; `[]` when there are none |
| `setChapter(index: number): void` | | |
| `nextChapter(): Promise<void>` / `previousChapter(): Promise<void>` | | |

**Position is an anchor, never a stream.** `state.positionAnchor` is
`{ position, timestamp, rate }` in **seconds**, updated only on discontinuities;
every surface projects `position + elapsed × rate` locally, so a scrubber moves
with zero bridge traffic. (`media-session`'s anchor is the same idea in
**milliseconds** — `{ value, at, rate }`.) Live streams are honest too:
`isLive: true` and `duration: undefined`.

### `@rn-media/player` — hooks

All of them take `Player | undefined`, so they are safe before `create()` resolves.

| | returns |
|---|---|
| `usePlayer(options?)` | `{ player, error }` — create on mount, destroy on unmount |
| `usePlayerState(player)` | the whole `PlayerState` |
| `usePlayerState(player, selector, isEqual?)` | one derived slice, re-rendering only when it changes |
| `useProgress(player, intervalMs = 250)` | `{ position, duration, buffered, isLive }` |
| `useMilestones(player, onMilestone, { marks = [25,50,75,90], intervalMs? })` | nothing — calls back at the scrobbling marks. A hook rather than a player timer because JS timers freeze with the screen off, and it says so instead of pretending |
| `usePrefetchStatus(player)` | `{ active: false } \| { active: true, uri, entryId?, at }` |
| `useEqualizer(player, options?)` | `Equalizer` — `bands`, `gainsDb`, `preset`, `presets`, `savedPresets`, `enabled`, `hydrated`, `error`, plus `setBandGain`, `setBandGains`, `applyPreset`, `reset`, `savePreset`, `deletePreset`, `setEnabled`. Options: `initialPreset`, `initialEnabled`, `extraFilters`, `chain`, `gainRangeDb` (±12 dB), `storage`, `storageKey`, `onStorageError` |
| `useVisualizer(player, options?, enabled?, pauseWhenInactive?)` | `{ frame, error, active }` |

### `@rn-media/player` — events (`player.on(name, listener): Unsubscribe`)

| event | payload |
|---|---|
| `trackChanged` | `{ index: number, previousIndex: number }` |
| `trackEnded` | `{ index: number }` — finished naturally |
| `queueEnded` | *(none)* — playback ran off the end |
| `queueChanged` | `{ count: number, reason: 'resized' \| 'reordered' }` |
| `chapterChanged` | `{ index?: number, previousIndex?: number }` |
| `seekStarted` | `{ reason: 'seek' \| 'auto-advance', from: number }` |
| `seekCompleted` | `{ reason: 'seek' \| 'auto-advance', position: number }` |
| `metadataChanged` | `Metadata` — at most once per native event batch |
| `prefetchStarted` | `{ uri: string, entryId?: number }` |
| `retrying` | `{ index, attempt, maxAttempts, error: PlayerError }` |
| `error` | `(error: PlayerError, info: { attempts: number })` |
| `log` | `{ level, prefix, text }` from mpv itself |

`PlayerError.code` is one of `'network' | 'unsupported-format' | 'load-failed' |
'disposed' | 'invalid-state' | 'unsupported' | 'mpv'`, and every error carries
`retryable: boolean` — read that rather than keeping a table of codes. A network
EOF is never confused with a natural end. `PlayerErrorException` is the thrown
form. The `seekStarted`/`seekCompleted` pair with its `reason` is what analytics
reconstructs listened time from; those arrive with the screen off, which is
exactly when a JS timer would not.

### `@rn-media/player` — audio processing

| | what it does | notes |
|---|---|---|
| `setAudioFilters(filters: readonly AudioFilter[]): void` | Compiles typed descriptors into mpv's `af` grammar | Replaces the whole user chain |
| `clearAudioFilters(): void` | | Leaves the managed loudnorm entry alone |
| `getAudioFilters(): string` | The compiled chain, as mpv sees it | |
| `setReplayGain(options: ReplayGainOptions): void` | `{ mode: 'no' \| 'track' \| 'album', preamp?, clip?, fallback? }` | Volume-domain, from the file's tags; applies to the *playing* track |
| `setLoudnessNormalization(enabled, options?)` | A managed `loudnorm` entry for files with no tags | `{ targetLufs?, loudnessRange?, truePeakDb?, dualMono? }`. Pick this **or** ReplayGain, never both — the gains stack |
| `getLoudnessNormalization()` | `LoudnessNormalizationOptions \| undefined` | |
| `AudioFilters.*` | `equalizer`, `bass`, `treble`, `lowpass`, `highpass`, `graphicEqualizer`, `crossfeed`, `compressor`, `limiter`, `dynamicNormalizer`, `loudnorm`, `volume`, `custom` | `custom` reaches any ffmpeg audio filter compiled in; `GRAPHIC_EQUALIZER_BANDS` is the 18-band centre list |
| `EQUALIZER_PRESETS` / `EQUALIZER_PRESET_LIST` / `EQUALIZER_BANDS` | 22 tuned 10-band curves; the list is picker-ordered; the bands are the ISO centres | `EQUALIZER_BAND_COUNT` is 10 |
| `equalizerPresetChain(preset, options?)` | Preset → filter chain **with a computed pre-amp** | So a preset cannot clip |
| `defineEqualizerPreset(id, name, gainsDb)` | Validates a user-designed curve | Exactly 10 gains, one per `EQUALIZER_BANDS` entry |
| `serializeEqualizerSettings` / `parseEqualizerSettings` | The on-disk form `useEqualizer`'s `storage` writes | `DEFAULT_EQUALIZER_STORAGE_KEY`, `EQUALIZER_SCHEMA_VERSION`; parse returns a typed `EqualizerRestoreResult`, never throws |
| `player.visualizer.capabilities` | `{ fft, waveform, maxFps, minFftSize, maxFftSize }` | `fft: false` on binaries without the PCM-tap patch |
| `player.visualizer.subscribe(listener, options?)` | Imperative spectrum, never auto-paused | The hook is what pauses; this is not |

The samples come from mpv itself — our forks carry a `pcm-tap` patch exposing the
audio the engine hands to the device, after the filter chain and after mpv's
software gain, so what you draw is what you hear. The FFT runs on a native thread;
the PCM never crosses into JavaScript and only ~4 KB of spectrum does. Nothing
exists until something subscribes, and `useVisualizer` stops itself when nothing
can be seen — on Android that took `AppState` **and** the display ANDed to stop a
65-80 %-of-a-core soak against 3.8 % for steady screen-off playback.
[Filters and EQ](packages/player/README.md#audio-filters-and-eq) ·
[visualizer](packages/player/README.md#visualizer-spectrum--waveform).

### `@rn-media/player` — escape hatch

`command` · `getPropertyString` / `Number` / `Bool` · `setPropertyString` /
`Number` / `Bool` · `observeProperty(name, 'string' | 'number' | 'bool')` ·
`unobserveProperty` · `getRawHandle(): bigint`. A complete raw mpv client, so
anything mpv can do you can do without waiting for us — with two documented
limits (an extra observed property does not become a `Player` event, and video
stays out): [docs/engine.md](docs/engine.md#reaching-into-mpv).

### `@rn-media/media-session`

| | what it does | notes |
|---|---|---|
| `MediaService.init(factory: () => MediaHandler, config?: MediaServiceConfig): Promise<MediaServiceApi>` | Wires the handler to every remote surface | Throws `alreadyInitialized` if called twice without a `stopService()` |
| `service.setPlaybackState(state: PlaybackState): void` | Channel 1 | `{ status, position, bufferedPosition?, controls?, capabilities?, customActions?, compactControlIndices?, queueIndex?, errorMessage?, repeatMode?, shuffleEnabled? }` |
| `service.setMediaItem(item?: MediaItem): void` | Channel 2 — merges over the queue entry at `queueIndex` | `{ id, title, artist?, album?, artworkUri?, duration?, genre?, albumArtist?, trackNumber?, discNumber?, year?, subtitle?, isLive?, extras? }` |
| `service.setQueue(items: MediaItem[]): void` | Channel 3 | |
| `service.setRemotePlayback(remote?: RemotePlayback): void` | Declares the audio is coming out of another device | `{ volume, muted?, steps?, volumeControl?, routingControllerId?, holdLocalAudioSlot? }`; call with nothing to take it back |
| `service.setSleepTimer(seconds: number): void` | Native countdown | Rejects `0`, negatives, `NaN`, `Infinity` |
| `service.setSleepTimerToTrackEnd(): void` | Pause when *this* item ends | Re-armed from `duration − position` on every broadcast |
| `service.cancelSleepTimer(): void` | | No-op when nothing is armed |
| `service.getSleepTimer(): SleepTimerState \| undefined` | `{ mode: 'duration', remainingSeconds } \| { mode: 'trackEnd', remainingSeconds? }` | The `trackEnd` case may legitimately have no number |
| `service.getSleepTimerRemaining(): number \| undefined` | Seconds | |
| `service.setResumptionSnapshot(snapshot?: string): void` | Writes the native mirror by hand | `withPersistence` does this for you; no-op on iOS |
| `service.stopService(): Promise<void>` | The **only** way to end background execution | Does not forget the persisted session |
| `service.invalidateBrowse(parentId?: string): void` | The car's list for `parentId` changed (download finished, library sync) | Android `notifyChildrenChanged`; CarPlay rebuilds the visible template; omit the id for everything |
| `service.getCarConnection(): CarConnection` | `{ kind: 'none' \| 'androidAuto' \| 'automotiveOs' \| 'carPlay' }` | Reactive twin: `useCarConnection()` |
| `BrowseItem` | One node of the car tree | `{ id, title, subtitle?, artworkUri?, browsable?, playable?, childStyle?, group?, explicit?, completion?, mediaType? }` — an item may be **both** browsable and playable |
| `BROWSE_ROOT` | The id `getChildren` receives for the root | Its children are the tabs: **≤ 4, browsable only**; extras are dropped and reported as `browseRootRejected` |
| `BrowseError` | Throw it from any browse method | `new BrowseError('authenticationExpired', msg, { label: 'Sign in', url })` shows the car's sign-in screen; codes: `authenticationExpired \| premiumAccountRequired \| notAvailableInRegion \| parentalControlRestricted \| notSupported` |
| `MediaControl` | `'play' \| 'pause' \| 'stop' \| 'skipToNext' \| 'skipToPrevious' \| 'fastForward' \| 'rewind' \| 'repeatMode' \| 'shuffle'` | Buttons, in order |
| `MediaCapability` | `'play' \| 'pause' \| 'stop' \| 'seek' \| 'skipToNext' \| 'skipToPrevious' \| 'skipToQueueItem' \| 'setRate' \| 'setRepeatMode' \| 'setShuffle'` | Commands your handler will service |
| `MediaPlaybackStatus` | `'playing' \| 'paused' \| 'buffering' \| 'stopped' \| 'error'` | |

**Handlers.** `MediaHandler` is `play`, `pause`, `stop`, `seekTo(ms)`,
`skipToNext`, `skipToPrevious`, `skipToQueueItem(index)`, `setRate(rate)`,
`onTaskRemoved`, `customAction(name, extras?)`, and the car trio
`getChildren(parentId)`, `getMediaItem(id)`, `playFromMediaId(id)` — plus the
optional `playFromSearch(query, focus)` (voice: "play some jazz"; absent ⇒ voice
play is not advertised), `search(query)` (Auto's search tab; absent ⇒ the tab is
not drawn), `onSetRepeatMode`, `onSetShuffle`, `onSetDeviceVolume`,
`onAdjustDeviceVolume`, `onSetDeviceMuted`, `onSleepTimer`,
`onPlaybackResumption` and `onSessionError`.

| | |
|---|---|
| `BaseMediaHandler` | Every method defaulted — override what you use |
| `CompositeMediaHandler` | Decorator: override one method, `super` the rest |
| `QueueHandler` / `withQueueHandling(Base)` | Default `skipToNext`/`skipToPrevious`/`skipToQueueItem` arithmetic over the queue you broadcast; you implement `playQueueItem(item, index)` |
| `MediaSessionError` / `logSessionError(error)` | The thrown error type, and the default `onSessionError` behaviour |

**Persistence.**

| | |
|---|---|
| `withPersistence(service, storage, options?)` | Tee decorator; adds `save()`, `flush()` and `clear()` |
| `restorePersisted(storage, options?)` | `Promise<RestoreResult>` — `'restored' \| 'empty' \| 'unsupportedVersion' \| 'corrupt'`, never a throw |
| `applyPersisted(service, session)` | Re-broadcast in the order the channels expect |
| `clearPersisted(storage, options?)` | Forget the saved session (**storage only**) |
| `PERSISTENCE_SCHEMA_VERSION`, `DEFAULT_PERSISTENCE_KEY` | Schema constants |
| `options.autosave` | `{ intervalMs? } \| false`. **On by default at 30 s**: one `setItem` per interval while playing, re-projecting the anchor in JS — no bridge traffic, no polling |

`storage` is anything with `{ getItem, setItem }`, sync or async — this package
depends on none of them. The restored position is **always paused**: a saved
anchor with a live rate would claim a position that grew while the process was
dead. `SessionError` is `{ code, severity, message }` with `severity: 'fatal' |
'degraded'`; the seven codes are tabulated in the
[package README](packages/media-session/README.md#when-the-session-itself-fails-onsessionerror).

### `@rn-media/audio-session`

| | what it does | notes |
|---|---|---|
| `wireAudioSession(player, options?): Unsubscribe` | Duck / pause / resume / stop-on-unplug, in one call | `{ preset?, duckVolume? (0.3), resumeAfterInterruption? (true), session?, onError? }` |
| `AudioSessionPresets.music` / `.speech` | Ready-made configs | `speech` pauses instead of ducking — ducked speech is unintelligible |
| `AudioSession.configure(config): Promise<void>` | `AVAudioSession` category / Android `AudioAttributes` | On Android it is stored for the next `activate()` |
| `AudioSession.activate(): Promise<boolean>` | Requests focus | `false` is a refusal, not an error |
| `AudioSession.deactivate(): Promise<void>` | | Rejects with `isBusy` on iOS if still playing |
| `AudioSession.addListener('interruption' \| 'becomingNoisy' \| 'routeChange', fn): Unsubscribe` | | `interruption` is `{ begin, type: 'duck' \| 'pause', permanent, shouldResume }` |

`player` is structural — anything with `{ play, pause, setVolume, getVolume }`,
optionally `isPlaying` and `onStateChange`. Implementing `isPlaying` is what keeps
a *user's* pause sacred across an interruption. Activating the session before
`play()` stays the app's job.
[Parity table and citations](packages/audio-session/README.md#platform-parity).

### `@rn-media/cast`

| | what it does | notes |
|---|---|---|
| `Cast.initialize(options?): Promise<CastConnectionState>` | Idempotent; call once, early | Resolves `'unavailable'` on a GMS-less Android device — never a crash |
| `Cast.getCastState(): CastConnectionState` | `'unavailable' \| 'idle' \| 'connecting' \| 'connected' \| 'transferring'` | Synchronous |
| `Cast.startDiscovery()` / `stopDiscovery()` | Scope it to "picker open" — discovery is battery-expensive | Stop it **after** connecting |
| `Cast.getCastDevices(): Promise<readonly CastDeviceInfo[]>` | | |
| `Cast.requestSession(deviceId?)` / `endSession(options?)` | | `endSession({ transferBackToLocal })` |
| `Cast.load(source, options?)` / `queueLoad(items, options?)` | Hand the receiver a URL, or a queue it advances by itself | |
| `Cast.queueInsert` / `queueRemove` / `queueReorder` / `queueJumpTo` / `queueSetRepeatMode` / `getQueueItemIds` / `fetchQueueSlice` | Receiver-side queue editing | |
| `Cast.play()` / `pause()` / `stop()` / `seek(position, resumeState?)` / `getApproximatePosition()` | Receiver transport | |
| `Cast.setDeviceVolume` / `setDeviceMuted` / `getDeviceVolume` / `setStreamVolume` / `setStreamMuted` | *Device* volume is what users mean; stream volume is app-level | |
| `Cast.addListener(event, fn): Unsubscribe` | `castState`, `session`, `devices`, `mediaStatus`, `error`, `queueChanged`, `deviceVolume` | `mediaStatus` is a discontinuity broadcast — project position, never poll |
| `wireCastHandoff(local, options): CastHandoff` | The whole local↔remote state machine | Returns `{ phase, receiverItemIndex, castTo, stopCasting, syncQueue, skipToItem, skipToNext, skipToPrevious, dispose }` |
| `useCastState(): CastConnectionState` / `useIsCasting(): boolean` | Live connection state as React state | Seeded synchronously, so the first paint is right; no polling |
| `isCastingState(state): boolean` | The one definition of "casting", for non-React callers | `'connected'` or `'transferring'` |
| `canCastMedia(item): CanCastVerdict` | `{ castable: false, reason: 'codec' \| 'local-file' \| 'headers' }` | Grey the route out per track instead of failing at load |
| `<CastButton style? tintColor? />` | The platform's own button as a native view | Hides itself while cast is unavailable |
| `CastError` | `code` is the thing to branch on — `statusCode` is Android-only | |

`wireCastHandoff`'s `options` are `{ snapshot, cast?, onPhaseChange?, onTransfer?,
onReceiverState?, onItemsSkipped?, onError?, now?, handoffTimeoutMs? }`; the local
player is `{ play, pause, seekTo, skipToIndex, getPosition, isPlaying }`.

### Also exported, deliberately not tabulated

The pure functions each package is unit-tested through — `reducePlayerState`,
`projectPosition`, `compileAudioFilters`, `toPlayerError`, `reduceCastHandoff`,
`projectCastQueue`, `normalizeConfig`, `validateMediaItem`, `stepRemoteVolume` and
their neighbours — plus the `createAudioSession` / `createMediaService` /
`createCast` factories that take a native object so the whole pipeline can be
exercised with no device, and the `DEFAULT_*` / `MAX_*` constants
behind every default named above. They are public so *your* tests can use them;
nothing in an app has to.

## Requirements

| | |
|---|---|
| React Native | **>= 0.82** (New Architecture); developed against 0.87.0 |
| Peer dependency | [`react-native-nitro-modules`](https://nitro.margelo.com) |
| Android setup | minSdk **24**, compileSdk **36**. Nothing to configure: the `media-session` manifest merges the foreground-service permissions, the `mediaPlayback` service, the Android Auto declaration and the artwork provider; `POST_NOTIFICATIONS` is *not* required for media notifications |
| iOS setup | **15.1+** — `@rn-media/cast` raises the floor to **16.0** and needs **Xcode 26+** to build. One `Info.plist` key: `UIBackgroundModes` → `<array><string>audio</string></array>`. CarPlay adds a scene manifest and the `com.apple.developer.carplay-audio` entitlement (Apple-granted) — `carPlay: true` on the plugin writes both |
| Expo | Prebuild (managed) workflow, no manual native edits: `"plugins": ["@rn-media/media-session"]` covers the whole library, merges `UIBackgroundModes` idempotently, and installs the notification drawable — the only way a prebuild app can add one. Expo Go cannot load this library; use a development build. [Plugin reference](packages/media-session/README.md#expo-config-plugin) |
| Android binary | 3.63 MB downloaded for `arm64-v8a`; 7,338,952 bytes of stripped `libmpv.so` (the other three ABIs are in the same band) |
| iOS binary | `Mpv.framework`'s device slice is 1,756,424 bytes; ≈7.1 MB across all ten frameworks |
| Google Play services | Casting only — without it `Cast.initialize()` resolves a typed `'unavailable'`, never a crash |
| Binary provenance | Downloaded at build time, pinned by tag **and** SHA-256; a mismatch is a hard build failure. Where the numbers came from: [docs/engine.md](docs/engine.md) |

## Common pitfalls

Every row here is a real bug someone hit, in this repo or in review.

| Symptom | What is actually happening |
|---|---|
| Gapless works locally but not with signed URLs | The resolver mints a fresh URL per call. mpv opens each entry twice and compares the two URLs **byte-for-byte** — mint once per track and size `resolverTtlMs` to cover it |
| The wrong artwork on the wrong song after "play next" | App-side metadata keyed on the queue **index**. An insert renumbers everything after it; key on `PlaylistEntry.entryId` (stable for the life of the core) or on the URI |
| The session comes back blank after a process kill | `MediaItem.id` was uniquified per insertion (`${id}-${i}`, a timestamp). `restorePersisted` matches by id, and those ids do not exist at cold start. Duplicates in a queue are legal and expected |
| The lock-screen scrubber is off by 1000× | `media-session`'s anchor is **milliseconds** (`{ value, at, rate }`); `PlayerState.positionAnchor` is **seconds** (`{ position, timestamp, rate }`) |
| `stop()` emptied the queue — or didn't | `player.stop()` **keeps** the queue (mpv's own `stop` clears it; we inverted that). Pass `{ clearPlaylist: true }` for the destructive version |
| The position never advances after a resume | A saved anchor restores with `rate: 0` and status `paused`, by design. Resume from a user gesture and broadcast a fresh anchor |
| `onSessionError` says `playbackResumptionNotWired` | `MediaService.init` is not reachable at JS **module scope**. Metro's inline requires defer a binding import to first *use*, and a revived runtime renders nothing — use a bare `import './src/playback'` in `index.js`. Raised ~3 s after the revived runtime comes up, and again as `playbackResumptionFailed` at the 10 s deadline; both are held for your next `init` |
| A track played straight through restores minutes behind | Autosave checkpoints every 30 s of playback, but **Android freezes JS timers once the Activity is gone** — so it covers the foreground only. Add `service.save()` on `AppState` leaving `active` (the exact instant autosave stops) and in `onTaskRemoved` |
| Everything is 3 dB too loud (or quiet) | ReplayGain **and** `setLoudnessNormalization` are both on. Pick one — the gains stack |
| The EQ screen's changes get wiped | While `useEqualizer` is mounted it owns `setAudioFilters`. Put the rest of your chain in its `extraFilters` option |
| The cast build fails on `_OBJC_CLASS_$_UIGlassEffect` | `google-cast-sdk` 4.8.6 is built against the iOS 26.2 SDK. **Xcode 26+** is required to link it; the runtime floor stays iOS 16 |
| A cast route greyed out for a track mpv plays fine | Receivers decode far less than mpv. Ask `canCastMedia()` — ALAC, hi-res FLAC, WMA, DSD and AC-3 are out |
| `content://` from the Android storage picker will not load | Neither libmpv nor FFmpeg has a handler for that scheme. Copy the file or resolve it to a path |

## Limitations

- **No DRM**, by construction — libmpv has no Widevine/FairPlay. This library
  cannot power a licensed-catalog streaming app.
- **iOS has never been run on a device.** It compiles, links and embeds the
  frameworks in CI, and the shipped binary demonstrably carries the HLS demuxers
  and the filter set — but no on-device playback, background audio or lock-screen
  behaviour has been observed. Expected to work, not proven. (Android is
  device-verified, HLS included.)
- **Force-quitting on iOS kills playback**, and nothing may restart the app for
  audio afterwards — true of every iOS app, and the reason `playbackResumption`
  is Android-only. Relatedly, an iOS sleep timer armed over *silence* may never
  fire, because iOS suspends a backgrounded process once audio stops; armed while
  audio plays — the case that matters — it fires.
- **No crossfade.** Built, listened to on a device, and dropped by owner
  decision: mpv's gapless is an output-buffer guarantee, and the crossfade built
  on top of it was not good enough to ship. A competitor ships crossfade; we do
  not, and would rather say so than pretend the row does not exist.
- **Embedded cover art decodes, but cannot be extracted yet.** The eight
  cover-art decoders are compiled into both binaries and mpv reports an attached
  picture through `track-list/N/albumart` — but there is **no API to get the
  bytes**, because the audio-only core runs `audio-display=no` (mpv then never
  selects the attached-picture track) and the only image-returning client-API
  command, `screenshot-raw`, needs a video output this core deliberately never
  creates. Until it ships, pass artwork from your own library as
  `MediaItem.artworkUri`.
- **Casting has real ceilings.** Android device-verified, iOS CI-verified only;
  receivers decode far less than mpv (no ALAC, hi-res FLAC, WMA, DSD or AC-3), no
  `file://` sources in v1, no header auth without your own Web Receiver, and no
  lock-screen controls during an iOS session. AirPlay-*as-handoff* stays out of
  scope — no sender SDK exists for it from a third-party engine, for anyone, and
  the platform-split workaround a paid competitor ships is exactly what this
  project's parity gate rejects. **AirPlay audio *output* works today with zero
  code**: it is an ordinary iOS system output route.
- **Persistence has two honest edges**: the 30 s autosave rides a JS timer, and
  Android stops those once the Activity is gone — so a long background stretch
  is checkpointed by your `service.save()` on `AppState`, not by the timer; and
  a live stream saves position `0`, because an offset into it has nothing to
  seek back to.
- **CarPlay has never been run** — it compiles on CI and mirrors Android Auto's
  handler contract, but no Simulator or head-unit session has been observed
  (Apple hardware and the entitlement are both owner-side). Android Auto *is*
  verified: on the Desktop Head Unit and by a real `MediaBrowser` on a phone.
- **Cold browse from the car needs `android.playbackResumption: true`.** A car
  binding a dead process gets the cached tree immediately; refreshing it means
  reviving JavaScript, and only the resumption path is allowed to. Without it
  the car sees the last cached lists until the app is opened.

## Roadmap

The gate that unlocks shipping, in this order: **on-device iOS verification**
(playback, background audio, lock screen, HLS and the EQ chain on real hardware)
→ the naming decision → the first npm publish.

Shipped 2026-08-27: **Android Auto + CarPlay** — one `getChildren`/`playFromMediaId`
handler behind both (ARCHITECTURE §31). Next, owner-approved:
**`@rn-media/downloads`** — offline playback as a *source resolver*, so the player
needs no changes at all — then LRC lyrics over position projection, then video as
an additive plugin package with its own binaries and zero core changes.
Investigations rather than promises: output-device routing. Full analysis and rationale:
[`PLAN.md`](PLAN.md).

## Licensing

**This library: MIT.** The bundled libmpv/FFmpeg binaries are **LGPL v3** (built
with `--enable-version3`, never `--enable-gpl`) and **dynamically linked** — the
App Store-accepted pattern that satisfies the relink obligation. Ship your app's
licenses screen with the mpv/FFmpeg notices. Both binaries come from our public
forks of media-kit's build scripts,
[`libmpv-android-audio-build`](https://github.com/afkcodes/libmpv-android-audio-build/releases/tag/v1.1.9-rnmedia.8)
and [`libmpv-darwin-build`](https://github.com/afkcodes/libmpv-darwin-build/releases/tag/v0.7.2-rnmedia.7)
— both mpv 0.41.0 / FFmpeg 8.1.2 / mbedTLS 3.6.7, so the two platforms run one
engine. The full obligation chain, including statically-linked libplacebo and GNU
libiconv inside that dynamically-linked libmpv: [docs/engine.md](docs/engine.md).

## Contributing

[`CONTRIBUTING.md`](CONTRIBUTING.md) has the whole loop — setup, per-package
tests, the Gradle tasks CI runs, how to typecheck a README snippet, and what
counts as verification here: device-free for TS logic, and a *physical* device for
any playback claim. Injected input is not a physical device.

[`apps/example`](apps/example) is the reference integration and the on-device test
bed for every recipe above. [`ARCHITECTURE.md`](ARCHITECTURE.md) is the living
record of every decision and its evidence; [`PLAN.md`](PLAN.md) holds the
analysis, [`docs/specs/`](docs/specs) the per-package contracts,
[`docs/engine.md`](docs/engine.md) the engine we build. The C++ core binds only
`mpv/client.h` — video arrives later as a separate opt-in plugin package with its
own binaries, at zero cost to audio-only users.
