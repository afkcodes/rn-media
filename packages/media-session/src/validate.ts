import { invalidArgument } from './errors'
import type {
  MediaCapability,
  MediaControl,
  MediaCustomAction,
  MediaPlaybackStatus,
  MediaSessionConfig,
  NativeMediaItem,
  NativePlaybackState,
  PositionAnchor,
} from './specs/media-session.nitro'
import type { MediaItem, MediaServiceConfig, PlaybackState } from './types'

/**
 * Android's collapsed media notification has three action slots. media3 will
 * silently drop the overflow; we would rather the app hear about it.
 *
 * https://developer.android.com/media/media3/session/background-playback
 */
export const MAX_COMPACT_CONTROLS = 3

const STATUSES: readonly MediaPlaybackStatus[] = [
  'playing',
  'paused',
  'buffering',
  'stopped',
  'error',
]

const CONTROLS: readonly MediaControl[] = [
  'play',
  'pause',
  'stop',
  'skipToNext',
  'skipToPrevious',
  'fastForward',
  'rewind',
]

const CAPABILITIES: readonly MediaCapability[] = [
  'play',
  'pause',
  'stop',
  'seek',
  'skipToNext',
  'skipToPrevious',
  'skipToQueueItem',
  'setRate',
]

/* -------------------------------------------------------------------------- */
/*                                  Helpers                                   */
/* -------------------------------------------------------------------------- */

function assertFinite(value: unknown, field: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw invalidArgument(`${field} must be a finite number, got ${String(value)}.`)
  }
}

function assertMember<T extends string>(
  value: unknown,
  allowed: readonly T[],
  field: string
): asserts value is T {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    throw invalidArgument(
      `${field} must be one of ${allowed.join(', ')} — got ${JSON.stringify(value)}.`
    )
  }
}

function assertNonEmptyString(
  value: unknown,
  field: string
): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) {
    throw invalidArgument(`${field} must be a non-empty string.`)
  }
}

/* -------------------------------------------------------------------------- */
/*                                   Anchor                                   */
/* -------------------------------------------------------------------------- */

/**
 * The anchor is the one payload whose garbage is *invisible* until a user
 * stares at a lock screen counting backwards, so it is validated hardest.
 */
export function validateAnchor(
  anchor: PositionAnchor,
  field = 'position'
): PositionAnchor {
  if (anchor == null || typeof anchor !== 'object') {
    throw invalidArgument(`${field} must be a { value, at, rate } object.`)
  }

  assertFinite(anchor.value, `${field}.value`)
  assertFinite(anchor.at, `${field}.at`)
  assertFinite(anchor.rate, `${field}.rate`)

  if (anchor.value < 0) {
    throw invalidArgument(`${field}.value must be >= 0, got ${anchor.value}.`)
  }
  if (anchor.at <= 0) {
    throw invalidArgument(
      `${field}.at must be a positive epoch timestamp (Date.now()), got ${anchor.at}.`
    )
  }
  if (anchor.rate < 0) {
    // Negative rates would make both `PositionSupplier.getExtrapolating` and
    // `MPNowPlayingInfoPropertyPlaybackRate` run the clock backwards. No remote
    // surface renders that usefully; scrub instead.
    throw invalidArgument(`${field}.rate must be >= 0, got ${anchor.rate}.`)
  }
  return { value: anchor.value, at: anchor.at, rate: anchor.rate }
}

/* -------------------------------------------------------------------------- */
/*                                 Media item                                 */
/* -------------------------------------------------------------------------- */

export function validateMediaItem(
  item: MediaItem,
  field = 'mediaItem'
): NativeMediaItem {
  if (item == null || typeof item !== 'object') {
    throw invalidArgument(`${field} must be an object.`)
  }
  assertNonEmptyString(item.id, `${field}.id`)
  assertNonEmptyString(item.title, `${field}.title`)

  if (item.duration !== undefined) {
    assertFinite(item.duration, `${field}.duration`)
    if (item.duration < 0) {
      throw invalidArgument(`${field}.duration must be >= 0, got ${item.duration}.`)
    }
  }
  return item
}

export function validateQueue(items: MediaItem[]): NativeMediaItem[] {
  if (!Array.isArray(items)) {
    throw invalidArgument('queue must be an array of media items.')
  }
  return items.map((item, index) => validateMediaItem(item, `queue[${index}]`))
}

/* -------------------------------------------------------------------------- */
/*                              Playback state                                */
/* -------------------------------------------------------------------------- */

