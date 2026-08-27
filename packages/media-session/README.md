# `@afkcodes/timbre-media-session`

Player-agnostic media session for React Native: one JavaScript handler behind
every remote surface — notification, lock screen, Bluetooth, headset, watch,
Android Auto, CarPlay, Control Center — and three broadcast channels that all of
them, and your own UI, render from. Nitro Module, Kotlin + Swift, with **no
dependency on `@afkcodes/timbre-player`**: the handler interface is the whole contract,
so it works with any player that can make sound.

## Install

`npm install @afkcodes/timbre-media-session react-native-nitro-modules`

| Platform | Setup |
|---|---|
| Android | Nothing. The library manifest merges `FOREGROUND_SERVICE` + `FOREGROUND_SERVICE_MEDIA_PLAYBACK`, the `foregroundServiceType="mediaPlayback"` service, the Android Auto declaration and the artwork provider. `POST_NOTIFICATIONS` is **not** required — media notifications are exempt |
| iOS | `UIBackgroundModes: audio` in your `Info.plist`. A library cannot merge Info.plist keys; the [Expo plugin](#expo-config-plugin) writes it |
| Expo | `"plugins": ["@afkcodes/timbre-media-session"]`, then `npx expo prebuild --clean` |

## The model

**Fan-in**: every command surface funnels into one handler. **Fan-out**: three
broadcast channels are the only state source.

```ts
import { BaseMediaHandler, MediaService } from '@afkcodes/timbre-media-session'

class MyHandler extends BaseMediaHandler {
  async play() { await player.play() }
  async pause() { await player.pause() }
  async seekTo(position: number) { await player.seek(position) }   // ms
  async skipToNext() { /* your queue logic, may resolve URLs lazily */ }
}

const service = await MediaService.init(() => new MyHandler(), {
  jumpForwardSeconds: 30,   // both platforms; default 15/15
  android: { notificationChannelId: 'playback', notificationChannelName: 'Playback' },
})

service.setQueue([{ id: '1', title: 'Track' }, { id: '2', title: 'Next' }])
service.setMediaItem({ id: '1', title: 'Track', artist: 'Someone', duration: 214_000 })
service.setPlaybackState({
  status: 'playing',
  position: { value: 0, at: Date.now(), rate: 1 },   // an anchor, not a stream
  controls: ['skipToPrevious', 'pause', 'skipToNext'],
  capabilities: ['play', 'pause', 'seek', 'skipToNext', 'skipToPrevious'],
  queueIndex: 0,
})
```

`setMediaItem` **merges over the queue entry at `queueIndex`**, field by field,
and only when the ids match; if they disagree the queue entry wins and
`metadataMismatch` is raised. Commands are native-first: a notification button
moves the native state machine first and calls your handler after, so nothing
changes on any surface until your next broadcast
([ARCHITECTURE §9](../../ARCHITECTURE.md#9-commands-are-native-first-js-is-notified-never-awaited)).

## API

### Service

| | what it does | notes |
|---|---|---|
| `MediaService.init(factory, config?)` | Wires the handler to every remote surface | Returns `Promise<MediaServiceApi>`; throws `alreadyInitialized` if called twice without a `stopService()` |
| `setPlaybackState(state: PlaybackState): void` | Channel 1 | `{ status, position, bufferedPosition?, controls?, capabilities?, customActions?, compactControlIndices?, queueIndex?, errorMessage?, repeatMode?, shuffleEnabled? }` |
| `setMediaItem(item?: MediaItem): void` | Channel 2 — merges over the queue entry at `queueIndex` | `{ id, title, artist?, album?, artworkUri?, duration?, genre?, albumArtist?, trackNumber?, discNumber?, year?, subtitle?, isLive?, extras? }` |
| `setQueue(items: MediaItem[]): void` | Channel 3 | Duplicate ids are legal; position is carried by `queueIndex` |
| `setRemotePlayback(remote?): void` | Declares the audio is coming out of another device | `{ volume, muted?, steps?, volumeControl?, routingControllerId?, holdLocalAudioSlot? }`; call with nothing to take it back |
| `setSleepTimer(seconds)` / `setSleepTimerToTrackEnd()` / `cancelSleepTimer()` / `getSleepTimer()` / `getSleepTimerRemaining()` | A native countdown, and its state as `{ mode: 'duration', remainingSeconds } \| { mode: 'trackEnd', remainingSeconds? }` | `setSleepTimer` rejects `0`, negatives, `NaN` and `Infinity` — "cancel" and "pause now" already have names. A `trackEnd` timer may legitimately have no number, which `getSleepTimerRemaining()` alone cannot tell from "not armed" |
| `setResumptionSnapshot(snapshot?)` / `stopService()` | Write the native mirror by hand; end background execution | `withPersistence` writes the mirror for you, and it is a no-op on iOS. `stopService()` is the only way to end background execution, and does not forget the persisted session |
| `invalidateBrowse(parentId?)` / `getCarConnection()` | The car's list changed; who is connected | Android `notifyChildrenChanged`, CarPlay rebuilds the visible template; omit the id for everything. `CarConnection` is `{ kind: 'none' \| 'androidAuto' \| 'automotiveOs' \| 'carPlay' }`, with the reactive twin `useCarConnection()` |
| `MediaControl` | `'play' \| 'pause' \| 'stop' \| 'skipToNext' \| 'skipToPrevious' \| 'fastForward' \| 'rewind' \| 'repeatMode' \| 'shuffle'` | Buttons, in order. Spelled `repeatMode` because every union member becomes a native enumerator and `repeat` is a Swift keyword |
| `MediaCapability` / `MediaPlaybackStatus` | `'play' \| 'pause' \| 'stop' \| 'seek' \| 'skipToNext' \| 'skipToPrevious' \| 'skipToQueueItem' \| 'setRate' \| 'setRepeatMode' \| 'setShuffle'`; `'playing' \| 'paused' \| 'buffering' \| 'stopped' \| 'error'` | The commands your handler will service, and the status you broadcast |
| `BrowseItem` / `BROWSE_ROOT` | One node of the car tree, and the id `getChildren` receives for the root | `{ id, title, subtitle?, artworkUri?, browsable?, playable?, childStyle?, group?, explicit?, completion?, mediaType? }` — an item may be **both** browsable and playable. The root's children are the car's tabs: ≤ 4, browsable only |
| `BrowseError` | Throw it from any browse method | `new BrowseError('authenticationExpired', msg, { label, url })` shows the car's sign-in screen. Codes: `authenticationExpired \| premiumAccountRequired \| notAvailableInRegion \| parentalControlRestricted \| notSupported` |

### Handlers

`MediaHandler` is `play`, `pause`, `stop`, `seekTo(ms)`, `skipToNext`,
`skipToPrevious`, `skipToQueueItem(index)`, `setRate(rate)`, `onTaskRemoved`,
`customAction(name, extras?)`, the car trio `getChildren(parentId)` /
`getMediaItem(id)` / `playFromMediaId(id)`, and the optional
`playFromSearch(query, focus)`, `search(query)`, `onSetRepeatMode`,
`onSetShuffle`, `onSetDeviceVolume`, `onAdjustDeviceVolume`, `onSetDeviceMuted`,
`onSleepTimer`, `onPlaybackResumption`, `onSessionError`. The *absence* of the
two search methods is advertised: voice play answers `ERROR_NOT_SUPPORTED` and
Auto draws no search tab, rather than one that answers nothing.

| | |
|---|---|
| `BaseMediaHandler` / `CompositeMediaHandler` | Every method defaulted — override what you use; or a decorator: override one method, `super` the rest |
| `QueueHandler` / `withQueueHandling(Base)` | Default `skipToNext`/`skipToPrevious`/`skipToQueueItem` arithmetic over the queue you broadcast (wraparound, empty and single-item queues, stale indices); you implement `playQueueItem(item, index)`. It does not restart the track when more than 3 s in — that needs player state it does not have |
| `MediaSessionError` / `logSessionError(error)` | The thrown error type, and the default `onSessionError` behaviour |

### Persistence

| | |
|---|---|
| `withPersistence(service, storage, options?)` | Tee decorator; adds `save()`, `flush()` and `clear()` |
| `restorePersisted(storage, options?)` | `Promise<RestoreResult>` — `'restored' \| 'empty' \| 'unsupportedVersion' \| 'corrupt'`, never a throw |
| `applyPersisted(service, session)` | Re-broadcast in the order the channels expect |
| `clearPersisted(storage, options?)` | Forget the saved session (**storage only**) |
| `PERSISTENCE_SCHEMA_VERSION`, `DEFAULT_PERSISTENCE_KEY`, `DEFAULT_AUTOSAVE_INTERVAL_MS` (`30_000`), `MIN_AUTOSAVE_INTERVAL_MS` (`1_000`) | Schema and timing constants. `options` is `{ key?, onError?, now?, autosave? }`; only `withPersistence` reads `autosave` |

## Platform parity

Everything works the same on both platforms **except** the rows below. Each is a
platform ceiling, also stated in the member's own TSDoc.

| Member | Android | iOS | Why |
|---|---|---|---|
| `customActions` / `MediaHandler.customAction` | notification overflow buttons + `SessionCommand`s | **nothing renders, handler never fires** | `MPRemoteCommandCenter`'s command set is fixed and closed, and nothing in it carries an app-defined id ([command list](https://developer.apple.com/documentation/mediaplayer/mpremotecommandcenter)) |
| `capabilities: ['skipToQueueItem']` | `COMMAND_SEEK_TO_MEDIA_ITEM` — Auto, Wear, car head units | **never reached from a remote surface** | no queue-jump command exists in that list. It still works from your own UI, and from CarPlay's Up Next |
| `bufferedPosition`; `compactControlIndices` | secondary bar behind the scrubber; the ≤3 collapsed notification slots | both ignored | no buffered-position key exists, and iOS has no button layout at all |
| `status: 'stopped'` / `'error'`, `errorMessage` | distinct media3 states + a real `PlaybackException` | **indistinguishable from `paused`**, message dropped | the only state lever iOS gives an app is the playback *rate*; `MPNowPlayingInfoCenter.playbackState` is documented as macOS-only |
| `year`, `subtitle`, `extras` on `MediaItem` | `setReleaseYear` / `setSubtitle` / `MediaMetadata` `Bundle` | carried + persisted, **not published** | no such key exists — see [Metadata fields](#metadata-fields) |
| `setRemotePlayback(...)` | hardware volume keys drive the other device | accepted, changes nothing | iOS gives an app no way to take over the volume buttons — see [Remote playback](#remote-playback-hardware-volume-keys-drive-the-other-device) |
| `android.*` config, `onRevivalRequested`, `onTaskRemoved`, `onPlaybackResumption`; `ios.supportedPlaybackRates`, `ios.artworkCacheSize` | the foreground service, its notification and its revival; not applicable | not applicable; the lock screen's rate list and the decoded-artwork cache | iOS has no service and a terminated iOS app stays terminated; media3 takes an arbitrary float, draws no rate control, and owns its own artwork cache |
| `MediaHandler.search` | Auto's search tab, and the `SEARCH_SUPPORTED` flag that draws it | **never called** | CarPlay audio apps have no search template. A missing surface, not a missing feature |
| `BrowseItem.childStyle`, `group` | Auto content style (list / grid / category) and group headings | `childStyle` ignored, `group` becomes a `CPListSection` header | a `CPListTemplate` is always a list; there is no grid |

## Broadcast rules

| Rule | Detail |
|---|---|
| `capabilities` are what your handler will service | On Android they become `Player.Command`s and media3 *never* invokes a handler for an undeclared command; on iOS they enable `MPRemoteCommandCenter` commands |
| `controls` are which buttons you want, in order | Android maps them to media3 media-button preferences, with `compactControlIndices` (≤3) picking the collapsed notification's slots; iOS has no button layout and simply unions the two lists. Declare a capability for every button you ask for — the package adds the command anyway, but the handler still has to do the work |
| `position` is `{ value, at, rate }`, not a number you keep pushing | `value` in ms, `at` from `Date.now()`, `rate` `0` while paused. Broadcast it **only on a discontinuity** — seek, play, pause, rate change, track change. Both platforms project it natively, so the lock-screen seekbar moves with zero bridge traffic ([ARCHITECTURE §7](../../ARCHITECTURE.md#7-position-is-never-streamed--anchors--projection)) |
| `MediaItem.id` is stable per **source** | Derive it from the catalogue id or the URI, never from a queue position or a counter. `restorePersisted` matches by id, so a per-insertion id does not exist after a cold start; and duplicates are legal, because media3's timeline uids are built as `"$index:$id"` |
| Pressing a repeat or shuffle toggle changes nothing by itself | It calls `onSetRepeatMode(mode)` / `onSetShuffle(enabled)`; the state and the icon move only when you broadcast. The **capability** alone lights up Auto, Wear and third-party controllers, which read `Player.repeatMode` directly; the phone's notification needs the **control** too, because media3's default provider draws only previous / play-pause / next |
| `isLive: true` drops the scrubber; `extras` is string → string | `isLive` works even when a duration is also present, and omitting it keeps the "no duration means live" rule. `extras` crosses an Android `Bundle` and a JSON round trip through persistence, so anything richer comes back as `unknown` — stringify at the edge |
| `jumpForwardSeconds` / `jumpBackwardSeconds` (15/15) drive `fastForward` / `rewind` | Identically on both platforms, resolved natively into an absolute `seekTo`, so there is no `fastForward` method to implement and no way for the two to disagree ([ARCHITECTURE §23](../../ARCHITECTURE.md#23-remote-surface-parity-one-jump-interval-repeatshuffle-on-both-sides-and-an-honest-metadata-table)) |

## Metadata fields

| Field | Android (media3 `MediaMetadata`) | iOS (`MPNowPlayingInfoCenter`) |
|---|---|---|
| `albumArtist` | `setAlbumArtist` | `MPMediaItemPropertyAlbumArtist` — sent; Apple documents no list of the keys it actually renders, so no promise is made that it is drawn |
| `trackNumber` / `discNumber` | `setTrackNumber` / `setDiscNumber` | `MPMediaItemPropertyAlbumTrackNumber` / `…DiscNumber` |
| `year` | `setReleaseYear` | **no key exists** — the one date-shaped key is an `NSDate`, so a synthesised "1 January *year*" would be a fabricated precision |
| `subtitle` | `setSubtitle` (the notification's content text) | **no third line exists** — the remaining free-text keys all mean something else |
| `isLive` | drops the duration + seekability, `isDynamic` timeline | `MPNowPlayingInfoPropertyIsLiveStream` |
| `extras` | `MediaMetadata` `Bundle` (reaches third-party controllers) | **no key exists** |

Fields with no iOS key are still carried through the session and through
`withPersistence`; they are simply not published to a key that means something
else.

## Session errors: `onSessionError`

An argument you got wrong throws synchronously as a `MediaSessionError`. Most of
what can go wrong here happens where no call is waiting — a media3 service
callback, an `MPRemoteCommandCenter` target, a late artwork download — so those
get a channel
([ARCHITECTURE §28](../../ARCHITECTURE.md#28-failures-with-no-caller-get-a-channel-not-a-log-line)).
`onSessionError(error: SessionError)` takes `{ code, severity, message }`;
implementing it is optional, since every failure still reaches `console.error`.
It cannot take the session down, and nothing here is retryable from JS. Branch on
`severity` — `'fatal'` (background playback is not going to work) or `'degraded'`
(a surface shows less than you asked for) — rather than on `code`.

| `code` | `severity` | Meaning |
|---|---|---|
| `backgroundPlaybackUnavailable` | fatal | Android: the OS refused the foreground service, so playback runs on with no notification and an unprotected process. iOS: `Info.plist` has no `audio` in `UIBackgroundModes` |
| `playbackResumptionFailed` / `playbackResumptionNotWired` | fatal | A resumption started and never finished — and its cause: the runtime is alive and `MediaService.init(...)` has not been called. The message names which wiring is missing, the entry-file import or `android.onRevivalRequested`, and both are delivered to the *next* `init` |
| `playbackResumptionUnavailable` / `artworkFailed` / `iconNotFound` | degraded | `playbackResumption` is on but inert (no `MediaButtonReceiver` in the manifest, or the mirror could not be written); artwork could not be fetched or decoded (once per URI); a drawable name does not resolve, so a fallback icon is drawn (once per name) |
| `metadataMismatch` / `localAudioSlotUnavailable` / `browseRootRejected` | degraded | `setMediaItem` does not describe the current queue entry, so the merge did not happen and its `duration` — and the scrubber — was dropped; `holdLocalAudioSlot: true` but the silent output would not open, so the opt-in is inert; a root entry was dropped for exceeding the four-tab cap or for not being browsable, naming each one |

## Remote playback: hardware volume keys drive the other device

When the audio comes out of **another device** — a Cast receiver, a UPnP
renderer, any multi-room protocol — say so with
`setRemotePlayback({ volume: 0.4 })`, and take it back with
`setRemotePlayback()`. The phone's hardware volume keys then drive the remote
device instead of the phone's music stream, foregrounded, backgrounded or with
the screen off, and presses arrive as `onSetDeviceVolume` / `onSetDeviceMuted`.
Nothing here knows what a receiver is, and this package has no dependency on
`@afkcodes/timbre-cast`.

| Option / precondition | Detail |
|---|---|
| `volume` (required, `0..1`), `muted` (`false`) | Publish again on every volume change the backend reports, including the device's own knob: a key press steps from the **last published level**, so a stale one makes the next press jump |
| `steps` (`20`) | Notches one key press moves through. 20 is media3's own `RemoteCastPlayer.MAX_VOLUME`, so a press feels like every other cast-enabled Android app |
| `volumeControl` (`'absolute'`) | `'absolute'` converts a press to a level and delivers `onSetDeviceVolume` — write one method, not two. `'relative'` delivers `onAdjustDeviceVolume('up' \| 'down')`. `'fixed'` is readable, not writable: the volume shows and the keys do nothing |
| `routingControllerId` | Android: ties the system output switcher's slider to the route that is playing |
| `holdLocalAudioSlot` (`false`) | Holds a silent, looping `AudioTrack` for exactly as long as remote playback is published, reclaiming the volume-key slot after a system sound takes it. It keeps the audio HAL out of standby — measurable battery — and makes a press move the *phone's* volume in the not-playing case rather than doing nothing |
| Android routes volume keys to a session only while it is **playing**, and a system sound can take them away with the screen off | Paused, the keys go back to the phone's stream — the platform's own rule. With the screen off the platform prefers the last uid to play local audio, and the caller is the system itself; it is sticky, not momentary, the foreground case is immune, and `holdLocalAudioSlot: true` opts out |
| `setRemotePlayback` is **not** a fourth channel | It describes the output, not what is playing, and it is sticky: an ordinary `setPlaybackState` neither carries nor clears it. It is not persisted either, because a restored session must not route volume keys at a backend this process has no connection to |
| iOS is a documented no-op | `MPRemoteCommandCenter` has no volume command, `AVAudioSession.outputVolume` is read-only, and Google's Cast SDK documents the same limit for its own switch. The iOS answer is an in-app slider — write the call unconditionally: load-bearing on Android, harmless on iOS |

## Surviving process death: `withPersistence`

A paused, demoted foreground service is killable. Persistence tees the three
broadcast channels into storage, reads them back on the next launch, and
re-broadcasts
([ARCHITECTURE §19](../../ARCHITECTURE.md#19-background-hardening-persistence-is-injected-the-sleep-timer-is-native-the-fgs-grace-period-is-a-knob)).

```ts
import { MediaService, applyPersisted, restorePersisted, withPersistence } from '@afkcodes/timbre-media-session'

const service = withPersistence(await MediaService.init(() => new MyHandler(), config), storage)
const restored = await restorePersisted(storage)
if (restored.status === 'restored') applyPersisted(service, restored.session)
```

`storage` is anything with `{ getItem, setItem }`, sync or async. AsyncStorage
satisfies it as-is; MMKV and `expo-sqlite/kv-store` need two lines. This package
depends on none of them.

| Rule | Detail |
|---|---|
| Every broadcast writes | The three setters are the primary trigger, and they are already discontinuity-only; nothing polls a player and no state is read on a timer |
| Playback also checkpoints every 30 s | `{ autosave: { intervalMs } }`; `false` turns it off. One `setItem` per interval: a tick re-projects the anchor the app already broadcast, in JavaScript, and never crosses the bridge. It runs only while the last broadcast said `playing` and re-arms from the *last write*, so an app that broadcasts every ten seconds pays for no autosave writes. Intervals below 1 s are rejected. Android freezes JS timers once the Activity is gone, so autosave covers the foreground and `service.save()` covers the rest — call it on `AppState` leaving `active`, in `onTaskRemoved`, and before a deliberate `stopService()` |
| A **synchronous** storage is written inside the setter | An **asynchronous** one gets at most one write in flight, and snapshots produced while it is pending collapse into one follow-up, so a late `setItem` can never resurrect stale state. `service.flush()` resolves once everything has settled |
| A broadcast the service rejects is not persisted | Validation runs first, and restored payloads go through the same validators a live broadcast does. Write failures go to `options.onError` (default `console.error`), never swallowed, and one failure does not stop later writes |
| Every failure is a value, not a throw | `RestoreResult` is `restored` / `empty` / `unsupportedVersion` / `corrupt`; a failing storage engine *does* reject, because that is a broken dependency rather than bad data |
| The restored position is **always paused**, and a live entry persists position `0` | The anchor is projected to the write instant, `rate` set to `0`, and `playing` downgraded to `paused`; `at` is re-stamped on the way back in. So restoring never lies about where you were, never starts a foreground service, and is clamped to the track's duration — resume from a user gesture. A restored offset into a live stream has nothing to seek back to, and sleep-timer state is not persisted either |
| `service.clear()` also forgets the native mirror | The session then stops being offered as a System UI resumption card; `clearPersisted(storage)` touches storage only |

## Playback resumption after process death

**Android only, opt-in.** Lets the System UI resumption card, a Bluetooth
reconnect or a headset play button bring the whole app back — service,
notification, queue and position — from a process Android had killed. The service
reads the native mirror synchronously, rebuilds the media3 session, posts the
correct notification inside the foreground-service deadline, and only *then*
starts your runtime; the `play` the user pressed is held and replayed on your
handler
([ARCHITECTURE §20](../../ARCHITECTURE.md#20-playback-resumption-the-session-is-rebuilt-natively-first-and-javascript-is-booted-behind-it)).

| Requirement | Detail |
|---|---|
| `android.playbackResumption: true`, and `withPersistence(...)` | The flag is off by default, because this path starts a foreground service in a process the user did not open; `withPersistence` writes the snapshot the service reads, and nothing else does |
| `MediaService.init(...)` reachable at JS **module scope**, from a bare side-effect import in your entry file (`import './src/playback'`) | A revived runtime starts no surface, so nothing mounts and no effect runs; and Metro's release-mode inline requires defer a *binding* import to its first use, which for anything used inside a component is the first render. A bare side-effect import has no bindings to defer |
| `androidx.media3.session.MediaButtonReceiver` declared in your `AndroidManifest.xml`, with an `android.intent.action.MEDIA_BUTTON` intent filter | media3 reads the declaration as your app's promise that it can resume, so an AAR cannot merge it. Under Expo prebuild the plugin writes it: `["@afkcodes/timbre-media-session", { "playbackResumption": true }]` |
| `android.onRevivalRequested` | The same recovery for a process that is still **alive**: `stopService()` keeps the persisted session so the card stays, and module scope cannot run twice. Give it your idempotent "bring the session up" path. Test the whole thing with `am kill` — `am force-stop` removes the System UI card, which `am kill` does not |

A missing wiring is **reported, not merely logged**: `playbackResumptionNotWired`
about three seconds after the revived runtime comes up, then
`playbackResumptionFailed` at the 10 s deadline, both held for your next `init`
— and an `init` that arrives before the deadline throws the diagnosis away.
`onPlaybackResumption()` is optional and informational, and is where you would
refresh an expired stream token. A START_STICKY restart is not a resumption and
stops quietly, and `setResumptionSnapshot` is a no-op on iOS, where a terminated
app stays terminated.

## Sleep timer (native)

`setSleepTimer(seconds)` and `setSleepTimerToTrackEnd()` arm it;
`cancelSleepTimer()` clears it. End-of-track is the mode a JS timer cannot
express: the deadline is `(duration − projectedPosition) / rate`, computed
natively and re-armed on every broadcast, so a seek, pause, rate change or late
duration all move it. With no duration it arms with no deadline and waits for the
item to change — and when the item changes it fires.

| Detail | |
|---|---|
| Do not build this on `setTimeout` | React Native gates JS timers on the Activity lifecycle, so they stop firing exactly when a sleep timer matters. This one is a main-looper `Handler.postDelayed` on Android and a cancellable `DispatchQueue.main.asyncAfter` work item on iOS |
| The pause happens natively first | The session, notification and lock screen go to paused and your `pause` handler is invoked; `onSleepTimer` reports something already done, so the default no-op is correct |
| Re-arming replaces, across modes; it never stacks | `cancelSleepTimer()` on nothing is a no-op. The timer is also cancelled by `stopService()` and by a dev reload. `getSleepTimerRemaining()` reads the clock the timer was scheduled against, so it cannot disagree with when the pause happens |
| **Android**: `postDelayed` counts in uptime, which does not advance in deep sleep | Playing audio holds the CPU awake, so uptime and wall time move together for the window that matters. `AlarmManager` would make this library demand `SCHEDULE_EXACT_ALARM` from every consumer |
| **iOS**: a timer armed over silence cannot be relied on | iOS suspends a backgrounded process shortly after its audio stops. Armed while audio plays — the case that matters — it fires |

## Android

media3 `MediaLibraryService` with a `SimpleBasePlayer` facade whose `State` is
built from the broadcast — which is where the session, the notification, Android
Auto and Bluetooth come from
([ARCHITECTURE §10](../../ARCHITECTURE.md#10-media3-from-day-one-simplebaseplayer-as-the-facade)).

| `android.*` option | Detail |
|---|---|
| `notificationChannelId` / `notificationChannelName` / `notificationIcon` / `notificationColor` | The first two are required for the notification; the third is a drawable **name** in your app (under Expo prebuild use the plugin's `androidNotificationIcon`, because `android/` is generated). The colour is an **ARGB integer** — `0x1db954` is transparent black — and it is a hint, since Android 12+ media notifications derive their palette from the artwork |
| `stopForegroundOnPause` (default `true`) / `stopForegroundTimeoutMs` | The first demotes the service on pause: the notification stays, the service becomes killable — wrap in `withPersistence` if losing state matters. The second is the grace period before that demotion: omitted, media3's 10-minute default stands; `0` demotes immediately; above `600000` media3 clamps back down; a negative value is rejected here, because media3 would clamp it to `0`. Shorter frees the process sooner, longer makes a resume-from-notification more likely to find everything alive. Applied when the service is created, so a later `init` does not retro-fit a running one |
| `playbackResumption` / `onRevivalRequested` | [Playback resumption](#playback-resumption-after-process-death) |

The foreground service starts on the first `status: 'playing'` broadcast, not at
`init`, because Android 12+ forbids starting one from the background. Swiping the
app away calls `onTaskRemoved`, then keeps playing if the last broadcast said
`playing`, otherwise stops the service.

**Keeping JavaScript alive.** The runtime belongs to the `Application`, so it
survives Activity destruction while the foreground service keeps the process
resident; there is no second JS context and no headless task
([ARCHITECTURE §8](../../ARCHITECTURE.md#8-one-js-runtime-kept-alive-by-platform-primitives--no-headless-fork)).
That does not cover **process death** (persistence and resumption do), **JS
timers** (which stop once the Activity is gone — hence the native sleep timer and
`service.save()`), or a **dev reload**, which tears the session down first.

## iOS

- `MPRemoteCommandCenter` targets are added *and removed* to match
  `controls ∪ capabilities` exactly, and `MPNowPlayingInfoCenter` is written from
  all three channels with the same queue-entry-plus-merge rule as Android.
- The accessory scan commands (`seekForwardCommand` / `seekBackwardCommand`, the
  FF/RW key on a Bluetooth remote or a head unit) are bound alongside
  `skipForwardCommand` / `skipBackwardCommand`, because media3 answers both from
  one `COMMAND_SEEK_FORWARD`. A continuous scan has no Android twin.
- There is **no service**. The process lives while audio plays, which needs
  `UIBackgroundModes: audio`. Force-quitting kills everything — iOS policy.

## Android Auto

Nothing to install and nothing to declare: the package ships the
`com.google.android.gms.car.application` meta-data and the `automotive_app_desc`
XML the launcher looks for. You add the tree — `getChildren`, `playFromMediaId`,
optionally `search` / `playFromSearch`
([recipe](../../docs/recipes/in-the-car.md), [ARCHITECTURE §31](../../ARCHITECTURE.md#31-the-car-is-a-browser-that-taps-one-handler-a-per-controller-door-and-a-cache-that-outlives-js)).

| Rule the car imposes | Detail |
|---|---|
| The root is at most four browsable items | Google's own guidance, and the root supports `FLAG_BROWSABLE` only. Extra or playable root entries are dropped and reported as `browseRootRejected`; the same cap runs on iOS, from the same function |
| Artwork must be `content://` | Set `artworkUri` to an ordinary `https://` URL and the package rewrites it to a `content://` served by its own provider: download, downscale to the requested size, cache. `file://`, `content://` and `android.resource://` pass through, and only URLs your browse tree registered are served |
| A browse error is a screen, not an exception | Throw a `BrowseError` and the car draws its sign-in or upgrade screen, with an optional button that deep-links into your app. Auto's legacy browser renders only `authenticationExpired` and `parentalControlRestricted`; the other three come back as an empty list there, while CarPlay draws all five |
| A tap is not a `play` | It arrives as `playFromMediaId(id)` and nothing else; the duplicate `play()` media3 synthesises after a browse tap is swallowed. An unknown parent is an empty list, never an error |

`service.invalidateBrowse('albums')` evicts the cached answer and makes every
connected browser ask again; it is cheap and safe with no car connected. A car
that reconnects to a killed app is answered from a native cache (64 nodes / 2 MB,
on disk), and because the asker is a car the JS runtime is started behind it and
every cached parent is refreshed once your handler exists — a cold path that
needs `android.playbackResumption: true`. Test with the Desktop Head Unit
([`scripts/dhu.sh`](../../scripts/dhu.sh)) or a real `MediaBrowser`.

## CarPlay

The same `getChildren` / `playFromMediaId` handler, rendered as CarPlay tabs and
lists, plus the system Now Playing screen. You write no Swift.

### Two things your app must declare

CarPlay connects only to a **scene-based** app, and it is a managed capability;
both are app-level declarations a library cannot merge. With Expo, set
`carPlay: true` on the plugin (see [Options](#options)) and re-run
`npx expo prebuild --clean`. Bare projects add `UIApplicationSceneManifest` to
`Info.plist` naming this pod's `RnMediaCarPlaySceneDelegate` (the head unit) and
`RnMediaWindowSceneDelegate` (the phone), plus
`com.apple.developer.carplay-audio` in the entitlements. The phone-side delegate
is a shim: adopting scenes is all-or-nothing, so without it the app launches to
black. It goes away at React Native 0.88, and an app that already declares its
own window-scene delegate is left alone.

| `BrowseItem` field | CarPlay |
|---|---|
| `browsable` at `BROWSE_ROOT` | a tab (≤ 4; the car reports the real limit) |
| `browsable` elsewhere / `playable` / both | a row with a chevron that pushes a child list; a tap that calls `playFromMediaId` and shows Now Playing; or both at once |
| `title` / `subtitle` / `artworkUri` / `group` / `explicit` / `completion` | the row's two lines and its image (scaled to the car's `maximumImageSize`); a section heading over contiguous rows sharing a `group`; the explicit badge; the podcast-style progress bar |
| `childStyle` / `mediaType` | ignored — Android content-style hints with no CarPlay equivalent |

Nesting is capped at five levels (Apple's limit for non-food apps). A
`BrowseError` becomes a modal alert whose `resolution.url` opens **on the phone**.
Now Playing gains a repeat, shuffle or rate button for each of `setRepeatMode` /
`setShuffle` / `setRate` you advertise, and an Up Next list — your broadcast
queue, tapping through to `skipToQueueItem` — whenever the queue has more than
one entry. The Simulator needs only the Info.plist key (I/O → External Displays →
CarPlay); a real head unit also needs Apple to grant the entitlement.

## Expo config plugin

`{ "expo": { "plugins": ["@afkcodes/timbre-media-session"] } }` is the config plugin for
the whole library; `@afkcodes/timbre-player` and `@afkcodes/timbre-audio-session` need none
([ARCHITECTURE §16](../../ARCHITECTURE.md#16-expo-support-is-one-config-plugin-owned-by-media-session)).
With no options it merges `audio` into iOS `UIBackgroundModes` and changes
nothing on Android, where this package's manifest already merges what is needed.
The merge is additive and idempotent, and the plugin is wrapped in
`createRunOncePlugin`, so listing it twice applies it once. Bare projects need no
plugin: add `UIBackgroundModes` and the `MediaButtonReceiver` yourself, add the
two [CarPlay](#carplay) declarations, and drop the drawable into
`android/app/src/main/res`.

### Options

Passed as `["@afkcodes/timbre-media-session", { … }]`.

| Option | Default | Detail |
|---|---|---|
| `androidNotificationIcon` | none | Path, relative to the project root, of the drawable to install as the notification small icon. It exists because a prebuild app has no other way to add an Android resource. A `.xml` vector goes to `res/drawable/`; a `.png`/`.webp` goes to `res/drawable-xxxhdpi/`, where a 96×96 white-on-transparent source is the 24 dp the platform asks for. The file name without its extension is the resource name — pass that same string as `android.notificationIcon`, and it must be a valid Android resource name or the prebuild fails here rather than in `aapt2` |
| `playbackResumption` | `false` | Adds media3's `MediaButtonReceiver` to the generated manifest — the manifest half of [playback resumption](#playback-resumption-after-process-death). Set it **only** together with `android.playbackResumption: true` at `init`: the two are one feature, and the receiver alone only changes how media buttons are routed. Idempotent; a receiver you already declared is left alone |
| `carPlay` | `false` | Writes `UIApplicationSceneManifest` (this package's two scene delegates) into `Info.plist` and `com.apple.developer.carplay-audio` into the entitlements. Off by default because the scene manifest changes how *every* launch works, car or no car; a scene role you already declare is left alone |

## Also exported

| Group | Exports |
|---|---|
| Config | `MediaSessionConfig`, `AndroidMediaSessionConfig`, `IosMediaSessionConfig`; `MediaCustomAction` — `{ name, title, icon? }`; the defaults `DEFAULT_JUMP_SECONDS`, `DEFAULT_SUPPORTED_PLAYBACK_RATES`, `DEFAULT_REPEAT_MODE`, `DEFAULT_SHUFFLE_ENABLED`, `DEFAULT_STOP_FOREGROUND_ON_PAUSE`, `DEFAULT_PLAYBACK_RESUMPTION`, `DEFAULT_REMOTE_VOLUME_CONTROL`, `DEFAULT_REMOTE_VOLUME_STEPS`, `MAX_COMPACT_CONTROLS`, `MAX_STOP_FOREGROUND_TIMEOUT_MS` |
| Errors | `SessionErrorCode`, `SessionErrorSeverity`, `SESSION_ERROR_SEVERITY` (the channel, see [`onSessionError`](#session-errors-onsessionerror)); `MediaSessionErrorCode` — `'invalidArgument' \| 'alreadyInitialized' \| 'notInitialized'` (the thrown kind); `toSessionError` |
| The car | `BrowseStyle` — `'list' \| 'grid' \| 'categoryList' \| 'categoryGrid'`; `BrowseMediaType`; `BrowseErrorCode`; `isBrowseError(x)`; `MAX_ROOT_TABS` = `4`; `capRootTabs(items)`; `SearchFocus`; `CarConnection`; `useCarConnection` |
| Persistence, the queue helper and remote playback | `PersistedSession`, `PersistenceOptions`, `RestoreResult`, `PersistedMediaService`, `MediaSessionStorage`; `QueueHandlerOptions`, `QueueHandlerMethods`, `QueueBroadcaster`; `RemoteVolumeControl`, `RemoteVolumeDirection` |
| Validation | `normalizePlaybackState`, `normalizeRemotePlayback`, `validateQueue`, `validateAnchor`, `validateSleepTimerSeconds` — what `MediaService` runs on every broadcast, exported so a host can pre-check |
| Native layer | `RnMediaMediaSession`, `MediaSessionHandlers`, `NativeMediaItem`, `NativePlaybackState`, `NativeRemotePlayback`, `NativeSleepTimerState`, `MediaServiceController` — the Nitro contract, for a host that bypasses `MediaService` |
| Shapes | `PositionAnchor` — `{ value, at, rate }`; `SleepTimerMode` — `'duration' \| 'trackEnd'`; `MediaRepeatMode` |
| Config, state and factory | `MediaServiceConfig`, `PersistenceAutosaveOptions`, `RemotePlayback`, `SleepTimerState`, `createMediaService` (the un-decorated factory `MediaService.init` wraps) |

## Development

```sh
npm run codegen       # nitrogen + bob build
npm run typecheck     # tsc --noEmit (strict), src + plugin
npm test              # vitest — src and plugin suites; build:plugin builds the plugin
npm run test:android  # JVM suite        npm run lint:android  # android lint
```
