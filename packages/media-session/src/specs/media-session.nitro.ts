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
}

/** iOS half of {@link MediaSessionConfig}. Ignored on Android. */
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
  /** Stable id. Doubles as the media3 `MediaItem.mediaId`. */
  id: string
  title: string
  artist?: string
  album?: string
  /** `http(s)://`, `file://` or `content://`. Loaded async, never on the caller. */
  artworkUri?: string
  /** Duration in ms. Omit for live/unknown. */
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
 * All ten are **required** — an optional callback would push "did the app
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
   * End background execution.
   *
   * Android: releases the session and stops the foreground service. This is the
   * ONLY thing that does — `pause()` never does (PLAN §5.4).
   * iOS: clears the now-playing info and disables every remote command; the
   * process then lives or dies on whether audio is still playing.
   */
  stopService(): Promise<void>
}
