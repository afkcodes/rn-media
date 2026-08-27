# Spec: `@timbre/media-session`

Architect-owned contract. The audio_service analog and this library's differentiator:
a **player-agnostic** media-session / background-playback / remote-control layer.
Any audio producer can plug in — ours, react-native-track-player-style, TTS, anything.
Implementers: verify media3 / MPRemoteCommandCenter / Nitro API shapes against current
docs, never memory. Read PLAN.md §5 first; the design decisions there are settled.

## Shape

- Nitro module, langs **kotlin + swift**. Package `packages/media-session`,
  npm `@timbre/media-session`. Singleton service (the OS media session is singular).
- No dependency on `@timbre/player`. The handler interface is the only contract.

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
  the JS runtime from the service. *Shipped 2026-08-10 — see the playback-resumption
  addendum below; the "dead end" reading was wrong, the missing piece was a
  native-readable snapshot.*

## AS-BUILT ADDENDUM (2026-08-10, background hardening — architect-reviewed)

Three additions, all answering "a paused, demoted service is killable". Full
rationale in ARCHITECTURE §19; the contract deltas are here.

### Queue/position persistence — TS only, zero dependencies

- `withPersistence(service, storage, options?) → PersistedMediaService` tees the
  three broadcast setters into `storage` and adds `save()` + `flush()`.
  `restorePersisted(storage, options?) → Promise<RestoreResult>`,
  `applyPersisted(service, session)`, `clearPersisted(storage, options?)`.
- **`MediaSessionStorage` is structural** — `{ getItem, setItem }`, sync *or*
  async — so AsyncStorage/MMKV/anything fits and none becomes a dependency.
  Deliberately no `removeItem`: `clearPersisted` writes a channel-less record of
  the current version instead, which reads back as `empty`.
- **Writes only on discontinuities**, which the broadcasts already are. No timer
  was added, and none may be. The cost is explicit: a track played straight
  through produces no write, so `save()` exists for the app to checkpoint at a
  moment it chooses (`AppState` leaving `active`, `onTaskRemoved`).
- **Anchor policy**: projected to the write instant, `rate → 0`,
  `playing|buffering → paused`, clamped to a known `duration`, `at` re-stamped
  on restore. A **live entry (no `duration` on either channel) persists position
  `0`** — same discriminator as `isDynamic`/`IsLiveStream` (§13).
- **Schema `v: 1`**, versioned and tolerant: `empty` / `unsupportedVersion` /
  `corrupt` are values, not throws; only a failing storage engine rejects.
  Restored payloads go through `normalizePlaybackState`/`validateMediaItem`/
  `validateQueue` — the same choke point a live broadcast uses.
