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
  async customAction(name: string, extras?: Record<string, unknown>) { /* ... */ }
}

const service = await MediaService.init(() => new MyHandler(), {
  android: {
    notificationChannelId: 'playback',
    notificationChannelName: 'Playback',
    notificationIcon: 'ic_notification', // drawable name in YOUR app
    stopForegroundOnPause: true,
  },
})
```

**Fan-out** — three broadcast channels are the only state source:

```ts
service.setMediaItem({ id: '1', title: 'Track', artist: 'Someone', duration: 214_000 })

service.setQueue([{ id: '1', title: 'Track' }, { id: '2', title: 'Next' }])

service.setPlaybackState({
  status: 'playing',
  position: { value: 0, at: Date.now(), rate: 1 }, // ANCHOR, see below
  controls: ['skipToPrevious', 'pause', 'skipToNext'],
  capabilities: ['play', 'pause', 'seek', 'skipToNext', 'skipToPrevious'],
  queueIndex: 0,
})

await service.stopService() // the ONLY way to end background execution
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
  trade-off — use a persistence decorator if losing state matters. Set `false`
  to stay in the foreground while paused.

  The demotion is **not instant**: media3 1.11 keeps the service foreground for
  a "user engaged" grace period after the pause
  (`MediaSessionService.DEFAULT_FOREGROUND_SERVICE_TIMEOUT_MS`, 10 minutes) and
  demotes only when it expires. So `dumpsys activity services` still reports
  `isForeground=true` right after pausing — measured on Android 16, media3
  1.11. That is media3's Android 14+ behaviour, and it is what keeps a
  resume-from-notification working.
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

- **Process death.** If Android kills the process, your handler is gone. A later
  media button starts the service into a process with no session; it logs and
  stops rather than showing a notification with dead buttons. Reviving a session
  across process death (playback resumption) is not a v1 feature.
- A **dev reload** destroys the runtime. The session is torn down first via
  `ReactHost.addBeforeDestroyListener`, so you never get a live notification
  wired to a dead runtime.

### iOS

- `MPRemoteCommandCenter` targets are added *and removed* to match
  `controls ∪ capabilities` exactly — stale handlers are the endemic bug here.
- `MPNowPlayingInfoCenter` is written from `mediaItem` + `playbackState`.
  Artwork loads off the main thread and is cached.
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
| Android | nothing | this package's own manifest already merges the foreground-service permissions and the `mediaPlayback` service into the app |

The merge is additive and idempotent: existing modes such as `voip` survive, and
a plist that already lists `audio` is left alone, so re-running prebuild is a
no-op. The plugin is wrapped in `createRunOncePlugin`, so listing it twice (say,
directly and through another library) applies it once.

### Options

Everything above needs no options. One is available:

```json
{
  "expo": {
    "plugins": [
      ["@rn-media/media-session", { "androidNotificationIcon": "./assets/ic_notification.xml" }]
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

Bare React Native projects do not need the plugin at all: add
`UIBackgroundModes` to `Info.plist` and drop the drawable into
`android/app/src/main/res` yourself.

## Development

```sh
npm run codegen       # nitrogen + bob build
npm run typecheck     # tsc --noEmit (strict), src + plugin
npm test              # vitest — src and plugin suites
npm run build:plugin  # tsc -p plugin → plugin/build (what app.plugin.js loads)
```
