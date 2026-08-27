/**
 * The exotic commands — the ones a *first* app does not reach for on day one:
 * speed/pitch, the native sleep timer, chapter reads, and the car-browse
 * invalidation. They are plain wrappers over the core's `getPlayer()` /
 * `getService()` seams, kept out of `playback.ts` so the everyday transport
 * there stays the tutorial.
 */
import type { ChapterEntry } from '@timbre/player'
import type { SleepTimerState } from '@timbre/media-session'
import { getPlayer, getService } from '../playback'

/** Playback speed (mpv's `scaletempo2`; pitch stays independent — see below). */
export function setRate(rate: number): void {
  getPlayer()?.setRate(rate)
}
/** Pitch as a frequency ratio — mpv's own `--pitch`, a semitone is `2 ** (1/12)`. */
export function setPitchSemitones(semitones: number): void {
  getPlayer()?.setPitch(2 ** (semitones / 12))
}

/**
 * Arm the **native** sleep timer. Note what is not here: a `setTimeout`. With the
 * Activity destroyed JS timers stop firing — exactly the state a sleep timer runs
 * in — so the session schedules it on the platform's own timer.
 */
export function setSleepTimer(seconds: number): void {
  try {
    getService()?.setSleepTimer(seconds)
    console.log(`[example] sleep timer armed for ${seconds}s`)
  } catch (cause) {
    console.warn('[example] sleep timer rejected:', cause)
  }
}
/** Pause when the current item finishes — the deadline is computed natively. */
export function setSleepTimerToTrackEnd(): void {
  try {
    getService()?.setSleepTimerToTrackEnd()
    console.log('[example] sleep timer armed for end of track')
  } catch (cause) {
    console.warn('[example] sleep timer rejected:', cause)
  }
}
export function cancelSleepTimer(): void {
  getService()?.cancelSleepTimer()
  console.log('[example] sleep timer cancelled')
}
/** Mode + remaining seconds, for the badge — the discriminated state, not a bare number. */
export function getSleepTimer(): SleepTimerState | undefined {
  return getService()?.getSleepTimer()
}

/** Tell a connected car a browse node changed (the sign-in toggle is the demo). */
export function invalidateBrowse(parentId?: string): void {
  getService()?.invalidateBrowse(parentId)
  console.log(`[example] invalidateBrowse(${parentId ?? 'everything'})`)
}

/** The current entry's chapters — a pull, taken when the entry changes. */
export function getChapters(): readonly ChapterEntry[] {
  return getPlayer()?.getChapters() ?? []
}
