import { useEffect, useRef, useState } from 'react'
import type { PlayerError } from '../errors'
import { toPlayerError } from '../errors'
import type { PlayerOptions } from '../player'
import { Player } from '../player'

/** Options for {@link usePlayer}. */
export interface UsePlayerOptions extends PlayerOptions {
  /**
   * Run once, right after the player is created and before it is handed to
   * the component — the place to `load()` an initial source.
   *
   * A rejected promise is reported through {@link UsePlayerResult.error}.
   */
  readonly setup?: (player: Player) => void | Promise<void>
}

/** What {@link usePlayer} returns. */
export interface UsePlayerResult {
  /** The player, once it has been created. `undefined` on the first render. */
  readonly player: Player | undefined
  /** Creation or `setup` failure, if there was one. */
  readonly error: PlayerError | undefined
}

/**
 * Create a {@link Player} on mount and destroy it on unmount.
 *
 * @param options - Read **once**, on mount. Later changes are ignored, because
 * re-creating an mpv core mid-render would tear down playback.
 * @returns `{ player, error }` — `player` is `undefined` until
 * `Player.create()` resolves.
 *
 * @example
 * ```tsx
 * const { player, error } = usePlayer({
 *   volume: 0.8,
 *   setup: (p) => p.load('https://example.com/track.mp3'),
 * })
 * ```
 */
export function usePlayer(options: UsePlayerOptions = {}): UsePlayerResult {
  const [player, setPlayer] = useState<Player | undefined>(undefined)
  const [error, setError] = useState<PlayerError | undefined>(undefined)

  // Captured once: the options object is a fresh literal on every render, and
  // depending on it would recreate the core continuously.
  const optionsRef = useRef(options)

  useEffect(() => {
    let cancelled = false
    let created: Player | undefined

    const { setup, ...playerOptions } = optionsRef.current

    void (async () => {
      try {
        created = await Player.create(playerOptions)
        if (cancelled) {
          created.destroy()
          return
        }
        setPlayer(created)
        if (setup !== undefined) await setup(created)
      } catch (thrown) {
        if (!cancelled) setError(toPlayerError(thrown))
      }
    })()

    return () => {
      cancelled = true
      setPlayer(undefined)
      created?.destroy()
    }
  }, [])

  return { player, error }
}
