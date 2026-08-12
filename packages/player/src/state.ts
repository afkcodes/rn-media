import type { PlayerError } from './errors'
import { classifyEndFile } from './errors'
import type { PlayerEvent } from './events'
import { MPV_VOLUME_SCALE, MpvProperty } from './properties'

/**
 * Coarse lifecycle of a player.
 *
 * ```text
 *                        startFile
 *        ┌───────────────────────────────────────────┐
 *        │                                           ▼
 *   ┌────────┐                                  ┌─────────┐
 *   │  idle  │                                  │ loading │
 *   └────────┘                                  └─────────┘
 *        ▲                                        │      │
 *        │ endFile(stop|quit) / shutdown          │      │ endFile(error)
 *        │ / idle-active=true                     │      ▼
 *        │                       playbackRestart  │  ┌───────┐
 *        │                                        │  │ error │
 *        │                                        ▼  └───────┘
 *        │       ┌───────┐   playing && core-idle  ┌───────────┐
 *        └───────│ ready │◀───────────────────────▶│ buffering │
 *                └───────┘   !core-idle            └───────────┘
 *                    │
 *                    │ endFile(endOfFile)
 *                    ▼
 *                ┌───────┐
 *                │ ended │
 *                └───────┘
 * ```
 *
 * `error`, `ended` and `loading` are sticky: only a new `startFile` (or a
 * shutdown) leaves them, so a late `idle-active` cannot erase a failure.
 */
export type PlayerStatus =
  'idle' | 'loading' | 'buffering' | 'ready' | 'ended' | 'error'

/** Repeat behaviour, mapped onto mpv's `loop-file` / `loop-playlist`. */
export type LoopMode = 'off' | 'track' | 'playlist'

/**
 * The fixed point from which {@link projectPosition} extrapolates.
 *
 * Position is never streamed across the bridge. mpv tells us the truth only on
 * discontinuities (seek, playback restart, pause/unpause, rate change, track
 * change); between them the client extrapolates from this anchor.
 */
export interface PositionAnchor {
  /** Known-good playback position, in seconds. */
  readonly position: number
  /** `Date.now()`-style millisecond timestamp at which {@link position} held. */
  readonly timestamp: number
  /** The playback rate in effect from {@link timestamp} onwards. */
  readonly rate: number
}

/** Where we are in mpv's playlist. */
export interface PlaylistPosition {
  /** 0-based index of the current entry; `-1` when there is no current entry. */
  readonly index: number
  /** Total number of playlist entries. */
  readonly count: number
}

/**
 * The raw `loop-file` / `loop-playlist` strings behind {@link PlayerState.loop}.
 *
 * Both are kept because {@link LoopMode} is lossy: deriving it needs *both*
 * values, and a pure reducer has nowhere else to remember the other one.
 * mpv's value domain is `"no" | "inf" | "force" | <count>`, which is why they
 * are observed as strings (mpv's node format for these options changes with
 * the value — flag for `no`, string for `inf`, int64 for a count).
 */
export interface LoopRaw {
  /** mpv's `loop-file`. `"no"`/`"0"` mean no track repeat. */
  readonly file: string
  /** mpv's `loop-playlist`. `"no"`/`"1"` mean no playlist repeat. */
  readonly playlist: string
}

/**
 * One immutable snapshot of everything the player knows.
 *
 * Snapshots are produced only by {@link reducePlayerState}; nothing mutates a
 * `PlayerState` in place, and an event that changes nothing returns the *same*
 * object identity — so a snapshot is safe to hand to `useSyncExternalStore`.
 */
