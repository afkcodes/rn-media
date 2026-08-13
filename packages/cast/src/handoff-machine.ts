/**
 * The local↔remote handoff state machine — cast.md §3, verbatim:
 *
 * ```
 * LOCAL --requestSession()/switcher-pick--> CONNECTING
 * CONNECTING --sessionStarted--> HANDOFF_TO_CAST
 *     (pause local · snapshot {queue, index, position, playWhenReady} ·
 *      load receiver queue at index/position)
 * HANDOFF_TO_CAST --receiver playing--> CAST_ACTIVE
 * CAST_ACTIVE --endSession()/switcher "this phone"/receiver died--> HANDOFF_TO_LOCAL
 *     (snapshot receiver position · local load+seek · resume per playWhenReady)
 * HANDOFF_TO_LOCAL --> LOCAL
 * any --error--> typed error + fall back to LOCAL at last known position
 * ```
 *
 * This file is the pure half: a reducer from `(state, event)` to
 * `{ state, effects }`, with no clock, no promises and no native calls — which
 * is what makes every transition (including every error fallback) unit-testable
 * without a device. `wireCastHandoff` (handoff.ts) executes the effects against
 * a real `CastApi` and a structural local player, and feeds completions back in
 * as events.
 *
 * Two invariants the shapes below encode:
 *
 * - **Position ownership is exclusive.** Exactly one backend owns the clock at
 *   any time. While `cast-active`, the receiver owns it: the reducer keeps a
 *   position *anchor* from the last `mediaStatus` (discontinuity-only — the
 *   library-wide rule) and every read projects from it. Transfers are
 *   discontinuities: each direction emits exactly one `castTransfer`.
 * - **The JS queue stays the source of truth.** The receiver queue is a
 *   *projection* of it — castable items only, `canCastMedia`-filtered, skips
 *   typed and surfaced — and every `mediaStatus` is reconciled back to a JS
 *   index through the `itemIds`/`jsIndices` mapping the reducer owns. The
 *   receiver queue dying with the session is fine: the projection is rebuilt
 *   from the JS queue on the next handoff.
 */
import { canCastMedia } from './can-cast'
import { CastError } from './errors'
import type {
  CastIdleReason,
  CastMediaMetadata,
  CastPlayerState,
  CastQueueItemInput,
  NativeCastMediaStatusEvent,
} from './specs/cast.nitro'

/* -------------------------------------------------------------------------- */
/*                                Public shapes                               */
/* -------------------------------------------------------------------------- */

/** The five phases of cast.md §3, in wire-format casing. */
export type CastHandoffPhase =
  | 'local'
  | 'connecting'
  | 'handoff-to-cast'
  | 'cast-active'
  | 'handoff-to-local'

/**
 * One JS-queue entry, as the handoff needs to see it: enough to decide
 * castability (`canCastMedia`) and to build the receiver-side
 * `CastMediaSource`. Structural on purpose — apps project their own queue
 * model into this, the same discipline as audio-session's
 * `AudioSessionPlayerLike`.
 */
export interface CastHandoffQueueItem {
  /** The app's own stable id — reported back in skip notices. */
  readonly id: string
  /**
   * What the *receiver* would fetch. Must be reachable from the receiver's
   * network: an app with a source resolver resolves here (signed URLs and
   * `demo://`-style logical ids alike) — the re-resolve-and-reload recipe for
   * expired URLs runs through this same field.
   */
  readonly url: string
  /**
   * Concrete audio MIME type (`'audio/mpeg'`, `'application/x-mpegurl'`, …).
   * Required: `CastMediaSource` needs one, and the app knows its catalogue.
   */
  readonly mimeType: string
  /** Per-request auth headers, if the source needs them — makes it non-castable. */
  readonly headers?: Record<string, string>
  readonly metadata?: CastMediaMetadata
  /** Known duration in seconds; omit when unknown or live. */
  readonly duration?: number
  readonly live?: boolean
}

/** The atomic read taken at handoff time: queue, cursor, clock, intent. */
export interface CastHandoffQueueSnapshot {
  readonly items: readonly CastHandoffQueueItem[]
  /** JS index of the current entry. */
  readonly index: number
  /** Position in seconds within the current entry. */
  readonly position: number
  /** Whether playback should continue on the receiver. */
  readonly playWhenReady: boolean
}

