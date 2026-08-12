import { NitroModules } from 'react-native-nitro-modules'
import type { RnMediaScreenState } from './specs/screen-state.nitro'

/**
 * A source of truth for "can anything this app draws actually be seen".
 *
 * @remarks
 * Deliberately an interface rather than a concrete object: it is what makes the
 * gate unit-testable without a device, and it is the escape hatch for an
 * integration whose idea of "presenting" is not the device display (an external
 * screen, a car head unit, a Live Activity). See {@link setScreenStateSource}.
 */
export interface ScreenStateSource {
  /** `true` while the display is on. Read, never cached, by the consumer. */
  readonly interactive: boolean
  /**
   * Observe transitions.
   *
   * @param listener - Called with the new value on every change, never with the
   * current one — read {@link interactive} for that.
   * @returns A function that removes this listener. The underlying platform
   * receiver is derived from the listener set, so the last removal releases it.
   */
  subscribe(listener: (interactive: boolean) => void): () => void
}

/**
 * The answer when the platform has nothing to say: always interactive.
 *
 * Used on any binary without the native side (a JS-only update over an older
 * app build, and every unit test), because the gate this feeds ANDs its inputs:
 * a source that claimed `false` here would silently disable the visualizer for
 * everyone, which is a far worse failure than falling back to `AppState` alone
 * — the behaviour that shipped before this existed.
 */
const ALWAYS_INTERACTIVE: ScreenStateSource = {
  interactive: true,
  subscribe: () => () => {},
}

/**
 * The native display-state signal, reference-counted.
 *
 * One Nitro listener is registered no matter how many hooks subscribe, and it
 * is removed again when the last one leaves — which is what lets the Kotlin
 * side keep its `BroadcastReceiver` derived from the listener set.
 */
class NativeScreenState implements ScreenStateSource {
  readonly #native: RnMediaScreenState
  readonly #listeners = new Set<(interactive: boolean) => void>()
  #listenerId: number | undefined

  constructor(native: RnMediaScreenState) {
    this.#native = native
  }

  get interactive(): boolean {
    try {
      return this.#native.interactive
    } catch {
      // A native read cannot fail today (it is a `PowerManager` call), but a
      // torn-down host object would throw — and "assume visible" keeps the
      // fallback direction consistent with `ALWAYS_INTERACTIVE`.
      return true
    }
  }

  subscribe(listener: (interactive: boolean) => void): () => void {
    this.#listeners.add(listener)
    if (this.#listenerId === undefined) {
      this.#listenerId = this.#native.addScreenStateListener((interactive) => {
        // Copied because a listener may unsubscribe from inside the callback.
        for (const each of [...this.#listeners]) each(interactive)
      })
    }
    let removed = false
    return () => {
      if (removed) return
      removed = true
      this.#listeners.delete(listener)
      if (this.#listeners.size > 0 || this.#listenerId === undefined) return
      this.#native.removeScreenStateListener(this.#listenerId)
      this.#listenerId = undefined
    }
  }
}

/** The installed source, or `undefined` until one is resolved. */
let source: ScreenStateSource | undefined

/**
 * The installed {@link ScreenStateSource}, creating the native one on first use.
 *
 * Lazy on purpose: importing this module must not construct a HybridObject, so
 * that a test process — or a platform without the native side — never touches
 * Nitro at all. The result is memoised either way, so a missing native module
 * costs one failed lookup per process, not one per render.
 */
export function getScreenStateSource(): ScreenStateSource {
  if (source !== undefined) return source
  try {
    source = new NativeScreenState(
      NitroModules.createHybridObject<RnMediaScreenState>('RnMediaScreenState')
    )
  } catch {
    // No native module registered: a JS bundle running against an app binary
    // built before this existed, or a unit-test process. Degrade to the
    // pre-existing `AppState`-only behaviour rather than throwing from a hook.
    source = ALWAYS_INTERACTIVE
  }
  return source
}

/**
 * Replace the display-state signal.
 *
 * @param next - The source to use, or `undefined` to go back to the platform's
 * (which is then re-resolved on the next read).
 *
 * @remarks
 * Two legitimate uses:
 *
 * 1. **Tests.** Install a fake and drive it; nothing needs a device.
 * 2. **A surface that is not the device display.** If your app is presenting to
 *    an external screen or a head unit, the phone's display being off does not
 *    mean nobody is looking — describe *that* surface here and the visualizer
 *    follows it.
 *
 * Anything already subscribed keeps its subscription to the previous source
 * until it re-subscribes, so install this before rendering the components that
 * depend on it (in practice: at module scope, or in your root effect).
 */
export function setScreenStateSource(
  next: ScreenStateSource | undefined
): void {
  source = next
}