export interface PlayerState {
  /** Coarse lifecycle stage. See {@link PlayerStatus}. */
  readonly status: PlayerStatus
  /** Playback *intent* — the inverse of mpv's `pause`. */
  readonly playing: boolean
  /**
   * Duration of the current entry in seconds; `undefined` while unknown **and
   * always `undefined` while {@link isLive}**.
   *
   * @remarks
   * The live suppression is not cosmetic. On an unseekable stream mpv's
   * `duration` is the length of what it has *cached*, not the length of the
   * broadcast: on-device it read `1.93` and climbed to `2.14` and beyond,
   * several times a second, forever. Publishing that would make every seek bar
   * lie and turn any duration-keyed broadcast into a ticker, so a live entry
   * reports no duration at all rather than a dishonest one.
   */
  readonly duration?: number
  /** The anchor {@link projectPosition} extrapolates from. */
  readonly positionAnchor: PositionAnchor
  /**
   * Absolute timestamp (seconds, directly comparable to position) up to which
   * the demuxer has buffered — mpv's `demuxer-cache-time`.
   *
   * @remarks
   * **Second-granular, deliberately.** mpv republishes this several times a
   * second for as long as the cache is filling (including while paused), and
   * every republication would otherwise mint a new `PlayerState` and wake every
   * state listener. The reducer therefore only adopts a value that moved at
   * least {@link BUFFERED_POSITION_STEP} second from the last published one —
   * plus one guaranteed update at the instant the buffer reaches
   * {@link duration}, so "fully buffered" is always observable exactly.
   *
   * The value itself is mpv's, unrounded: what is quantised is *how often* it
   * changes, not what it says. Do not use it as a clock — it is a fill level,
   * and {@link projectPosition} is what moves smoothly.
   */
  readonly bufferedPosition?: number
  /** Playback rate multiplier (mpv's `speed`; mpv accepts 0.01–100). */
  readonly rate: number
  /** Volume normalised to `0..1`; `1` is mpv's `volume=100` (unattenuated). */
  readonly volume: number
  /** Whether output is muted (mpv's `mute`). */
  readonly muted: boolean
  /** Repeat behaviour. */
  readonly loop: LoopMode
  /** The raw mpv strings {@link loop} was derived from. */
  readonly loopRaw: LoopRaw
  /** Playlist cursor. */
  readonly playlist: PlaylistPosition
  /**
   * The failure that produced `status: 'error'`. Present iff status is
   * `'error'`.
   *
   * @remarks
   * **How long it sticks, exactly** — the three ways it clears, all of them
   * already in the reducer and none of them a timer:
   *
   * 1. **`startFile`** — a new entry is loading, so every file-scoped field
   *    including this one is dropped. On a queue this is the common case: mpv
   *    advances past the failed entry within milliseconds, and the error is
   *    visible only in the window before the next entry starts.
   * 2. **`playbackRestart`** — audio is flowing again, which is the strongest
   *    possible evidence that whatever failed no longer applies. This is the
   *    "auto-clear on the next successful playback restart" rule.
   * 3. **`endFile` with reason `stop`/`quit`** — deliberate teardown; the state
   *    goes to `idle` with nothing left over.
   *
   * So it survives indefinitely in exactly one situation: the **last** entry
   * failed and nothing started after it. That is the case
   * {@link Player.clearError} exists for — a user dismissing a banner. Clearing
   * is a change to this snapshot only: the `error` event has already been
   * delivered and nothing suppresses, replays or un-logs it.
   */
  readonly error?: PlayerError
  /**
   * Title of the current entry (mpv's `media-title`), when known.
   *
   * @remarks
   * **This is the now-playing surface, and it is one of two deliberately
   * different routes to a track's metadata.** Read this one when you want *the
   * line a lock screen shows*; reach for `Player.getMetadata()` /
   * `Player.getMetadataValue()` when you want *a specific tag*.
   *
   * | | `state.title` | `metadataChanged` + `getMetadataValue` |
   * | --- | --- | --- |
   * | shape | one coalesced string | the whole tag map, or one key |
   * | delivery | part of every snapshot, so it rides the state fan-out and every broadcast channel built on it | an event, and only while something is listening |
   * | cost | none beyond the snapshot | one node read per batch that touched the tags |
   * | on a radio stream | follows `StreamTitle` automatically | `icy-title`, `icy-name`, `icy-genre`, `icy-br` … individually |
   *
   * mpv derives `media-title` from the demuxer's `title` tag when there is one
   * and from ICY's `icy-title` on a live stream, and invalidates both it and
   * `metadata` on the same `MP_EVENT_METADATA_UPDATE` (`player/command.c`). So
   * on an Icecast/Shoutcast station this field *is* the currently-playing song,
   * changing every few minutes without a track change — which is exactly what a
   * media session wants to publish, and exactly why it lives in state rather
   * than behind a pull.
   *
   * The reason both exist: a media session re-broadcasts **state**, not events,
   * so the now-playing line has to be a state field or it cannot reach the
   * notification at all. And the full tag map cannot be a state field, because
   * building it costs a synchronous read and most apps never look at it — see
   * `PlayerEventMap.metadataChanged`, which is why that one is opt-in.
   *
   * One consequence worth knowing on a live stream: this field carries the
   * *song*, and the *station* is only in the tag map (`icy-name`). An app that
   * wants both needs both routes.
   */
  readonly title?: string
  /** `true` while mpv is repositioning; position projection freezes. */
  readonly seeking: boolean
  /**
   * mpv's `seekable`: "whether it's generally possible to seek in the current
   * file". `undefined` until mpv publishes it for the current entry (and while
   * nothing is loaded), which is why it is tri-state rather than a boolean.
   *
   * Useful directly — a UI should not offer a scrubber when this is `false` —
   * and it is the sole input to {@link isLive}.
   */
  readonly seekable?: boolean
  /**
   * Whether the current entry is an endless live stream with no meaningful
   * total length.
   *
   * @remarks
   * Exactly `seekable === false` on a loaded entry. mpv has no "is live"
   * property, but on every on-device sample `seekable` discriminated cleanly:
   * unseekable network streams (Icecast, HLS live) report `false`, finite
   * tracks report `true`.
   *
   * Semantics, precisely:
   * - It is `false` before mpv has said anything — the honest default, since a
   *   just-issued `loadfile` is far more often a finite track, and `seekable`
   *   is *unavailable* (not `false`) while the core is idle.
   * - It flips to `true` the moment `seekable = false` arrives while an entry
   *   is loaded (`idle-active = no`).
   * - It resets to `false` on every `startFile` and on every `playlist-pos`
   *   change, so a live entry cannot leak its liveness onto the finite track
   *   that follows it.
   *
   * While it is `true`, {@link duration} is suppressed to `undefined`.
   */
  readonly isLive: boolean
  /**
   * mpv's `core-idle`: `true` whenever no audio is being produced — which
   * includes paused, buffering, restarting and idle. Combined with
   * {@link playing} this is what separates `buffering` from `ready`.
   */
  readonly coreIdle: boolean
  /** mpv's `idle-active`: nothing is loaded and the core is parked. */
  readonly idleActive: boolean
  /**
   * mpv's `eof-reached`.
   *
   * @remarks
   * Never used to decide that a track ended — with `keep-open=no` (mpv's
   * default, which we keep) the property "will logically be cleared
   * immediately after it's set" (mpv `input.rst`, `eof-reached`), so the edge
   * is not reliably observable. Its only job here is to stop us reporting
   * `buffering` for a core that is idle *because* it hit EOF.
   */
  readonly eofReached: boolean
}

