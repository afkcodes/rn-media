import type { HybridObject } from 'react-native-nitro-modules'

/* -------------------------------------------------------------------------- */
/*                                   Enums                                    */
/* -------------------------------------------------------------------------- */

/**
 * Coarse playback status, broadcast by the app.
 *
 * These are the five states from the spec doc. Deliberately *not* media3's
 * `Player.STATE_*` nor `AVPlayer.timeControlStatus` — this is the union the app
 * thinks in; each platform maps it to its own vocabulary
 * (see `PlaybackFacadePlayer.kt` / `NowPlaying.swift`).
 *
 * NOTE: every member of a string union becomes a native enumerator whose name
 * is the member, upper-cased with separators stripped (`skipToNext` →
 * `SKIPTONEXT`, Swift `.skiptonext`). Members must therefore stay distinct
 * case-insensitively, and must not collide with a C macro or a Swift keyword —
 * the same constraint that forced `defaultMode` in `@rn-media/audio-session`.
 */
export type MediaPlaybackStatus =
  | 'playing'
  | 'paused'
  | 'buffering'
  | 'stopped'
  | 'error'

/**
 * A button the app wants offered on remote surfaces.
 *
 * Android: these become the media3 notification's actions (see
 * `compactControlIndices` for the ≤3 collapsed slots). iOS: `controls` and
 * {@link MediaCapability} are unioned into the set of enabled
 * `MPRemoteCommandCenter` commands — iOS has no notion of "button layout".
 */
export type MediaControl =
  | 'play'
  | 'pause'
  | 'stop'
  | 'skipToNext'
  | 'skipToPrevious'
  /**
   * Relative moves. There is deliberately no `fastForward`/`rewind` *handler*
   * method: both platforms resolve the increment natively and deliver an
   * absolute `seekTo` (media3's `COMMAND_SEEK_FORWARD`/`_BACK` pre-compute the
   * target position; iOS's `MPSkipIntervalCommand` is applied to the projected
   * position). One less thing for every app to reimplement, and one less way
   * for the two platforms to disagree.
   */
  | 'fastForward'
  | 'rewind'

/**
 * A capability the app is willing to service, independent of whether it wants a
 * button for it.
 *
 * Android: turns into a `Player.Command` on the facade player's available
 * commands. This is load-bearing — media3 never invokes a `handle*` method for
 * a command that is not in `State.availableCommands`, and controllers grey the
 * control out. iOS: turns into an enabled `MPRemoteCommand`.
 */
export type MediaCapability =
  | 'play'
  | 'pause'
  | 'stop'
  | 'seek'
  | 'skipToNext'
  | 'skipToPrevious'
  | 'skipToQueueItem'
  | 'setRate'

/* -------------------------------------------------------------------------- */
/*                                   Config                                   */
/* -------------------------------------------------------------------------- */

