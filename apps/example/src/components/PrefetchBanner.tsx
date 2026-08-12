/**
 * `usePrefetchStatus` — the library's own hook over the typed
 * `prefetchStarted` event, not app plumbing.
 *
 * mpv opens the **next** queue entry while the current one is still playing, so
 * the handover does not have to pay for a fresh TCP + TLS + probe. The hook
 * goes `active` at the instant mpv's opener thread is released on that entry —
 * which is seconds *into* the current track rather than near its end — and
 * clears itself at the boundary that consumes the prefetch (and on error /
 * queue end). This component holds no state and wires no events: the hook is
 * the whole integration, which is the point of demoing it here.
 *
 * Two conditions for it to ever go active, both honest (see the hook's TSDoc):
 *
 * 1. **mpv must actually be prefetching.** `prefetchPlaylist` is off by default
 *    in the library; this app turns it on in `Player.create` (see
 *    `controller.ts`). The toggle below flips mpv's property at runtime so the
 *    difference is audible on a device without a rebuild. Note the status can
 *    outlive the toggle: turning prefetch off does not abort an opener already
 *    running, and the banner honestly keeps showing what is still warm.
 * 2. **The linked libmpv must carry the prefetch hook** — Android
 *    `v1.1.9-rnmedia.5`+ / iOS `v0.7.2-rnmedia.4`+. On any other build the
 *    status simply never leaves `{ active: false }`; an idle banner is not a
 *    failure.
 */
import React from 'react'
import { StyleSheet, Text, View } from 'react-native'
import { usePrefetchStatus, type Player } from '@rn-media/player'
import { COLORS, SPACE, TYPE } from '../theme'
import { Chip, Detail, Strip } from './ui'

export const PrefetchBanner = React.memo(function PrefetchBanner({
  player,
  enabled,
  ready,
  onToggle,
}: {
  player: Player | undefined
  enabled: boolean
  ready: boolean
  onToggle: (enabled: boolean) => void
}): React.JSX.Element {
  // The library way: one hook, no listeners, no clearing rules to hand-roll.
  const prefetch = usePrefetchStatus(player)

  return (
    // A flat strip like the retry/error banners — the rule turns success-green
    // the moment a prefetch is in flight, which is the visible proof the next
    // boundary is going to be gapless.
    <View style={styles.container}>
      <Strip color={prefetch.active ? COLORS.success : COLORS.border}>
        <View style={styles.row}>
          <View style={styles.text}>
            <Text style={styles.title}>
              {prefetch.active
                ? 'Next entry opened early'
                : enabled
                  ? 'Prefetch armed — waiting for a boundary'
                  : 'Prefetch off'}
            </Text>
            <Detail>
              {prefetch.active
                ? `${prefetch.uri}${prefetch.entryId === undefined ? '' : ` · entry #${prefetch.entryId}`}`
                : enabled
                  ? 'mpv opens the next entry once the current one is fully read.'
                  : 'Every transition will pay for a cold connection.'}
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
