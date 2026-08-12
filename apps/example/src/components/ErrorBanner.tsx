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
 * ## Two things this file used to get wrong, and one it still teaches
 *
 * **"Is a retry worth offering?" is not this file's judgement any more.** There
 * used to be a `transient: boolean` column in the table below — an app-side copy
 * of the library's taxonomy, which is exactly the kind of table that goes stale
 * the first time a code is added. `PlayerError.retryable` is that answer, from
 * the layer that classified the failure, and it is the same flag the player's
 * own `retry` option consumes. The copy is gone; only the *copy* was ever the
 * problem.
 *
 * **The banner is also not the whole retry story.** With `retry` enabled, an
 * entry that failed and then played on the second attempt never produces an
 * `error` event at all — it produces `retrying`, which this app draws through
 * `RetryNote` instead. So this banner is what "gave up" looks like, not what
 * "failed" looks like; `attempts` says how many tries it took to get here.
 *
 * What survives, and is still the point: `code` drives the copy and the colour,
 * `message` is only the detail line underneath.
 */
import React from 'react'
import { StyleSheet, Text, View } from 'react-native'
import type { PlayerError, PlayerErrorCode } from '@rn-media/player'
import { COLORS, SPACE, TYPE } from '../theme'
import { Strip } from './ui'

/** Copy per code. Advice about *what happened*, never about what to do next. */
const ADVICE: Record<PlayerErrorCode, { headline: string; hint: string }> = {
  network: {
    headline: 'Network',
    hint: 'The stream stopped mid-flight. FFmpeg already reconnected as far as it could.',
  },
  'unsupported-format': {
    headline: 'Unsupported format',
    hint: 'This build of ffmpeg has no demuxer or decoder for it.',
  },
  'load-failed': {
    headline: 'Could not open',
    hint: 'The source was reached but nothing playable came back — a 404, or a resolver that refused.',
  },
  disposed: {
    headline: 'Player destroyed',
    hint: 'Something called into a player after `destroy()`. That is an app bug, not a media problem.',
  },
  'invalid-state': {
    headline: 'Rejected',
    hint: 'An argument was outside the range the API accepts — validated, not silently clamped.',
  },
  unsupported: {
    headline: 'Not supported here',
    hint: 'The engine on this platform cannot do it.',
  },
  mpv: {
    headline: 'mpv',
    hint: 'An mpv errno with no better classification. The raw text is below.',
  },
}

export const ErrorBanner = React.memo(function ErrorBanner({
  error,
  attempts,
  onRetry,
  onDismiss,
}: {
  error: PlayerError | undefined
  /** How many automatic re-attempts preceded this, from the `error` event. */
  attempts?: number
  onRetry?: () => void
  onDismiss?: () => void
}): React.JSX.Element | null {
  if (error === undefined) return null
  const advice = ADVICE[error.code]
  // Straight from the library. No app-side table, no guessing.
  const retryable = error.retryable

  return (
    // A flat strip: the rule's colour is the taxonomy (warning while a retry
    // is worth offering, error once it is not), the copy is the fact. No box.
    <View accessibilityRole="alert" style={styles.container}>
      <Strip color={retryable ? COLORS.warning : COLORS.error}>
        <Text style={styles.headline}>
          {advice.headline}
          <Text style={styles.code}>
            {' · '}
            {error.code}
            {retryable ? ' · retryable' : ''}
          </Text>
        </Text>
        <Text style={styles.message}>{error.message}</Text>
        <Text style={styles.hint}>{advice.hint}</Text>
        {attempts !== undefined && attempts > 0 ? (
          <Text style={styles.hint}>
            Re-attempted {attempts} {attempts === 1 ? 'time' : 'times'} before
            giving up.
          </Text>
        ) : null}
        <View style={styles.actions}>
          {retryable && onRetry !== undefined ? (
            <Text
              accessibilityRole="button"
              onPress={onRetry}
              style={styles.retry}
            >
              Retry
            </Text>
          ) : null}
          {onDismiss !== undefined ? (
            <Text
              accessibilityRole="button"
              onPress={onDismiss}
              style={styles.dismiss}
            >
              Dismiss
            </Text>
          ) : null}
        </View>
      </Strip>
    </View>
  )
})

const styles = StyleSheet.create({
  container: { alignSelf: 'stretch' },
  actions: { flexDirection: 'row', gap: SPACE.lg },
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
  dismiss: {
    marginTop: SPACE.xs,
    fontSize: TYPE.label,
    fontWeight: '700',
    color: COLORS.muted,
  },
})