/** A queue entry the projection left out — typed, surfaced, never silent. */
export interface SkippedCastItem {
  /** JS-queue index of the skipped entry. */
  readonly index: number
  readonly item: CastHandoffQueueItem
  readonly reason: 'codec' | 'local-file' | 'headers'
}

/**
 * The castable projection of a JS-queue snapshot. `items[p]` came from
 * `snapshot.items[jsIndices[p]]` — the parallel array is one half of the
 * reconciliation mapping; the receiver-assigned `itemIds` (learned after
 * `queueLoad`) are the other.
 */
export interface CastQueueProjection {
  readonly items: readonly CastQueueItemInput[]
  readonly jsIndices: readonly number[]
  readonly skipped: readonly SkippedCastItem[]
  /** Projection-space start index (what `queueLoad` receives). */
  readonly startIndex: number
  /** Seconds into the start item. `0` whenever {@link startShifted}. */
  readonly startPosition: number
  /**
   * `true` when the current JS entry was not castable and the start moved to
   * the nearest castable one (at-or-after the cursor, wrapping to the first
   * castable if nothing follows). The position resets to `0` with it — a
   * position in one track means nothing in another.
   */
  readonly startShifted: boolean
}

/** A transfer discontinuity — one per direction per handoff. */
export interface CastTransferEvent {
  readonly direction: 'toCast' | 'toLocal'
  /** Position in seconds at the moment ownership moved. */
  readonly position: number
  /** JS-queue index ownership moved at. */
  readonly itemIndex: number
}

/**
 * The receiver's state, reconciled to JS-queue vocabulary — what the app maps
 * into its `setPlaybackState`/`setMediaItem` broadcasts while `cast-active`.
 * `{position, at, rate}` is a position *anchor* in the library-wide sense:
 * broadcast on discontinuities, projected locally in between.
 */
export interface CastReceiverSnapshot {
  readonly playerState: CastPlayerState
  readonly idleReason: CastIdleReason
  /** `true` while the receiver intends to advance (playing/buffering/loading). */
  readonly playing: boolean
  /** Reconciled JS-queue index, when the current receiver item maps to one. */
  readonly itemIndex?: number
  /** Receiver position in seconds at {@link at}. */
  readonly position: number
  /** Epoch ms the anchor was taken. */
  readonly at: number
  /** Rate the position advances at from {@link at}; `0` freezes projection. */
  readonly rate: number
  /** Stream duration in seconds, when the receiver knows it. */
  readonly duration?: number
  /** The receiver finished the last queue item (idle + `finished`). */
  readonly queueEnded: boolean
}

/* -------------------------------------------------------------------------- */
/*                              Events & effects                              */
/* -------------------------------------------------------------------------- */

/**
 * Everything that can move the machine. `at` fields are stamped by the caller
 * (the orchestrator) so the reducer itself never reads a clock.
 */
export type CastHandoffEvent =
  /** Command: the app asked to cast to a device. */
  | { readonly type: 'start'; readonly deviceId: string }
  /** Command: the app asked to end the session. */
  | {
      readonly type: 'end'
      readonly transferBack: boolean
      readonly at: number
    }
  /** Command: the JS queue changed while casting — re-project it. */
  | {
      readonly type: 'resync'
      readonly snapshot: CastHandoffQueueSnapshot
      readonly at: number
    }
  /** A cast session is up (requestSession resolved, or the system switcher/picker did it). */
  | {
      readonly type: 'sessionStarted'
      readonly snapshot: CastHandoffQueueSnapshot
      readonly at: number
    }
  | { readonly type: 'sessionStartFailed'; readonly error: CastError }
  | { readonly type: 'sessionEnded'; readonly at: number }
  | { readonly type: 'sessionSuspended'; readonly at: number }
  /** `loadCastQueue` completed; `itemIds` are the receiver-assigned ids in queue order. */
  | {
      readonly type: 'castQueueLoaded'
      readonly itemIds: readonly number[]
      readonly at: number
    }
  /**
   * A fresh read of the receiver item ids, outside a load ack. Device truth
   * behind this event: the sender-side `MediaQueue` mirror populates
   * *asynchronously after* `queueLoad`'s command ack, so the ids fetched with
   * the ack are routinely empty — the orchestrator re-reads them on every
   * native `queueChanged` and feeds them in here, which is what heals the
   * reconciliation mapping. (Found on hardware: every receiver jump rejected
   * `invalid-argument` until this existed.)
   */
  | {
      readonly type: 'queueItemIds'
      readonly itemIds: readonly number[]
      readonly at: number
    }
  | { readonly type: 'castQueueLoadFailed'; readonly error: CastError }
  /** A receiver status discontinuity. */
  | {
      readonly type: 'mediaStatus'
      readonly status: NativeCastMediaStatusEvent
      readonly at: number
    }
  /** A typed cast error (receiver fetch failure and friends). */
  | { readonly type: 'castError'; readonly error: CastError }
  /** `restoreLocal` completed. */
  | { readonly type: 'localRestored' }
  | { readonly type: 'localRestoreFailed'; readonly error: CastError }