/**
 * The file-scoped values the Player reads once when the playlist cursor moves.
 *
 * A key is *absent* when mpv reported that property unavailable — which the
 * reducer treats as honestly unknown (drop the field), never as unchanged.
 * See {@link ReducerContext.trackChange} for why these are read at all.
 */
export interface TrackChangeReads {
  /** `duration` of the entry that just became current, in seconds. */
  readonly duration?: number
  /** `seekable` for the entry that just became current. */
  readonly seekable?: boolean
  /** `media-title` of the entry that just became current. */
  readonly title?: string
}

/**
 * Everything the reducer needs that is not carried by the event itself.
 *
 * @remarks
 * A reducer over a real-time stream cannot be pure *and* call `Date.now()`.
 * Time, the one-shot `time-pos` resync, the one-shot track-change reads and
 * the current URI are therefore injected — which is exactly what makes the
 * state machine reproducible from recorded fixtures.
 */
export interface ReducerContext {
  /** `Date.now()` at the moment the batch was received, in milliseconds. */
  readonly now: number
  /**
   * `time-pos`, read once per batch and only when the batch contains a
   * position discontinuity. `undefined` when mpv reported it unavailable.
   */
  readonly timePos?: number
  /**
   * `duration` / `seekable` / `media-title`, read once per batch and only when
   * the batch carries a `playlist-pos` change.
   *
   * @remarks
   * This exists because **mpv will not tell us these a second time**. Two facts
   * of mpv's property-observation contract (`player/client.c`, confirmed
   * on-device 2026-08-11) combine against a "drop it and wait for the
   * re-publication" strategy on a gapless transition:
   *
   * 1. An observed property is delivered again only when its new value
   *    compares *unequal* to the one last sent (`send_client_property_changes`).
   *    Two consecutive tracks of the same length therefore never produce a
   *    second `duration` event at all.
   * 2. `gen_property_change_event` walks a client's observers in *registration*
   *    order, and `OBSERVED_PROPERTIES` registers `duration` before
   *    `playlist-pos`. On a gapless transition the new entry's `duration` thus
   *    arrives in the *same* batch, *before* the cursor change that would drop
   *    it.
   *
   * So the re-publication the cursor change waits for has either already gone
   * past or will never come, and `duration`/`seekable`/`title` stay `undefined`
   * for the rest of the entry. Reordering the observation table fixes neither
   * (fact 1 is independent of order). The Player instead reads the three values
   * synchronously when it sees the cursor move and injects them here, exactly
   * as it does for {@link timePos}.
   *
   * They are "now" values — read when the batch reached JavaScript, not at the
   * instant mpv generated the event — the same accepted approximation as
   * {@link timePos}. When a value is genuinely not known yet (a network entry
   * that is not demuxed), the key is absent and the field is dropped; mpv *will*
   * send a change event once it becomes known, because `none → value` compares
   * unequal.
   */
  readonly trackChange?: TrackChangeReads
  /** The source URI currently loaded, used to classify failures. */
  readonly uri?: string
}

