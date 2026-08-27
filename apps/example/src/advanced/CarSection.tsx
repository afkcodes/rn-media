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
import { StyleSheet, Text } from 'react-native'
import { useCarConnection } from '@timbre/media-session'
import { COLORS, TYPE } from '../theme'
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
      <Text style={styles.note}>
        The browse tree lives in src/advanced/browse.ts — four tabs (Library,
        Albums, Artists, Recent). A tap arrives as playFromMediaId; a voice
        query as playFromSearch.
      </Text>
      <ChipRow>
        <Chip
          label={signInRequired ? 'sign-in required: on' : 'simulate sign-in required'}
          active={signInRequired}
          onPress={() => onToggleSignIn(!signInRequired)}
        />
      </ChipRow>
      {signInRequired ? (
        <Text style={styles.note}>
          Every browse request now throws BrowseError(&apos;authenticationExpired&apos;)
          with a &quot;Sign in&quot; button that deep-links to rnmedia://signin.
        </Text>
      ) : null}
    </Section>
  )
}

const styles = StyleSheet.create({
  note: { fontSize: TYPE.caption, color: COLORS.muted, marginTop: 6 },
})