/** What the reducer asks the orchestrator to do. Executed in array order. */
export type CastHandoffEffect =
  | { readonly type: 'connect'; readonly deviceId: string }
  | { readonly type: 'pauseLocal' }
  | {
      readonly type: 'loadCastQueue'
      readonly items: readonly CastQueueItemInput[]
      readonly startIndex: number
      readonly startPosition: number
    }
  | {
      readonly type: 'notifySkipped'
      readonly skipped: readonly SkippedCastItem[]
    }
  | { readonly type: 'endCastSession'; readonly stopReceiver: boolean }
  | {
      readonly type: 'restoreLocal'
      readonly itemIndex: number
      readonly position: number
      readonly playWhenReady: boolean
    }
  | { readonly type: 'emitTransfer'; readonly transfer: CastTransferEvent }
  | {
      readonly type: 'emitReceiverState'
      readonly snapshot: CastReceiverSnapshot
    }
  | { readonly type: 'emitError'; readonly error: CastError }

/* -------------------------------------------------------------------------- */
/*                                   State                                    */
/* -------------------------------------------------------------------------- */

/** Last known receiver clock: `position` (s) held at `at` (ms), advancing at `rate`. */
interface ReceiverAnchor {
  readonly position: number
  readonly at: number
  readonly rate: number
}

export type CastHandoffState =
  | { readonly phase: 'local' }
  | { readonly phase: 'connecting' }
  | {
      readonly phase: 'handoff-to-cast'
      readonly snapshot: CastHandoffQueueSnapshot
      readonly projection: CastQueueProjection
      /** `queueLoad` acknowledged; waiting for the receiver's first real status. */
      readonly loaded: boolean
      readonly itemIds: readonly number[]
    }
  | {
      readonly phase: 'cast-active'
      /** Receiver-assigned ids, queue order — one half of the reconciliation map. */
      readonly itemIds: readonly number[]
      /** `jsIndices[p]` is the JS index behind receiver queue position `p`. */
      readonly jsIndices: readonly number[]
      /** Current JS index, reconciled from the last `currentItemId`. */
      readonly itemIndex: number
      readonly anchor: ReceiverAnchor
      /** The receiver's advance intent — what a transfer-back resumes per. */
      readonly playWhenReady: boolean
      readonly duration?: number
      /** A resync's projection, adopted when its `castQueueLoaded` lands. */
      readonly pendingProjection?: CastQueueProjection
    }
  | {
      readonly phase: 'handoff-to-local'
      readonly itemIndex: number
      readonly position: number
      readonly playWhenReady: boolean
      readonly transferBack: boolean
      readonly awaiting: 'session-end' | 'local-restore'
    }

export const initialCastHandoffState: CastHandoffState = { phase: 'local' }

/* -------------------------------------------------------------------------- */
/*                              Pure projections                              */
/* -------------------------------------------------------------------------- */

/** Project a receiver anchor to `at` — the same rule every position surface uses. */
export function projectReceiverPosition(
  anchor: { position: number; at: number; rate: number },
  at: number
): number {
  const elapsed = Math.max(0, at - anchor.at) / 1000
  return anchor.position + elapsed * anchor.rate
}

