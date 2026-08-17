/**
 * @vitest-environment jsdom
 *
 * The rest of this package's suite runs in plain Node — these two hooks are the
 * only React in it, so the DOM renderer is asked for per file rather than
 * imposed on everything.
 */
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { CastConnectionState } from '../specs/cast.nitro'

/**
 * A controllable stand-in for the process-wide `Cast` singleton.
 *
 * Mocked rather than injected because the singleton is deliberately not
 * injectable — the OS cast framework is itself a process singleton, and
 * `resolveInstance()` reaches for the real hybrid object. What is under test
 * here is the *subscription lifecycle*, which this exercises exactly.
 */
const cast = vi.hoisted(() => {
  const listeners = new Set<(event: { state: string }) => void>()
  return {
    state: 'idle' as string,
    listeners,
    /** How many listeners were ever registered, to prove teardown. */
    subscriptions: 0,
    /** Drive a state change the way the native side would. */
    change(next: string): void {
      cast.state = next
      for (const listener of [...listeners]) listener({ state: next })
    },
    reset(): void {
      listeners.clear()
      cast.state = 'idle'
      cast.subscriptions = 0
    },
  }
})

vi.mock('../cast', () => ({
  Cast: {
    getCastState(): string {
      return cast.state
    },
    addListener(
      event: string,
      listener: (payload: { state: string }) => void
    ): () => void {
      if (event !== 'castState') throw new Error(`unexpected event ${event}`)
      cast.listeners.add(listener)
      cast.subscriptions += 1
      return () => {
        cast.listeners.delete(listener)
      }
    },
  },
}))

import { isCastingState, useCastState, useIsCasting } from '../use-cast-state'

beforeEach(() => {
  cast.reset()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('useCastState', () => {
  it('seeds synchronously, so the first paint is already right', () => {
    cast.state = 'connected'
    const { result } = renderHook(() => useCastState())
    expect(result.current).toBe('connected')
  })

  it('re-reads on subscribe, in case initialize() resolved in between', () => {
    const { result } = renderHook(() => useCastState())
    expect(result.current).toBe('idle')
    // The effect's re-read is what catches a state that moved between the
    // seeding render and the subscription.
    expect(cast.subscriptions).toBe(1)
  })

  it('follows the castState event', () => {
    const { result } = renderHook(() => useCastState())
    act(() => {
      cast.change('connecting')
    })
    expect(result.current).toBe('connecting')
    act(() => {
      cast.change('connected')
    })
    expect(result.current).toBe('connected')
  })

  it('unsubscribes on unmount', () => {
    const { unmount } = renderHook(() => useCastState())
    expect(cast.listeners.size).toBe(1)
    unmount()
    expect(cast.listeners.size).toBe(0)
  })

  it('gives each caller its own listener', () => {
    const first = renderHook(() => useCastState())
    const second = renderHook(() => useCastState())
    expect(cast.listeners.size).toBe(2)
    act(() => {
      cast.change('connected')
    })
    expect(first.result.current).toBe('connected')
    expect(second.result.current).toBe('connected')
    first.unmount()
    second.unmount()
  })
})

describe('useIsCasting', () => {
  it('is false for every state where the phone is still the output', () => {
    for (const state of ['unavailable', 'idle', 'connecting'] as const) {
      cast.state = state
      const { result, unmount } = renderHook(() => useIsCasting())
      expect(result.current).toBe(false)
      unmount()
    }
  })

  it('is true while connected and while transferring', () => {
    for (const state of ['connected', 'transferring'] as const) {
      cast.state = state
      const { result, unmount } = renderHook(() => useIsCasting())
      expect(result.current).toBe(true)
      unmount()
    }
  })

  it('re-renders only when the answer flips', () => {
    let renders = 0
    const { result } = renderHook(() => {
      renders += 1
      return useIsCasting()
    })
    const baseline = renders

    // Two non-casting states in a row: the boolean never changes, so React
    // bails out of the re-render.
    act(() => {
      cast.change('connecting')
    })
    expect(renders).toBe(baseline)
    expect(result.current).toBe(false)

    act(() => {
      cast.change('connected')
    })
    expect(renders).toBeGreaterThan(baseline)
    expect(result.current).toBe(true)
  })
})

describe('isCastingState', () => {
  it('is the single definition the hook and non-React callers share', () => {
    const table: Record<CastConnectionState, boolean> = {
      unavailable: false,
      idle: false,
      connecting: false,
      connected: true,
      transferring: true,
    }
    for (const [state, expected] of Object.entries(table)) {
      expect(isCastingState(state as CastConnectionState)).toBe(expected)
    }
  })
})
