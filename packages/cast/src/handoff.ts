/**
 * `wireCastHandoff` — the impure half of the handoff: executes the reducer's
 * effects against a `CastApi` and a structural local player, and feeds native
 * events (and effect completions) back into the machine.
 *
 * Deliberately a *cast-package* module, not a media-session one:
 * `@rn-media/media-session` stays cast-free in both directions. The handoff
 * talks to the app through structural interfaces only — the same discipline as
 * audio-session's `AudioSessionPlayerLike` — and the app routes the outputs
 * (`onReceiverState`, `onTransfer`, …) into its own media-session broadcasts.
 * That is how contract §3's "the app's broadcasts carry the receiver's state"
 * works without this package ever importing a session.
 */
import { Cast } from './cast'
import { CastError, toCastError } from './errors'
import {
  initialCastHandoffState,
  reduceCastHandoff,
  type CastHandoffEffect,
  type CastHandoffEvent,
  type CastHandoffPhase,
  type CastHandoffQueueSnapshot,
  type CastHandoffState,
  type CastReceiverSnapshot,
  type CastTransferEvent,
  type SkippedCastItem,
} from './handoff-machine'
import type { CastApi, EndSessionOptions, Unsubscribe } from './types'

/**
 * The only things the handoff needs from a local player — the write side.
 * (The read side is the {@link WireCastHandoffOptions.snapshot} provider: one
 * atomic queue+cursor+clock read at handoff time.)
 *
 * Structural on purpose: our `Player` behind an app adapter, any other RN
 * player, or a test fake all satisfy it. This package must never import
 * `@rn-media/player`.
 */
export interface CastHandoffLocalPlayer {
  /** Resume local playback (a transfer-back with `playWhenReady`). */
  play(): void | Promise<void>
  /** Silence the local player for the session (a handoff-to-cast begins with this). */
  pause(): void | Promise<void>
  /** Seek the current entry to `seconds`. */
  seekTo(seconds: number): void | Promise<void>
  /**
   * Move the local queue cursor to `index` **without starting playback** —
   * the transfer-back sequence is `skipToIndex → seekTo → play?`, and a
   * `playWhenReady: false` transfer must land paused.
   */
  skipToIndex(index: number): void | Promise<void>
  /** Projected local position in seconds (parity with the snapshot's `position`). */
  getPosition(): number
  /** Whether local playback is advancing (parity with `playWhenReady`). */
  isPlaying(): boolean
}

export interface WireCastHandoffOptions {
  /**
   * One coherent read of the JS queue: items (with receiver-fetchable URLs —
   * resolve signed/logical URLs here), cursor, position, intent. Called at
   * handoff time and on {@link CastHandoff.syncQueue}; never polled.
   */
  snapshot: () => CastHandoffQueueSnapshot
  /** Injectable for tests; defaults to the process-wide {@link Cast} facade. */
  cast?: CastApi
  /** The §3 phase moved. Fires only on change. */
  onPhaseChange?: (phase: CastHandoffPhase) => void
  /**
   * A transfer discontinuity — `{direction, position, itemIndex}` — exactly
   * one per direction per handoff. Route into your app's `castTransfer`
   * event / analytics; position ownership changed hands at this instant.
   */
  onTransfer?: (transfer: CastTransferEvent) => void
  /**
   * The receiver's state, reconciled to JS-queue vocabulary, as a position
   * anchor. While `cast-active` this is the app's ONLY truthful source for
   * its `playbackState`/`mediaItem` broadcasts; between calls, project from
   * `{position, at, rate}` — never poll.
   */
  onReceiverState?: (snapshot: CastReceiverSnapshot) => void
  /** Queue items the projection had to skip — typed, surfaced, never silent. */
  onItemsSkipped?: (skipped: readonly SkippedCastItem[]) => void
  /**
   * Every typed failure: session starts, receiver fetches
   * (`cast-receiver-fetch` — the re-resolve-and-reload hook), fallbacks.
   * Defaults to `console.error`; errors are never swallowed.
   */
  onError?: (error: CastError) => void
  /** Clock, injectable for tests. @default Date.now */
  now?: () => number
}