- Not persisted: handlers (code), the `stopService` lifecycle (stop ends
  background execution, not the user's place), and the sleep timer.

### Native sleep timer

- Spec: `setSleepTimer(seconds)`, `cancelSleepTimer()`,
  `getSleepTimerRemaining(): number | undefined`, plus `onSleepTimer` on the
  handlers struct (nitrogen regenerated the struct cleanly; no enum members were
  added, so the casing rule is untouched).
- Android `Handler.postDelayed` on the main looper; iOS `DispatchWorkItem` via
  `DispatchQueue.main.asyncAfter`. Neither is Activity-scoped.
- **Fire order is the contract**: native pause first — on Android through the
  facade player's own `Player.pause()`, i.e. byte-for-byte the notification-pause
  path — then `onSleepTimer` fire-and-forget. `BaseMediaHandler.onSleepTimer` is
  a no-op and that is correct, not a stub.
- Cancelled by `stopService()` and by the `ReactHost` before-destroy hook (dev
  reload). Does not survive process death; not persisted.
- `getSleepTimerRemaining` reads the clock the timer was *scheduled* against
  (`uptimeMillis` / `DispatchTime`), never a wall clock.

### `android.stopForegroundTimeoutMs`

- New optional field on `AndroidMediaSessionConfig`, milliseconds, validated
  `>= 0` and finite. Applied in `RnMediaMediaSessionService.onCreate` (after
  `setMediaNotificationProvider`) via
  `MediaSessionService.setForegroundServiceTimeoutMs(long)` — `@UnstableApi`,
  media3 1.11.0, verified by `javap` on the shipped AAR.
- Omitted ⇒ media3's default. `0` ⇒ demote on pause. `> 600000` ⇒ media3 clamps
  down (the default is also the ceiling). Negative ⇒ rejected in TS, because
  media3 would clamp it to `0` silently.
- Applied at service creation only; a later `init` does not retro-fit a running
  service.

## AS-BUILT ADDENDUM (2026-08-10, playback resumption — architect-reviewed)

Closes the last deferred background item. Full rationale in ARCHITECTURE §20;
contract deltas here. Opt-in, default off.

**Platform framing (normative, so the asymmetry is not "fixed" later).** The
cross-platform feature is *persistence* — `withPersistence`/`restorePersisted`
behave identically on both platforms. `playbackResumption` names only what
**Android** additionally does with that record: revive the process automatically
(resumption card / Bluetooth / media button). **iOS consumes the same record on
the next manual launch** — the user opens the app and `restorePersisted` puts them
back on the track and position, paused. An automatic iOS twin **cannot exist**: a
terminated iOS app stays terminated, because force-quit is read as user intent and
nothing may resurrect a process for playback (same register as the existing
force-quit limitation). The flag therefore lives in the `android` config namespace
and `IosMediaSessionConfig` carries a TSDoc note naming
`ios.playbackResumption` as its home should Apple ever ship a mechanism.

### API surface

- `AndroidMediaSessionConfig.playbackResumption: boolean` (TS-optional,
  `@default false`; validated as a boolean, normalized to `false`, exported as
  `DEFAULT_PLAYBACK_RESUMPTION`).
- `MediaServiceApi.setResumptionSnapshot(snapshot?: string)` → nitro
  `RnMediaMediaSession.setResumptionSnapshot`. **Not app-facing**: it is called by
  `withPersistence` with the exact record it hands the storage engine.
- `PersistedMediaService.clear(): Promise<void>` — tombstones storage *and* the
  native mirror. `clearPersisted(storage)` still only knows about storage.
- `MediaHandler.onPlaybackResumption?()` + `BaseMediaHandler`/`CompositeMediaHandler`
  members, and `MediaSessionHandlers.onPlaybackResumption` on the bridge struct.
  **Optional** on `MediaHandler`, for the same reason `onSleepTimer?` is: an
  informational callback added after v1 must not break structural implementors.

### Native contract

- **The mirror is native-owned.** `ResumptionStore` writes both the session record
  and the Android config into this package's `SharedPreferences`, on a private
  thread with `commit()` (not `apply()` — its flush is only guaranteed at lifecycle
  transitions, and this feature exists for the process that gets none). Reads are
  synchronous, on the service's main thread, because the alternative is asking
  JavaScript for the thing whose absence defines the scenario.
- **Seeded state is `stopped`, always.** `paused` maps to `STATE_READY`, and media3
  posts a notification for anything not `STATE_IDLE` — which a SystemUI *bind*
  would then trigger. `STATE_IDLE` is also the precondition
  `MediaLibrarySessionImpl.onGetChildrenOnHandler` puts on serving the full recent
  item.
- **`MediaSession.Callback.onPlaybackResumption(session, controller, isForPlayback)`**
  is implemented (media3 1.11.0; `javap`-verified on the shipped AAR — the
  two-argument overload is deprecated in favour of this one). `isForPlayback=false`
  is SystemUI populating its card; `isForPlayback=true` is a play with no current
  item, reachable only when nothing was mirrored, because the timeline is already
  seeded. `COMMAND_SET_MEDIA_ITEM` is deliberately **not** advertised: the seeded
  timeline makes it unnecessary and adding it would let a stray controller replace
  the app's playlist.
- **`BroadcastPlayer` no longer captures handlers.** It takes a `CommandDispatcher`
  (implemented by `MediaSessionController`) and resolves them per command; that is
  what makes the service-builds-it / JS-attaches-later handover a non-event.
  Commands arriving before the runtime are held (max 8, oldest dropped) and
  replayed *after* `onPlaybackResumption` fires.
- **Ordering under the `startForeground` deadline**: bridge notification (media3's
  own notification id, `MediaStyle` + platform token, built from the mirror) →
  `ReactHost.start()` (register-listener, start, re-check `currentReactContext`) →
  posted flip to `buffering` that acknowledges the pending command, handing every
  later transition back to media3.
- **Bounded failure**: 10 s, not configurable, with distinct messages for "the
  runtime never started" and "the runtime started but `MediaService.init` was never
  called". A null start intent (START_STICKY restart) abandons rather than reviving.
  No `ReactHost` (brownfield) → one warning, pre-existing behaviour.

### Requirements the app owns

`playbackResumption: true` + `withPersistence(...)` + **`MediaService.init` at JS
module scope** + media3's `MediaButtonReceiver` in the *app's* manifest. The
receiver is deliberately not merged in from this package — media3 reads it as the
app's promise that it can resume, and it changes media-button routing for every
consumer. Its absence is a warning at `init`.

Expo prebuild regenerates `android/`, so there the copy-paste is unownable: the
config plugin's opt-in `playbackResumption` option writes the same receiver into
the generated manifest (idempotent; an existing declaration is left untouched).
Opt-in either way — the decision stays the app's, only its expression changes.

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
