import { useCallback, useRef, useSyncExternalStore } from 'react'
import type { Player } from '../player'
import type { PlayerState } from '../state'
import { createInitialState } from '../state'

/**
 * The snapshot returned while no player exists yet — a frozen `idle` state, so
 * a component can render before `Player.create()` resolves without special
 * cases.
 */
const IDLE_STATE: PlayerState = Object.freeze(createInitialState(0))

/** A pure projection of {@link PlayerState} down to what a component needs. */
export type PlayerStateSelector<T> = (state: PlayerState) => T

/**
 * Subscribe to the whole player state.
 *
 * @param player - The player, or `undefined` before it has been created.
 * @returns The current immutable snapshot.
 */
export function usePlayerState(player: Player | undefined): PlayerState
/**
 * Subscribe to a *projection* of the player state.
 *
 * The component re-renders only when the selected value changes, which is the
 * point: `useProgress`-style tickers aside, most UI cares about one or two
 * fields.
 *
 * @param player - The player, or `undefined` before it has been created.
 * @param selector - Pure projection of the snapshot. Must be cheap: it runs on
 * every store read.
 * @param isEqual - Comparison used to decide whether the selected value
 * changed. Defaults to `Object.is`; pass a shallow comparison when the
 * selector returns a fresh object.
 * @returns The selected value.
 */
export function usePlayerState<T>(
  player: Player | undefined,
  selector: PlayerStateSelector<T>,
  isEqual?: (a: T, b: T) => boolean
): T
export function usePlayerState<T>(
  player: Player | undefined,
  selector?: PlayerStateSelector<T>,
  isEqual: (a: T, b: T) => boolean = Object.is
): PlayerState | T {
  // `useSyncExternalStore` requires `getSnapshot` to return a stable value
  // while the store has not changed. The reducer already guarantees stable
  // `PlayerState` identity, but a selector can synthesise a new object on
  // every call — so the last selected value is memoised here.
  const cache = useRef<{ source: PlayerState; selected: T } | undefined>(
    undefined
  )

  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      if (player === undefined) return () => {}
      return player.onStateChange(onStoreChange)
    },
    [player]
  )

  const getSnapshot = useCallback((): PlayerState | T => {
    const state = player?.state ?? IDLE_STATE
    if (selector === undefined) return state

    const previous = cache.current
    if (previous !== undefined && previous.source === state) {
      return previous.selected
    }
    const selected = selector(state)
    if (previous !== undefined && isEqual(previous.selected, selected)) {
      // Value is unchanged: keep the old identity so React bails out.
      cache.current = { source: state, selected: previous.selected }
      return previous.selected
    }
    cache.current = { source: state, selected }
    return selected
  }, [player, selector, isEqual])

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}
