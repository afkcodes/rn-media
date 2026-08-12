import { useEffect, useState } from 'react'
import type { Player } from '../player'

/**
 * No prefetch is in flight. The state {@link usePrefetchStatus} starts in,
 * returns to at every boundary, and stays in forever on binaries without the
 * prefetch hook (see the event's own docs for that honesty).
 */
export interface PrefetchIdle {
  readonly active: false
}

/**
 * mpv is holding an opened-early next entry — the current track's end is going
 * to be gapless. Carries what `prefetchStarted` carried, plus when it fired.
 */
export interface PrefetchActive {
  readonly active: true
  /** The logical URI being prefetched — the string in the playlist. */
  readonly uri: string
  /**
   * mpv's playlist entry id for that entry, when the linked libmpv exposes it
   * (`prefetch-playlist-entry-id`, fork releases only — see
   * `PlayerEventMap.prefetchStarted`).
   */
  readonly entryId?: number
  /**
   * When the prefetch was observed, as a `Date.now()` timestamp — so a UI can
   * say "opened 24 s early" at the boundary.
   */
  readonly at: number
}

/**
 * What {@link usePrefetchStatus} returns: a discriminated union on `active`,
 * so `status.uri` only exists where it means something.
 */
export type PrefetchStatus = PrefetchIdle | PrefetchActive

/** Frozen so the idle renders share one identity and React can bail out. */
const IDLE: PrefetchStatus = Object.freeze({ active: false })

/**
 * The player's `prefetchStarted` signal as renderable state: `active` from the
 * moment mpv opens the next entry early, cleared at the boundary that consumes
 * it.
 *
 * ```tsx
 * const prefetch = usePrefetchStatus(player)
 * return prefetch.active
 *   ? <Badge label={`next ready · ${prefetch.uri}`} />
 *   : null
 * ```
 *
 * @param player - The player, or `undefined` before it has been created.
 * @returns See {@link PrefetchStatus}. `{ active: false }` while no prefetch
 * is in flight — which, per the event's own two honest conditions
 * (`PlayerEventMap.prefetchStarted`), is *always* when `prefetchPlaylist` is
 * off or the linked libmpv lacks the prefetch hook. An idle status is not a
 * failure signal.
 *
 * @remarks
 * **Why this is a hook and not player state.** `prefetchStarted` is a
 * discrete event; folding it into {@link PlayerState} would put a field on
 * every snapshot that only a debug/status surface reads, and the snapshot
 * would then need its own clearing rules. The event → state reduction is four
 * subscriptions and one `useState` — exactly what a hook is for, and apps that
 * never mount one pay nothing (the player walks an empty listener set).
 *
 * **When it clears — the honest set, from the existing event map only:**
 *
 * - `trackChanged` — the boundary arrived. Either the prefetched entry became
 *   current (the gapless case) or a queue edit made mpv open something else
 *   cold (mpv logs `Dropping finished prefetch of wrong URL.` — see
 *   `PlaylistAddOptions.position`); in both cases nothing is opened-early
 *   anymore. This also covers `stop()`, which moves the cursor to `-1`.
 * - `error` — the player gave up on the current entry; whatever happens next
 *   arrives through its own events.
 * - `queueEnded` — the queue finished; there is no next entry to be warm.
 *
 * Deliberately *not* on a timer and *not* on `seekStarted`: a seek within the
 * current track does not invalidate the next entry's open demuxer.
 *
 * No native surface is involved — this rides `Player.on`, so the subscription
 * lifecycle (and its teardown on unmount and on player swap) is the whole
 * implementation.
 */
export function usePrefetchStatus(player: Player | undefined): PrefetchStatus {
  const [status, setStatus] = useState<PrefetchStatus>(IDLE)

  useEffect(() => {
    if (player === undefined || player.destroyed) return undefined
    // A swapped-in player starts idle: the previous player's sighting is not
    // this one's. Setting the shared frozen IDLE keeps this a no-op re-render
    // when the state was already idle.
    setStatus(IDLE)
    // Keeps identity when already idle, so clearing events while idle cost no
    // render.
    const clear = (): void => {
      setStatus((previous) => (previous.active ? IDLE : previous))
    }
    const unsubscribes = [
      player.on('prefetchStarted', (event) => {
        setStatus({
          active: true,
          uri: event.uri,
          entryId: event.entryId,
          at: Date.now(),
        })
      }),
      player.on('trackChanged', clear),
      player.on('error', clear),
      player.on('queueEnded', clear),
    ]
    return () => {
      for (const unsubscribe of unsubscribes) unsubscribe()
    }
  }, [player])

  return player === undefined ? IDLE : status
}
