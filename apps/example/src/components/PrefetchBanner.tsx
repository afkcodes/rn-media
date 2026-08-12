/**
 * `prefetchStarted` — the typed event, not a log line being parsed.
 *
 * mpv opens the **next** queue entry while the current one is still playing, so
 * the handover does not have to pay for a fresh TCP + TLS + probe. This event
 * fires at the instant mpv's opener thread is released on that entry, which is
 * seconds *into* the current track rather than near its end — so if you see a
 * line here well before a boundary, that boundary is going to be gapless.
 *
 * Two conditions, both honest, and the banner reports on both:
 *
 * 1. **mpv must actually be prefetching.** `prefetchPlaylist` is off by default
 *    in the library; this app turns it on in `Player.create` (see
 *    `controller.ts` for why, and for the queue-edit caveat that comes with it).
 *    The toggle below flips mpv's property at runtime so the difference is
 *    audible on a device without a rebuild.
 * 2. **The linked libmpv must carry the prefetch hook** — Android
 *    `v1.1.9-rnmedia.5`+ / iOS `v0.7.2-rnmedia.4`+. Stock libmpv runs no hooks
 *    on its prefetch path, so on any other build the event simply never occurs.
 *    There is no error and no capability flag: an event that does not happen is
 *    not a failure.
 */
import React from 'react'
import { StyleSheet, Text, View } from 'react-native'
import { COLORS, SPACE, TYPE } from '../theme'
import { Chip, Detail, Strip } from './ui'
import type { PrefetchNote } from '../playback'

export const PrefetchBanner = React.memo(function PrefetchBanner({
  note,
  enabled,
  ready,
  onToggle,
}: {
  note: PrefetchNote | undefined
  enabled: boolean
  ready: boolean
  onToggle: (enabled: boolean) => void
}): React.JSX.Element {
  return (
    // A flat strip like the retry/error banners — the rule turns success-green
    // the moment `prefetchStarted` has fired, which is the visible proof a
    // boundary is going to be gapless.
    <View style={styles.container}>
      <Strip color={note === undefined ? COLORS.border : COLORS.success}>
        <View style={styles.row}>
          <View style={styles.text}>
            <Text style={styles.title}>
              {note === undefined
                ? enabled
                  ? 'Prefetch armed — waiting for a boundary'
                  : 'Prefetch off'
                : 'Next entry opened early'}
            </Text>
            <Detail>
              {note === undefined
                ? enabled
                  ? 'mpv opens the next entry once the current one is fully read.'
                  : 'Every transition will pay for a cold connection.'
                : `${note.uri}${note.entryId === undefined ? '' : ` · entry #${note.entryId}`}`}
            </Detail>
          </View>
          <Chip
            label={enabled ? 'On' : 'Off'}
            active={enabled}
            disabled={!ready}
            onPress={() => onToggle(!enabled)}
          />
        </View>
      </Strip>
    </View>
  )
})

const styles = StyleSheet.create({
  container: { alignSelf: 'stretch' },
  row: { flexDirection: 'row', alignItems: 'center', gap: SPACE.md },
  text: { flex: 1, gap: 2 },
  title: { fontSize: TYPE.label, fontWeight: '600', color: COLORS.text },
})
