/**
 * Sleep timer — the **native** one, in both of its shapes.
 *
 * Note what is not in this file: a `setTimeout`. With the Activity destroyed, JS
 * timers stop firing, which is exactly the state a sleep timer is used in. The
 * media session schedules the pause on the platform's own timer
 * (`Handler.postDelayed` / `DispatchQueue.asyncAfter`), so it fires whether or
 * not this screen — or this React tree — still exists.
 *
 * Two ways to arm it, and the badge tells them apart:
 *
 * - **a duration** (`setSleepTimer(seconds)`) — a wall-clock countdown;
 * - **end of track** (`setSleepTimerToTrackEnd()`) — the deadline is computed
 *   natively from the broadcasts the app already sends (duration minus the
 *   projected position, over the rate) and re-armed on every one, so a seek or
 *   a rate change moves it with nothing new crossing the bridge. On an entry
 *   with no published duration — a live radio stream — it stays armed with
 *   *no* deadline and fires when the item changes; the badge says "end of
 *   track" rather than inventing a number, which is exactly the case
 *   `getSleepTimer()`'s discriminated state exists for (`remainingSeconds` is
 *   absent ≠ not armed).
 *
 * The countdown *display* is a JS interval, and that is the one place it is the
 * right tool: the number only has to be correct while someone is looking at it,
 * and the timer that matters keeps counting whether or not the interval does.
 */
import React from 'react'
import { StyleSheet, Text } from 'react-native'
import type { SleepTimerState } from '@rn-media/media-session'
import { COLORS, TYPE } from '../theme'
import { Chip, ChipRow, Detail, Section } from './ui'

/**
 * Durations offered by the demo UI.
 *
 * 45 seconds is not a plausible product choice — it is short enough to watch
 * the whole thing happen with the Activity destroyed, which is the only way to
 * prove the timer is not a JS timer.
 */
const CHOICES: readonly number[] = [45, 300, 1800]

/** The badge line for one poll of `getSleepTimer()`. */
function badge(timer: SleepTimerState | undefined): string {
  if (timer === undefined) return 'off'
  if (timer.remainingSeconds !== undefined) {
    const seconds = `${Math.ceil(timer.remainingSeconds)}s`
    return timer.mode === 'trackEnd' ? `end of track · ${seconds}` : `${seconds} left`
  }
  // Armed, deadline unknowable (live stream / duration not broadcast yet).
  return 'end of track'
}

export function SleepTimerSection({
  ready,
  getTimer,
  onArm,
  onArmTrackEnd,
  onCancel,
}: {
  ready: boolean
  /** Polled while this screen is on. See the header comment. */
  getTimer: () => SleepTimerState | undefined
  onArm: (seconds: number) => void
  onArmTrackEnd: () => void
  onCancel: () => void
}): React.JSX.Element {
  const timer = usePolled(getTimer)

  return (
    <Section
      title="Sleep timer"
      accessory={
        <Text style={[styles.state, timer !== undefined && styles.armed]}>
          {badge(timer)}
        </Text>
      }
    >
      <ChipRow>
        {CHOICES.map((seconds) => (
          <Chip
            key={seconds}
            label={seconds < 60 ? `${seconds}s` : `${seconds / 60}m`}
            disabled={!ready}
            onPress={() => onArm(seconds)}
          />
        ))}
        <Chip
          label="End of track"
          active={timer?.mode === 'trackEnd'}
          disabled={!ready}
          onPress={onArmTrackEnd}
        />
        <Chip label="Cancel" disabled={!ready} onPress={onCancel} />
      </ChipRow>
      <Detail>
        Arm 45s, then press Back to destroy the Activity — playback still pauses
        on time, and `onSleepTimer` reaches JS after the fact. "End of track" on
        a live radio entry arms with no deadline and fires on the next track
        change, which is the honest reading of "stop after this one".
      </Detail>
    </Section>
  )
}

function usePolled(
  getTimer: () => SleepTimerState | undefined
): SleepTimerState | undefined {
  const [timer, setTimer] = React.useState<SleepTimerState | undefined>(
    undefined
  )
  const latest = React.useRef(getTimer)
  latest.current = getTimer
  React.useEffect(() => {
    const id = setInterval(() => setTimer(latest.current()), 500)
    return () => clearInterval(id)
  }, [])
  return timer
}

const styles = StyleSheet.create({
  state: {
    fontSize: TYPE.micro,
    fontVariant: ['tabular-nums'],
    color: COLORS.muted,
  },
  armed: { color: COLORS.accentBright, fontWeight: '700' },
})