function validateCustomActions(
  actions: MediaCustomAction[]
): MediaCustomAction[] {
  if (!Array.isArray(actions)) {
    throw invalidArgument('playbackState.customActions must be an array.')
  }
  const seen = new Set<string>()
  for (const [index, action] of actions.entries()) {
    assertNonEmptyString(action?.name, `playbackState.customActions[${index}].name`)
    assertNonEmptyString(action.title, `playbackState.customActions[${index}].title`)
    if (seen.has(action.name)) {
      // Duplicates make `customAction(name)` ambiguous on the way back in.
      throw invalidArgument(
        `playbackState.customActions has a duplicate name "${action.name}".`
      )
    }
    seen.add(action.name)
  }
  return actions
}

function validateCompactIndices(
  indices: number[],
  controlCount: number
): number[] {
  if (!Array.isArray(indices)) {
    throw invalidArgument('playbackState.compactControlIndices must be an array.')
  }
  if (indices.length > MAX_COMPACT_CONTROLS) {
    throw invalidArgument(
      `playbackState.compactControlIndices accepts at most ${MAX_COMPACT_CONTROLS} ` +
        `entries (Android's collapsed notification has that many slots), got ${indices.length}.`
    )
  }
  for (const index of indices) {
    assertFinite(index, 'playbackState.compactControlIndices[]')
    if (!Number.isInteger(index) || index < 0 || index >= controlCount) {
      throw invalidArgument(
        `playbackState.compactControlIndices contains ${index}, which is not a valid ` +
          `index into controls (length ${controlCount}).`
      )
    }
  }
  return indices
}

/**
 * Validate and fill in a {@link PlaybackState}, producing the exact struct the
 * bridge wants. The single choke point: nothing reaches native un-validated.
 */
export function normalizePlaybackState(
  state: PlaybackState
): NativePlaybackState {
  if (state == null || typeof state !== 'object') {
    throw invalidArgument('playbackState must be an object.')
  }
  assertMember(state.status, STATUSES, 'playbackState.status')

  const controls = state.controls ?? []
  if (!Array.isArray(controls)) {
    throw invalidArgument('playbackState.controls must be an array.')
  }
  for (const control of controls) {
    assertMember(control, CONTROLS, 'playbackState.controls[]')
  }

  const capabilities = state.capabilities ?? []
  if (!Array.isArray(capabilities)) {
    throw invalidArgument('playbackState.capabilities must be an array.')
  }
  for (const capability of capabilities) {
    assertMember(capability, CAPABILITIES, 'playbackState.capabilities[]')
  }

  if (state.bufferedPosition !== undefined) {
    assertFinite(state.bufferedPosition, 'playbackState.bufferedPosition')
    if (state.bufferedPosition < 0) {
      throw invalidArgument('playbackState.bufferedPosition must be >= 0.')
    }
  }

  if (state.queueIndex !== undefined) {
    assertFinite(state.queueIndex, 'playbackState.queueIndex')
    if (!Number.isInteger(state.queueIndex) || state.queueIndex < -1) {
      throw invalidArgument(
        `playbackState.queueIndex must be an integer >= -1 (-1 meaning "not queue-backed"), ` +
          `got ${state.queueIndex}.`
      )
    }
  }

  return {
    status: state.status,
    position: validateAnchor(state.position, 'playbackState.position'),
    bufferedPosition: state.bufferedPosition,
    controls,
    capabilities,
    customActions: validateCustomActions(state.customActions ?? []),
    compactControlIndices:
      state.compactControlIndices === undefined
        ? undefined
        : validateCompactIndices(state.compactControlIndices, controls.length),
    queueIndex: state.queueIndex,
    errorMessage: state.errorMessage,
  }
}

/* -------------------------------------------------------------------------- */
/*                                 Sleep timer                                */
/* -------------------------------------------------------------------------- */

/**
 * Validate a sleep-timer duration.
 *
 * Strictly positive: `0` is rejected rather than treated as "fire now" because
 * the two plausible readings — "pause immediately" and "cancel" — are both
 * already spelled out (`pause()` and `cancelSleepTimer()`), and picking one
 * silently would make the other a bug that only shows up on a device with the
 * screen off. `NaN`/`Infinity` are rejected here rather than downstream, where
 * `NaN * 1000` becomes a `Long` of 0 on Android and a timer that fires
 * instantly.
 */
