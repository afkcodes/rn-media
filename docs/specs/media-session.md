# Spec: `@rn-media/media-session`

Architect-owned contract. The audio_service analog and this library's differentiator:
a **player-agnostic** media-session / background-playback / remote-control layer.
Any audio producer can plug in — ours, react-native-track-player-style, TTS, anything.
Implementers: verify media3 / MPRemoteCommandCenter / Nitro API shapes against current
docs, never memory. Read PLAN.md §5 first; the design decisions there are settled.

## Shape

- Nitro module, langs **kotlin + swift**. Package `packages/media-session`,
  npm `@rn-media/media-session`. Singleton service (the OS media session is singular).
- No dependency on `@rn-media/player`. The handler interface is the only contract.

## Core model (audio_service's proven fan-in/fan-out)

- **Fan-in**: every command surface — notification buttons, lock screen, Bluetooth/
  headset, watch, Android Auto, Control Center — funnels into ONE JS handler.
- **Fan-out**: the app broadcasts state through three channels; every surface
  (including the app's own UI) renders from them. There is no other state source.

## TS API

```ts
class MyHandler extends BaseMediaHandler {
  async play() { this.player.play(); }
  async pause() { this.player.pause(); }
  async stop() { /* release; optionally MediaService.stopService() */ }
  async seekTo(position: number) { ... }
  async skipToNext() { /* app-owned queue logic; may resolve URLs lazily */ }
  async skipToPrevious() { ... }
  async skipToQueueItem(index: number) { ... }
  async setRate(rate: number) { ... }
  async onTaskRemoved() { /* Android: app swiped away — decide keep playing vs stop */ }
  async customAction(name: string, extras?: Record<string, unknown>) { ... }
  // Android Auto browse (later phase, interface reserved now):
  async getChildren(parentId: string): Promise<MediaItem[]> { return []; }
  async getMediaItem(id: string): Promise<MediaItem | undefined> { ... }
}

const service = await MediaService.init(() => new MyHandler(), {
  android: {
    notificationChannelId: 'playback', notificationChannelName: 'Playback',
    notificationIcon: 'ic_notification',          // drawable resource name
    stopForegroundOnPause: true,                  // audio_service default; document killability
  },
});

// Broadcast (the only state source for all surfaces):
service.setMediaItem({ id, title, artist, album?, artworkUri?, duration? });
service.setPlaybackState({
  status: 'playing' | 'paused' | 'buffering' | 'stopped' | 'error',
  position: { value: number, at: number, rate: number },   // ANCHOR — surfaces project, never poll JS
  controls: ['pause','next','previous'],                    // ≤3 compact on Android
  capabilities: ['seek','setRate', ...],                    // maps to enabled remote commands
  customActions?: [{ name, title, icon }],
});
service.setQueue(items);
service.stopService();     // ONLY way to end background execution; pause never does (PLAN §5.4)
```

- `CompositeMediaHandler(inner)` delegating base for decorators (analytics,
  persistence); `QueueHandler` mixin giving default skip logic over `setQueue` data.
- All handler callbacks are async; native side must tolerate slow JS (never ANR —
  dispatch and return).

## Android implementation

- **media3 `MediaLibraryService`** (covers MediaSessionService + browse) — NOT
  MediaSessionCompat/androidx.media (PLAN §5.2). Use media3's **`SimpleBasePlayer`**
  as the facade Player: build its `State` from the broadcast playbackState/mediaItem/
  queue (position anchor maps to media3's position supplier — projection stays
  native, zero JS traffic), implement `handle*` methods by invoking the JS handler
  via Nitro callbacks. Verify SimpleBasePlayer's current contract from media3 docs;
  resolve latest stable media3 version from Maven (never memory).
- Notification: media3's default MediaNotification with our channel config;
  Android 13+ media controls derive from the session — custom actions carry the rest.
- **Foreground-service lifecycle** (the RNTP scar-tissue list, PLAN §5.6):
  - Service starts ONLY from a play command while the app/session is startable
    (Android 12+ FGS-from-background restriction); `startForeground` within the
    5-second window; `foregroundServiceType="mediaPlayback"` + permissions
    (FOREGROUND_SERVICE, FOREGROUND_SERVICE_MEDIA_PLAYBACK, POST_NOTIFICATIONS
    documented for consumers) in the library manifest where merge-able.
  - `stopForegroundOnPause: true` → `stopForeground(STOP_FOREGROUND_DETACH)` on
    pause (notification stays, service demoted — document killability; persistence
    decorator is the mitigation).
  - `onTaskRemoved` → forward to JS; default (no handler override): keep playing if
    `status === 'playing'`, else stop service (audio_service behavior).
- **JS runtime survival**: the service holds the ReactHost/RN instance alive
  (one-runtime model, PLAN §5.3). Investigate against the scaffold's RN version
  (0.86, bridgeless): the supported way to keep the JS runtime running with the
  Activity gone — do NOT introduce a second JS context. Document findings; if RNTP's
  HeadlessJsTaskService pattern is still the proven route on bridgeless, use it and
  cite; this is the highest-risk item, prototype it FIRST.

## iOS implementation

- `MPRemoteCommandCenter`: enable exactly the commands in
  `controls ∪ capabilities`; each target invokes the JS handler. Disable + remove
  targets when not in `controls` (stale-handler bugs are endemic — test).
- `MPNowPlayingInfoCenter`: from mediaItem + playbackState; position anchor maps to
  `MPNowPlayingInfoPropertyElapsedPlaybackTime` + `...PlaybackRate` (set on
  discontinuities only — iOS projects itself; never timer-update it).
- Artwork loading async + cached (`MPMediaItemArtwork` from artworkUri).
- No service concept: document the platform contract — process lives while audio
  plays (`UIBackgroundModes: audio` is the consumer's/config-plugin's job);
  force-quit kills everything (not our bug).

## AS-BUILT ADDENDUM (2026-08-09, architect-reviewed and accepted)

- media3 **1.11.0**; `media3-session` only (no exoplayer), declared `api`.
- **No HeadlessJsTaskService fork.** Verified from RN 0.86 sources: the JS runtime
  survives Activity destruction by construction; headless tasks don't pin the
  runtime, they only keep JS *timers* warm — and this package has no JS timers by
  design. Consequence documented: app-level `setTimeout` inside handlers may
  freeze in background (see ReactRuntime.kt + RN #56324). Commands are handled
  native-first; JS is notified fire-and-forget, never on the critical path.
- Broadcast state additions: `compactControlIndices` (≤3, media3 1.11 slots /
  audio_service precedent), `queueIndex`, optional `artist`, custom-action
  `icon` required-on-Android with documented fallback.
- Command acknowledgement: JS callback fires, media3 gets a `SettableFuture`
  completed by the app's next `setPlaybackState` (3s deadline). Position anchor
  converted wall→monotonic ONCE at broadcast receipt (NTP-clamped).
- Dev-reload safety: `ReactHost.addBeforeDestroyListener` tears the session down
  before the runtime dies.
- **Channel priority, per timeline entry**: for the CURRENT entry only, a
  `setMediaItem` whose `id` matches `queue[queueIndex]` is merged over the queue
  entry field-by-field (item field present wins, absent falls back) — this is how
  `duration`, and therefore the scrubber, reaches a queue-backed timeline;
  mismatched ids leave the queue entry alone and log a warning
  (`Snapshot.enrichedWith`).
- **Deferred from v1** (documented, needs its own on-device budget): cold-starting
  the JS runtime from the service (app-killed → media-button resume is a dead end).

## Explicitly out of scope for v1 (interface reserved, no implementation)
Android Auto browse tree beyond returning empty, CarPlay, cast, ratings, search.

## Acceptance criteria
- TS: strict, unit tests for broadcast-state validation, QueueHandler default logic,
  CompositeMediaHandler delegation (all device-free).
- Android: example-app scenario compiles and runs — play → notification appears with
  working pause/next; survives activity destruction; `adb shell dumpsys media_session`
  shows the session. (Full on-device pass is Task 8, but this package's agent must
  smoke-test on emulator if available.)
- Position never crosses the bridge on a timer, in either direction.
- Every FGS edge case above has either handling code or an explicit documented
  decision — no silent gaps.