/** Android half of {@link MediaSessionConfig}. Ignored on iOS. */
export interface AndroidMediaSessionConfig {
  /** Notification channel id. Created on API 26+ if it does not exist. */
  notificationChannelId: string
  /** User-visible channel name, shown in system notification settings. */
  notificationChannelName: string
  /**
   * Drawable resource *name* (e.g. `'ic_notification'`) resolved out of the
   * consumer app's resources at runtime — a library cannot reference an app's
   * generated `R`.
   *
   * When absent or unresolvable, media3's own `media3_notification_small_icon`
   * is used. A small icon is never simply omitted: `Notification` throws
   * without one, and that throw would take the foreground-service start down
   * with it.
   */
  notificationIcon?: string
  /**
   * `true` (audio_service's default) → `stopForeground(STOP_FOREGROUND_DETACH)`
   * when playback pauses: the notification survives but the service is demoted
   * to background and therefore *killable*. `false` keeps the service in the
   * foreground while paused, which is more robust but consumes an ongoing
   * notification slot.
   */
  stopForegroundOnPause: boolean
  /**
   * How long a paused service stays in the foreground before media3 demotes it,
   * in **milliseconds**.
   *
   * media3 1.11 does not demote on pause; it keeps the service foreground for a
   * "user engaged" grace period —
   * `MediaSessionService.DEFAULT_FOREGROUND_SERVICE_TIMEOUT_MS`, **10 minutes** —
   * and only then applies `stopForegroundOnPause`. This maps 1:1 onto
   * `@UnstableApi public final void
   * MediaSessionService.setForegroundServiceTimeoutMs(long)`, called from the
   * service's `onCreate` (media3 1.11.0; verified by `javap` on the shipped AAR
   * and against
   * https://github.com/androidx/media/blob/1.11.0/libraries/session/src/main/java/androidx/media3/session/MediaSessionService.java#L643-L668).
   *
   * Omit to keep media3's default. `0` demotes immediately on pause.
   *
   * **10 minutes is also the ceiling.** media3 runs the value through
   * `Util.constrainValue(v, 0, DEFAULT_FOREGROUND_SERVICE_TIMEOUT_MS)`, so a
   * larger number is silently clamped down rather than honoured. Values below
   * zero are rejected here before they can be clamped up to `0` in silence.
   *
   * The trade-off runs both ways and neither end is free:
   * - **Shorter** — the process stops being protected sooner, so the OS may
   *   reclaim it (and with it the JS runtime and the app's handler) minutes
   *   after a pause. Better for battery/memory pressure; pair it with
   *   `withPersistence` so the session can be rebuilt.
   * - **Longer** — a resume from the notification is far more likely to find
   *   the runtime still alive, at the cost of holding a foreground service
   *   (and its process) for that whole window.
   *
   * Ignored on iOS: there is no service to demote.
   */
  stopForegroundTimeoutMs?: number
  /**
   * Opt in to **playback resumption after process death** (Android only).
   *
   * When `true`, the media3 service is allowed to come back from nothing: the
   * System UI resumption card, a Bluetooth reconnect or a headset play button
   * can start the service into a process with no JavaScript at all, and the
   * service will rebuild the session from a *native* mirror of the persisted
   * snapshot and then boot the React runtime behind it. See
   * `RnMediaMediaSessionService.beginRevival` and
   * {@link RnMediaMediaSession.setResumptionSnapshot}.
   *
   * Three things are required and none of them is silently substituted:
   * 1. `withPersistence(...)` — the mirror is written by it, and nothing else
   *    writes it. Without persistence there is nothing to resume.
   * 2. `MediaService.init(...)` must be reachable at **JS module scope**. A
   *    revived runtime loads the bundle but mounts no component, so an `init`
   *    inside a `useEffect` never runs and the revival is abandoned after a
   *    bounded wait (with a log saying exactly this).
   * 3. The consuming app must declare media3's `MediaButtonReceiver` in its
   *    manifest — that declaration is what makes media3 advertise resumption
   *    support to the System UI at all
   *    (`MediaSessionLegacyStub.canResumePlaybackOnStart` is literally
   *    "is there a broadcast receiver for `ACTION_MEDIA_BUTTON`").
   *
   * Default `false`: this path starts a foreground service from a process the
   * user did not open, so it stays opt-in until it has been proven on more
   * hardware than ours.
   *
   * ## Why this lives under `android` and has no iOS twin
   * The **cross-platform** half of surviving process death is `withPersistence`
   * / `restorePersisted`, which behave identically on both platforms. This flag
   * only names what *Android* can additionally do with that data: revive the
   * process by itself. iOS consumes the same record on the next **manual**
   * launch — the user opens the app and it is paused where they left it — and an
   * automatic iOS twin cannot exist, because on iOS a terminated app stays
   * terminated: force-quit is read as user intent and nothing may resurrect a
   * process for playback. That is Apple's policy, not a gap in this package.
   * See {@link IosMediaSessionConfig} for where an iOS twin would go if that
   * ever changes.
   */
  playbackResumption: boolean
}

