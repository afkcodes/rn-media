import { useEffect, useRef } from 'react'
import type { Player } from '../player'
import { useProgress } from './useProgress'

/**
 * A milestone that has been reached, exactly once per playthrough.
 */
export interface Milestone {
  /** The mark that fired, as a percentage of the entry's duration. */
  readonly percent: number
  /** Projected position when it fired, in seconds. */
  readonly position: number
  /** Duration of the entry it belongs to, in seconds. */
  readonly duration: number
  /** Playlist index of that entry. */
  readonly index: number
}

/** Default marks: the scrobbling/`mark as played` set. */
export const DEFAULT_MILESTONES: readonly number[] = [25, 50, 75, 90]

/**
 * Fire a callback once when playback passes 25 % / 50 % / 75 % / 90 % of an
 * entry — the scrobbling primitive, forward-only and once per playthrough.
 *
 * @param player - The player, or `undefined` before it has been created.
 * @param onMilestone - Called once per mark per playthrough. Kept in a ref, so
 * it does not need to be memoised.
 * @param options - `marks` (defaults to {@link DEFAULT_MILESTONES}, must be
 * percentages in `0 … 100`) and `intervalMs`, forwarded to {@link useProgress}.
 *
 * @example
 * ```ts
 * useMilestones(player, ({ percent }) => {
 *   if (percent === 50) scrobble(currentTrack)   // Last.fm's "now played"
 * })
 * ```
 *
 * @remarks
 * **Why this is a hook and not a `Player` method — the honest version.**
 *
 * A milestone is a *time* event: nothing in mpv fires at 50 % of a track. This
 * library deliberately never streams position across the bridge and never runs
 * a native timer for it (ARCHITECTURE §7); state changes only on
 * discontinuities. So a `player.onMilestone(...)` would have exactly two
 * possible implementations, and both are worse than this one:
 *
 * - **A timer inside the player.** JS timers freeze with the screen off
 *   (ARCHITECTURE, "Platform truths"), so a background playthrough would fire
 *   its milestones in a burst when the user next unlocks the phone — or never.
 *   A player that pretends to have a clock it does not have is the kind of
 *   quiet lie this project refuses elsewhere.
 * - **Checking only at discontinuities.** That is genuinely free, and it can
 *   honestly report a milestone at a seek, a pause, a track end — but a track
 *   played straight through produces *no* events between its start and its end,
 *   which is precisely the case milestones exist for. It would fire every mark
 *   at once at the track's end, which is not what "reached 50 %" means.
 *
 * So the tick has to come from somewhere, and the only place that has one
 * already — and only while a UI is actually mounted and playback is actually
 * advancing — is {@link useProgress}. This hook adds **no timer of its own**:
 * it derives from the same projection your progress bar is already rendering.
 * A screen-off playthrough with no mounted UI produces no milestones, and that
 * is stated rather than papered over. An app that needs background-accurate
 * scrobbling should log `trackEnded` plus the `seekStarted`/`seekCompleted`
 * pair and reconstruct listened time from those, which *are* delivered with the
 * screen off.
 *
 * **The rules, once the tick exists:**
 * - **Forward-only, once per playthrough.** Passing 50 % fires once; seeking
 *   back and passing it again does not fire again.
 * - **Seeking past a mark consumes it silently.** Jumping from 10 % to 80 %
 *   marks 25 %, 50 % and 75 % as spent without calling back — you did not
 *   listen to them. A seek is recognised from the player's own
 *   `seekStarted` event, never guessed from the size of a position delta,
 *   which cannot tell a scrub from a dropped render.
 * - **A new entry, or a restart of the same one, resets everything.** The
 *   playthrough is keyed on the playlist index plus a backwards jump, so a
 *   repeat of the same track earns its milestones again.
 * - **Live streams are skipped**, having no duration to be a percentage of.
 */
export function useMilestones(
  player: Player | undefined,
  onMilestone: (milestone: Milestone) => void,
  options: {
    readonly marks?: readonly number[]
    readonly intervalMs?: number
  } = {}
): void {
  const { position, duration, isLive } = useProgress(player, options.intervalMs)
  const index = player?.state.playlist.index ?? -1

  const marks = options.marks ?? DEFAULT_MILESTONES
  // Held in refs so a caller may pass a fresh closure and a fresh array on
  // every render — the common case — without resetting anyone's progress.
  const callback = useRef(onMilestone)
  callback.current = onMilestone
  const marksRef = useRef(marks)
  marksRef.current = marks

  const spent = useRef<{
    index: number
    position: number
    fired: Set<number>
  }>({ index: -1, position: 0, fired: new Set() })

  /**
   * What the position discontinuity that happened since the last sample means
   * for this playthrough — `undefined` when nothing jumped.
   *
   * Taken from the player's own `seekCompleted` event rather than guessed from
   * the size of a position delta: a delta says nothing about intent, and a
   * dropped render (a slow frame, a backgrounded app) produces exactly the same
   * jump as a scrub. This is the fact itself, and it is what `seekCompleted`
   * carries a reason for.
   */
  const pending = useRef<'reset' | 'jumped' | undefined>(undefined)

  useEffect(() => {
    if (player === undefined) return undefined
    return player.on('seekCompleted', (event) => {
      // A new entry (or a repeat wrap, or a jump) is a new playthrough; a
      // *backwards* seek is a replay of this one. Everything else is a forward
      // skip, whose marks are spent without being reported.
      pending.current =
        event.reason === 'auto-advance' ||
        event.position < spent.current.position
          ? 'reset'
          : 'jumped'
    })
  }, [player])

  useEffect(() => {
    if (duration === undefined || duration <= 0 || isLive) return undefined
    const state = spent.current
    const percent = (position / duration) * 100
    const jump = pending.current
    pending.current = undefined

    // A different entry, or this one replayed from an earlier point: a new
    // playthrough either way, and both deserve their milestones again. The
    // index test also covers the first sample after mounting.
    if (jump === 'reset' || state.index !== index) {
      state.index = index
      state.position = position
      // Marks already behind the position this playthrough *starts* at are
      // spent silently. That covers the two cases that would otherwise fire a
      // burst of callbacks for audio nobody heard: a component mounting
      // half-way through a track, and a session resumed at a saved offset.
      state.fired = new Set(marksRef.current.filter((mark) => percent >= mark))
      return undefined
    }

    // A mark the listener jumped over is spent, not reported — "reached 50 %"
    // has to mean they were there. Consumed per sample, so one seek silences
    // exactly the marks it skipped and nothing after them.
    const jumped = jump === 'jumped'
    state.position = position

    for (const mark of marksRef.current) {
      if (!Number.isFinite(mark) || mark <= 0 || mark > 100) continue
      if (state.fired.has(mark) || percent < mark) continue
      // Spent either way: a mark is offered once per playthrough, whether it
      // was listened through or jumped over.
      state.fired.add(mark)
      if (jumped) continue
      callback.current({ percent: mark, position, duration, index })
    }
    return undefined
  }, [position, duration, isLive, index])
}