/** The state of a freshly created, not-yet-loaded player. */
export function createInitialState(now: number): PlayerState {
  return {
    status: 'idle',
    playing: false,
    positionAnchor: { position: 0, timestamp: now, rate: 1 },
    rate: 1,
    volume: 1,
    muted: false,
    loop: 'off',
    loopRaw: { file: 'no', playlist: 'no' },
    playlist: { index: -1, count: 0 },
    seeking: false,
    isLive: false,
    coreIdle: true,
    idleActive: true,
    eofReached: false,
  }
}

/**
 * How far {@link PlayerState.bufferedPosition} must move before the reducer
 * publishes it, in seconds.
 *
 * @remarks
 * mpv republishes `demuxer-cache-time` continuously — ~4-6 broadcasts per
 * second in steady playback, and it keeps filling while *paused* too. Each
 * accepted value is a fresh `PlayerState` object and a full state fan-out, so
 * left unquantised this single property makes the "state changes only on
 * discontinuities" contract untrue for the entire life of a session.
 *
 * One second is chosen, not tuned: it is the granularity every consumer of the
 * value already works at (a buffer bar is a few hundred pixels wide over a
 * multi-minute track; media3's `setContentBufferedPositionMs` feeds the same
 * bar; the media-session persistence layer rounds to seconds anyway), and it
 * is coarse enough that a 4-6 Hz feed becomes ~1 Hz at the fastest fill and
 * silent at a realistic one.
 */
export const BUFFERED_POSITION_STEP = 1

/**
 * Whether `next` is the moment the buffer reached the end of a finite entry.
 *
 * The one update that must never be quantised away: "fully buffered" is a
 * *state*, not a sample, and a UI that draws `buffered >= duration` differently
 * (no spinner, a filled bar, an offline badge) would otherwise be left up to
 * {@link BUFFERED_POSITION_STEP} short of it forever, because nothing further
 * arrives once the cache stops growing. A live entry has no duration, so this
 * is simply never true there.
 */
function crossesEndOfBuffer(state: PlayerState, next: number): boolean {
  const { duration, bufferedPosition } = state
  if (duration === undefined || bufferedPosition === undefined) return false
  return bufferedPosition < duration && next >= duration
}

/**
 * Whether the projected position advances with wall-clock time.
 *
 * Only `ready` counts: while `loading`, `buffering`, seeking, `ended`, `idle`
 * or `error`, no audio leaves the decoder, so a ticking clock would lie.
 */
function isAdvancing(state: PlayerState): boolean {
  return state.playing && state.status === 'ready' && !state.seeking
}