/**
 * iOS half of {@link MediaSessionConfig}. Ignored on Android.
 *
 * ## There is deliberately no `playbackResumption` here
 * Not an oversight and not a TODO. iOS has no mechanism that can restart a
 * terminated app to play audio: force-quit (and an OS termination) is treated as
 * the user's intent that the app stop, and nothing — no media button, no Control
 * Center, no route change — may bring it back. What iOS *does* share with Android
 * is the layer underneath: `withPersistence` saves the session on both platforms
 * identically, and on iOS the next **manual** launch calls `restorePersisted` and
 * comes back paused, on the same track, at the same position.
 *
 * If Apple ever ships a resumption mechanism, this is where the flag belongs —
 * `ios.playbackResumption`, mirroring
 * {@link AndroidMediaSessionConfig.playbackResumption}. Stated here so the
 * asymmetry reads as a platform fact rather than as something to "fix" by
 * hoisting the flag out of its platform namespace.
 */
export interface IosMediaSessionConfig {
  /**
   * Maximum number of decoded artwork images kept in memory, keyed by URI.
   * Artwork decoding is off the main thread; the cache is what keeps a queue of
   * repeated covers from re-decoding on every `setMediaItem`.
   *
   * @default 8
   */
  artworkCacheSize?: number
}

/** Both halves optional — supply only the platform you care about. */
export interface MediaSessionConfig {
  android?: AndroidMediaSessionConfig
  ios?: IosMediaSessionConfig
}

/* -------------------------------------------------------------------------- */
/*                              Broadcast payloads                            */
/* -------------------------------------------------------------------------- */

/**
 * The position anchor. **The single most important type in this package.**
 *
 * Position is never streamed: the app broadcasts `{value, at, rate}` only on a
 * discontinuity (seek, pause, resume, rate change, track change) and every
 * surface extrapolates locally. Android feeds it to `SimpleBasePlayer`'s
 * position supplier; iOS feeds it to `MPNowPlayingInfoPropertyElapsedPlaybackTime`
 * + `...PlaybackRate`, which the system extrapolates for the lock screen.
 *
 * ## Clock domains
 * `at` is a **wall-clock** timestamp (`Date.now()`), because that is the only
 * clock JS has. Both native sides convert it into their own monotonic clock
 * *at the instant the broadcast is received*:
 *
 * ```
 * ageMs   = wallClockNow() - at          // milliseconds this anchor is stale
 * anchor  = monotonicNow() - ageMs       // same instant, monotonic domain
 * ```
 *
 * Doing the conversion once, on arrival, bounds the error to the JS→native
 * latency (sub-millisecond) instead of letting an NTP step or a suspend/resume
 * corrupt the projection forever.
 */
export interface PositionAnchor {
  /** Playback position in **milliseconds** at instant {@link at}. */
  value: number
  /** `Date.now()` when {@link value} was sampled. */
  at: number
  /**
   * Rate the position advances at from {@link at} onwards. `0` freezes the
   * projection (paused/buffering), `1` is normal speed.
   */
  rate: number
}

/** A custom action: a button with no built-in meaning. */
export interface MediaCustomAction {
  /** Opaque identifier handed back to the JS handler's `customAction`. */
  name: string
  /** User-visible label. */
  title: string
  /** Android drawable resource name. Ignored on iOS (no such surface). */
  icon?: string
}

/**
 * Everything a surface needs to render "now", except the metadata.
 *
 * Broadcast wholesale (never patched): a partial update would need a merge
 * policy on three platforms, and the app already holds the full state.
 */
export interface NativePlaybackState {
  status: MediaPlaybackStatus
  position: PositionAnchor
  /** Buffered position in ms. Omit when unknown. Android-only surface. */
  bufferedPosition?: number
  /** Buttons to offer, in order. */
  controls: MediaControl[]
  /** Commands to accept. See {@link MediaCapability}. */
  capabilities: MediaCapability[]
  customActions: MediaCustomAction[]
  /**
   * Android only: indices into {@link controls} that get the ≤3 slots of the
   * collapsed notification. Omit to let the platform take the first three.
   *
   * Not in the spec doc's sketch, which folded the two concepts together; they
   * have to be separable because Android 13+ derives the *expanded* layout from
   * the session while the compact layout stays an explicit choice
   * (audio_service calls this `androidCompactActionIndices`).
   */
  compactControlIndices?: number[]
  /**
   * Index into the last {@link RnMediaMediaSession.setQueue} array that
   * `mediaItem` corresponds to. Omit (or `-1`) when playback is not queue-backed;
   * Android then presents a single-item timeline built from the media item.
   */
  queueIndex?: number
  /** Only meaningful when `status === 'error'`. Shown by some surfaces. */
  errorMessage?: string
}