/**
 * Build the castable projection of a queue snapshot.
 *
 * Filtering is `canCastMedia` verbatim — the receiver codec table is the spec.
 * Start rules are in {@link CastQueueProjection.startShifted}'s doc. Autoplay:
 * every item advances receiver-side (that is what survives the phone
 * sleeping), except the start item, which honours `playWhenReady` so a paused
 * handoff arrives paused.
 */
export function projectCastQueue(
  snapshot: CastHandoffQueueSnapshot
): CastQueueProjection {
  const items: CastQueueItemInput[] = []
  const jsIndices: number[] = []
  const skipped: SkippedCastItem[] = []

  snapshot.items.forEach((item, index) => {
    const verdict = canCastMedia({
      url: item.url,
      mimeType: item.mimeType,
      headers: item.headers,
    })
    if (!verdict.castable) {
      skipped.push({ index, item, reason: verdict.reason ?? 'codec' })
      return
    }
    jsIndices.push(index)
    items.push({
      source: {
        url: item.url,
        mimeType: item.mimeType,
        metadata: item.metadata,
        duration: item.duration,
        live: item.live,
      },
      autoplay: true,
    })
  })

  // Nearest castable at-or-after the cursor; wrap to the first castable when
  // nothing follows. (Failing outright when castable items exist earlier
  // would end the handoff over a queue that can mostly cast.)
  let startIndex = jsIndices.findIndex((jsIndex) => jsIndex >= snapshot.index)
  if (startIndex === -1) startIndex = 0
  const startJsIndex = jsIndices[startIndex]
  const startShifted = startJsIndex !== snapshot.index

  const startItem = items[startIndex]
  if (startItem !== undefined && !snapshot.playWhenReady) {
    items[startIndex] = { ...startItem, autoplay: false }
  }

  return {
    items,
    jsIndices,
    skipped,
    startIndex,
    startPosition: startShifted ? 0 : snapshot.position,
    startShifted,
  }
}

/** `itemId` → JS index through the projection mapping, or `undefined`. */
function reconcileItemIndex(
  itemIds: readonly number[],
  jsIndices: readonly number[],
  currentItemId: number | undefined
): number | undefined {
  if (currentItemId === undefined) return undefined
  const p = itemIds.indexOf(currentItemId)
  if (p === -1) return undefined
  return jsIndices[p]
}

/** `true` while the receiver intends the position to advance. */
function isAdvancing(playerState: CastPlayerState): boolean {
  return (
    playerState === 'playing' ||
    playerState === 'buffering' ||
    playerState === 'loading'
  )
}

function receiverSnapshot(
  status: NativeCastMediaStatusEvent,
  at: number,
  itemIndex: number | undefined
): CastReceiverSnapshot {
  const playing = isAdvancing(status.playerState)
  return {
    playerState: status.playerState,
    idleReason: status.idleReason,
    playing,
    itemIndex,
    position: status.position,
    at,
    // Only a genuinely-playing receiver advances the projection; buffering and
    // loading hold a truthful frozen clock rather than a drifting one.
    rate: status.playerState === 'playing' ? status.playbackRate : 0,
    duration: status.duration,
    queueEnded:
      status.playerState === 'idle' && status.idleReason === 'finished',
  }
}

function noCastableError(): CastError {
  return new CastError(
    'no-castable-media',
    'No item in the queue can be handed to a Cast receiver. See each ' +
      'skipped item’s reason (codec / local-file / headers) via onItemsSkipped.'
  )
}

/* -------------------------------------------------------------------------- */
/*                                 The reducer                                */
/* -------------------------------------------------------------------------- */

export interface CastHandoffTransition {
  readonly state: CastHandoffState
  readonly effects: readonly CastHandoffEffect[]
}

/** Convenience: unchanged state, no effects. */
function stay(state: CastHandoffState): CastHandoffTransition {
  return { state, effects: [] }
}

/**
 * The §3 machine as a pure transition function. Events that are meaningless in
 * the current phase are ignored (state unchanged, no effects) — remote
 * surfaces and platform callbacks fire at times the machine cannot forbid, so
 * "ignore what cannot apply" is the safe contract; every *meaningful* cell is
 * handled explicitly below and exercised by the unit suite.
 */