function clampPosition(position: number, duration: number | undefined): number {
  const lower = position > 0 ? position : 0
  if (duration === undefined || !Number.isFinite(duration) || duration < 0) {
    return lower
  }
  return lower > duration ? duration : lower
}

/**
 * Project the current playback position from `state`'s anchor.
 *
 * `position = anchor.position + (advancing ? (now - anchor.timestamp) / 1000 *
 * anchor.rate : 0)`, clamped to `[0, duration]`.
 *
 * @param state - The snapshot to project from.
 * @param now - `Date.now()`-style millisecond timestamp to project to.
 * @returns The position in seconds.
 */
export function projectPosition(state: PlayerState, now: number): number {
  const anchor = state.positionAnchor
  if (!isAdvancing(state)) {
    return clampPosition(anchor.position, state.duration)
  }
  const elapsedMs = now - anchor.timestamp
  const elapsed = elapsedMs > 0 ? (elapsedMs / 1000) * anchor.rate : 0
  return clampPosition(anchor.position + elapsed, state.duration)
}

/**
 * Re-anchor the projection at `now` without moving the reported position.
 *
 * Every discontinuity goes through this first: it freezes the value the old
 * anchor was about to report, so a following status/rate/pause change cannot
 * make the projected position jump.
 */
function rebase(
  state: PlayerState,
  now: number,
  rate = state.positionAnchor.rate
): PlayerState {
  return {
    ...state,
    positionAnchor: {
      position: projectPosition(state, now),
      timestamp: now,
      rate,
    },
  }
}

function deriveStatus(state: PlayerState): PlayerStatus {
  switch (state.status) {
    case 'error':
    case 'ended':
    case 'loading':
    case 'idle':
      return state.status
    case 'ready':
    case 'buffering':
      if (state.idleActive) return 'idle'
      return state.playing && state.coreIdle && !state.eofReached
        ? 'buffering'
        : 'ready'
    default: {
      const exhaustive = state.status
      exhaustive satisfies never
      return state.status
    }
  }
}

/** Re-derive `status` after a field that feeds it has changed. */
function withStatus(state: PlayerState): PlayerState {
  const status = deriveStatus(state)
  return status === state.status ? state : { ...state, status }
}

function toLoopMode(raw: LoopRaw): LoopMode {
  // `loop-file` is off for "no"/"0"; `loop-playlist` is off for "no"/"1"
  // (mpv models "play the playlist once" as 1). Anything else — "inf",
  // "force", a repeat count — is a loop.
  if (raw.file !== 'no' && raw.file !== '0') return 'track'
  if (raw.playlist !== 'no' && raw.playlist !== '1') return 'playlist'
  return 'off'
}