/** Metadata for the item currently playing. */
export interface NativeMediaItem {
  /**
   * Stable id. Doubles as the media3 `MediaItem.mediaId`.
   *
   * @remarks
   * **Use a stable id per *source*, and let duplicates be duplicates.**
   *
   * ### Duplicates are legal
   * The same id may appear more than once in a queue, and it routinely does:
   * "play next" on a track that is already queued produces exactly that, and so
   * does a repeat-one-song-twice playlist. Nothing here rejects it and nothing
   * misbehaves because of it — position is carried by `queueIndex`, and media3's
   * timeline uids are built as `"$index:${item.id}"`
   * (`BroadcastPlayer.kt`), which stays unique even when the ids do not.
   *
   * ### Where the id is load-bearing
   * Two places, both of which want the id to mean "this source", not "this row":
   *
   * 1. **The channel-2 merge.** `setMediaItem` enriches the *current* queue
   *    entry field-by-field, and only when `item.id` equals the id of the entry
   *    at the broadcast `queueIndex` (`Snapshot.kt`'s `timeline`). Matching on
   *    the id at a known index is what makes the merge well-defined in the
   *    presence of duplicates — it never has to ask "which of the two copies did
   *    you mean". When the ids disagree the queue entry wins unchanged and
   *    Android logs the mismatch; that combination means the two broadcasts got
   *    out of step, and it is usually visible as a missing scrubber (the
   *    duration is the field that normally arrives only via `setMediaItem`).
   * 2. **Restoring a persisted session.** A restored record is matched back to
   *    the app's catalogue by id. An id that was minted per *insertion* rather
   *    than per source — `track-7#2`, `${id}-${Date.now()}`, an array index —
   *    does not exist any more by the time the app cold-starts, so the match
   *    fails and the session comes back blank.
   *
   * ### The rule
   * Derive the id from the thing being played (its catalogue id, or its URI) —
   * never from its position in the queue, and never uniquified with a counter
   * or a timestamp to "avoid" duplicates. Suffixing to make ids unique breaks
   * resumption and buys nothing, because nothing here needed them unique.
   */
  id: string
  title: string
  artist?: string
  album?: string
  /** `http(s)://`, `file://` or `content://`. Loaded async, never on the caller. */
  artworkUri?: string
  /**
   * Duration in ms. Omit for live/unknown.
   *
   * Broadcasting it through `setMediaItem` is enough even when the track also
   * sits in a queue: for the current entry the two channels are merged (see
   * `MediaServiceApi.setMediaItem`). Without a duration Android greys out the
   * scrubber and iOS marks the track as a live stream.
   */
  duration?: number
  genre?: string
}

/* -------------------------------------------------------------------------- */
/*                              Handler callbacks                             */
/* -------------------------------------------------------------------------- */

/**
 * The fan-in surface: one callback per remote command, supplied once at
 * {@link RnMediaMediaSession.initialize}.
 *
 * A single struct of callbacks rather than ten `setXHandler` methods: nitrogen
 * turns each function type into a `Func_*` wrapper either way, and one struct
 * makes "the handler set is replaced atomically" true by construction.
 *
 * All of them are **required** — an optional callback would push "did the app
 * implement this?" into native, when the answer is already carried by
 * {@link NativePlaybackState.capabilities}. `BaseMediaHandler` supplies no-ops.
 *
 * ## Contract
 * - Callbacks return `void`, not a promise. Native dispatches and returns
 *   immediately — a remote command must never wait on JS (that is an ANR on
 *   Android and a dropped command on iOS). The *acknowledgement* is the app's
 *   next `setPlaybackState` broadcast, which is also what completes media3's
 *   pending-operation future.
 * - Nitro schedules the JS invocation onto the JS thread itself, so native may
 *   call these from a binder thread, the media3 application looper, or a
 *   `MPRemoteCommandCenter` target
 *   (https://nitro.margelo.com/docs/types/callbacks).
 */