export function reduceCastHandoff(
  state: CastHandoffState,
  event: CastHandoffEvent
): CastHandoffTransition {
  switch (state.phase) {
    case 'local':
      return reduceLocal(state, event)
    case 'connecting':
      return reduceConnecting(state, event)
    case 'handoff-to-cast':
      return reduceHandoffToCast(state, event)
    case 'cast-active':
      return reduceCastActive(state, event)
    case 'handoff-to-local':
      return reduceHandoffToLocal(state, event)
  }
}

/** Shared by `local` and `connecting`: a session is up — begin the handoff. */
function beginHandoff(
  snapshot: CastHandoffQueueSnapshot
): CastHandoffTransition {
  const projection = projectCastQueue(snapshot)
  if (projection.items.length === 0) {
    // Nothing castable: stay LOCAL (local playback untouched — nothing was
    // paused), surface the typed answer. The session itself stays up; the
    // app decides whether to end it.
    return {
      state: { phase: 'local' },
      effects: [{ type: 'emitError', error: noCastableError() }],
    }
  }
  const effects: CastHandoffEffect[] = [{ type: 'pauseLocal' }]
  if (projection.skipped.length > 0) {
    effects.push({ type: 'notifySkipped', skipped: projection.skipped })
  }
  effects.push({
    type: 'loadCastQueue',
    items: projection.items,
    startIndex: projection.startIndex,
    startPosition: projection.startPosition,
  })
  return {
    state: {
      phase: 'handoff-to-cast',
      snapshot,
      projection,
      loaded: false,
      itemIds: [],
    },
    effects,
  }
}

/** Fall back to LOCAL at the pre-handoff snapshot (cast.md's any→error rule). */
function fallBackToLocal(
  snapshot: CastHandoffQueueSnapshot,
  error?: CastError
): CastHandoffTransition {
  const effects: CastHandoffEffect[] = []
  if (error !== undefined) effects.push({ type: 'emitError', error })
  effects.push({
    type: 'restoreLocal',
    itemIndex: snapshot.index,
    position: snapshot.position,
    playWhenReady: snapshot.playWhenReady,
  })
  return {
    state: {
      phase: 'handoff-to-local',
      itemIndex: snapshot.index,
      position: snapshot.position,
      playWhenReady: snapshot.playWhenReady,
      transferBack: true,
      awaiting: 'local-restore',
    },
    effects,
  }
}

function reduceLocal(
  state: CastHandoffState & { phase: 'local' },
  event: CastHandoffEvent
): CastHandoffTransition {
  switch (event.type) {
    case 'start':
      return {
        state: { phase: 'connecting' },
        effects: [{ type: 'connect', deviceId: event.deviceId }],
      }
    case 'sessionStarted':
      // The system output switcher / platform picker path: a session can
      // appear without this machine having asked for one.
      return beginHandoff(event.snapshot)
    case 'castError':
      // Already local — nothing to fall back from; still surfaced, never
      // swallowed.
      return { state, effects: [{ type: 'emitError', error: event.error }] }
    default:
      return stay(state)
  }
}

function reduceConnecting(
  state: CastHandoffState & { phase: 'connecting' },
  event: CastHandoffEvent
): CastHandoffTransition {
  switch (event.type) {
    case 'sessionStarted':
      return beginHandoff(event.snapshot)
    case 'sessionStartFailed':
      return {
        state: { phase: 'local' },
        effects: [{ type: 'emitError', error: event.error }],
      }
    case 'sessionEnded':
      // The user cancelled the picker (or the route vanished). Not an error.
      return { state: { phase: 'local' }, effects: [] }
    case 'castError':
      return {
        state: { phase: 'local' },
        effects: [{ type: 'emitError', error: event.error }],
      }
    default:
      return stay(state)
  }
}