function withLoopRaw(state: PlayerState, loopRaw: LoopRaw): PlayerState {
  return { ...state, loopRaw, loop: toLoopMode(loopRaw) }
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function asBool(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

/** Drop `error` (and keep every other field) — used when leaving `error`. */
function clearError(state: PlayerState): PlayerState {
  if (state.error === undefined) return state
  const next = { ...state }
  delete (next as { error?: PlayerError }).error
  return next
}

/**
 * Re-derive `isLive` from `seekable`, and suppress `duration` while live.
 *
 * Applied once to the output of every reduction, which is what makes the rule
 * total: no individual case has to remember it, and the two fields can never
 * disagree. Returns the *same object identity* when nothing changes, so the
 * reducer's no-op contract survives.
 *
 * The `!idleActive` term is belt-and-braces: mpv reports `seekable` as
 * unavailable while nothing is loaded, so it should already be `undefined`
 * there, but a stale `false` must never be readable as "the idle core is a
 * live stream".
 */
function withLiveness(state: PlayerState): PlayerState {
  const isLive = state.seekable === false && !state.idleActive
  if (isLive === state.isLive) return state
  if (!isLive) return { ...state, isLive }
  const next: PlayerState = { ...state, isLive }
  // mpv's `duration` on a live stream is the cache length; see PlayerState.
  delete (next as { duration?: number }).duration
  return next
}

function reduceProperty(
  state: PlayerState,
  name: string,
  value: unknown,
  context: ReducerContext
): PlayerState {
  switch (name) {
    case MpvProperty.pause: {
      const paused = asBool(value)
      if (paused === undefined) return state
      const playing = !paused
      if (playing === state.playing) return state
      // Pause/unpause is a discontinuity for the projection clock even though
      // the position itself does not move.
      return withStatus({ ...rebase(state, context.now), playing })
    }

    case MpvProperty.speed: {
      const rate = asNumber(value)
      if (rate === undefined || rate === state.rate) return state
      // Rebase with the OLD rate first, then adopt the new one.
      return withStatus({ ...rebase(state, context.now, rate), rate })
    }

    case MpvProperty.duration: {
      // On a live stream this number is the demuxer cache length and grows
      // forever, so it is dropped on the floor rather than stored and
      // re-suppressed (which would churn snapshot identity several times a
      // second). See {@link PlayerState.duration}.
      const duration = state.isLive ? undefined : asNumber(value)
      return duration === state.duration ? state : { ...state, duration }
    }

    case MpvProperty.seekable: {
      const seekable = asBool(value)
      if (seekable === state.seekable) return state
      if (seekable === undefined) {
        const next = { ...state }
        delete (next as { seekable?: boolean }).seekable
        return next
      }
      return { ...state, seekable }
    }

    case MpvProperty.seeking: {
      const seeking = asBool(value) ?? false
      if (seeking === state.seeking) return state
      return withStatus({ ...rebase(state, context.now), seeking })
    }

    case MpvProperty.coreIdle: {
      const coreIdle = asBool(value) ?? true
      if (coreIdle === state.coreIdle) return state
      return withStatus({ ...rebase(state, context.now), coreIdle })
    }

    case MpvProperty.idleActive: {
      const idleActive = asBool(value) ?? false
      if (idleActive === state.idleActive) return state
      return withStatus({ ...rebase(state, context.now), idleActive })
    }

    case MpvProperty.eofReached: {
      const eofReached = asBool(value) ?? false
      if (eofReached === state.eofReached) return state
      return withStatus({ ...state, eofReached })
    }

    case MpvProperty.playlistPos: {
      const index = asNumber(value)
      const next = index === undefined ? -1 : Math.trunc(index)
      if (next === state.playlist.index) return state
      // Track change: position restarts and every file-scoped field still
      // describes the previous entry.
      //
      // `bufferedPosition` is simply dropped — `demuxer-cache-time` republishes
      // several times a second, so it repairs itself immediately. The other
      // three cannot be waited for (see {@link ReducerContext.trackChange}), so
      // they take the one-shot reads the Player injected: present means adopt,
      // absent means honestly unknown. Setting/dropping `seekable` here is what
      // re-derives `isLive` through `withLiveness` — a finite track after a live
      // stream reads back `seekable = true` and stops being live, and one that
      // reads back nothing falls to the same `undefined` (not live) the old
      // unconditional drop produced.
      const changed: PlayerState = {
        ...state,
        playlist: { index: next, count: state.playlist.count },
        positionAnchor: {
          position: 0,
          timestamp: context.now,
          rate: state.rate,
        },
      }
      // One cast for the four optional fields; `changed` is a fresh copy that
      // has not escaped, so writing it in place is still pure.
      const fileScoped = changed as {
        duration?: number
        bufferedPosition?: number
        title?: string
        seekable?: boolean
      }
      const reads = context.trackChange
      delete fileScoped.bufferedPosition
      if (reads?.duration !== undefined) fileScoped.duration = reads.duration
      else delete fileScoped.duration
      if (reads?.title !== undefined) fileScoped.title = reads.title
      else delete fileScoped.title
      if (reads?.seekable !== undefined) fileScoped.seekable = reads.seekable
      else delete fileScoped.seekable
      return withStatus(changed)
    }

    case MpvProperty.playlistCount: {
      const count = asNumber(value)
      const next = count === undefined ? 0 : Math.trunc(count)
      if (next === state.playlist.count) return state
      return {
        ...state,
        playlist: { index: state.playlist.index, count: next },
      }
    }

    case MpvProperty.demuxerCacheTime: {
      const bufferedPosition = asNumber(value)
      if (bufferedPosition === state.bufferedPosition) return state
      if (bufferedPosition === undefined) {
        const next = { ...state }
        delete (next as { bufferedPosition?: number }).bufferedPosition
        return next
      }
      const previous = state.bufferedPosition
      if (
        previous !== undefined &&
        !crossesEndOfBuffer(state, bufferedPosition)
      ) {
        // The buffer clock is the one property mpv republishes continuously —
        // measured at ~4-6 Hz in steady playback — and every acceptance here
        // costs a whole new `PlayerState` plus a full listener fan-out, for a
        // number most UIs draw as a bar a few hundred pixels wide. Sub-second
        // movement is therefore not news; see {@link BUFFERED_POSITION_STEP}.
        if (Math.abs(bufferedPosition - previous) < BUFFERED_POSITION_STEP) {
          return state
        }
      }
      return { ...state, bufferedPosition }
    }

    case MpvProperty.volume: {
      const raw = asNumber(value)
      if (raw === undefined) return state
      const volume = raw / MPV_VOLUME_SCALE
      return volume === state.volume ? state : { ...state, volume }
    }

    case MpvProperty.mute: {
      const muted = asBool(value)
      if (muted === undefined || muted === state.muted) return state
      return { ...state, muted }
    }

    case MpvProperty.loopFile: {
      const file = asString(value) ?? 'no'
      if (file === state.loopRaw.file) return state
      return withLoopRaw(state, { file, playlist: state.loopRaw.playlist })
    }

    case MpvProperty.loopPlaylist: {
      const playlist = asString(value) ?? 'no'
      if (playlist === state.loopRaw.playlist) return state
      return withLoopRaw(state, { file: state.loopRaw.file, playlist })
    }

    case MpvProperty.mediaTitle: {
      const title = asString(value)
      if (title === state.title) return state
      if (title === undefined) {
        const next = { ...state }
        delete (next as { title?: string }).title
        return next
      }
      return { ...state, title }
    }

    default:
      // An unrecognised property — almost certainly a raw `observeProperty()`
      // escape-hatch observation. Not our business.
      return state
  }
}

/**
 * The pure state reducer: `(state, event, context) → state`.
 *
 * Every `PlayerState` in the system comes from here. It performs no I/O, reads
 * no clock, and returns the *same object identity* when an event changes
 * nothing — so `onStateChange` never fires spuriously.
 *
 * @param state - The previous snapshot.
 * @param event - One translated event (see {@link PlayerEvent}).
 * @param context - Injected clock / `time-pos` / current URI.
 * @returns The next snapshot, or `state` unchanged.
 */
export function reducePlayerState(
  state: PlayerState,
  event: PlayerEvent,
  context: ReducerContext
): PlayerState {
  // Liveness is derived, not reduced: every path funnels through one place so
  // that `isLive` and the `duration` suppression can never be forgotten.
  return withLiveness(reduceEvent(state, event, context))
}

/** The event-by-event half of {@link reducePlayerState}. */
function reduceEvent(
  state: PlayerState,
  event: PlayerEvent,
  context: ReducerContext
): PlayerState {
  switch (event.kind) {
    case 'property':
      return reduceProperty(state, event.name, event.value, context)

    case 'startFile': {
      // A fresh entry: everything file-scoped is dropped, including any error
      // from the previous attempt and the previous entry's seekability (so
      // `isLive` starts from its `false` default again).
      const loading: PlayerState = {
        status: 'loading',
        playing: state.playing,
        positionAnchor: {
          position: 0,
          timestamp: context.now,
          rate: state.rate,
        },
        rate: state.rate,
        volume: state.volume,
        muted: state.muted,
        loop: state.loop,
        loopRaw: state.loopRaw,
        playlist: state.playlist,
        seeking: false,
        isLive: false,
        coreIdle: state.coreIdle,
        idleActive: false,
        eofReached: false,
      }
      return loading
    }

    case 'seek':
      // The seek target is not in the event; freeze where we are and wait for
      // `playbackRestart` to hand us the truth.
      return withStatus({ ...rebase(state, context.now), seeking: true })

    case 'playbackRestart': {
      const position =
        context.timePos !== undefined
          ? context.timePos
          : projectPosition(state, context.now)
      const restarted: PlayerState = {
        ...clearError(state),
        status: 'ready',
        seeking: false,
        eofReached: false,
        idleActive: false,
        positionAnchor: {
          position: clampPosition(position, state.duration),
          timestamp: context.now,
          rate: state.rate,
        },
      }
      return withStatus(restarted)
    }

    case 'endFile': {
      const outcome = classifyEndFile(event.reason, event.error, context.uri)
      const settled = rebase(state, context.now)
      switch (outcome.type) {
        case 'ended':
          return {
            ...settled,
            status: 'ended',
            seeking: false,
            positionAnchor:
              state.duration !== undefined
                ? {
                    position: state.duration,
                    timestamp: context.now,
                    rate: settled.positionAnchor.rate,
                  }
                : settled.positionAnchor,
          }
        case 'failed':
          return {
            ...settled,
            status: 'error',
            seeking: false,
            error: outcome.error,
          }
        case 'stopped':
          return {
            ...clearError(settled),
            status: 'idle',
            seeking: false,
          }
        case 'redirect':
          // The entry was a playlist and got expanded in place; a fresh
          // `startFile` follows. Nothing to report.
          return state
        default: {
          const exhaustive = outcome
          exhaustive satisfies never
          return state
        }
      }
    }

    case 'shutdown':
      return {
        ...rebase(state, context.now),
        status: 'idle',
        playing: false,
        seeking: false,
        idleActive: true,
        coreIdle: true,
      }

    case 'log':
      // Logs never move state; the Player forwards them to its log listener.
      return state

    default: {
      const exhaustive = event
      exhaustive satisfies never
      return state
    }
  }
}

/**
 * Drop a settled `error` on request, leaving every other field alone.
 *
 * @param state - The snapshot to clear.
 * @returns A new snapshot with no `error` and `status: 'idle'`, or `state`
 * unchanged when there was nothing to clear.
 *
 * @remarks
 * This is the deliberate-dismissal counterpart to the three automatic clears
 * documented on {@link PlayerState.error}; it exists because those all require
 * *something to happen*, and the one error that sticks forever is the one after
 * which nothing does.
 *
 * `status` must move too, or the snapshot would violate its own invariant
 * ("`error` present iff `status === 'error'`"). It moves to `'idle'` rather
 * than to a re-derived value because `'error'` is a **sticky terminal** status
 * — the reducer only leaves it on a `startFile`/`playbackRestart`/stop, and if
 * any of those had happened there would be no error left to clear. `'idle'` is
 * the other terminal, and it is what the core genuinely is: nothing playing,
 * nothing loading.
 *
 * Clearing changes **state only**. No event is suppressed, replayed or undone:
 * the `error` event fired when the failure happened and is already in the app's
 * logs. Dismissing a banner is not the same as the failure not having occurred,
 * and this function is careful not to conflate them.
 */
export function clearPlayerError(state: PlayerState): PlayerState {
  if (state.error === undefined && state.status !== 'error') return state
  const next: PlayerState = {
    ...state,
    status: state.status === 'error' ? 'idle' : state.status,
  }
  delete (next as { error?: PlayerError }).error
  return next
}

/**
 * Re-anchor the projection on an authoritative position, without touching any
 * other field.
 *
 * Used by the one-shot `time-pos` resync: reading the real position is not an
 * event, so it does not go through {@link reducePlayerState}, but it must
 * still produce a fresh immutable snapshot.
 *
 * @param state - The snapshot to re-anchor.
 * @param position - The authoritative position in seconds.
 * @param now - `Date.now()`-style timestamp the position was read at.
 * @returns A new snapshot, or `state` if the anchor would not change.
 */
export function withResyncedAnchor(
  state: PlayerState,
  position: number,
  now: number
): PlayerState {
  const clamped = clampPosition(position, state.duration)
  const anchor = state.positionAnchor
  if (anchor.position === clamped && anchor.timestamp === now) return state
  return {
    ...state,
    positionAnchor: { position: clamped, timestamp: now, rate: state.rate },
  }
}

/**
 * Whether an event invalidates the position anchor badly enough that the
 * Player should spend one synchronous `time-pos` read on it.
 *
 * Only `playbackRestart` qualifies: it is mpv's "position is meaningful again"
 * signal after a seek or a load. Pause, rate and track changes are re-anchored
 * arithmetically and need no read.
 */
export function isPositionDiscontinuity(event: PlayerEvent): boolean {
  return event.kind === 'playbackRestart'
}