export interface MediaSessionHandlers {
  play: () => void
  pause: () => void
  stop: () => void
  /** @param position milliseconds */
  seekTo: (position: number) => void
  skipToNext: () => void
  skipToPrevious: () => void
  /** @param index index into the last broadcast queue */
  skipToQueueItem: (index: number) => void
  setRate: (rate: number) => void
  /**
   * Android only: the app's task was swiped out of Recents.
   *
   * Always invoked *in addition to* the built-in default policy so the JS side
   * can react (persist state, analytics); the default policy itself lives in
   * native so it still runs when JS is wedged. See
   * `RnMediaMediaSessionService.onTaskRemoved`.
   */
  onTaskRemoved: () => void
  /**
   * @param name  {@link MediaCustomAction.name}
   * @param extras JSON object string, `'{}'` when there are none. A JSON string
   * rather than a map because the Android payload is an arbitrary `Bundle` from
   * a third-party `MediaController`; flattening it once, in native, keeps the
   * bridge type trivial and the failure mode visible.
   */
  customAction: (name: string, extras: string) => void
  /**
   * The sleep timer set by {@link RnMediaMediaSession.setSleepTimer} elapsed.
   *
   * **The pause has already happened** by the time this runs — natively, on the
   * same path a notification pause takes (ARCHITECTURE §9). This callback is a
   * *notification*, not a request: it is where an app clears its own timer UI,
   * logs, fades out, or calls `stopService()`. Doing nothing is correct.
   *
   * Fired at most once per armed timer, and never after
   * {@link RnMediaMediaSession.cancelSleepTimer}.
   */
  onSleepTimer: () => void
  /**
   * Android only: this JS runtime was booted **by the media service**, to
   * finish a playback resumption that had already started without it.
   *
   * Fired once, immediately after the handlers are installed and before any
   * command deferred during the revival is replayed. Purely informational —
   * the notification is already up, the session already carries the persisted
   * track, and the `play` the user pressed is replayed on your handler a beat
   * later whether or not you implement this.
   */
  onPlaybackResumption: () => void
}

/* -------------------------------------------------------------------------- */
/*                               Hybrid Object                                */
/* -------------------------------------------------------------------------- */

/**
 * The process-wide media session.
 *
 * A singleton by nature, not by convenience: `MediaSessionService` and
 * `MPNowPlayingInfoCenter` are both process-singular (CLAUDE.md principle 5's
 * documented exception).
 *
 * Named `initialize` rather than `init` because `init` is a Swift keyword and
 * nitrogen emits the method name verbatim into the generated Swift protocol.
 */
