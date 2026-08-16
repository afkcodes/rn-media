# `@rn-media/media-session`

Player-agnostic media session for React Native: one JavaScript handler behind
every remote surface — notification, lock screen, Bluetooth, headset, watch,
Android Auto, Control Center — and one broadcast state that all of them (and
your own UI) render from.

Nitro Module, Kotlin + Swift. **No dependency on `@rn-media/player`**: the
handler interface is the entire contract, so this works with our player,
react-native-track-player, `expo-audio`, a TTS engine, or anything else that can
make sound.

## The model

**Fan-in** — every command surface funnels into one handler:

```ts
import { BaseMediaHandler, MediaService } from '@rn-media/media-session'

class MyHandler extends BaseMediaHandler {
  async play() { await player.play() }
  async pause() { await player.pause() }
  async stop() { await player.release() }
  async seekTo(position: number) { await player.seek(position) }
  async skipToNext() { /* your queue logic, may resolve URLs lazily */ }
  async skipToPrevious() { /* ... */ }
  async setRate(rate: number) { player.rate = rate }
  async onSetRepeatMode(mode: 'off' | 'one' | 'all') { /* then broadcast it */ }
  async onSetShuffle(enabled: boolean) { /* then broadcast it */ }
  async customAction(name: string, extras?: Record<string, unknown>) { /* ... */ }
}

const service = await MediaService.init(() => new MyHandler(), {
  android: {
    notificationChannelId: 'playback',
    notificationChannelName: 'Playback',
    notificationIcon: 'ic_notification', // drawable name in YOUR app
    stopForegroundOnPause: true,
    notificationColor: 0xff1db954,       // ARGB — include the alpha byte
  },
  ios: {
    // What the lock-screen rate control offers. iOS only; media3 takes an
    // arbitrary float and draws no rate control, so there is no list to hand it.
    supportedPlaybackRates: [1, 1.25, 1.5, 1.75, 2],
  },
  // How far the fastForward/rewind buttons jump, BOTH platforms. Default 15/15.
  jumpForwardSeconds: 30,
  jumpBackwardSeconds: 15,
})
```

**Fan-out** — three broadcast channels are the only state source:

```ts
service.setMediaItem({
  id: '1',
  title: 'Track',
  artist: 'Someone',
  duration: 214_000,
  // Optional extended tags — see "Metadata fields" below for what each
  // platform can actually render.
  albumArtist: 'Various Artists',
  trackNumber: 7,
  discNumber: 1,
  year: 1997,
  subtitle: 'Episode 12',
  isLive: false,
  extras: { source: 'library' }, // opaque, app-owned, string values
})

service.setQueue([{ id: '1', title: 'Track' }, { id: '2', title: 'Next' }])

service.setPlaybackState({
  status: 'playing',
  position: { value: 0, at: Date.now(), rate: 1 }, // ANCHOR, see below
  controls: ['skipToPrevious', 'pause', 'skipToNext', 'shuffle', 'repeatMode'],
  capabilities: [
    'play', 'pause', 'seek', 'skipToNext', 'skipToPrevious',
    'setRepeatMode', 'setShuffle',
  ],
  repeatMode: 'off',      // default 'off'
  shuffleEnabled: false,  // default false
  queueIndex: 0,
})

await service.stopService() // the ONLY way to end background execution
```

## Platform parity, in one table

Everything in the public API works the same on both platforms **except** the
rows below. Each one is a platform ceiling with a citation, not a to-do — and
every one of them is also stated in the TSDoc of the member itself, so a caller
never discovers a no-op at runtime. Anything not listed here behaves identically.

