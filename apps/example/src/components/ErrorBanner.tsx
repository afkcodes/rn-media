/**
 * The typed error taxonomy, rendered.
 *
 * The reason `PlayerError` is a discriminated union rather than a string is
 * exactly this screen: a network drop deserves a retry button, an unsupported
 * format deserves "this file will never play here", and a `disposed` is a bug in
 * the app rather than a problem with the media. An app that only ever prints
 * `error.message` cannot tell them apart, so it either retries everything or
 * nothing.
 *
 * The mapping below is the whole point — `code` drives the copy and the colour,
 * `message` is only the detail line underneath.
 */
import React from 'react'
import { StyleSheet, Text, View } from 'react-native'
import type { PlayerError, PlayerErrorCode } from '@rn-media/player'
import { COLORS, RADIUS, SPACE, TYPE } from '../theme'

interface Advice {
  readonly headline: string
  readonly hint: string
  /** `false` for the ones a retry cannot fix. */
  readonly transient: boolean
}

const ADVICE: Record<PlayerErrorCode, Advice> = {
  network: {
    headline: 'Network',
    hint: 'The stream stopped mid-flight. Retrying is reasonable.',
    transient: true,
  },
  'unsupported-format': {
    headline: 'Unsupported format',
    hint: 'This build of ffmpeg has no demuxer or decoder for it. Retrying will not help.',
    transient: false,
  },
  'load-failed': {
    headline: 'Could not open',
    hint: 'The URL was reached but nothing playable came back — a 404, or a resolver that refused.',
    transient: false,
  },
  disposed: {
    headline: 'Player destroyed',
    hint: 'Something called into a player after `destroy()`. That is an app bug, not a media problem.',
    transient: false,
  },
  'invalid-state': {
    headline: 'Rejected',
    hint: 'An argument was outside the range the API accepts — validated, not silently clamped.',
    transient: false,
  },
  unsupported: {
    headline: 'Not supported here',
    hint: 'The engine on this platform cannot do it. Nothing to retry.',
    transient: false,
  },
  mpv: {
    headline: 'mpv',
    hint: 'An mpv errno with no better classification. The raw text is below.',
    transient: false,
  },
}

export const ErrorBanner = React.memo(function ErrorBanner({
  error,
  onRetry,
}: {
  error: PlayerError | undefined
  onRetry?: () => void
}): React.JSX.Element | null {
  if (error === undefined) return null
  const advice = ADVICE[error.code]

  return (
    <View
      accessibilityRole="alert"
      style={[styles.banner, advice.transient && styles.transient]}
    >
      <Text style={styles.headline}>
        {advice.headline}
        <Text style={styles.code}> · {error.code}</Text>
      </Text>
      <Text style={styles.message}>{error.message}</Text>
      <Text style={styles.hint}>{advice.hint}</Text>
      {advice.transient && onRetry !== undefined ? (
        <Text accessibilityRole="button" onPress={onRetry} style={styles.retry}>
          Retry
        </Text>
      ) : null}
    </View>
  )
})

const styles = StyleSheet.create({
  banner: {
    alignSelf: 'stretch',
    gap: SPACE.xs,
    padding: SPACE.md,
    borderRadius: RADIUS.md,
    borderLeftWidth: 3,
    borderLeftColor: COLORS.error,
    backgroundColor: COLORS.surfaceSunken,
  },
  transient: { borderLeftColor: COLORS.warning },
  headline: { fontSize: TYPE.label, fontWeight: '700', color: COLORS.text },
  code: { fontWeight: '400', color: COLORS.muted },
  message: { fontSize: TYPE.caption, color: COLORS.error },
  hint: { fontSize: TYPE.caption, lineHeight: 17, color: COLORS.muted },
  retry: {
    marginTop: SPACE.xs,
    fontSize: TYPE.label,
    fontWeight: '700',
    color: COLORS.accentBright,
  },
})