/** The running handoff — one per app; dispose before creating another. */
export interface CastHandoff {
  /** Current §3 phase. */
  readonly phase: CastHandoffPhase
  /**
   * Reconciled JS-queue index the receiver is on, while `cast-active`.
   * `undefined` in every other phase — exactly one backend owns the cursor.
   */
  readonly receiverItemIndex: number | undefined
  /**
   * Cast the queue to `deviceId` (from `getCastDevices`). Resolves when the
   * session is up (the handoff continues asynchronously — watch
   * `onPhaseChange`); rejects `invalid-state` outside the `local` phase.
   * On an already-connected session it reuses it and starts the handoff
   * directly. Ordering note: call this *before* `stopDiscovery()`.
   */
  castTo(deviceId: string): Promise<void>
  /**
   * End the session. Default (`transferBackToLocal: true`): stop the
   * receiver and resume locally at the receiver's projected position;
   * resolves when the machine is back in `local` (restore issued).
   * `transferBackToLocal: false`: disconnect and leave the receiver playing.
   * Idempotent in `local`; rejects `invalid-state` mid-handoff.
   */
  stopCasting(options?: EndSessionOptions): Promise<void>
  /**
   * The JS queue changed while casting: re-project and reload the receiver
   * queue, anchored at the receiver's current item and projected position.
   * No-op outside `cast-active`.
   */
  syncQueue(): void
  /** Jump the receiver to the castable item at JS index `jsIndex`. */
  skipToItem(jsIndex: number, position?: number): Promise<void>
  /** Advance to the next castable item (non-castable ones are inherently skipped). */
  skipToNext(): Promise<void>
  skipToPrevious(): Promise<void>
  /**
   * Detach every listener. Ends no session and restores nothing — this is
   * teardown of the *wiring*, not of playback.
   */
  dispose(): void
}

/**
 * Wire the handoff between a local player and the cast surface.
 *
 * Idle until a session appears: `castTo()` (in-app picker), or the platform
 * doing it — `requestSession()`/`<CastButton/>`'s dialog, or Android's system
 * output switcher — all funnel into the same machine, so a switcher-initiated
 * session pauses local playback and loads the receiver queue exactly like an
 * in-app one. A session that already existed *before* wiring is deliberately
 * left alone (auto-casting over whatever the receiver is doing at app launch
 * would be destructive); `castTo` reuses it on the next user gesture.
 */
