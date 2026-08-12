# rn-media

[![Android CI](https://img.shields.io/github/actions/workflow/status/afkcodes/rn-media/android-build.yml?branch=main&label=Android%20CI&logo=android&logoColor=white)](https://github.com/afkcodes/rn-media/actions/workflows/android-build.yml)
[![iOS CI](https://img.shields.io/github/actions/workflow/status/afkcodes/rn-media/ios-build.yml?branch=main&label=iOS%20CI&logo=apple&logoColor=white)](https://github.com/afkcodes/rn-media/actions/workflows/ios-build.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![React Native ≥ 0.82](https://img.shields.io/badge/React%20Native-%E2%89%A5%200.82-61dafb?logo=react&logoColor=white)](#requirements)

**React Native audio playback built on [libmpv](https://mpv.io), with a
player-agnostic media-session layer** — lock screen, notification, Bluetooth
and background playback that keep working after the app's UI is gone.

Three independent packages, no cross-dependencies: a libmpv player, an
audio-focus arbiter, and a media session that drives lock screens for *any*
player. Powered by [Nitro Modules](https://nitro.margelo.com) — the C++ core
binds libmpv's client API directly, no bridge layer. Lineage: Flutter's
[`audio_service`](https://pub.dev/packages/audio_service) /
[`audio_session`](https://pub.dev/packages/audio_session) / media-kit trio.

> **Status: v0.1, pre-release — nothing is on npm yet.** The install line below
> is what it will be; today the packages are consumed from this workspace (see
> [Roadmap](#roadmap)). The Android stack is verified end-to-end on a physical
> device: audio output, notification controls round-tripping to JS, playback
> surviving Activity destruction, and the whole session coming back from a
> process the OS had killed. iOS is **built by CI** — it compiles, links and
> embeds the libmpv frameworks, and the shipped binaries are inspected
> assertion-by-assertion — but it has never run on a device. APIs may still
> change.

<p align="center">
  <img src="docs/assets/demo.gif" width="330"
       alt="The example app: a live Shoutcast stream with ICY now-playing, the same session in the notification shade and on the lock screen, then seeking, an EQ preset and stop." />
</p>

<p align="center">
  <sub><a href="apps/example">The example app</a>, on a physical Android 16 device — live Shoutcast with
  artwork and ICY now-playing → notification shade → lock screen, whose play
  button drives the same handler → seek on a finite AAC/MP4 track → EQ preset →
  stop and dismiss. <a href="docs/assets/demo.mp4">Source video</a>.</sub>
</p>

## Why this exists

| | [track-player](https://rntp.dev) | [expo-audio](https://docs.expo.dev/versions/latest/sdk/audio/) | [rn-video](https://github.com/TheWidlarzGroup/react-native-video) | [queue-player](https://ghenry22.github.io/react-native-queue-player/) | **rn-media** |
|---|---|---|---|---|---|
| Engine | ExoPlayer / AVPlayer | ExoPlayer / AVPlayer | ExoPlayer / AVPlayer | not documented | **libmpv 0.41.0 + FFmpeg 8.1.2 — our own build** |
| One identical engine on both platforms | ❌ two engines | ❌ | ❌ | — | ✅ same sources, same flags: 103 mpv options a side, **101 identical** (the two that differ are the platform's audio device) |
| Formats | platform codecs | platform codecs | platform codecs | not documented | everything FFmpeg decodes — MP3, AAC/M4A, FLAC, OGG/Opus, HLS, ICY/Icecast, TrueHD, embedded cover-art streams (decoded, extraction API planned), legacy-charset tags |
| Multiple players | ❌ singleton | ✅ | ✅ | ❌ singleton | ✅ one mpv core each |
| Background + media session | ✅ best-in-class | ✅ lock screen + notification | ⚠️ notification controls | ✅ | ✅ media3 `MediaLibraryService`, native-first commands |
| Session layer works with *any* player | ❌ | ❌ | ❌ | ❌ | ✅ (`@rn-media/media-session` is player-agnostic) |
| Gapless queue | ⚠️ | ✅ | ❌ | ✅ | ✅ 25 ms handover, measured on-device |
| Signed / expiring URLs stay gapless | ❌ | ❌ | ❌ | ❌ | ✅ resolver runs at **prefetch** time — our own mpv patch, [below](#resolve-sources-at-the-last-moment) |
| Per-source HTTP headers | ✅ | ✅ | ✅ | ⚠️ global config only | ✅ typed; CR/LF/colon rejected as request splitting |
| EQ / DSP | ❌ | ❌ | ❌ | ✅ 10-band | ✅ 16 ffmpeg filters, 22 tuned EQ presets |
| Pitch control, independent of rate | ❌ correction algorithms only | ❌ | ❌ | ❌ | ✅ `setPitch(ratio)` — mpv's first-class `--pitch` |
| Chapters (read + navigate) | ❌ | ❌ | ⚠️ tvOS, app-supplied marks | ❌ | ✅ `getChapters()`, `state.chapter`, next/previous |
| Sleep timer | ❌ a DIY guide (V5, commercial, ships one) | ❌ | ❌ | ✅ duration / end-of-track, with fade | ✅ native, duration + end-of-track (no fade) |
| Spectrum visualizer | ❌ | ❌ | ❌ | ✅ | ✅ both platforms, no `RECORD_AUDIO` |
| Crossfade | ❌ | ❌ | ❌ | ✅ | ❌ deliberately — built, listened to, dropped ([Limitations](#limitations)) |
| Casting (Chromecast / AirPlay) | ✅ | ❌ | ❌ app-side | ✅ | ❌ deferred with a reason ([Limitations](#limitations)) |
| Android Auto / CarPlay | ✅ | ❌ | ❌ | ✅ | 🚧 next feature ([Roadmap](#roadmap)) |
| DRM (Widevine/FairPlay) | ⚠️ announced | ❌ | ✅ | not documented | ❌ libmpv cannot ([Limitations](#limitations)) |
| Native binary it adds | ≈none (platform codecs) | ≈none | ≈none | — | 3.63 MB downloaded for `arm64-v8a`, ≈7.1 MB for the iOS device slice ([Requirements](#requirements)) |

Every cell in the four competitor columns comes from that project's own
documentation, read on 2026-08-12/13. The track-player column is **V4, the
open-source baseline** — V5 is a commercial rewrite, and where it advertises
something V4 lacks, the cell says so. Ours are linked to the section that proves
them. The sweet spot: music apps with **non-DRM audio** — indie catalogs,
self-hosted libraries (Plex / Jellyfin / Subsonic), podcasts, radio, audiobooks.
The row we pay for is the last one: a shipped engine costs megabytes that
platform codecs do not, and that number is in [Requirements](#requirements)
rather than in a footnote.

Different job? [`react-native-audio-api`](https://github.com/software-mansion/react-native-audio-api)
implements the **Web Audio API** — an audio *graph* for synthesis, games and
per-sample DSP. That's a paradigm this library doesn't attempt, and the reverse
holds for queues, lock screens and background survival. They compose, though:
`@rn-media/media-session` takes any player structurally, so a Web-Audio app can
drive our lock-screen and background layer.

## 60-second quick start

```sh
npm install @rn-media/player @rn-media/audio-session @rn-media/media-session react-native-nitro-modules
cd ios && pod install   # downloads + verifies the pinned libmpv xcframeworks
```

```tsx
import { Button, Text, View } from 'react-native';
import { usePlayer, useProgress } from '@rn-media/player';

export function MiniPlayer() {
  // Created on mount, destroyed on unmount.
  const { player } = usePlayer({ setup: p => p.load('https://cdn.example/t.flac') });
  const { position, duration, isLive } = useProgress(player);

  return (
    <View>
      <Button title="Play / Pause" onPress={() => player?.toggle()} />
      <Text>{position.toFixed(0)}s {isLive ? '· live' : `/ ${duration?.toFixed(0)}s`}</Text>
    </View>
  );
}
```

That is a working player: [platform setup](#platform-setup) is one `Info.plist`
key on iOS and nothing at all on Android.

## The mental model

```
            your app UI ─────────────┐
                                     ▼ (renders from the same broadcasts)
┌────────────────────────────────────────────────────────────────────┐
│ @rn-media/media-session   fan-in:  notification · lock screen ·    │
│                                    Bluetooth · watch → ONE handler │
│                           fan-out: playbackState · mediaItem ·     │
│                                    queue — the only state source   │
├────────────────────────────────────────────────────────────────────┤
│ @rn-media/audio-session   focus · AVAudioSession · interruptions   │
├────────────────────────────────────────────────────────────────────┤
│ @rn-media/player          TS Player (state reducer, hooks)         │
│   └─ Nitro pure-C++ HybridObject ── libmpv (one core per player)   │
└────────────────────────────────────────────────────────────────────┘
```

Use `player` alone for foreground playback; add `audio-session` for focus; add
`media-session` for lock screen and background. Both session packages accept
**any** engine — the contracts are structural, not nominal, so RNTP,
`expo-audio` or a TTS engine fit them unchanged.

Two rules the whole design rests on, and you will feel both. **Position is an
anchor, never a stream**: state carries `{ value, at, rate }`, updated only on
discontinuities, and every surface projects `value + elapsed × rate` locally —
the lock-screen scrubber moves with zero bridge traffic. **Commands are
native-first**: the notification's pause button acts on the native state machine
immediately, and your JS handler is notified after, never on the critical path.

## Play something

```ts
import { Player } from '@rn-media/player';

const player = await Player.create({ volume: 0.8, cacheSecs: 60 });
await player.loadPlaylist([a, b, c], { startIndex: 0 }); // gapless, one mpv playlist
player.play();

player.on('trackChanged', ({ index }) => console.log('now on', index));
player.on('trackEnded', () => console.log('finished naturally'));
player.on('queueEnded', () => console.log('ran off the end of the queue'));
player.on('prefetchStarted', ({ uri }) => console.log('opening ahead', uri));
player.on('seekCompleted', ({ reason, position }) =>       // 'seek' | 'auto-advance';
  console.log('landed at', position, 'because', reason));  // pairs with seekStarted
player.on('error', e => console.log(e.code, e.message)); // network | unsupported-format | …

// --- the rest of the surface, at a glance ---
player.pause(); player.toggle();
await player.seekTo(90);
await player.seekBy(-15);         // relative — immune to projection error
player.setRate(1.5);              // pitch-corrected speed
player.setPitch(2 ** (3 / 12));   // transpose 3 semitones up — independent of rate
player.setVolume(0.5);            // 0..1
player.setLoop('playlist');       // 'off' | 'track' | 'playlist'
player.setAudioChannels('mono');  // accessibility downmix; 'auto-safe' restores
await player.stop();              // stops playback; the queue SURVIVES
await player.stop({ clearPlaylist: true });  // mpv's full clear, as the opt-in

await player.playlist.add(uri);                                    // to the end
await player.playlist.add(uri, { position: 'next' });              // play it after this one
await player.playlist.add(uri, { position: 0 });                   // exact index; rejected if out of range
await player.playlist.add(uri, { position: 'next', play: true });  // …and start if nothing is playing
await player.playlist.move(0, 4);
await player.playlist.jumpTo(2);  // plays it; { autoPlay: false } to stay paused
await player.playlist.previous(); // the ⏮ button: >3 s in restarts, else moves back ({ restartThreshold })
await player.playlist.shuffle();  // mpv playlist-shuffle; unshuffle() undoes it, once

const chapters = player.getChapters();  // [{ title?, start }] — podcasts, m4b audiobooks
await player.nextChapter();             // with previousChapter() and setChapter(index)

const snapshot = player.state;    // status, playing, duration, isLive, hasNext, pitch, chapter, …
player.onStateChange(state => render(state));  // only on real changes
player.getPosition();             // projected locally — no bridge traffic, no timers
player.getMetadata();             // typed tags, ICY now-playing included
player.getCommonMetadata();       // the same tags normalised: title/artist/album/trackNumber/year/…
player.destroy();                 // when you are done with the core
```

Worth knowing:

- **Multiple players are first-class** — each is its own mpv core, so a
  crossfade deck or a preview player is just a second `Player.create()`.
- **Live streams are honest**: `isLive: true` and `duration: undefined`. mpv's
  perpetually-growing cache length is suppressed, not broadcast as a duration.
- **HLS works on both platforms** — our libmpv pins add the `hls` and `mpegts`
  demuxers that stock audio builds omit — as do HTTPS files and ICY/Icecast.
  `.m3u8`/`.m3u` loads force `demuxer=lavf`, so mpv's playlist demuxer cannot
  explode your queue with segment entries.
- **Metadata is a pull plus an event**: `getMetadata()` /
  `getMetadataValue('icy-title')` walk mpv's typed tag list (no string parsing),
  and `metadataChanged` fires at most once per native event batch — which is how
  ICY now-playing arrives on a radio stream.
- **Gapless is the audio device staying open**, not a crossfade: a queue is one
  mpv playlist, and consecutive entries hand over in ~25 ms with the device
  never reopened (measured on-device, release build). `gaplessAudio` picks how
  hard to try when consecutive tracks decode to *different* formats.
- `prefetchPlaylist: true` opens the next entry early — on a network queue that
  is what keeps the handover gapless (measured: 644 ms and an audible underrun
  without it, 25 ms and none with it), and `prefetchStarted` tells you the moment
  it happens. `cacheSecs` bounds mpv's readahead (30 s by default, against mpv's
  ~1000 hours); `userAgent` defaults to `rn-media (libmpv)` because real
  Shoutcast hosts 401 the literal `libmpv`.
- **Insertion is one command, not two.** `position` compiles onto mpv's own
  `insert-next` / `insert-at` load actions, so the queue is never briefly wrong
  the way an append-then-move pair leaves it, and an index outside
  `0 … playlist.count` throws instead of quietly landing at the far end.
- **HTTP headers are per source, and typed.** `load(uri, { headers: {
  Authorization: … } })` — `loadPlaylist` and `playlist.add` take the same
  per-entry options — is the typed form of mpv's `http-header-fields`, escaped
  through both of mpv's list layers (a comma in a header value used to corrupt
  the whole option list) and rejecting CR/LF/NUL/colon, which mpv would write
  into the request verbatim: that is request splitting, not formatting. Headers
  belong to the *entry*, so a [source resolver](#resolve-sources-at-the-last-moment)
  rewriting the URL does not lose them.
- **Pitch is a ratio, not semitones, on purpose**: mpv's `--pitch` is a
  frequency multiplier, and picking a tuning convention is an app decision —
  `2 ** (n / 12)` is the twelve-tone version. Speed and pitch compose: `1.5×`
  rate with `setPitch(1)` is a faster audiobook at the right pitch.
- **`stop()` keeps the queue.** mpv's own `stop` clears the playlist; ours
  deliberately inverts that default — RNTP's `stop()` keeps the queue too, and
  a migrator silently losing one is data loss — with `{ clearPlaylist: true }`
  as the destructive opt-in.
- **The signals analytics need are events, not polling**: `queueEnded` when
  playback runs off the end, the `seekStarted`/`seekCompleted` pair with a
  `'seek' | 'auto-advance'` reason (reconstruct listened time from those — they
  arrive with the screen off), `state.bufferingPercent` while stalled, and the
  `useMilestones` hook for the 25/50/75/90 % scrobbling marks (a hook and not a
  player timer, because JS timers freeze screen-off and the hook says so
  honestly).

Queue semantics, shuffle's one-level undo, ReplayGain, prefetch caveats, the
typed error taxonomy: [`@rn-media/player` README](packages/player/README.md).

## Resolve sources at the last moment

Signed CDN links that expire in minutes, transcode sessions created per track:
queues whose entries cannot be written down when the queue is built. Give the
player a resolver and it asks, per entry, moments before mpv opens it.

```ts
const player = await Player.create({
  prefetchPlaylist: true,
  sourceResolver: async ({ uri }) => {
    if (!uri.startsWith('library://')) return uri;
    const { url } = await api.signPlaybackUrl(uri.slice('library://'.length));
    return url;
  },
});

await player.loadPlaylist(['library://a', 'library://b', 'library://c']);
player.setSourceResolver(null); // install, replace or remove it at any time
```

**The half that makes it useful: it also runs at *prefetch* time.**
mpv opens the next entry ahead of the boundary, and upstream mpv deliberately
runs no hooks there — its manual says resolved URLs "won't" work with
`--prefetch-playlist` — so a URL-rewriting resolver on stock libmpv makes
prefetch *worse* than off: mpv compares the two URLs, throws the prefetched
stream away and opens cold while blocking its core. Our fork carries the patch
that fires a hook on that path, so a signed queue keeps the 25 ms handover
instead of paying 644 ms for it.

The current and next entries are resolved as soon as the queue moves — read from
mpv's own playlist, so it follows `next()`, repeat and shuffle rather than
guessing — and the answers are cached natively, so a resolved entry costs a map
lookup with no JavaScript near mpv's core. Answers are replayed per URI
(`resolverTtlMs`, 10 min) because mpv reuses a prefetched stream only when the
two URLs are byte-identical: mint one URL per track, not one per call. A miss at
play time holds mpv for at most `resolverTimeoutMs` (10 s, `0` disables the
hold); a resolver that throws emits a typed `load-failed` error and is retried.
[Full contract](packages/player/README.md#dynamic-source-resolution-signed-urls-transcode-sessions).

## Show it on the lock screen

Every command surface — notification, lock screen, Bluetooth, headset, watch —
funnels into **one handler you implement**. You broadcast state on three channels,
and every surface, including your own UI, renders from them.

```ts
import { BaseMediaHandler, MediaService } from '@rn-media/media-session';

class PlaybackHandler extends BaseMediaHandler {
  override async play() { player.play(); }
  override async pause() { player.pause(); }
  override async seekTo(ms: number) { await player.seekTo(ms / 1000); }
  override async skipToNext() { await player.playlist.next(); }
  override async skipToPrevious() { await player.playlist.previous(); }
  override async stop() { player.pause(); await service.stopService(); }
  // onSetRepeatMode, onSetShuffle, onTaskRemoved, customAction, onSleepTimer,
  // onPlaybackResumption: all defaulted.
}

const service = await MediaService.init(() => new PlaybackHandler(), {
  android: {
    notificationChannelId: 'playback',
    notificationChannelName: 'Playback',
    notificationIcon: 'ic_notification', // a drawable in YOUR app
  },
});
```

Then broadcast, typically straight from `player.onStateChange`:

```ts
service.setQueue(tracks.map(t => ({ id: t.id, title: t.title, artist: t.artist })));
service.setMediaItem({
  id: track.id, title: track.title, artist: track.artist, artworkUri: track.art,
  duration: track.durationMs, // or isLive: true — explicit, so "no duration yet" ≠ live
});

player.onStateChange(state => {
  service.setPlaybackState({
    status: state.playing ? 'playing' : 'paused',
    position: {
      value: player.getPosition() * 1000, at: Date.now(),
      rate: state.playing ? state.rate : 0, // 0 freezes every surface's projection
    },
    controls: ['skipToPrevious', 'pause', 'skipToNext'],
    capabilities: ['play', 'pause', 'seek', 'skipToNext', 'skipToPrevious'],
    queueIndex: state.playlist.index,
  });
});
```

`controls` are the buttons you want, in order; `capabilities` are the commands
your handler will actually service (media3 never invokes a handler for a command
you did not declare). `QueueHandler` supplies default `skipToNext` /
`skipToPrevious` / `skipToQueueItem` arithmetic over the broadcast queue, and
`CompositeMediaHandler` decorates a handler (analytics, logging) without
touching it:
[reference](packages/media-session/README.md#controls-vs-capabilities).

**Repeat and shuffle ride the same contract**: advertise `setRepeatMode` /
`setShuffle` in `capabilities` (that alone lights up Android Auto, Wear and
Bluetooth controllers), add `'repeatMode'` / `'shuffle'` to `controls` for
buttons in the phone's shade with media3's state-following icons, and broadcast
`repeatMode` / `shuffleEnabled`. A press calls `onSetRepeatMode(mode)` /
`onSetShuffle(enabled)` on your handler, and nothing changes until your next
broadcast — the acknowledge-by-broadcast contract every command follows. The
`fastForward` / `rewind` jumps are one cross-platform pair,
`jumpForwardSeconds` / `jumpBackwardSeconds` (default 15/15 — before this
option, the identical JS call skipped back 5 s on Android and 15 s on iOS);
both platforms resolve the increment natively into an absolute `seekTo`, so
there is no jump handler to implement. `android.notificationColor` tints the
notification (an ARGB hint — Android 12+ shades may prefer the artwork's
palette). And `MediaItem` carries the long tail — `albumArtist`, `trackNumber`,
`discNumber`, `year`, `subtitle`, `isLive`, `extras` — with a per-field honesty
table of what each platform actually renders (iOS has no year key, no third
text line and no extras surface; those are carried and persisted, never faked
into other fields):
[repeat & shuffle](packages/media-session/README.md#repeat-and-shuffle) ·
[jump intervals](packages/media-session/README.md#jump-intervals) ·
[metadata fields](packages/media-session/README.md#metadata-fields).

## Handle focus and headphones

Duck for navigation prompts, pause for phone calls, resume after, pause when
the headphones come out — one call:

```ts
import { AudioSessionPresets, wireAudioSession } from '@rn-media/audio-session';

const unwire = wireAudioSession(player, {
  preset: AudioSessionPresets.music, // or .speech — pauses instead of ducking
  duckVolume: 0.3,
  resumeAfterInterruption: true,
});
```

`wireAudioSession` takes anything with `{ play, pause, setVolume, getVolume }`,
so it is not coupled to our `Player`; activating the session before `play()`
stays the app's job. Everything under the helper —
`AudioSession.configure/activate/deactivate` and the `interruption`,
`becomingNoisy` and `routeChange` listeners — is public when you want the policy
yourself: [reference](packages/audio-session/README.md#player-integration).

## Survive backgrounding and process death

On Android the media3 foreground service keeps the process — and with it the JS
runtime — alive, so your handlers keep working with the Activity destroyed. But
**a paused service is eventually demoted, and a demoted service is killable**.
media3 holds it foreground for a grace period first (10 minutes by default;
`android.stopForegroundTimeoutMs` moves it, `0` demotes at once). When Android
reclaims the process, the queue, track and position must live somewhere else.

```ts
import {
  MediaService, applyPersisted, restorePersisted, withPersistence,
} from '@rn-media/media-session';

// Saves on every broadcast. `storage` is anything with { getItem, setItem }:
// AsyncStorage, MMKV, your own — this package depends on none of them.
const service = withPersistence(
  await MediaService.init(() => new PlaybackHandler(), config),
  storage,
);

// Next launch:
const restored = await restorePersisted(storage);
if (restored.status === 'restored') applyPersisted(service, restored.session);
```

Writes happen on broadcasts, and broadcasts are discontinuity-only — so a track
played straight through saves nothing until you say so. `service.save()`
re-projects the anchor and writes on demand, with no broadcast; you pick the
moment (`AppState` leaving `active`, `onTaskRemoved`, before `stopService`).
The position always comes back **paused**: a saved anchor with a live rate
would claim a position that grew while the process was dead, and on Android a
`playing` broadcast is precisely what starts a foreground service.

**JS timers freeze in the background** (an RN platform behaviour — handlers,
promises and network callbacks work; `setTimeout` does not). So the sleep timer
is a library feature rather than something you build, with both modes people
actually set: `setSleepTimer(seconds)` for a countdown, and
`setSleepTimerToTrackEnd()` for "pause when *this* track finishes" — its
deadline computed natively from the broadcasts you already send and re-armed on
every discontinuity, so a seek, a rate change or a late-arriving duration all
move it, and on a live stream (no duration at all) it simply fires when the
item changes. Both run on a native `Handler` / `DispatchQueue` timer. When one
fires, playback is paused **natively first** — the same path a notification
pause takes — and only then is `onSleepTimer` called on your handler.
`getSleepTimer()` reports `{ mode, remainingSeconds? }` — an armed end-of-track
timer may legitimately have no number yet, which the plain
`getSleepTimerRemaining()` cannot distinguish from "not armed" —
and `cancelSleepTimer()` completes the surface. The countdown path is verified
on-device with the Activity destroyed.

### Coming back from the dead (Android)

Android can bring the whole thing back after the process is gone — System UI's
resumption card, a Bluetooth reconnect, a headset play button. Opt-in, because it
starts a foreground service in a process the user did not open.

```ts
import type { MediaServiceConfig } from '@rn-media/media-session';

// The same withPersistence(await MediaService.init(…)) as above, plus one flag:
const config: MediaServiceConfig = {
  android: {
    notificationChannelId: 'playback',
    notificationChannelName: 'Playback',
    playbackResumption: true, // default false
  },
};
```

Three things must line up, and the library logs which one is missing: that flag,
`withPersistence` (it writes the snapshot the service reads), and
`MediaService.init` at module scope (below) — plus media3's `MediaButtonReceiver`
declared in your own `AndroidManifest.xml`, a deliberate copy-paste since it
changes media-button routing for the whole app.

The service rebuilds the session from a **native** mirror of the persisted
snapshot — no JavaScript involved — posts the notification with the right track
inside the foreground-service deadline, and *then* boots your runtime behind it;
the `play` the user pressed is replayed on your handler once it arrives.
Measured from a killed process: notification up 59 ms after the OS granted the
start, audio playing from the persisted position at 377 ms.

The requirement that catches everybody: **`MediaService.init(...)` must be
reachable at JS module scope**, not inside a component or a hook. A revived
runtime loads your bundle and mounts nothing, so an `init` in a `useEffect`
never runs — the library waits 10 s, logs exactly that, and stops the service.
[`apps/example/App.tsx`](apps/example/App.tsx) does it the right way.

**Where iOS fits.** Persistence is identical on both platforms; only the
*consumer* differs. Android's OS reads the record automatically; on iOS the user
does, by launching the app, and the restore puts them back on the same track and
position, paused. There is no iOS twin of `playbackResumption` and there cannot
be one — a terminated iOS app stays terminated. Platform policy, not a gap.

The full story, including the honest edges:
[persistence](packages/media-session/README.md#surviving-process-death-withpersistence)
· [resumption](packages/media-session/README.md#playback-resumption-after-process-death)
· [sleep timer](packages/media-session/README.md#sleep-timer-native)
· [foreground-service lifecycle](packages/media-session/README.md#android).

## Shape the sound

`setAudioFilters` compiles typed descriptors into mpv's own `af` grammar. Our
libmpv builds carry the same 16 LGPL audio filters on **both** platforms, so
nothing here needs a platform branch.

```ts
import { AudioFilters, EQUALIZER_PRESETS, equalizerPresetChain } from '@rn-media/player';

// 22 tuned 10-band presets (EQUALIZER_PRESET_LIST is picker-ordered), each with
// a pre-amp computed from the summed response, so a preset cannot clip.
player.setAudioFilters(equalizerPresetChain(EQUALIZER_PRESETS.rock));

// Or by hand: parametric bands, shelves, an 18-band FFT EQ, crossfeed,
// compressor, limiter, dynamic normaliser, loudnorm, volume.
player.setAudioFilters([
  AudioFilters.equalizer({ frequency: 60, widthType: 'o', width: 1, gain: 4 }),
  AudioFilters.crossfeed({ strength: 0.3 }),
  AudioFilters.limiter(),
]);
player.clearAudioFilters();

// Volume-domain loudness normalisation — independent of the filter chain.
player.setReplayGain({ mode: 'album', preamp: -3, fallback: -6 });
```

Filters, playback speed and ReplayGain never interact: mpv's speed handling sits
downstream of the user chain, and ReplayGain is volume-domain.
`defineEqualizerPreset` validates a user-designed curve; `AudioFilters.custom`
reaches any ffmpeg audio filter that is compiled in. Factory list, preset
mechanics, availability probe:
[filters and EQ](packages/player/README.md#audio-filters-and-eq) ·
[ReplayGain](packages/player/README.md#replaygain-loudness-normalisation).

## See the sound

A live spectrum of exactly this player's output, on **both platforms**, with no
permission to request and nothing to add to your manifest:

```tsx
const { frame, error } = useVisualizer(player, { bands: 28 });
// frame.bands — Float32Array in [0, 1], log-spaced and already smoothed
```

The samples come from mpv itself: our libmpv forks carry a small source patch
that exposes the audio the engine is handing to the device (`pcm-tap`,
`pcm-tap-frame`), tapped after the filter chain and after mpv's software gain —
so what you draw is what you hear, EQ and all. A native sampler thread
downmixes, windows and transforms it; the PCM never crosses into JavaScript and
only ~4 KB of spectrum does. Lazy end to end: nothing exists until something
subscribes, and the last unsubscribe frees all of it.

**The hook stops itself when nothing can be seen**, and that is a correctness
fix rather than a nicety: the frames are *native* callbacks, so unlike a JS
timer the platform does not freeze them behind a locked screen. On Android "can
be seen" is two signals ANDed — `AppState` **and** the display
(`PowerManager.isInteractive()` plus screen on/off, through this package's own
native object). One is not enough: on a Poco F4 soak `AppState` reported the app
active again with the display still off, and the visualizer burned 65-80 % of a
core in that window against 3.8 % for steady playback. On iOS the display signal
is a constant `true`, correctly — locking the phone backgrounds the app, so
there `AppState` already *is* the display truth. The imperative
`player.visualizer.subscribe()` is never gated; pausing belongs to the hook.

It needs binaries carrying that patch (Android `v1.1.9-rnmedia.3`+, iOS
`v0.7.2-rnmedia.3`+ — what this repo pins). On anything older
`player.visualizer.capabilities.fft` is `false` and subscribing throws a typed
`unsupported` error rather than doing nothing quietly. Full contract:
[visualizer](packages/player/README.md#visualizer-spectrum--waveform).

## Reach into mpv

The C++ binding is a complete, raw mpv client and the typed `Player` is TS on
top of it — so anything mpv can do, you can do, without waiting for us:

```ts
await player.command(['loadfile', uri, 'append-play']);
player.setPropertyString('af', 'loudnorm'); // any mpv option or filter string
player.observeProperty('demuxer-cache-time', 'number'); // arrives as a typed event
player.getPropertyNumber('demuxer-cache-duration');
player.getRawHandle(); // the mpv_handle, reserved for the future video plugin
```

`createMpvClient()` hands you the binding with no `Player` wrapper at all.

## We own the engine

Both libmpv binaries are ours, built from forks of media-kit's build scripts,
and their flags, pins and patches are **generated** from one workshop repo —
[`afkcodes/rn-media-engine`](https://github.com/afkcodes/rn-media-engine). Edits
happen there; `workshop sync --check` fails when a fork drifts, and `workshop
verify-artifacts` scores the **released** binaries of both platforms rather than
a build log — 12 slices × 10 categories = 120 cells, scored 0 FAIL on the parity
release, and its very first run is what caught the iOS simulator slice shipping
with no audio output compiled into it at all, four generations after the fact.

That machinery buys three things a wrapper around two platform players cannot:

**One configuration, not two.** mpv 0.41.0, FFmpeg 8.1.2 and mbedTLS 3.6.7 on
both platforms, configured exhaustively: **103 mpv options a side, 101
identical**, the only two that differ being the platform's own audio device
(`audiotrack` / `audiounit`). Parity is aligned *up*, never down — iOS gained the
eight cover-art decoders and the TrueHD decoder (it had the demuxer, so a `.thd`
demuxed cleanly and then failed to decode, which reads like a corrupt file rather
than a missing feature); Android gained zlib for compressed Matroska headers and,
because bionic has no `iconv(3)` before API 28 while the fork targets API 21, a
**statically vendored GNU libiconv 1.19** — so an ICY title or an old tag in
CP1251 or Shift-JIS decodes on both platforms instead of on iOS only. Switching
iconv *off* on iOS would have been the cheap parity, and it was reversed.

**Features upstream will not ship.** Two source patches, byte-identical between
the forks: the PCM tap behind the visualizer, and the prefetch hook behind
resolver-at-prefetch-time. Both are proven present in the *shipped* artifact by
strings only the patched code emits, and the release script refuses to package a
binary that lacks one.

**Size, attacked rather than excused.** The 0.41 engine bump cost +27 % on
Android and was written down here as a regression; the size release then took
back **−20.5 % on Android** (arm64 `libmpv.so`
9,233,464 → 7,338,952 bytes stripped, all four ABIs −19.9…−21.8 %) and
**−34.4 % off the iOS `Mpv` slice** (2,676,512 → 1,756,424 bytes), with zero
feature loss proven rather than argued: 62 assertions against the shipped jars,
a 50-assertion on-device engine harness A/B'd against the previous release, and
the same 50 on an emulated 16 KB-page system *with* a negative control — remove
the alignment flag and `dlopen` refuses the library, so the flag is observed
load-bearing rather than assumed. Stripping unwind tables (−437 KB more) was
declined on purpose: field crash diagnosis outranks bytes before 1.0.

### What it costs at runtime

Measured on a Poco F4 (Android 16), release build:

| | |
|---|---|
| Live HLS radio, screen off | **3.8 %** of one core |
| Cold start to a restored queue | **~1 s** |
| Gapless handover, identically encoded pair | **25 ms**, audio device never reopened |
| Network track boundary, prefetch on / off | **25 ms** / 644 ms plus an underrun |
| Synchronous mpv reads per event batch, worst case | **5**, flat (was 47 on a 20-tag FLAC) |
| Periodic bridge traffic while playing | none — position is projected, not streamed |

No iOS runtime numbers appear here, on purpose: nothing has run on an iOS device.

## Platform setup

**Android** — nothing to configure. The `media-session` library manifest merges
the foreground-service permissions and the `mediaPlayback` service into your
app. `POST_NOTIFICATIONS` is *not* required for media notifications.

**iOS** — add the background audio mode to `Info.plist`:

```xml
<key>UIBackgroundModes</key>
<array><string>audio</string></array>
```

**Expo** — works with the prebuild (managed) workflow, no manual native edits.
`@rn-media/media-session` ships the config plugin for the whole library; the
other two packages need none.

```json
{ "expo": { "plugins": ["@rn-media/media-session"] } }
```

```sh
npx expo prebuild --clean
npx expo run:android   # or run:ios, or an EAS build
```

It merges `UIBackgroundModes: audio` into `Info.plist` idempotently (a sibling
mode like `voip` survives); Android needs nothing. Its one option installs the
notification drawable — `["@rn-media/media-session", { "androidNotificationIcon":
"./assets/ic_notification.xml" }]` — the only way a prebuild app can add one,
since `android/` is regenerated. Expo Go cannot load this library; use a
development build. [Plugin reference](packages/media-session/README.md#expo-config-plugin).

## Requirements

- React Native **>= 0.82** (New Architecture; developed against 0.86)
- [`react-native-nitro-modules`](https://nitro.margelo.com)
- Android: minSdk **24**, compileSdk **36**. iOS: **15.1+**
- Prebuilt libmpv downloads at build time (Gradle task / podspec script), pinned
  by tag + SHA-256. Android, `arm64-v8a`: **3.63 MB** downloaded, **7,338,952
  bytes** of stripped `libmpv.so` (the other three ABIs are in the same band).
  iOS: `Mpv.framework`'s device slice is **1,756,424 bytes**, ≈7.1 MB
  across all ten frameworks. The engine bump to mpv 0.41 / FFmpeg 8 cost +27 %,
  the size release gave back −20.5 % (Android) and −34.4 % (iOS `Mpv`);
  ARCHITECTURE §11 records both directions.

## Limitations

- **No DRM**, by construction — libmpv has no Widevine/FairPlay. This library
  cannot power a licensed-catalog streaming app.
- **iOS has never been run on a device.** It compiles, links and embeds the
  frameworks in CI, and the shipped binary demonstrably carries the HLS demuxers
  and the filter set — but no on-device playback, background audio or
  lock-screen behaviour has been observed. Expected to work, not proven.
  (Android is device-verified, HLS included.)
- **Force-quitting on iOS kills playback**, and nothing may restart the app for
  audio afterwards — true of every iOS app, and the reason `playbackResumption`
  is Android-only. Relatedly, an iOS sleep timer armed over silence may never
  fire (iOS suspends a backgrounded process once audio stops, and a suspended
  process runs no timers — either mode's); armed while audio plays — the case
  that matters — it fires, because playing audio is exactly what keeps the
  process out of suspension.
- **No casting, deferred with a reason.** media3's `CastPlayer` replaces our
  engine with Google's, and there is no AirPlay path out of mpv at all — so a
  casting feature here would be Android-shaped and would hand playback to a
  different engine, which fails the parity gate this project is built on. Use the
  Cast SDK app-side; AirPlay audio still works through normal iOS routing.
- **No crossfade.** It was built, listened to on a device, and dropped by owner
  decision: mpv's gapless is an output-buffer guarantee, and the crossfade built
  on top of it was not good enough to ship. Loudness-aware fade points are
  recorded as the one revisit worth making. A competitor ships crossfade; we do
  not, and would rather say that than pretend the row does not exist.
- **Embedded cover art decodes, but cannot be extracted yet.** The eight
  cover-art decoders (bmp, gif, jpeg2000, jpegls, mjpeg, png, tiff, webp) are
  compiled into both binaries and mpv reports an attached picture through
  `track-list/N/albumart` — but there is **no API to get the bytes**, and the
  audio-only core is why: it runs `audio-display=no`, under which mpv never
  selects the attached-picture track at all (`player/loadfile.c:617`), and the
  only image-returning command in the client API, `screenshot-raw`, needs a
  configured video output, which this core deliberately never creates
  (`vid=no`, `force-window=no`). So the formats row above means "the stream
  decodes", not "you can render the artwork". Until this ships, read artwork
  from your own library/API and pass it as `MediaItem.artworkUri`. Local-file
  extraction is the gap to close, and it is native work rather than a
  TypeScript wrapper.
- **Persistence has two honest edges**: writes happen on broadcasts, so a track
  played straight through saves nothing until you call `service.save()`; and a
  live stream saves position `0`, because an offset into it has nothing to seek
  back to.

## Licensing

**This library: MIT.** The bundled libmpv/FFmpeg binaries are **LGPL v3** (built
with `--enable-version3`, never `--enable-gpl`) and **dynamically linked** —
`.so` in the APK, embedded dynamic xcframeworks on iOS, the App Store-accepted
pattern that satisfies the relink obligation. Ship your app's licenses screen
with the mpv/FFmpeg notices.

Both binaries come from our public forks of media-kit's build scripts —
[`libmpv-android-audio-build`](https://github.com/afkcodes/libmpv-android-audio-build/releases/tag/v1.1.9-rnmedia.8)
and [`libmpv-darwin-build`](https://github.com/afkcodes/libmpv-darwin-build/releases/tag/v0.7.2-rnmedia.7)
— both mpv 0.41.0 / FFmpeg 8.1.2 / mbedTLS 3.6.7, so the two platforms run one
engine, and both are generated from
[`rn-media-engine`](https://github.com/afkcodes/rn-media-engine). The delta versus
upstream is additive ffmpeg configure flags (the `hls`/`mpegts` demuxers, which
stock audio flavours omit, plus 16 audio filters) and two source patches (the PCM
tap behind the visualizer, the prefetch hook behind the source resolver). Every
GPL-gated ffmpeg filter is a *video* filter, so the LGPL line is untouched.
libmpv also links **libplacebo** (LGPL v2.1+, mandatory for mpv >= 0.37) and, on
Android, **GNU libiconv 1.19** (LGPL v2.1+) — both statically, inside the LGPL
libmpv that is itself dynamically linked, so the relink obligation still holds at
that boundary.

## Development

```sh
npm install                                # workspace root
npm test                                   # per package: cd packages/<p> && npm test
npm run typecheck                          # all three packages, strict
npm run test:cpp --prefix packages/player  # host C++ tests (EventBatch, lifecycle)
cd apps/example/android && ./gradlew :app:assembleDebug   # the example app
```

[`apps/example`](apps/example) is the reference integration and the on-device
test bed: a queue of live streams and files, focus wiring, EQ presets, pitch
and playback-mode controls, chapters, ±15 s jumps, the native sleep timer in
both modes, and session persistence across process death. It carries one
dependency the library does not (`react-native-mmkv`, purely as the persistence
storage) — exactly the point of the injected-storage contract.

[`CONTRIBUTING.md`](CONTRIBUTING.md) has the full loop — per-package tests, the
Android Gradle tasks CI runs, and what counts as verification here (device-free
for TS logic, a *physical* device for any playback claim).

[`ARCHITECTURE.md`](ARCHITECTURE.md) is the living record of every decision and
its evidence; [`PLAN.md`](PLAN.md) holds the analysis, and
[`docs/specs/`](docs/specs) the per-package contracts. The C++ core binds only
`mpv/client.h` — video arrives later as a separate opt-in plugin package with its
own binaries, at zero cost to audio-only users.

## Roadmap

The gate that unlocks shipping, in this order: **on-device iOS verification**
(playback, background audio, lock screen, HLS and the EQ chain on real hardware)
→ the naming decision → the first npm publish.

Next in the queue, owner-approved:

1. **React Native 0.87**, inside the two-week currency window the dependency
   policy sets.
2. **Android Auto**, with a CarPlay-symmetric API — a browse tree over the
   media3 `MediaLibraryService` already here, fanned into a JS handler the same
   way commands are. The CarPlay half lands when Apple hardware exists.
3. **`@rn-media/downloads`** — offline playback as a *source resolver* (local
   file when downloaded, CDN otherwise), so the player needs no changes at all.
4. Quick wins: `setLoudnessNormalization()` (loudnorm is already compiled in),
   LRC lyrics utilities over position projection, a prefetch-status hook.
5. Video as an additive plugin package — `VideoView`, its own binaries, zero
   core changes.

Investigations rather than promises: output-device routing. Pitch control used
to sit on this line, pending an LGPL filter path (rubberband is GPL and
therefore banned) — it shipped instead with no filter at all, as
`setPitch(ratio)` over mpv 0.41's first-class `--pitch`. Casting is deferred
with the reason in [Limitations](#limitations).
