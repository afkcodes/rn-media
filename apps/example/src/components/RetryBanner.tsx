/**
 * `retrying` — the event that exists because "failed" and "gave up" are not the
 * same fact.
 *
 * mpv's own behaviour when an entry fails hard is to advance to the next one.
 * That is right for a file that will never play and wrong for a stream that was
 * unlucky, so the player re-attempts a `retryable` failure before letting the
 * queue move — and while it is doing that, **no `error` event fires at all**.
 * An app that only listened to `error` would therefore show nothing while a
 * radio stream reconnects, and then show a banner only if it never came back.
 * This is the missing half.
 *
 * Two layers are actually at work by the time this appears, and only the second
 * one is visible here:
 *
 * 1. **FFmpeg's own reconnection** (`networkReconnect`) has already run and
 *    failed. It is native, inside libavformat's read loop, with no timers — the
 *    only kind of retry that survives the screen being off — and it retries with
 *    a backoff of 0 s, 1 s, 3 s… up to `maxDelaySeconds`.
 * 2. **The player's re-attempt** (`retry`) then asks the different question:
 *    *should the queue move on?* It jumps back to the entry, preserving whether
 *    it was playing, and emits this.
 *
 * There is deliberately no delay between the attempts you see counted here.
 * A JS-timer backoff would freeze with the display off — which is precisely when
 * a radio app needs it — so spaced retrying belongs to layer 1 and this layer
 * acts immediately. See `RetryOptions`.
 */
import React from 'react'
import { StyleSheet, Text, View } from 'react-native'
import { COLORS, RADIUS, SPACE, TYPE } from '../theme'
import { Detail } from './ui'
import type { RetryNote } from '../playback'

export const RetryBanner = React.memo(function RetryBanner({
  note,
}: {
  note: RetryNote | undefined
}): React.JSX.Element | null {
  if (note === undefined) return null
  return (
    <View accessibilityRole="alert" style={styles.banner}>
      <Text style={styles.title}>
        Reconnecting — attempt {note.attempt} of {note.maxAttempts}
      </Text>
      <Detail>
        Entry #{note.index} failed and is being re-attempted rather than
        skipped: {note.message}
      </Detail>
    </View>
  )
})

const styles = StyleSheet.create({
  banner: {
    alignSelf: 'stretch',
    gap: 2,
    padding: SPACE.md,
    borderRadius: RADIUS.md,
    borderLeftWidth: 3,
    borderLeftColor: COLORS.warning,
    backgroundColor: COLORS.surfaceSunken,
  },
  title: { fontSize: TYPE.label, fontWeight: '600', color: COLORS.text },
})