export interface RnMediaMediaSession
  extends HybridObject<{ ios: 'swift'; android: 'kotlin' }> {
  /**
   * Install the handlers and platform configuration.
   *
   * Android: creates the notification channel and the `MediaLibrarySession`
   * (bound to a facade `SimpleBasePlayer`). It does **not** start the
   * foreground service — that happens on the first `play` while the app is
   * startable, per the Android 12+ background-FGS-start restriction.
   * iOS: installs `MPRemoteCommandCenter` targets.
   *
   * Rejects when called twice without an intervening {@link stopService}.
   */
  initialize(
    config: MediaSessionConfig,
    handlers: MediaSessionHandlers
  ): Promise<void>

  /** Broadcast channel 1 of 3. See {@link NativePlaybackState}. */
  setPlaybackState(state: NativePlaybackState): void

  /** Broadcast channel 2 of 3. Pass nothing to clear the metadata. */
  setMediaItem(item?: NativeMediaItem): void

  /** Broadcast channel 3 of 3. Pass `[]` to clear the queue. */
  setQueue(items: NativeMediaItem[]): void

  /**
   * Mirror the persisted session into **native-owned** storage, for Android
   * playback resumption.
   *
   * Not a fourth broadcast channel and not an app-facing call: `withPersistence`
   * invokes this with the very same JSON record it hands the app's storage
   * engine, so the two copies cannot drift. Pass `undefined` to forget it.
   *
   * ## Why a native mirror exists at all
   * The whole point of playback resumption is that it works **with no
   * JavaScript in the process**. The service is created by the OS, has ~5 s to
   * call `startForeground`, and must already know what track to show. Reading
   * the app's storage engine is not an option: that engine is JavaScript, and
   * JavaScript is precisely what is missing. So the record is also written to
   * `SharedPreferences` owned by this package — survives process death, read
   * back **synchronously** on the service's main thread, no bridge involved
   * (ARCHITECTURE §9, native-first).
   *
   * The JS-side storage stays the app-facing source of truth; this is a cache
   * that only the resumption path reads. Ignored on iOS, which has no service
   * to resurrect.
   *
   * @param snapshot the serialized `PersistedSession` record, or `undefined`.
   */
  setResumptionSnapshot(snapshot?: string): void

  /**
   * End background execution.
   *
   * Android: releases the session and stops the foreground service. This is the
   * ONLY thing that does — `pause()` never does (PLAN §5.4).
   * iOS: clears the now-playing info and disables every remote command; the
   * process then lives or dies on whether audio is still playing.
   */
  stopService(): Promise<void>

  /* ------------------------------- Sleep timer ------------------------------ */

  /**
   * Pause playback in `seconds`. Replaces any timer already armed.
   *
   * ## Why this is native and not `setTimeout`
   * A JS sleep timer is broken by construction on Android: RN's
   * `JavaTimerManager` gates timers on the Activity lifecycle plus headless
   * tasks, so with no Activity they simply stop firing — and Samsung freezes
   * them even *with* one (RN #56324). A sleep timer is the one feature whose
   * entire job happens after the user has put the phone down, i.e. exactly when
   * JS timers do not run. So it lives on a platform timer: a main-looper
   * `Handler.postDelayed` on Android, a `DispatchQueue.main.asyncAfter` work
   * item on iOS. Neither is tied to an Activity, and neither is a JS timer.
   *
   * ## What happens when it fires
   * 1. **Playback is paused natively**, on the identical path a notification
   *    pause takes — the facade `Player` is paused, so the session, the
   *    notification and the lock screen all go to `paused` immediately, and the
   *    app's `pause` handler is invoked to actually stop the audio.
   * 2. {@link MediaSessionHandlers.onSleepTimer} is invoked fire-and-forget.
   *
   * The timer is armed even with no Activity alive; it does **not** survive
   * process death (nothing does — see the README's background-playback limits)
   * and it is cancelled by {@link stopService} and by a dev reload.
   *
   * iOS note, stated honestly: iOS suspends a backgrounded process shortly
   * after audio *stops*, and a suspended process runs no timers. That is not a
   * problem for this feature — while audio is playing the process is not
   * suspended, so a timer armed during playback fires. What cannot be relied on
   * is a timer armed (or still pending) while nothing is playing.
   *
   * @param seconds strictly positive; the TS layer rejects `0`, negatives and
   * non-finite values before they reach here.
   */
  setSleepTimer(seconds: number): void

  /** Disarm the sleep timer. A no-op when none is armed. */
  cancelSleepTimer(): void

  /**
   * Seconds until the armed timer fires, or `undefined` when none is armed.
   *
   * Read from **the same clock the timer was scheduled against** —
   * `SystemClock.uptimeMillis()` on Android (what `Handler.postDelayed` uses)
   * and `DispatchTime.now()` on iOS — so it can never disagree with when the
   * pause will actually happen, and a wall-clock change cannot move it.
   * Synchronous and cheap: it is meant to be polled by a UI that is on screen,
   * which is the one place a JS timer *does* work.
   */
  getSleepTimerRemaining(): number | undefined
}
