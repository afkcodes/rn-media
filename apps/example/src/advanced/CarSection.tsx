/**
 * Android Auto / CarPlay — the two things about the browse tree that cannot be
 * seen from inside the car.
 *
 * 1. **Is a car connected?** `useCarConnection()` is the reactive twin of
 *    `MediaService.getCarConnection()`; it re-renders on every transition, and
 *    it is fed by native (the set of connected controllers media3 classifies as
 *    the Auto companion or Automotive OS, or a connected CarPlay scene). With
 *    the phone plugged into a head unit this row is the proof that the session
 *    knows.
 * 2. **The error screen.** `BrowseError` is the only browse behaviour a
 *    developer cannot reach by browsing: it needs the app to *refuse*. The
 *    toggle makes every `getChildren` throw `authenticationExpired` with a
 *    "Sign in" button, which Android Auto renders as its own error screen —
 *    that code is one of the two media3 replicates into the platform playback
 *    state, which is what a legacy browser like Auto reads.
 *
 * Flipping the toggle also calls `invalidateBrowse()`, because a car that is
 * already showing a list does not ask again on its own.
 */
import React from 'react'
import { useCarConnection } from '@afkcodes/timbre-media-session'
import { Chip, ChipRow, Detail, Section } from '../components/ui'

const LABELS: Record<string, string> = {
  none: 'no car connected',
  androidAuto: 'Android Auto (phone projecting)',
  automotiveOs: 'Automotive OS (built-in)',
  carPlay: 'CarPlay',
}

export function CarSection({
  signInRequired,
  onToggleSignIn,
}: {
  signInRequired: boolean
  onToggleSignIn: (required: boolean) => void
}): React.JSX.Element {
  const car = useCarConnection()

  return (
    <Section title="Car (Android Auto / CarPlay)">
      <Detail>connection · {LABELS[car.kind] ?? car.kind}</Detail>
      <ChipRow>
        <Chip
          label={signInRequired ? 'sign-in required: on' : 'simulate sign-in required'}
          active={signInRequired}
          onPress={() => onToggleSignIn(!signInRequired)}
        />
      </ChipRow>
    </Section>
  )
}
