/**
 * The failures the media session reports about *itself*.
 *
 * This strip exists for a class of bug that is invisible from JavaScript, and
 * that is the whole reason `MediaHandler.onSessionError` exists: the OS refusing
 * to start the foreground service (playback carries on with no notification and
 * an unprotected process), a `notificationIcon` name that resolves to nothing,
 * an artwork URL that 404s, an iOS `Info.plist` with no `UIBackgroundModes:
 * audio`. Every one of them used to be a native log line and *nothing else* —
 * the app was never told, so no app could ever have shown this.
 *
 * ## What the copy is, and is not
 * The `message` comes from the library, whole. This file adds a headline per
 * code and no advice of its own: the same rule `ErrorBanner` learned the hard
 * way — an app-side table that restates the library's taxonomy is a table that
 * goes stale the first time a code is added. The **severity** is the library's
 * too, and it is what picks the colour: `fatal` means background playback is
 * not going to work, `degraded` means a surface is showing less than was asked
 * for.
 *
 * There is no Retry. Nothing on this channel is retryable from JS — each code
 * is fixed in the app's configuration, or in *when* it started playing.
 */
import React from 'react'
import { StyleSheet, Text, View } from 'react-native'
import type { SessionError, SessionErrorCode } from '@rn-media/media-session'
import { COLORS, SPACE, TYPE } from '../theme'
import { Detail, Strip } from './ui'

/** One headline per code. Says what happened; never what to do about it. */
const HEADLINE: Record<SessionErrorCode, string> = {
  backgroundPlaybackUnavailable: 'Background playback is not protected',
  playbackResumptionFailed: 'A playback resumption did not finish',
  playbackResumptionUnavailable: 'Playback resumption cannot work',
  playbackResumptionNotWired: 'A resumption never reached this app',
  artworkFailed: 'Artwork did not load',
  metadataMismatch: 'Metadata was dropped',
  iconNotFound: 'An icon did not resolve',
  localAudioSlotUnavailable: 'The local audio slot could not be held',
  playFromMediaIdUnhandled: 'A car tapped an item this app cannot play',
  browseRootRejected: 'Some browse tabs were dropped',
}

export const SessionErrorBanner = React.memo(function SessionErrorBanner({
  error,
  onDismiss,
}: {
  error: SessionError | undefined
  onDismiss: () => void
}): React.JSX.Element | null {
  if (error === undefined) return null
  // Straight from the library: this screen keeps no table of what is serious.
  const fatal = error.severity === 'fatal'

  return (
    <View accessibilityRole="alert" style={styles.container}>
      <Strip color={fatal ? COLORS.error : COLORS.warning}>
        <Text style={styles.headline}>
          {HEADLINE[error.code] ?? 'The media session reported a failure'}
          <Text style={styles.code}>
            {' · '}
            {error.code}
            {fatal ? ' · fatal' : ''}
          </Text>
        </Text>
        <Detail>{error.message}</Detail>
        <Text
          accessibilityRole="button"
          onPress={onDismiss}
          style={styles.dismiss}
        >
          Dismiss
        </Text>
      </Strip>
    </View>
  )
})

const styles = StyleSheet.create({
  container: { alignSelf: 'stretch' },
  headline: { fontSize: TYPE.label, fontWeight: '700', color: COLORS.text },
  code: { fontWeight: '400', color: COLORS.muted },
  dismiss: {
    marginTop: SPACE.xs,
    fontSize: TYPE.label,
    fontWeight: '700',
    color: COLORS.muted,
  },
})