export function validateSleepTimerSeconds(seconds: number): number {
  assertFinite(seconds, 'seconds')
  if (seconds <= 0) {
    throw invalidArgument(
      `seconds must be > 0, got ${seconds}. Use cancelSleepTimer() to disarm, ` +
        `or pause() to stop now.`
    )
  }
  return seconds
}

/* -------------------------------------------------------------------------- */
/*                                   Config                                   */
/* -------------------------------------------------------------------------- */

/** `stopForegroundOnPause` follows audio_service's default. See PLAN §5.6. */
export const DEFAULT_STOP_FOREGROUND_ON_PAUSE = true

/**
 * media3's `MediaSessionService.DEFAULT_FOREGROUND_SERVICE_TIMEOUT_MS`, which
 * is both the default *and* the maximum: the setter runs the argument through
 * `Util.constrainValue(v, 0, DEFAULT_FOREGROUND_SERVICE_TIMEOUT_MS)`, so a
 * larger value is clamped down rather than honoured (media3 1.11.0, confirmed
 * by `javap` on the shipped AAR: `ConstantValue: long 600000l`).
 *
 * Exported so an app can say "half of media3's default" without hard-coding
 * ten minutes, and so a test can assert the ceiling.
 */
export const MAX_STOP_FOREGROUND_TIMEOUT_MS = 600_000

/**
 * Playback resumption is **off** unless the app asks for it.
 *
 * It is the one feature here that starts a foreground service in a process the
 * user did not open, from a snapshot written by an earlier process. That is a
 * lot of trust to hand an app by default, so it stays opt-in until it has been
 * exercised on more hardware than the machine this was written on.
 */
export const DEFAULT_PLAYBACK_RESUMPTION = false

export function normalizeConfig(
  config: MediaServiceConfig = {}
): MediaSessionConfig {
  const android = config.android
  const ios = config.ios

  if (android !== undefined) {
    assertNonEmptyString(
      android.notificationChannelId,
      'config.android.notificationChannelId'
    )
    assertNonEmptyString(
      android.notificationChannelName,
      'config.android.notificationChannelName'
    )
    if (android.notificationIcon !== undefined) {
      assertNonEmptyString(
        android.notificationIcon,
        'config.android.notificationIcon'
      )
    }
    if (
      android.playbackResumption !== undefined &&
      typeof android.playbackResumption !== 'boolean'
    ) {
      throw invalidArgument(
        `config.android.playbackResumption must be a boolean, got ` +
          `${JSON.stringify(android.playbackResumption)}.`
      )
    }
    if (android.stopForegroundTimeoutMs !== undefined) {
      assertFinite(
        android.stopForegroundTimeoutMs,
        'config.android.stopForegroundTimeoutMs'
      )
      if (android.stopForegroundTimeoutMs < 0) {
        // media3 would silently clamp a negative to 0, i.e. "demote instantly"
        // — the opposite of what someone writing a negative number is likely
        // to mean. Rejecting is the honest reading.
        throw invalidArgument(
          `config.android.stopForegroundTimeoutMs must be >= 0 (0 demotes the service ` +
            `immediately on pause), got ${android.stopForegroundTimeoutMs}.`
        )
      }
    }
  }

  if (ios?.artworkCacheSize !== undefined) {
    assertFinite(ios.artworkCacheSize, 'config.ios.artworkCacheSize')
    if (!Number.isInteger(ios.artworkCacheSize) || ios.artworkCacheSize < 0) {
      throw invalidArgument(
        `config.ios.artworkCacheSize must be a non-negative integer, got ${ios.artworkCacheSize}.`
      )
    }
  }

  return {
    android:
      android === undefined
        ? undefined
        : {
            notificationChannelId: android.notificationChannelId,
            notificationChannelName: android.notificationChannelName,
            notificationIcon: android.notificationIcon,
            stopForegroundOnPause:
              android.stopForegroundOnPause ?? DEFAULT_STOP_FOREGROUND_ON_PAUSE,
            // Passed through undefined rather than defaulted: "no opinion" has
            // to stay distinguishable from "10 minutes", because media3 is
            // free to change its own default and an app that did not ask
            // should move with it.
            stopForegroundTimeoutMs: android.stopForegroundTimeoutMs,
            playbackResumption:
              android.playbackResumption ?? DEFAULT_PLAYBACK_RESUMPTION,
          },
    ios: ios === undefined ? undefined : { artworkCacheSize: ios.artworkCacheSize },
  }
}
