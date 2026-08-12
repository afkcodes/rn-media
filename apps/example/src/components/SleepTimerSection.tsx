/**
 * Sleep timer — the **native** one.
 *
 * Note what is not in this file: a `setTimeout`. With the Activity destroyed, JS
 * timers stop firing, which is exactly the state a sleep timer is used in. The
 * media session schedules the pause on the platform's own timer
 * (`Handler.postDelayed` / `DispatchQueue.asyncAfter`), so it fires whether or
 * not this screen — or this React tree — still exists.
 *
 * The countdown *display* is a JS interval, and that is the one place it is the
 * right tool: the number only has to be correct while someone is looking at it,
 * and the timer that matters keeps counting whether or not the interval does.
 */
import React from 'react'
import { StyleSheet, Text } from 'react-native'
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

export function SleepTimerSection({
  ready,
  getRemaining,
  onArm,
  onCancel,
}: {
  ready: boolean
  /** Polled while this screen is on. See the header comment. */
  getRemaining: () => number | undefined
  onArm: (seconds: number) => void
  onCancel: () => void
}): React.JSX.Element {
  const remaining = useCountdown(getRemaining)

  return (
    <Section
      title="Sleep timer"
      accessory={
        <Text style={[styles.state, remaining !== undefined && styles.armed]}>
          {remaining === undefined ? 'off' : `${Math.ceil(remaining)}s left`}
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
        <Chip label="Cancel" disabled={!ready} onPress={onCancel} />
      </ChipRow>
      <Detail>
        Arm 45s, then press Back to destroy the Activity. Playback still pauses
        on time, and `onSleepTimer` reaches JS after the fact — the app does no
        pausing of its own.
      </Detail>
    </Section>
  )
}

function useCountdown(
  getRemaining: () => number | undefined
): number | undefined {
  const [remaining, setRemaining] = React.useState<number | undefined>(undefined)
  const latest = React.useRef(getRemaining)
  latest.current = getRemaining
  React.useEffect(() => {
    const id = setInterval(() => setRemaining(latest.current()), 500)
    return () => clearInterval(id)
  }, [])
  return remaining
}

const styles = StyleSheet.create({
  state: {
    fontSize: TYPE.micro,
    fontVariant: ['tabular-nums'],
    color: COLORS.muted,
  },
  armed: { color: COLORS.accentBright, fontWeight: '700' },
})