function reduceHandoffToCast(
  state: CastHandoffState & { phase: 'handoff-to-cast' },
  event: CastHandoffEvent
): CastHandoffTransition {
  switch (event.type) {
    case 'castQueueLoaded':
      return {
        state: { ...state, loaded: true, itemIds: event.itemIds },
        effects: [],
      }
    case 'castQueueLoadFailed':
      return fallBackToLocal(state.snapshot, event.error)
    case 'castError':
      // The receiver could not fetch what we just loaded (or the SDK reported
      // an out-of-band media error) mid-handoff: typed error + LOCAL at the
      // last known (pre-handoff) position.
      return fallBackToLocal(state.snapshot, event.error)
    case 'sessionEnded':
      // The receiver died mid-handoff. The session's own events already tell
      // the story (castState → idle); restore local playback where it was.
      return fallBackToLocal(state.snapshot)
    case 'mediaStatus': {
      // "Receiver playing" completes the handoff — for a paused handoff the
      // analogue is any real (non-idle) player state. Requires the queueLoad
      // ack first: the reconciliation mapping needs the receiver item ids.
      if (!state.loaded) return stay(state)
      const status = event.status
      if (status.playerState === 'idle' || status.playerState === 'unknown') {
        return stay(state)
      }
      const { projection } = state
      const itemIndex =
        reconcileItemIndex(
          state.itemIds,
          projection.jsIndices,
          status.currentItemId
        ) ??
        projection.jsIndices[projection.startIndex] ??
        state.snapshot.index
      const snapshot = receiverSnapshot(status, event.at, itemIndex)
      return {
        state: {
          phase: 'cast-active',
          itemIds: state.itemIds,
          jsIndices: projection.jsIndices,
          itemIndex,
          anchor: {
            position: status.position,
            at: event.at,
            rate: snapshot.rate,
          },
          playWhenReady: snapshot.playing,
          duration: status.duration,
        },
        effects: [
          {
            type: 'emitTransfer',
            transfer: {
              direction: 'toCast',
              position: status.position,
              itemIndex,
            },
          },
          { type: 'emitReceiverState', snapshot },
        ],
      }
    }
    default:
      return stay(state)
  }
}

