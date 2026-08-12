/**
 * The playback layer's front door: one process-scoped instance, started at
 * module scope, plus the hook React uses to read it.
 *
 * Everything above this line in the import graph (`controller`, `session`,
 * `handler`, `broadcast`, `persistence`, `resolver`) is plain TypeScript with
 * no React in it — which is the property that lets it keep running after the
 * Activity is gone.
 */
import { useEffect, useReducer } from 'react'
import { AppState } from 'react-native'
import type { Player } from '@rn-media/player'
import { Playback } from './controller'

export { Playback } from './controller'
export type { PrefetchNote, RetryNote } from './controller'

/**
 * Parked on `globalThis` so a Fast Refresh of this module reuses the running
 * player and session instead of building a second one on top of them.
 */
const scope = globalThis as typeof globalThis & {
  __rnMediaPlayback?: Playback
  __rnMediaAppState?: { remove(): void }
}

export const playback: Playback = (scope.__rnMediaPlayback ??= new Playback())

/**
 * Start everything **here**, at module scope — not from a `useEffect`.
 *
 * This is what makes playback resumption possible at all. When the media
 * service revives a killed process it calls `ReactHost.start()`, which loads
 * this bundle and runs exactly this: module-scope code. It starts **no
 * surface**, so no component ever mounts and every `useEffect` in this app is
 * dead code in that process. An app whose `MediaService.init` lives in a hook
 * therefore boots a runtime that never registers a handler, the library waits,
 * logs "MediaService.init was never called", and stops the service.
 *
 * `start()` is idempotent, so the effect in {@link usePlayback} is still
 * correct — it just is not the thing that matters after a kill.
 */
void playback.start()

/**
 * Checkpoint the session on the way out of the foreground.
 *
 * Module scope, not a component effect, for the same reason the player is:
 * this has to keep working after the React tree is gone. `background` is
 * emitted while the Activity is still being torn down, which is the last
 * moment JavaScript is guaranteed to run — after that the process may be
 * reclaimed with no warning, and whatever was written here is what the next
 * launch restores.
 */
scope.__rnMediaAppState ??= AppState.addEventListener('change', (next) => {
  if (next !== 'active') {
    playback.saveSession()
    console.log(`[example] persistence: checkpoint on "${next}"`)
  }
})

/** What {@link usePlayback} hands the UI. */
export interface PlaybackHandle {
  /** `undefined` until `Player.create()` resolves. */
  readonly player: Player | undefined
  /** The controller itself — commands in, app-owned state out. */
  readonly playback: Playback
}

/**
 * Start playback infrastructure on first mount; re-render on its changes.
 *
 * Note what this subscription is *not*: it is not the player state. Player
 * state has its own subscription with its own selector (`usePlayerState`, see
 * `src/App.tsx`); this one fires only for things the controller owns — the
 * queue mirror, the restore note, the prefetch banner — which change a handful
 * of times per session.
 */
export function usePlayback(): PlaybackHandle {
  const [, bump] = useReducer((n: number) => n + 1, 0)
  useEffect(() => {
    void playback.start()
    return playback.subscribe(bump)
  }, [])
  return { player: playback.player, playback }
}