export function wireCastHandoff(
  local: CastHandoffLocalPlayer,
  options: WireCastHandoffOptions
): CastHandoff {
  const cast = options.cast ?? Cast
  const now = options.now ?? Date.now
  const onError =
    options.onError ??
    ((error: CastError) => {
      console.error('[cast] handoff:', error)
    })

  let state: CastHandoffState = initialCastHandoffState
  let disposed = false
  /** Resolvers waiting for the machine to return to `local`. */
  let localWaiters: Array<() => void> = []
  /** The in-flight `requestSession` promise, for `castTo` to await. */
  let connecting: Promise<void> | undefined

  function dispatch(event: CastHandoffEvent): void {
    if (disposed) return
    const previous = state
    const { state: next, effects } = reduceCastHandoff(state, event)
    state = next
    if (next.phase !== previous.phase) {
      options.onPhaseChange?.(next.phase)
      if (next.phase === 'local') {
        const waiters = localWaiters
        localWaiters = []
        for (const resolve of waiters) resolve()
      }
    }
    for (const effect of effects) run(effect)
  }

  function run(effect: CastHandoffEffect): void {
    switch (effect.type) {
      case 'connect': {
        const request = cast.requestSession(effect.deviceId)
        connecting = request
        request.catch((cause: unknown) => {
          dispatch({ type: 'sessionStartFailed', error: toCastError(cause) })
        })
        return
      }
      case 'pauseLocal': {
        settle(local.pause())
        return
      }
      case 'loadCastQueue': {
        void (async () => {
          try {
            await cast.queueLoad(effect.items, {
              startIndex: effect.startIndex,
              startPosition: effect.startPosition,
            })
            const itemIds = await cast.getQueueItemIds()
            dispatch({ type: 'castQueueLoaded', itemIds, at: now() })
          } catch (cause) {
            dispatch({ type: 'castQueueLoadFailed', error: toCastError(cause) })
          }
        })()
        return
      }
      case 'notifySkipped': {
        options.onItemsSkipped?.(effect.skipped)
        return
      }
      case 'endCastSession': {
        cast
          .endSession({ transferBackToLocal: effect.stopReceiver })
          .catch((cause: unknown) => {
            const error = toCastError(cause)
            // `no-session` means the end already happened (the session
            // listener has fired or is about to); anything else is surfaced
            // and the machine completes on the listener's `sessionEnded`.
            if (error.code !== 'no-session') onError(error)
          })
        return
      }
      case 'restoreLocal': {
        void (async () => {
          try {
            await local.skipToIndex(effect.itemIndex)
            await local.seekTo(effect.position)
            if (effect.playWhenReady) await local.play()
            dispatch({ type: 'localRestored' })
          } catch (cause) {
            dispatch({ type: 'localRestoreFailed', error: toCastError(cause) })
          }
        })()
        return
      }
      case 'emitTransfer':
        options.onTransfer?.(effect.transfer)
        return
      case 'emitReceiverState':
        options.onReceiverState?.(effect.snapshot)
        return
      case 'emitError':
        onError(effect.error)
        return
    }
  }

  /** Local-player calls may be sync or async; either way a failure is surfaced. */
  function settle(result: void | Promise<void>): void {
    if (result instanceof Promise) {
      result.catch((cause: unknown) => {
        onError(toCastError(cause))
      })
    }
  }

  /* ---- native event fan-in ---------------------------------------------- */

  const unsubscribers: Unsubscribe[] = [
    cast.addListener('session', (event) => {
      switch (event.type) {
        case 'started':
        case 'resumed':
          // Stamp the queue snapshot here — one coherent read at the moment
          // the session becomes usable. (Ignored by the reducer outside
          // local/connecting, so a resume during cast-active is a no-op.)
          dispatch({
            type: 'sessionStarted',
            snapshot: options.snapshot(),
            at: now(),
          })
          return
        case 'startFailed':
          dispatch({
            type: 'sessionStartFailed',
            error: new CastError(
              'session-start-failed',
              'The platform reported a session start failure.',
              { statusCode: event.errorCode }
            ),
          })
          return
        case 'ended':
          dispatch({ type: 'sessionEnded', at: now() })
          return
        case 'suspended':
          dispatch({ type: 'sessionSuspended', at: now() })
          return
        default:
          // starting/ending are progress notifications; transferring/
          // transferred/transferFailed (the Android output-switcher stream
          // transfer) complete through the regular started/ended events.
          return
      }
    }),
    cast.addListener('mediaStatus', (status) => {
      dispatch({ type: 'mediaStatus', status, at: now() })
    }),
    cast.addListener('error', (error) => {
      dispatch({ type: 'castError', error })
    }),
  ]

  /* ---- cast-active transport helpers ------------------------------------ */

  function requireActive(): CastHandoffState & { phase: 'cast-active' } {
    if (state.phase !== 'cast-active') {
      throw new CastError(
        'invalid-state',
        `Receiver transport needs an active cast session (phase: ${state.phase}).`
      )
    }
    return state
  }

  function jumpByOffset(offset: number): Promise<void> {
    try {
      const active = requireActive()
      const p = active.jsIndices.indexOf(active.itemIndex)
      const target = active.itemIds[p + offset]
      if (p === -1 || target === undefined) {
        return Promise.reject(
          new CastError(
            'invalid-argument',
            'No castable queue item in that direction.'
          )
        )
      }
      return cast.queueJumpTo(target)
    } catch (error) {
      return Promise.reject(error)
    }
  }

  /* ---- the handle -------------------------------------------------------- */

  return {
    get phase(): CastHandoffPhase {
      return state.phase
    },
    get receiverItemIndex(): number | undefined {
      return state.phase === 'cast-active' ? state.itemIndex : undefined
    },

    castTo(deviceId: string): Promise<void> {
      if (state.phase !== 'local') {
        return Promise.reject(
          new CastError(
            'invalid-state',
            `castTo() is only legal from the local phase (phase: ${state.phase}).`
          )
        )
      }
      if (cast.getCastState() === 'connected') {
        // A session already exists (pre-wire resumption, or a previous
        // handoff that fell back): reuse it — the handoff starts now.
        dispatch({
          type: 'sessionStarted',
          snapshot: options.snapshot(),
          at: now(),
        })
        return Promise.resolve()
      }
      connecting = undefined
      dispatch({ type: 'start', deviceId })
      // The `connect` effect stored the requestSession promise synchronously.
      return connecting ?? Promise.resolve()
    },

    stopCasting(endOptions?: EndSessionOptions): Promise<void> {
      if (state.phase === 'local') return Promise.resolve()
      if (state.phase !== 'cast-active') {
        return Promise.reject(
          new CastError(
            'invalid-state',
            `stopCasting() is only legal while cast-active (phase: ${state.phase}).`
          )
        )
      }
      const done = new Promise<void>((resolve) => {
        localWaiters.push(resolve)
      })
      dispatch({
        type: 'end',
        transferBack: endOptions?.transferBackToLocal !== false,
        at: now(),
      })
      return done
    },

    syncQueue(): void {
      if (state.phase !== 'cast-active') return
      dispatch({ type: 'resync', snapshot: options.snapshot(), at: now() })
    },

    skipToItem(jsIndex: number, position?: number): Promise<void> {
      try {
        const active = requireActive()
        const p = active.jsIndices.indexOf(jsIndex)
        const target = active.itemIds[p]
        if (p === -1 || target === undefined) {
          return Promise.reject(
            new CastError(
              'invalid-argument',
              `Queue index ${String(jsIndex)} is not on the receiver (not castable, or not yet loaded).`
            )
          )
        }
        return cast.queueJumpTo(target, position)
      } catch (error) {
        return Promise.reject(error)
      }
    },

    skipToNext(): Promise<void> {
      return jumpByOffset(1)
    },
    skipToPrevious(): Promise<void> {
      return jumpByOffset(-1)
    },

    dispose(): void {
      if (disposed) return
      disposed = true
      for (const unsubscribe of unsubscribers) unsubscribe()
      // Nothing left to wait for; release rather than hang.
      const waiters = localWaiters
      localWaiters = []
      for (const resolve of waiters) resolve()
    },
  }
}
