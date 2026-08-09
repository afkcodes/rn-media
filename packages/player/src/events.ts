import type {
  MpvEndFileReason,
  MpvEvent,
  MpvLogLevel,
  MpvPropertyValue,
} from './specs/mpv-client.nitro'

/**
 * A property observation changed (or became unavailable).
 *
 * @remarks
 * `value` is `undefined` when mpv reported the property as currently
 * unavailable (`MPV_FORMAT_NONE`) — e.g. `duration` while the core is idle.
 * That is a real state transition, not a dropped event.
 */
export interface PropertyEvent {
  readonly kind: 'property'
  /** The observed mpv property name, exactly as passed to `observeProperty`. */
  readonly name: string
  /** The new value, in the format the property was observed in. */
  readonly value: MpvPropertyValue | undefined
}

/** mpv began loading a playlist entry (`MPV_EVENT_START_FILE`). */
export interface StartFileEvent {
  readonly kind: 'startFile'
}

/** A playlist entry stopped playing (`MPV_EVENT_END_FILE`). */
export interface EndFileEvent {
  readonly kind: 'endFile'
  /** Why playback of the entry ended. */
  readonly reason: MpvEndFileReason
  /**
   * mpv's error string (from `mpv_error_string`), present only when
   * {@link reason} is `'error'`.
   */
  readonly error: string | undefined
}

/** A seek was initiated (`MPV_EVENT_SEEK`). Position is not yet valid. */
export interface SeekEvent {
  readonly kind: 'seek'
}

/**
 * Playback restarted after a seek or after loading finished
 * (`MPV_EVENT_PLAYBACK_RESTART`). This is the point at which `time-pos` is
 * meaningful again, so it is the primary position-anchor discontinuity.
 */
export interface PlaybackRestartEvent {
  readonly kind: 'playbackRestart'
}

/** An mpv log line (`MPV_EVENT_LOG_MESSAGE`). */
export interface LogEvent {
  readonly kind: 'log'
  /** Severity, as requested via the `log-level` init option. */
  readonly level: MpvLogLevel
  /** mpv's log prefix (the subsystem, e.g. `ffmpeg`, `stream`). */
  readonly prefix: string
  /** The message text, including mpv's trailing newline. */
  readonly text: string
}

/** The core is shutting down (`MPV_EVENT_SHUTDOWN`). No further events follow. */
export interface ShutdownEvent {
  readonly kind: 'shutdown'
}

/**
 * A proper TypeScript discriminated union over the flat {@link MpvEvent} struct
 * that crosses the Nitro boundary.
 *
 * @remarks
 * Nitro cannot represent per-variant string literal discriminators, so the
 * native side ships one flat struct whose populated fields depend on `kind`
 * (see `docs/specs/player-core.md` §2.5). {@link toPlayerEvent} is the single
 * place that translation happens; everything above it switches exhaustively on
 * this union.
 */
export type PlayerEvent =
  | PropertyEvent
  | StartFileEvent
  | EndFileEvent
  | SeekEvent
  | PlaybackRestartEvent
  | LogEvent
  | ShutdownEvent

/**
 * Translate one flat native {@link MpvEvent} into the {@link PlayerEvent}
 * discriminated union.
 *
 * @param event - The event as delivered by `setEventBatchListener`.
 * @returns The equivalent discriminated-union event, or `undefined` if the
 * event was malformed (a `property` or `log` event without a `name`, which
 * native never produces but the untrusted struct shape permits).
 *
 * @remarks
 * Total and exhaustive: the `switch` is guarded by `satisfies never`, so adding
 * a member to `MpvEventKind` is a compile error here rather than a silent drop.
 */
export function toPlayerEvent(event: MpvEvent): PlayerEvent | undefined {
  switch (event.kind) {
    case 'property':
      if (event.name === undefined) return undefined
      return { kind: 'property', name: event.name, value: event.value }
    case 'startFile':
      return { kind: 'startFile' }
    case 'endFile':
      return {
        kind: 'endFile',
        reason: event.endFileReason ?? 'unknown',
        error: event.error,
      }
    case 'seek':
      return { kind: 'seek' }
    case 'playbackRestart':
      return { kind: 'playbackRestart' }
    case 'log':
      return {
        kind: 'log',
        level: event.logLevel ?? 'info',
        prefix: event.name ?? '',
        text: event.text ?? '',
      }
    case 'shutdown':
      return { kind: 'shutdown' }
    default: {
      const exhaustive = event.kind
      // Compile-time proof that every `MpvEventKind` member is handled above.
      exhaustive satisfies never
      return undefined
    }
  }
}

/**
 * Translate a whole native batch, dropping malformed entries.
 *
 * @param events - One batch as delivered by `setEventBatchListener`.
 * @returns The batch as discriminated-union events, in order.
 */
export function toPlayerEvents(events: readonly MpvEvent[]): PlayerEvent[] {
  const out: PlayerEvent[] = []
  for (const event of events) {
    const mapped = toPlayerEvent(event)
    if (mapped !== undefined) out.push(mapped)
  }
  return out
}
