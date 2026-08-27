import React from 'react'

import { Cast } from './cast'
import type { CastConnectionState } from './specs/cast.nitro'

/**
 * The live cast connection state, as renderable React state.
 *
 * This is the one subscription every cast-aware screen needs: it decides
 * whether to draw a cast affordance at all, whether to show a "connecting…"
 * spinner, and whether the transport controls are steering the phone or a
 * receiver.
 *
 * **Seeded synchronously**, so the first paint is already right rather than
 * flashing through `'unavailable'`: the initial value is a direct
 * `Cast.getCastState()` read, and the effect re-reads once on subscribe
 * because `Cast.initialize()` may have resolved between that render and the
 * effect running.
 *
 * No timer, no polling — the `castState` event is the only thing that moves
 * this, and the subscription is torn down on unmount. Several components may
 * call it; each holds its own listener, which is a `Set` insertion on the
 * shared singleton.
 *
 * @returns One of the five {@link CastConnectionState} values.
 * `'unavailable'` is the honest answer both *before* `Cast.initialize()`
 * resolves and *forever* on a device without Google Play services — it is not
 * an error state, and `<CastButton/>` treats it as "draw nothing".
 *
 * @example
 * ```tsx
 * import { useCastState } from '@afkcodes/timbre-cast'
 *
 * function CastStatus() {
 *   const state = useCastState()
 *   if (state === 'unavailable') return null
 *   return <Text>{state === 'connected' ? 'Casting' : state}</Text>
 * }
 * ```
 */
export function useCastState(): CastConnectionState {
  return useCastValue(identity)
}

/**
 * Whether playback is being served by a receiver right now.
 *
 * The boolean an app actually branches on: "is the phone the output, or is a
 * Chromecast?". It rides the same subscription as {@link useCastState} and
 * re-renders only when the answer flips — the four non-casting states collapse
 * to `false`, so `idle → connecting` costs no render in a component that only
 * asked this question.
 *
 * **`'transferring'` counts as casting**, deliberately: that state is a
 * receiver-to-receiver stream transfer (Android's output switcher moving a
 * session between speakers), during which the phone is still not the output
 * and the session is still alive. Treating it as "not casting" would make a UI
 * flicker back to local controls mid-transfer and let the app issue local
 * commands that the handoff machine is about to override.
 *
 * @returns `true` while the connection state is `'connected'` or
 * `'transferring'`.
 *
 * @example
 * ```tsx
 * import { useIsCasting } from '@afkcodes/timbre-cast'
 *
 * function VolumeRow() {
 *   const casting = useIsCasting()
 *   // While casting the volume slider drives the RECEIVER's device volume.
 *   return <Slider onChange={casting ? setDeviceVolume : setPlayerVolume} />
 * }
 * ```
 */
export function useIsCasting(): boolean {
  // Deliberately not `isCastingState(useCastState())`: the *projection* is what
  // is held in state, so `idle → connecting` writes the same `false` and React
  // bails out of the render entirely. Composing the two hooks instead would
  // re-render every subscriber on every state change and then throw the
  // difference away.
  return useCastValue(isCastingState)
}

/**
 * The single definition of "casting" shared by {@link useIsCasting} and any
 * non-React caller, so the two can never drift.
 *
 * @param state - A connection state, e.g. from `Cast.getCastState()`.
 */
export function isCastingState(state: CastConnectionState): boolean {
  return state === 'connected' || state === 'transferring'
}

/** The `useCastState` projection: the state itself. Module scope, so stable. */
function identity(state: CastConnectionState): CastConnectionState {
  return state
}

/**
 * The one subscription both hooks are built on: seed synchronously, re-read on
 * subscribe, follow `castState`, unsubscribe on unmount.
 *
 * The projection is applied *before* the value reaches state, which is what
 * makes a hook that only asked a yes/no question skip the renders that do not
 * change the answer — the same trade `usePlayerState`'s selector overload makes
 * in `@afkcodes/timbre-player`.
 *
 * @param select - Pure projection of the connection state. Must be a stable
 * reference (module scope or `useCallback`); it is a subscription dependency.
 */
function useCastValue<T>(select: (state: CastConnectionState) => T): T {
  const [value, setValue] = React.useState<T>(() => select(Cast.getCastState()))
  React.useEffect(() => {
    // Re-read on subscribe: `initialize()` may have resolved between the
    // seeding render and this effect.
    setValue(select(Cast.getCastState()))
    return Cast.addListener('castState', (event) => {
      setValue(select(event.state))
    })
  }, [select])
  return value
}