function reduceCastActive(
  state: CastHandoffState & { phase: 'cast-active' },
  event: CastHandoffEvent
): CastHandoffTransition {
  switch (event.type) {
    case 'mediaStatus': {
      const status = event.status
      const itemIndex =
        reconcileItemIndex(
          state.itemIds,
          state.jsIndices,
          status.currentItemId
        ) ?? state.itemIndex
      const snapshot = receiverSnapshot(status, event.at, itemIndex)
      return {
        state: {
          ...state,
          itemIndex,
          anchor: {
            position: status.position,
            at: event.at,
            rate: snapshot.rate,
          },
          playWhenReady: snapshot.playing,
          duration: status.duration ?? state.duration,
        },
        effects: [{ type: 'emitReceiverState', snapshot }],
      }
    }
    case 'castError':
      // Receiver-side failure with the session intact (`cast-receiver-fetch`
      // family). Surface it and stay: the app may re-resolve the source and
      // `resync`, and the receiver queue often advances past the bad item on
      // its own. Not a handoff failure — no fallback.
      return { state, effects: [{ type: 'emitError', error: event.error }] }
    case 'end': {
      const position = projectReceiverPosition(state.anchor, event.at)
      return {
        state: {
          phase: 'handoff-to-local',
          itemIndex: state.itemIndex,
          position,
          playWhenReady: state.playWhenReady,
          transferBack: event.transferBack,
          awaiting: 'session-end',
        },
        effects: [{ type: 'endCastSession', stopReceiver: event.transferBack }],
      }
    }
    case 'sessionEnded': {
      // Unsolicited end: the receiver died, or the system switcher moved the
      // stream back to "this phone". The session is already gone, so the
      // restore starts immediately.
      const position = projectReceiverPosition(state.anchor, event.at)
      return {
        state: {
          phase: 'handoff-to-local',
          itemIndex: state.itemIndex,
          position,
          playWhenReady: state.playWhenReady,
          transferBack: true,
          awaiting: 'local-restore',
        },
        effects: [
          {
            type: 'emitTransfer',
            transfer: {
              direction: 'toLocal',
              position,
              itemIndex: state.itemIndex,
            },
          },
          {
            type: 'restoreLocal',
            itemIndex: state.itemIndex,
            position,
            playWhenReady: state.playWhenReady,
          },
        ],
      }
    }
    case 'sessionSuspended': {
      // Recoverable (network blip; the framework retries by itself). Freeze
      // the anchor at its projected position so nothing keeps advancing a
      // clock nobody owns, and say so on the broadcast (rate 0).
      const position = projectReceiverPosition(state.anchor, event.at)
      const anchor = { position, at: event.at, rate: 0 }
      return {
        state: { ...state, anchor },
        effects: [
          {
            type: 'emitReceiverState',
            snapshot: {
              playerState: 'buffering',
              idleReason: 'none',
              playing: state.playWhenReady,
              itemIndex: state.itemIndex,
              position,
              at: event.at,
              rate: 0,
              duration: state.duration,
              queueEnded: false,
            },
          },
        ],
      }
    }
    case 'resync': {
      const projection = projectCastQueue(event.snapshot)
      if (projection.items.length === 0) {
        return {
          state,
          effects: [{ type: 'emitError', error: noCastableError() }],
        }
      }
      // Anchor the reload at the item the receiver is on *now* (the reducer's
      // reconciled index — the JS queue is truth, but the receiver owns the
      // cursor), at the projected current position. If that item left the
      // queue, the projection's own at-or-after rule takes over.
      const currentP = projection.jsIndices.indexOf(state.itemIndex)
      const anchored =
        currentP !== -1
          ? {
              ...projection,
              startIndex: currentP,
              startPosition: projectReceiverPosition(state.anchor, event.at),
              startShifted: false,
            }
          : projectCastQueue({ ...event.snapshot, index: state.itemIndex })
      const effects: CastHandoffEffect[] = []
      if (anchored.skipped.length > 0) {
        effects.push({ type: 'notifySkipped', skipped: anchored.skipped })
      }
      effects.push({
        type: 'loadCastQueue',
        items: anchored.items,
        startIndex: anchored.startIndex,
        startPosition: anchored.startPosition,
      })
      return { state: { ...state, pendingProjection: anchored }, effects }
    }
    case 'castQueueLoaded': {
      // A resync's ack: adopt the new mapping. (The initial load's ack lands
      // in handoff-to-cast; this one only ever follows a resync.)
      const pending = state.pendingProjection
      if (pending === undefined) return stay(state)
      return {
        state: {
          ...state,
          itemIds: event.itemIds,
          jsIndices: pending.jsIndices,
          pendingProjection: undefined,
        },
        effects: [],
      }
    }
    case 'queueItemIds':
      // Mirror catch-up (see the event's doc). While a resync is in flight
      // the ids on the wire belong to an unknown generation — wait for the
      // ack; otherwise adopt any non-empty read.
      return state.pendingProjection === undefined && event.itemIds.length > 0
        ? { state: { ...state, itemIds: event.itemIds }, effects: [] }
        : stay(state)
    case 'castQueueLoadFailed':
      // A resync failed: the receiver keeps playing its previous queue — the
      // session is intact, so this is an error to surface, not a fallback.
      return {
        state: { ...state, pendingProjection: undefined },
        effects: [{ type: 'emitError', error: event.error }],
      }
    default:
      return stay(state)
  }
}

function reduceHandoffToLocal(
  state: CastHandoffState & { phase: 'handoff-to-local' },
  event: CastHandoffEvent
): CastHandoffTransition {
  if (state.awaiting === 'session-end') {
    switch (event.type) {
      case 'sessionEnded':
        if (!state.transferBack) {
          // Disconnect-and-keep-playing: the receiver goes on without us;
          // local stays paused where the handoff left it. No transfer event —
          // ownership did not come back.
          return { state: { phase: 'local' }, effects: [] }
        }
        return {
          state: { ...state, awaiting: 'local-restore' },
          effects: [
            {
              type: 'emitTransfer',
              transfer: {
                direction: 'toLocal',
                position: state.position,
                itemIndex: state.itemIndex,
              },
            },
            {
              type: 'restoreLocal',
              itemIndex: state.itemIndex,
              position: state.position,
              playWhenReady: state.playWhenReady,
            },
          ],
        }
      case 'castError':
        return { state, effects: [{ type: 'emitError', error: event.error }] }
      default:
        return stay(state)
    }
  }
  // awaiting === 'local-restore'
  switch (event.type) {
    case 'localRestored':
      return { state: { phase: 'local' }, effects: [] }
    case 'localRestoreFailed':
      return {
        state: { phase: 'local' },
        effects: [{ type: 'emitError', error: event.error }],
      }
    case 'castError':
      return { state, effects: [{ type: 'emitError', error: event.error }] }
    default:
      return stay(state)
  }
}