| Member | Android | iOS | Why |
|---|---|---|---|
| `customActions` / `MediaHandler.customAction` | notification overflow buttons + `SessionCommand`s | **nothing renders, handler never fires** | `MPRemoteCommandCenter`'s command set is fixed and closed, and nothing in it carries an app-defined id. `like`/`dislike`/`bookmark` are `MPFeedbackCommand`s with system heart/thumb icons and `rating` is a star rating — a wrong button is worse than a missing one ([command list](https://developer.apple.com/documentation/mediaplayer/mpremotecommandcenter)) |
| `capabilities: ['skipToQueueItem']` / `MediaHandler.skipToQueueItem` | `COMMAND_SEEK_TO_MEDIA_ITEM` — Auto, Wear, car head units | **never reached from a remote surface** | no queue-jump command exists in that same list |
| `bufferedPosition` | secondary bar behind the scrubber | ignored | no buffered-position key; `MPNowPlayingInfoPropertyPlaybackProgress` is a *watched-so-far* indicator, not a buffer |
| `status: 'stopped'` / `'error'`, `errorMessage` | distinct media3 states + a real `PlaybackException` | **indistinguishable from `paused`**, message dropped | the only state lever iOS gives an app is the playback *rate*. `MPNowPlayingInfoCenter.playbackState` exists on iOS 13+ but Apple documents it as *"This property only applies to macOS"* ([docs](https://developer.apple.com/documentation/mediaplayer/mpnowplayinginfocenter/playbackstate)) |
| `compactControlIndices` | picks the ≤3 collapsed notification slots | ignored | iOS has no button *layout*; commands are enabled or not and the system draws what it draws |
| `year`, `subtitle`, `extras` on `MediaItem` | `setReleaseYear` / `setSubtitle` / `MediaMetadata` `Bundle` | carried + persisted, **not published** | no such key exists — see [Metadata fields](#metadata-fields) |
| `setRemotePlayback(...)` | hardware volume keys drive the other device | accepted, changes nothing | iOS gives an app no way to take over the volume buttons — see [iOS: a documented no-op](#ios-a-documented-no-op) |
| `android.*` config, `onRevivalRequested`, `MediaHandler.onTaskRemoved`, `MediaHandler.onPlaybackResumption` | the foreground service, its notification and its revival | not applicable | iOS has no service, and a terminated iOS app stays terminated — see [The platform story](#the-platform-story-read-this-before-why-is-it-android-only) |
| `ios.supportedPlaybackRates`, `ios.artworkCacheSize` | not applicable | the lock screen's rate list; the decoded-artwork cache | media3 takes an arbitrary float and draws no rate control, and owns its own artwork cache |

Two things people expect to be on this list and are not, because they were
fixed rather than documented:

- **Queue-only broadcasts.** `setQueue` + `queueIndex` with no `setMediaItem`
  used to leave the iOS lock screen blank while Android showed the queue entry.
  Both platforms now resolve the current item the same way, and merge
  `setMediaItem` over the queue entry field by field — see
  [`setMediaItem`'s channel priority](#the-model).
- **The fast-forward / rewind key on a Bluetooth remote or a car head unit.**
  media3 answers it from the same `COMMAND_SEEK_FORWARD` as the on-screen
  button; MediaPlayer splits the two (`skipForwardCommand` vs
  `seekForwardCommand`) and only the first used to be bound, so the accessory key
  was dead on iOS. Both are bound now, and one press means one
  `jumpForwardSeconds` jump on both platforms.

## `MediaItem.id`: stable per **source**, and duplicates are fine

One rule, because two different mechanisms depend on it:

> Derive the id from the thing being played — its catalogue id, or its URI.
> Never from its position in the queue, and never uniquified with a counter or a
> timestamp.

**Duplicates are legal.** The same id may appear twice in a queue, and it
routinely does — "play next" on a track already in the queue produces exactly
that. Nothing rejects it and nothing breaks: position is carried by
`queueIndex`, and media3's timeline uids are built as `"$index:$id"`, so they
stay unique even when the ids do not.

**Where the id actually matters:**

1. **The channel-2 merge.** `setMediaItem` enriches the *current* queue entry
   field-by-field, and only when `item.id` equals the id of the entry at the
   broadcast `queueIndex`. Keying on the id *at a known index* is what keeps the
   merge well-defined when a queue contains duplicates — it never has to guess
   which copy you meant. If the ids disagree, the queue entry wins unchanged and
   Android logs the mismatch; the usual symptom is a missing scrubber, because
   `duration` is the field that normally arrives only through `setMediaItem`.
2. **`restorePersisted`.** A restored record is matched back to your catalogue
   by id. Ids minted per *insertion* — `track-7#2`, `` `${id}-${Date.now()}` ``,
   an array index — no longer exist when the app cold-starts, so the match fails
   and the session comes back blank.

So suffixing ids to "avoid" duplicates breaks resumption and buys nothing,
because nothing here needed them unique in the first place.

```ts
// Wrong: unique per insertion, meaningless after a restart.
service.setQueue(tracks.map((t, i) => ({ id: `${t.id}-${i}`, title: t.title })))

// Right: the same source is always the same id, however many times it appears.
service.setQueue(tracks.map((t) => ({ id: t.id, title: t.title })))
```

## The position anchor

`position` is `{ value, at, rate }` — **not** a number you keep pushing.

- `value` — position in ms, `at` — `Date.now()` when you sampled it, `rate` —
  how fast it advances from then on (`0` while paused).
- Broadcast it **only on a discontinuity**: seek, play, pause, rate change,
  track change. Never on a timer.
- Both platforms project it natively: Android feeds it to
  `SimpleBasePlayer`'s position supplier, iOS to
  `MPNowPlayingInfoPropertyElapsedPlaybackTime` + `...PlaybackRate`. The
  seekbar on your lock screen moves with **zero** bridge traffic.

Native converts `at` out of the wall clock and into a monotonic clock the
instant the broadcast arrives, so an NTP step cannot corrupt the projection.

## `controls` vs `capabilities`

- **`capabilities`** — what your handler will actually service. On Android these
  become `Player.Command`s; media3 *never* invokes a handler for a command that
  is not declared. On iOS they enable `MPRemoteCommandCenter` commands.
- **`controls`** — which buttons you want, in order. Android maps them to media3
  media-button preferences; `compactControlIndices` (≤3) picks the ones that get
  the collapsed notification's slots. iOS has no button layout, so `controls`
  and `capabilities` are simply unioned into the enabled command set.

Declare a capability for every button you ask for; the package is generous and
adds the command anyway, but the handler still has to do the work.

## Repeat and shuffle

Two halves, and you almost always want both:

```ts
service.setPlaybackState({
  // …
  capabilities: [/* … */ 'setRepeatMode', 'setShuffle'], // accept the commands
  controls: [/* … */ 'shuffle', 'repeatMode'],           // draw the buttons
  repeatMode: 'all',
  shuffleEnabled: true,
})
```

`repeatMode` / `shuffleEnabled` are **additive and optional**; omitted they are
`'off'` and `false`, which is what every surface showed before they existed.

**Pressing a toggle does not change anything by itself.** It calls
`onSetRepeatMode(mode)` / `onSetShuffle(enabled)` on your handler, and the state
(and the icon) move only when you broadcast the new `setPlaybackState` — the same
acknowledge-by-broadcast contract `play`/`pause` follow. Both handler methods are
optional, so adding them was not a breaking change for anyone implementing
`MediaHandler` structurally.

The **capability alone** lights up Android Auto, Wear and third-party
controllers, which read `Player.repeatMode` / `shuffleModeEnabled` directly. The
phone's notification needs the **control** as well: media3's
`DefaultMediaNotificationProvider` draws previous / play-pause / next and nothing
else, so without the control there is no button in the shade. The icon follows
the state (`ICON_REPEAT_OFF` / `_ONE` / `_ALL`, `ICON_SHUFFLE_ON` / `_OFF`), and
the two toggles take the secondary notification slots — never the central or
back/forward ones, which belong to transport.

The control is spelled `'repeatMode'`, not `'repeat'`, because every union member
becomes a native enumerator verbatim and `repeat` is a Swift keyword.

On iOS both map to `MPRemoteCommandCenter.changeRepeatModeCommand` /
`changeShuffleModeCommand`, and the current state is pushed onto
`currentRepeatType` / `currentShuffleType` on every broadcast. iOS's
`MPShuffleType.collections` (shuffle albums, keep tracks in order) has no
cross-platform twin and is read as "shuffle on" rather than dropped.

## Remote playback: hardware volume keys drive the other device

When the audio is coming out of **another device** — a Cast receiver, a UPnP
renderer, a multi-room protocol, anything the phone is not producing itself —
say so, and hand over that device's volume:

```ts
// while the remote backend owns playback
service.setRemotePlayback({ volume: 0.4, muted: false })
// …and when the phone takes it back
service.setRemotePlayback()
```

That is the whole API. In return, **the phone's hardware volume keys drive the
remote device instead of the phone's own music stream — with your app
foregrounded, backgrounded, or with the screen off** (with one platform
precondition on the screen-off case, spelled out below — read it before you
promise it to a user). Presses arrive on your handler:

```ts
class MyHandler extends BaseMediaHandler {
  override onSetDeviceVolume(volume: number) {   // 0..1
    void backend.setVolume(volume)
  }
  override onSetDeviceMuted(muted: boolean) {
    void backend.setMuted(muted)
  }
}
```

Nothing here knows what a receiver is. This package works with any player and
any output, and it has no dependency on `@rn-media/cast`.

### Why an Activity cannot do this

An app can intercept volume keys in `Activity.dispatchKeyEvent` — and that is
foreground-only *by construction*, because with the app backgrounded or the
screen locked there is no Activity to receive a key event. The routing has to
live on the **media session**, and Android's own contract for it is the feature:

> Configure this session to use remote volume handling. **This must be called to
> receive volume button events**, otherwise the system will adjust the
> appropriate stream volume for this session.
> — `android.media.session.MediaSession.setPlaybackToRemote`

`setRemotePlayback` is what gets you there: the session starts advertising
`DeviceInfo.PLAYBACK_TYPE_REMOTE`, media3 puts the platform session into remote
volume handling, and clearing it puts the keys back on the phone's stream with
nothing left behind.

### Two platform conditions, because both look like bugs

**1. Android routes volume keys to a session only while that session is
actually playing.** Paused, the keys go back to the phone's stream. That is the
platform's rule (`MediaSessionStack.getDefaultVolumeSession` keeps only sessions
whose `PlaybackState.isActive()`), not this package's.

**2. With the screen off, a system sound can take the keys away until you play
locally again.** `MediaSessionService.dispatchAdjustVolumeLocked` contains a
heuristic (b/275185436) that discards the chosen session when the *caller's* uid
was the last to play local audio. With the screen off the caller is
`PhoneWindowManager` — uid 1000, the system — so any system-played sound
(notification, ringtone) makes the platform prefer the phone's local stream.
Your session is dropped, and because a remote backend plays nothing on the local
`STREAM_MUSIC`, the key is discarded entirely: neither device moves.

It is sticky, not momentary — the platform's list never removes its head entry,
and an app whose audio is remote never plays locally to displace it. The
foreground case is immune, because a foregrounded `Activity` routes presses
straight to its own session by token, bypassing the heuristic.

Diagnose it in one command — the first `uid=` line is the value the heuristic
compares against:

```sh
adb shell dumpsys media_session | grep -A3 "Audio playback"
```

`uid=1000` at the top with the screen off means the next volume press will be
swallowed. Verified on Android 16 (API 36); the same code is in
`android15-release` and `main`.

#### Opting out of condition 2: `holdLocalAudioSlot`

The platform documents one escape, in the same file: when the head uid goes
**inactive**, the first still-**active** uid is promoted to the head. So an app
that keeps a local audio output active reclaims the slot as soon as the
interfering sound ends.

```ts
service.setRemotePlayback({
  volume: 0.4,
  holdLocalAudioSlot: true, // hold a silent local output while remote plays
})
```

This holds a silent, looping, zero-filled `AudioTrack` (`USAGE_MEDIA`,
`MODE_STATIC` at the device's native sample rate, deep-buffer path where the HAL
accepts it) for exactly as long as the remote playback is published — cleared
with it, never leaked. No writer thread, no periodic wakeup. It takes no audio
focus and never touches your player.

Two honest side effects: while it runs the audio HAL never enters standby (an
active track keeps the output powered — that is the battery cost, and no flag
removes it), and if your app *loses* audio focus the track is faded out like any
other `USAGE_MEDIA` player, so the slot is briefly given up while something else
is audible. Both self-heal.

**It is off by default, and that is deliberate.** It keeps a real audio output —
and so the audio HAL — awake for the whole remote session, which is measurable
battery for something the user only notices when they reach for the rocker. It
also makes `AudioSystem.isStreamActive(STREAM_MUSIC)` true, which *changes* the
remaining failure mode rather than only removing one: if the session is
discarded for condition 1 (not PLAYING), the key now moves the **phone's**
volume instead of doing nothing. Turn it on when lock-screen volume over a
remote device matters more than idle power; leave it off otherwise. No-op on
iOS, where the buttons cannot be taken over at all.

### Options, and their defaults

| field | default | what it is for |
| --- | --- | --- |
| `volume` | — | required, `0..1` |
| `muted` | `false` | |
| `steps` | `20` | how many notches one key press moves through. 20 is media3's own `RemoteCastPlayer.MAX_VOLUME`, so a press feels like every other cast-enabled Android app |
| `volumeControl` | `'absolute'` | what your backend can drive — see below |
| `routingControllerId` | — | Android: ties the system output switcher's slider to the route that is playing |

`volumeControl` decides which handler method a key press becomes, and it is
decided by **what you declared**, never by which methods you happen to have
defined (every `BaseMediaHandler` subclass inherits both, so sniffing would
silently kill the keys for the common case):

- `'absolute'` — the backend takes a level. A key press is converted here (one
  `1 / steps` notch from the last published volume, quantised and clamped) and
  delivered as `onSetDeviceVolume`. Cast, UPnP, essentially everything. **Write
  one method, not two.**
- `'relative'` — the backend can only be nudged: `onAdjustDeviceVolume('up' |
  'down')`, no level.
- `'fixed'` — readable, not writable. The volume shows on the remote surfaces
  and the keys do nothing, which is the honest rendering of a device whose
  volume you may not touch.

Publish again on every volume change the backend reports — including the remote
device's own physical knob — because a key press steps from the **last published
level**. A stale one makes the next press jump.

`setRemotePlayback` is deliberately **not** a fourth broadcast channel: it
describes the output, not what is playing, and it is sticky — an ordinary
`setPlaybackState` neither carries nor clears it. It is not persisted either
(`withPersistence` passes it straight through): which device the audio came out
of is a fact about a live session, and a restored one must not route volume keys
at a backend this process has no connection to.

### iOS: a documented no-op

Calling this on iOS is free and changes nothing, and that is a platform ceiling
rather than an omission. iOS gives an app no way to take over the hardware
volume buttons: `MPRemoteCommandCenter` has no volume command,
`AVAudioSession.outputVolume` is read-only, `MPVolumeView` renders the *system*
slider, and `AVRoutePickerView` is AirPlay — which the OS handles because an
AirPlay target is a *route*, and a network receiver is not. Google's Cast SDK
documents the same limit for its own
`GCKCastOptions.physicalVolumeButtonsWillControlDeviceVolume`: *"Due to changes
in iOS, controlling the volume of a Cast session using the physical volume
buttons is currently not supported for iOS 15+."*
([Cast iOS sender guide](https://developers.google.com/cast/docs/ios_sender/integrate))
The iOS answer is an in-app volume slider — which is what Google's own iOS cast
apps ship. Write the `setRemotePlayback` call unconditionally: load-bearing on
Android, harmless on iOS.

## Jump intervals

```ts
await MediaService.init(() => new MyHandler(), {
  jumpForwardSeconds: 30,   // default 15
  jumpBackwardSeconds: 15,  // default 15
})
```

These drive the `fastForward` / `rewind` controls and apply **identically on both
platforms** — Android through
`SimpleBasePlayer.State.Builder.setSeekForwardIncrementMs`, iOS through
`MPSkipIntervalCommand.preferredIntervals`. Both platforms resolve the increment
natively and deliver an absolute `seekTo` to your handler, so there is no
`fastForward` handler method to implement and no way for the two to disagree.

They exist because the two platforms *did* disagree: iOS pinned 15 s in both
directions while Android set no increment and inherited media3's
`C.DEFAULT_SEEK_BACK_INCREMENT_MS` (5 s) and `..._FORWARD_...` (15 s), so the same
JS call skipped back 5 s on Android and 15 s on iOS. The shared default is 15/15
— matching RNTP V4/V5 — and podcast and audiobook apps set 30 explicitly.

## Metadata fields

`MediaItem` carries `id`, `title`, `artist`, `album`, `artworkUri`, `duration`,
`genre`, plus these. **What each platform can render differs, and the table says
so rather than pretending:**

| Field | Android (media3 `MediaMetadata`) | iOS (`MPNowPlayingInfoCenter`) |
|---|---|---|
| `albumArtist` | `setAlbumArtist` | `MPMediaItemPropertyAlbumArtist` — a real key, sent; Apple documents no list of the keys `nowPlayingInfo` actually renders, so no promise is made that it is drawn |
| `trackNumber` | `setTrackNumber` | `MPMediaItemPropertyAlbumTrackNumber` |
| `discNumber` | `setDiscNumber` | `MPMediaItemPropertyDiscNumber` |
| `year` | `setReleaseYear` | **no key exists** — MediaPlayer has no year key at all, and the one date-shaped key, `MPMediaItemPropertyReleaseDate`, is an `NSDate`; a synthesised "1 January *year*" would be a fabricated precision |
| `subtitle` | `setSubtitle` (media3's notification content text) | **no third line exists** — the only free-text keys left (`Comments`, `Lyrics`, `PodcastTitle`, `ServiceIdentifier`) all mean something else |
| `isLive` | drops the duration + seekability, `isDynamic` timeline | `MPNowPlayingInfoPropertyIsLiveStream` |
| `extras` | `MediaMetadata` `Bundle` (reaches third-party controllers) | **no key exists** |

Fields with no iOS key are still carried through the session and through
`withPersistence`, so your app gets them back — they are simply not published to
a key that means something else. `year`, `subtitle` and `extras` are the three.

`isLive` is worth calling out: before it, the *absence of a duration* was the
only way to say "live", which conflated it with "I don't know the duration yet".
Setting `isLive: true` drops the scrubber even when a duration is also present.
Omitting it keeps the old rule exactly.

`extras` is **string → string**. It crosses an Android `Bundle` to third-party
controllers and a JSON round trip through persistence; a string map survives both
unchanged, and anything richer would come back as `unknown` anyway. Stringify at
the edge.

## Handler composition

```ts
import {
  BaseMediaHandler,
  CompositeMediaHandler,
  QueueHandler,
} from '@rn-media/media-session'

// Decorator: override one method, delegate the rest.
class Analytics extends CompositeMediaHandler {
  override play() { track('play'); return super.play() }
}

// Default queue navigation over the data you broadcast on channel 3.
class MyQueueHandler extends QueueHandler {
  async playQueueItem(item, index) { await player.load(item.id) }
}
const handler = new MyQueueHandler()
handler.wrapAround = true
handler.setQueue(items, 0) // stores AND broadcasts

await MediaService.init(() => new Analytics(handler))
```

`QueueHandler` gives you `skipToNext` / `skipToPrevious` / `skipToQueueItem`
index arithmetic (including wraparound, empty and single-item queues, and stale
indices from remote surfaces). It deliberately does *not* implement "restart the
track if more than 3 s in" — that needs player state it does not have; override
`skipToPrevious` and call `super` for the real skip.

## Surviving process death: `withPersistence`

A paused, demoted foreground service is **killable** (see [Android](#android)
below). When Android reclaims the process, your JS runtime — and with it the
queue, the current track and the position — goes with it. Persistence is the
mitigation: tee the three broadcast channels into storage, read them back on the
next launch, re-broadcast.

```ts
import {
  MediaService,
  withPersistence,
  restorePersisted,
  applyPersisted,
} from '@rn-media/media-session'

// 1. Wrap the service. Every broadcast from here on saves itself.
const service = withPersistence(
  await MediaService.init(() => new MyHandler(), config),
  storage,
)

// 2. On the next launch, read it back.
const restored = await restorePersisted(storage)
if (restored.status === 'restored') {
  applyPersisted(service, restored.session)   // queue → item → state
}
```

### Storage is yours; this package has no dependency

`storage` is anything structurally matching:

```ts
interface MediaSessionStorage {
  getItem(key: string): Promise<string | null> | string | null
  setItem(key: string, value: string): Promise<void> | void
}
```

Sync or async, both work. `@react-native-async-storage/async-storage` satisfies
it as-is; MMKV, `expo-sqlite/kv-store` and a `Map` need two lines:

```ts
import AsyncStorage from '@react-native-async-storage/async-storage'
withPersistence(service, AsyncStorage)

import { createMMKV } from 'react-native-mmkv'
const mmkv = createMMKV()
withPersistence(service, {
  getItem: (k) => mmkv.getString(k) ?? null,
  setItem: (k, v) => mmkv.set(k, v),
})
```

The library depends on none of them — the same reason `wireAudioSession` takes a
structural player rather than importing `@rn-media/player`.

### What is saved, and when

- **Writes happen on discontinuities only.** The only automatic trigger is one
  of the three broadcast setters, and those are already discontinuity-only by
  design. There are no timers here and no polling.

  The direct consequence, stated plainly: **a track played straight through
  produces no write**, so the saved position stays wherever the last
  play/seek/track-change left it. This package will not fix that with a timer —
  a periodic save is exactly the per-tick write the whole design exists to
  avoid, and on Android the JS timer driving it would freeze in the background
  anyway. Instead you choose the moment:

  ```ts
  import { AppState } from 'react-native'

  AppState.addEventListener('change', (next) => {
    if (next !== 'active') service.save()   // last moment JS is guaranteed to run
  })
  ```

  `service.save()` re-projects the live anchor to *right now* and writes, with
  no broadcast. Other good moments: `onTaskRemoved` (the app was swiped away),
  and just before a deliberate `stopService()`. Nothing can checkpoint a process
  killed without warning while playing in the background; the position then
  restores to the last checkpoint, which is a defensible answer and never a
  wrong one.
- A **synchronous** storage is written *inside* the setter, so the record is on
  disk before `setPlaybackState` returns. An **asynchronous** one gets at most
  one write in flight; snapshots produced while it is pending collapse into a
  single follow-up, so three channel broadcasts in one tick cost one round trip
  and a late `setItem` can never resurrect stale state. `service.flush()`
  resolves once everything has settled.
- A broadcast the service **rejects** is not persisted — validation runs first.
- Write failures go to `options.onError` (default `console.error`); they are
  never swallowed, and one failure does not stop later writes.

### The position is always restored paused

This is the part that is easy to get wrong. A persisted `{ value, at, rate: 1 }`
becomes a lie the instant the process dies: every surface projects
`value + (now − at) × rate`, so a session restored the next morning would claim
a position eight hours into the track.

So the record is frozen at write time — the anchor is projected to the write
instant, `rate` is set to `0`, and a `playing`/`buffering` status is downgraded
to `paused`. On the way back in, `at` is re-stamped to *now*. The consequences:

- restoring never lies about where you were, however long the gap;
- restoring never starts a foreground service (a `playing` broadcast is exactly
  what does that on Android — see below), so a cold launch is silent until the
  user presses play;
- the projection is clamped to the track's `duration` when one is known, so a
  long-lived `playing` state cannot restore past the end;
- **a live entry persists position `0`.** A missing `duration` is this
  package's live/unknown discriminator everywhere else (Android marks the
  timeline entry dynamic and draws no scrubber, iOS sets
  `MPNowPlayingInfoPropertyIsLiveStream`), and persistence uses the same one. A
  restored offset into a live stream is meaningless in every direction: there
  is nothing to seek back to, the number measures how long you *listened* rather
  than a place in the content, and `1:47:32` on a radio station you tuned in
  yesterday is the same class of lie as a running anchor. Both channels are
  consulted — an item without a duration still counts as finite if the matching
  queue entry has one.

Resume playback from a **user gesture**, not from the restore.

### Every failure is a value, not a throw

```ts
type RestoreResult =
  | { status: 'restored'; session: PersistedSession }
  | { status: 'empty' }                                          // first launch, or cleared
  | { status: 'unsupportedVersion'; found?: number; expected: number }
  | { status: 'corrupt'; reason: string }
```

A truncated write, an app downgrade, a user clearing storage — all ordinary
runtime conditions, so none of them throws; an app that has to `try/catch` its
cold start eventually will not. What *does* reject is a failing storage engine,
because that is a broken dependency and not bad data.

Restored payloads go through the **same validators a live broadcast does**, so
nothing that could not have been broadcast can be restored.

| Export | Purpose |
| --- | --- |
| `withPersistence(service, storage, options?)` | Tee decorator; adds `save()`, `flush()` and `clear()` |
| `restorePersisted(storage, options?)` | `Promise<RestoreResult>` |
| `applyPersisted(service, session)` | Re-broadcast in the order the channels expect |
| `clearPersisted(storage, options?)` | Forget the saved session (**storage only**) |
| `PERSISTENCE_SCHEMA_VERSION`, `DEFAULT_PERSISTENCE_KEY` | Schema constants |

`options` is `{ key?, onError?, now? }`. Sleep-timer state is deliberately *not*
persisted — see below. `service.clear()` and `clearPersisted(storage)` differ in
one way that matters once resumption is on: `clear()` also forgets the native
mirror, so the session stops being offered as a System UI resumption card.

## Playback resumption after process death

**Android only, opt-in.** Lets the System UI resumption card, a Bluetooth
reconnect or a headset play button bring the whole app back — foreground service,
notification, queue, position and all — from a process Android had killed.

```ts
const service = withPersistence(
  await MediaService.init(() => new MyHandler(), {
    android: {
      notificationChannelId: 'playback',
      notificationChannelName: 'Playback',
      playbackResumption: true,       // default false
    },
  }),
  storage,
)
```

```xml
<!-- your app's AndroidManifest.xml, inside <application> -->
<receiver android:name="androidx.media3.session.MediaButtonReceiver"
          android:exported="true">
  <intent-filter>
    <action android:name="android.intent.action.MEDIA_BUTTON" />
  </intent-filter>
</receiver>
```

On **Expo prebuild** that block is not yours to keep — `android/` is
regenerated — so the [config plugin](#options) writes it for you:

```json
["@rn-media/media-session", { "playbackResumption": true }]
```

Four requirements, and the library logs which one you are missing:

1. **`playbackResumption: true`.** Off by default — this path starts a foreground
   service in a process the user did not open.
2. **`withPersistence(...)`.** It writes the snapshot the service reads. Nothing
   else does.
3. **`MediaService.init(...)` reachable at JS *module scope*, in a module your
   entry file imports for its side effects:**

   ```js
   // index.js
   import './src/playback'   // ← this line is the requirement
   import App from './App'
   ```

   Two separate platform facts make the bare entry-file import the only form
   that works, and each kills resumption on its own:

   - A revived runtime loads your bundle and starts **no surface**, so nothing
     mounts and no effect ever runs — `init` in a component, hook or screen is
     dead code in that process.
   - Metro's release-mode **inline requires** (`inlineRequires: true`, the RN
     default) rewrites every *binding* import — `import { x } from './m'` —
     into a `require` at the first **use** of `x`. For anything used only
     inside a component, that first use is the first *render*, which a
     headless runtime never performs. So `App.tsx` importing your playback
     hook does **not** execute your playback module at boot, however
     module-scoped its `init` is. A bare side-effect import has no bindings to
     defer; the entry file is the one module guaranteed to run.

   This is the single most likely way to enable resumption and see it not
   work; the service waits 10 s, logs exactly this, and stops cleanly.
4. **`android.onRevivalRequested`** — the same recovery for a process that is
   still **alive**. `stopService()` ends background execution but deliberately
   keeps the persisted session (stop is not forget — see
   [persistence](#surviving-process-death-withpersistence)), so the System UI
   keeps offering its resumption card. Tapping play on it starts the service
   into a process whose module scope already ran and cannot run again; the
   service instead asks your app to re-run its init path:

   ```ts
   android: {
     playbackResumption: true,
     // Your idempotent "bring the session up" path — the same thing your
     // module scope runs. Only invoked while no init is up or in flight.
     onRevivalRequested: () => void playback.start(),
   }
   ```

   Without it, play on the card after a stop silently does nothing for 10 s
   and the service logs the reason.

### What actually happens

The persisted record is mirrored into native `SharedPreferences` on every write —
the same serialized string, so the two copies cannot drift. When the OS creates
the service into an empty process it reads that mirror **synchronously**, rebuilds
the media3 session from it, posts the notification with the right track inside the
foreground-service deadline, and only *then* calls `ReactHost.start()`. Your
runtime boots behind a notification that is already correct. The `play` the user
pressed is held and replayed on your handler once it arrives.

```ts
class MyHandler extends BaseMediaHandler {
  override onPlaybackResumption() {
    // Optional and informational. The notification is already up and `play()`
    // is about to be replayed on this handler — this is where you'd refresh an
    // expired stream token or log the event.
  }
}
```

Measured on device (Android 16, release build) from a killed process:
notification up **59 ms** after the OS granted the foreground-service start,
runtime up at 84 ms, `init` done at 254 ms, audio playing from the persisted
position at 377 ms.

### The platform story (read this before "why is it Android-only?")

Three layers, and only the middle one is platform-specific:

| Layer | Android | iOS |
| --- | --- | --- |
| Save + restore the session (`withPersistence` / `restorePersisted`) | ✅ identical | ✅ identical |
| Who consumes it | the OS: resumption card, Bluetooth, media button — **automatically**, no app launch | the **user**, by opening the app; `restorePersisted` puts them back on the same track, paused |
| Config flag | `android.playbackResumption` | none, and none is possible |

The cross-platform feature is persistence. `playbackResumption` only names the
extra thing *Android* can do with that same data. An iOS twin cannot exist: a
terminated iOS app stays terminated — a force-quit is read as the user's intent
that it stop, and no media button, Control Center press or route change may
resurrect a process for playback. That is Apple's policy, the same platform
reality as "force-quit kills playback", not a missing feature here. If it ever
changes, the flag has a natural home at `ios.playbackResumption`; it is
namespaced under `android` deliberately, so nobody later "fixes" the asymmetry by
hoisting it.

Honest edges:

- **`setResumptionSnapshot` is a no-op on iOS**, because the mirror only exists
  for a service that has to read it with no JS alive, and iOS has no such service.
  Your own `withPersistence` storage is untouched and is what the next launch
  restores from.
- **`adb shell am force-stop` removes the System UI resumption card**; `am kill` —
  what actually happens to a paused, demoted app — does not. Test with `am kill`.
- A **START_STICKY restart** (the OS bringing the service back on its own) is not
  a resumption and does not boot your app; it stops quietly.
- An `Application` that does not implement `ReactApplication` (brownfield) gets
  one warning and the pre-existing behaviour.

## Sleep timer (native)

```ts
service.setSleepTimer(30 * 60)      // pause in 30 minutes
service.setSleepTimerToTrackEnd()   // pause when THIS track finishes
service.cancelSleepTimer()

service.getSleepTimerRemaining()    // seconds, or undefined
service.getSleepTimer()             // { mode, remainingSeconds? } | undefined

class MyHandler extends BaseMediaHandler {
  override onSleepTimer() { /* already paused — clear your badge */ }
}
```

### End of current track

The mode most sleep-timer users actually want, and the one a JS timer cannot
express even in the foreground: "30 minutes" cuts a track in half, "end of this
track" does not.

A package with no playback engine still knows when a track ends, because the
broadcast channels already carry both numbers: the deadline is
`(duration − projectedPosition) / rate`, computed **natively** and re-armed on
every broadcast. A seek, a pause, a rate change or a duration that arrives late
all move it — and since broadcasts are discontinuity-only by design, that is
exactly the update rate this needs. Nothing polls, and nothing new crosses the
bridge.

Two cases it handles with no duration at all:

- **the current item changes** (the track ended and you advanced, or the user
  skipped) → it fires immediately, which is the honest reading of "stop after
  this one";
- **no duration was ever broadcast** (a live stream, or it has not arrived yet)
  → armed with no deadline, waiting for that item change.

Which is why `getSleepTimer()` exists alongside `getSleepTimerRemaining()`:

```ts
const timer = service.getSleepTimer()
if (timer?.mode === 'trackEnd') {
  badge(timer.remainingSeconds ?? 'end of track')  // may legitimately have none
}
```

`getSleepTimerRemaining()` returns `undefined` for an armed end-of-track timer
with no computable deadline, which a UI cannot tell apart from "not armed" —
`getSleepTimer()` can. A `'duration'` timer always has a number.

**Do not build this on `setTimeout`.** React Native's `JavaTimerManager` gates
JS timers on the Activity lifecycle plus headless tasks, so with the Activity
destroyed they stop firing — and Samsung freezes them even with one alive
(RN #56324). A sleep timer's entire job happens after the user has put the phone
down, which is precisely when JS timers do not run. So this one is a platform
timer: a main-looper `Handler.postDelayed` on Android, a cancellable
`DispatchQueue.main.asyncAfter` work item on iOS. Neither is tied to an Activity
and neither is a JS timer.

**When it fires, the pause happens natively first.** On Android the facade
player is paused through its own `Player.pause()` — the identical call a
notification or Bluetooth pause makes — so the session, the notification and the
lock screen go to paused immediately and your `pause` handler is invoked to stop
the audio. iOS does the same two steps explicitly (now-playing state, then the
handler), since it has no facade player. *Only then* is `onSleepTimer` called.
It is a notification of something already done, so the default no-op is correct:
an app that just wants "stop after 30 minutes" writes no handler code at all.

Details worth knowing:

- Re-arming **replaces**; it never stacks, and that is true across modes —
  `setSleepTimerToTrackEnd()` after `setSleepTimer(600)` leaves exactly one
  timer. `cancelSleepTimer()` on nothing is a no-op.
- `setSleepTimer` rejects `0`, negatives, `NaN` and `Infinity` with
  `MediaSessionError('invalidArgument')` — "cancel" and "pause now" both already
  have names.
- The timer is cancelled by `stopService()` and by a dev reload (the session is
  torn down through `ReactHost.addBeforeDestroyListener` before the runtime
  dies).
- It does **not** survive process death, and it is not persisted: restoring
  "37 minutes left" into a process that has just been born would be a fiction —
  the premise is an OS timer that has been counting the whole time.
- `getSleepTimerRemaining()` reads the same clock the timer was scheduled
  against (`SystemClock.uptimeMillis()` / `DispatchTime.now()`), so it cannot
  disagree with when the pause will happen. Polling it from a JS interval is
  fine: a visible screen has a live Activity, which is the one place JS timers
  work.
- **Android**: `Handler.postDelayed` counts in *uptime*, which does not advance
  in deep sleep. That is the right trade rather than a defect — playing audio
  holds the CPU awake, so uptime and wall time move together for the whole
  window that matters, and the alternative (`AlarmManager` with an exact alarm)
  would make this library demand `SCHEDULE_EXACT_ALARM` from every consumer.
- **iOS**, honestly: iOS suspends a backgrounded process shortly after its audio
  *stops*, and a suspended process runs no timers. A timer armed while audio is
  playing fires — playing audio is what keeps the process out of suspension, and
  the job is finished at the moment it fires. A timer armed over silence, or
  still pending when playback stops for another reason, cannot be relied on.
  There is no supported way around that.

## Platform notes

### Android

- **media3 `MediaLibraryService`** (`androidx.media3:media3-session`) with a
  `SimpleBasePlayer` facade whose `State` is built from the broadcast. media3
  gives us the session, the notification, Android Auto and Bluetooth for free.
- The library manifest merges in `FOREGROUND_SERVICE` +
  `FOREGROUND_SERVICE_MEDIA_PLAYBACK` and the service declaration
  (`foregroundServiceType="mediaPlayback"`). You do not have to add anything.
- `POST_NOTIFICATIONS` is **not** required — media-session notifications are
  exempt. Declare it only if your app posts other notifications.
- The foreground service starts on the first `status: 'playing'` broadcast, not
  at `init`: Android 12+ forbids starting one from the background.
- `stopForegroundOnPause: true` (default) demotes the service on pause. The
  notification stays; the service becomes **killable**. That is the documented
  trade-off — wrap the service in
  [`withPersistence`](#surviving-process-death-withpersistence) if losing state
  matters. Set `false` to stay in the foreground while paused.

  The demotion is **not instant**: media3 1.11 keeps the service foreground for
  a "user engaged" grace period after the pause
  (`MediaSessionService.DEFAULT_FOREGROUND_SERVICE_TIMEOUT_MS`, 10 minutes) and
  demotes only when it expires. So `dumpsys activity services` still reports
  `isForeground=true` right after pausing — measured on Android 16, media3
  1.11. That is media3's behaviour on every API level, and it is what keeps a
  resume-from-notification working.

- `notificationColor` sets the notification's accent, as an **ARGB integer**:

  ```ts
  android: { …, notificationColor: 0xff1db954 }
  ```

  Include the alpha byte — `0x1db954` is transparent black. Both signed
  (`-16777216`) and unsigned (`0xff000000`) spellings are accepted; they are the
  same 32 bits.

  Applied to `Notification.color` through a thin `MediaNotification.Provider`
  decorator, because `DefaultMediaNotificationProvider.createNotification` is
  `final` in media3 1.11 and its `Builder` exposes channel id, channel name,
  notification id and small icon — but no colour. Setting the field after media3
  has finished building is the only public lever, and it means nothing media3
  does can overwrite it.

  **It is a hint, not a guarantee**, and that is the platform's doing: pre-12
  shades tint the small icon and action text with it, while Android 12+ media
  notifications derive their own palette from the artwork and may ignore it
  entirely. Ignored on iOS, which has no colour surface at all — the lock
  screen's palette comes from the artwork, which is not ours to tint.

- `stopForegroundTimeoutMs` sets that grace period.

  ```ts
  android: { …, stopForegroundTimeoutMs: 60_000 }   // demote a minute after pausing
  ```

  Maps 1:1 onto `MediaSessionService.setForegroundServiceTimeoutMs(long)`
  (`@UnstableApi`, media3 1.11.0 —
  [source](https://github.com/androidx/media/blob/1.11.0/libraries/session/src/main/java/androidx/media3/session/MediaSessionService.java#L643-L668)),
  applied in the service's `onCreate`. Omit it and media3's default stands.

  | Value | Effect |
  | --- | --- |
  | omitted | media3's default: 10 minutes |
  | `0` | demote immediately on pause |
  | `1…600000` | that many milliseconds |
  | `> 600000` | media3 clamps it back down to 600000 — 10 minutes is the ceiling, not just the default |
  | `< 0` | rejected here, because media3 would silently clamp it to `0`, i.e. the opposite of what a negative is likely to mean |

  **Shorter** stops the process being protected sooner, so Android may reclaim
  it — and with it the JS runtime and your handler — minutes after a pause.
  Better for battery and memory pressure, and the honest choice for an app that
  does not expect to be resumed from the notification much later; pair it with
  `withPersistence`. **Longer** makes a resume-from-notification far more likely
  to find everything still alive, at the cost of holding a foreground service
  (and its process) for that whole window. Neither end is free, which is why
  there is no opinionated default beyond media3's.

  Applied when the service is created — the first `playing` broadcast. Calling
  `init` again with a different value does not retro-fit a running service.

- `playbackResumption` lets the service come back after the process is killed.
  Off by default; see
  [Playback resumption](#playback-resumption-after-process-death). Note that a
  service created *by a resumption* is configured from the **mirrored** config of
  the previous run, for the same reason as above: the app's real config is in
  JavaScript, which is what a cold start does not have yet.
- Swiping the app away: the JS `onTaskRemoved` handler is called, and the
  built-in policy keeps playing if the last broadcast said `playing`, otherwise
  it stops the service.

### Keeping JavaScript alive (Android)

The service calls your handler with no Activity in sight. That works because on
bridgeless React Native 0.86 the JS runtime belongs to the `Application`, not to
an Activity: `ReactActivityDelegate.onDestroy` bottoms out in
`ReactHostImpl.onHostDestroy`, which only moves the lifecycle state and drops the
Activity reference — it never touches the ReactInstance. Only an explicit
`ReactHost.destroy()` does that.

So the runtime survives Activity destruction by construction, and the foreground
service keeps the *process* resident. There is no second JS context and no
`HeadlessJsTaskService`: on 0.86 a headless task only runs a JS task, it cannot
pin the runtime, and this package has no background JS timers to keep warm
(position is projected natively).

What that does **not** cover:

- **Process death.** If Android kills the process, your handler is gone. By
  default a later media button starts the service into a process with no session;
  it logs and stops rather than showing a notification with dead buttons, and the
  state itself is not lost —
  [`withPersistence`](#surviving-process-death-withpersistence) saves the three
  channels on every broadcast and the next launch restores queue, track and a
  paused position. With
  [`playbackResumption: true`](#playback-resumption-after-process-death) that
  media button (or the System UI resumption card) instead rebuilds the session
  natively and boots your runtime behind it.
- **JS timers.** `setTimeout` inside your handler stops firing once the Activity
  is gone. That is an RN platform behaviour, not something this package can fix
  — which is why the [sleep timer](#sleep-timer-native) is native.
- A **dev reload** destroys the runtime. The session is torn down first via
  `ReactHost.addBeforeDestroyListener`, so you never get a live notification
  wired to a dead runtime.

### iOS

- `MPRemoteCommandCenter` targets are added *and removed* to match
  `controls ∪ capabilities` exactly — stale handlers are the endemic bug here.
- `MPNowPlayingInfoCenter` is written from all three channels: the queue entry
  at `queueIndex` is the base and `setMediaItem` is merged over it field by
  field, exactly as on Android (`NowPlaying.resolve` ↔ `Snapshot.timeline`).
  Artwork loads off the main thread and is cached.
- The two accessory scan commands (`seekForwardCommand` / `seekBackwardCommand`
  — the FF/RW key on a Bluetooth remote or a car head unit) are bound alongside
  `skipForwardCommand` / `skipBackwardCommand`, because media3 answers both from
  one `COMMAND_SEEK_FORWARD`. A press delivers one `jumpForwardSeconds` jump; a
  *continuous* scan has no Android twin, so it is not invented here.
- There is **no service**. The process lives while audio plays, which requires
  `UIBackgroundModes: audio` in *your* Info.plist (a library cannot merge
  Info.plist keys — the Expo config plugin below writes it for you).
  Force-quitting from the app switcher kills everything — that is iOS policy,
  not a bug here.
- `skipToQueueItem` and custom actions have no iOS remote surface. They still
  work from your own UI.

## Expo config plugin

This package ships the config plugin for the whole library — it is the package
that owns background playback, and it is the only one that needs anything an
Expo app cannot express by itself. `@rn-media/player` and
`@rn-media/audio-session` need no plugin.

```json
{
  "expo": {
    "plugins": ["@rn-media/media-session"]
  }
}
```

```sh
npx expo prebuild --clean
```

What it does:

| Platform | Change | Why |
| --- | --- | --- |
| iOS | merges `audio` into `UIBackgroundModes` | without it iOS suspends the app on backgrounding and the audio session is torn down mid-track |
| Android | nothing by default | this package's own manifest already merges the foreground-service permissions and the `mediaPlayback` service into the app |

The merge is additive and idempotent: existing modes such as `voip` survive, and
a plist that already lists `audio` is left alone, so re-running prebuild is a
no-op. The plugin is wrapped in `createRunOncePlugin`, so listing it twice (say,
directly and through another library) applies it once.

### Options

Everything above needs no options. Two are available:

```json
{
  "expo": {
    "plugins": [
      ["@rn-media/media-session", {
        "androidNotificationIcon": "./assets/ic_notification.xml",
        "playbackResumption": true
      }]
    ]
  }
}
```

`androidNotificationIcon` — path, relative to the project root, of the drawable
to install as the notification small icon. It exists because a prebuild app has
no other way to add an Android resource: `android/` is generated, so
`android.notificationIcon` in `MediaService.init` would have nothing to resolve
and media3 would silently fall back to its own icon.

- A **vector drawable** (`.xml`) is copied to `res/drawable/`; a `.png`/`.webp`
  is copied to `res/drawable-xxxhdpi/`, where a 96×96 px white-on-transparent
  source is the 24 dp the platform asks for (a raster in unqualified
  `drawable/` would be read as mdpi and upscaled 4×).
- The file name without its extension is the resource name — pass that same
  string as `android.notificationIcon`. It must be a valid Android resource
  name (lowercase, digits, `_`, letter-first); the plugin fails the prebuild
  rather than letting `aapt2` do it later.

`playbackResumption` — adds media3's `MediaButtonReceiver` to the generated
`AndroidManifest.xml`, the manifest half of [playback
resumption](#playback-resumption-after-process-death). Off by default, and set
it **only** together with `android.playbackResumption: true` at
`MediaService.init` — the two are one feature, and the receiver alone does
nothing but change how media buttons are routed.

- It is not merged in from the library's own manifest on purpose: media3 reads
  the declaration as your app's promise that it can resume, and an AAR cannot
  make that promise on behalf of every app that installs it.
- The mod is idempotent — a receiver you already declared is left exactly as it
  is, so repeated prebuilds and a hand-written declaration both stay put.

Bare React Native projects do not need the plugin at all: add
`UIBackgroundModes` to `Info.plist`, paste the `MediaButtonReceiver` block
above into `android/app/src/main/AndroidManifest.xml`, and drop the drawable
into `android/app/src/main/res` yourself.

## Development

```sh
npm run codegen       # nitrogen + bob build
npm run typecheck     # tsc --noEmit (strict), src + plugin
npm test              # vitest — src and plugin suites
npm run build:plugin  # tsc -p plugin → plugin/build (what app.plugin.js loads)
```

The Kotlin half has its own JVM suite — the resumption record parser, the
channel-priority merge, and the guard that keeps `ResumptionStore.SCHEMA_VERSION`
equal to `PERSISTENCE_SCHEMA_VERSION` in `src/persistence.ts`. It needs the
Android SDK (it runs through the example app's Gradle build) but no device, and
CI runs both of these on every Android-touching change:

```sh
npm run test:android  # :rn-media_media-session:testReleaseUnitTest
npm run lint:android  # :rn-media_media-session:lintRelease
```
