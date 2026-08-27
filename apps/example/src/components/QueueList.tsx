/**
 * The queue — mpv's own playlist, which is what makes the transitions gapless.
 *
 * Feature map for this one group:
 *
 * - **tap a row** → `Playback.jumpTo` (`playlist.jumpTo`, behind the audio-focus
 *   gate, and never restarting the entry that is already open);
 * - **`✕`** → `playlist.remove(index)`. Removing the current entry stops it
 *   and starts the next — mpv's rule;
 * - **Clear** → `playlist.clear()` (which keeps the entry that is playing).
 *
 * The old per-row queue-insert arrows (`⤴`/`⤵`) are gone: this is a music-app
 * queue now, one clean row plus a quiet remove, not a demo of every
 * `loadfile` insert position.
 *
 * Shuffle lives with repeat in `PlaybackModes` now — it is a broadcast *mode*
 * shared with the notification, not a queue edit button, even though under the
 * hood it performs one (see `Playback.setShuffleEnabled`).
 *
 * The rows are drawn from the app's *mirror* of mpv's playlist, re-read after
 * every `queueChanged` — see `QueueMirror` for why that is a pull, not a push.
 *
 * Visually: no row boxes. Rows are separated by hairlines, the current row is
 * marked by the accent title and the ▶/❚❚ glyph, and the row actions are
 * quiet glyphs — each its own hit target so a fat thumb cannot start the track
 * it meant to queue.
 */
import React from 'react'
import { Image, Pressable, StyleSheet, Text, View } from 'react-native'
import { COLORS, RADIUS, SPACE, TYPE } from '../theme'
import type { Track } from '../data/tracks'
import type { QueueRow } from '../playback'
import { Chip, ChipRow, Section } from './ui'

/**
 * React key for one row.
 *
 * mpv's `entryId` is "unique for the entire life time of the current mpv core
 * instance" and survives inserts, removes, moves and shuffles — which is
 * exactly what a key has to do, and exactly what an index-based key does not.
 * Keying on the position meant a shuffle told React "row 3 changed its
 * contents" instead of "row 3 moved", so every row remounted: artwork
 * re-fetched, and any per-row state would have landed on the wrong song.
 *
 * The fallback covers the rows that have no mpv id yet — `QueueMirror` seeds
 * itself from `TRACKS` before the core has a playlist to read, and stamps those
 * placeholders with negative ids. They are positional by nature, so a
 * positional key is the honest one for them.
 */
function rowKey(row: QueueRow, position: number): string {
  return row.entryId >= 0
    ? `entry-${row.entryId}`
    : `slot-${position}-${row.track.id}`
}

export const QueueList = React.memo(function QueueList({
  queue,
  index,
  playing,
  ready,
  onJump,
  onRemove,
  onClear,
}: {
  queue: readonly QueueRow[]
  index: number
  playing: boolean
  ready: boolean
  onJump: (index: number) => void
  onRemove: (index: number) => void
  onClear: () => void
}): React.JSX.Element {
  return (
    <Section
      title="Up Next"
      accessory={
        <Text style={styles.counter}>
          {index + 1} / {queue.length}
        </Text>
      }
    >
      <View>
        {queue.map((row, position) => (
          <Row
            key={rowKey(row, position)}
            track={row.track}
            position={position}
            current={position === index}
            playing={playing}
            ready={ready}
            first={position === 0}
            onJump={onJump}
            onRemove={onRemove}
          />
        ))}
      </View>

      <ChipRow>
        <Chip label="Clear" tone="danger" disabled={!ready} onPress={onClear} />
      </ChipRow>
    </Section>
  )
})

const Row = React.memo(function Row({
  track,
  position,
  current,
  playing,
  ready,
  first,
  onJump,
  onRemove,
}: {
  track: Track
  position: number
  current: boolean
  playing: boolean
  ready: boolean
  first: boolean
  onJump: (index: number) => void
  onRemove: (index: number) => void
}): React.JSX.Element {
  return (
    <View style={[styles.row, !first && styles.rowRule]}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ selected: current }}
        disabled={!ready}
        onPress={() => onJump(position)}
        style={({ pressed }) => [styles.rowMain, pressed && styles.pressed]}
      >
        {track.artworkUri === undefined ? (
          <View style={[styles.thumb, styles.thumbEmpty]}>
            <Text style={styles.thumbGlyph}>♪</Text>
          </View>
        ) : (
          <Image source={{ uri: track.artworkUri }} style={styles.thumb} />
        )}

        <View style={styles.rowText}>
          <Text
            numberOfLines={1}
            style={[styles.rowTitle, current && styles.rowTitleCurrent]}
          >
            {current ? (playing ? '▶ ' : '❚❚ ') : ''}
            {track.title}
          </Text>
          <Text numberOfLines={1} style={styles.rowMeta}>
            {/* The live badge, as type: red inline caps instead of a pill. */}
            {track.isLive === true ? (
              <Text style={styles.rowLive}>LIVE </Text>
            ) : null}
            {track.album ?? track.artist}
          </Text>
        </View>
      </Pressable>

      {/* One quiet remove affordance, its own hit target so a fat thumb cannot
          start the track it meant to remove. Removing the playing row starts
          the next one — mpv's rule. */}
      <RowAction
        glyph="✕"
        accessibilityLabel={`Remove ${track.title}`}
        disabled={!ready}
        onPress={() => onRemove(position)}
      />
    </View>
  )
})

function RowAction({
  glyph,
  accessibilityLabel,
  disabled,
  onPress,
}: {
  glyph: string
  accessibilityLabel: string
  disabled: boolean
  onPress: () => void
}): React.JSX.Element {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.action,
        disabled && styles.dim,
        pressed && styles.pressed,
      ]}
    >
      <Text style={styles.actionGlyph}>{glyph}</Text>
    </Pressable>
  )
}

const THUMB = 40

const styles = StyleSheet.create({
  counter: {
    fontSize: TYPE.micro,
    fontVariant: ['tabular-nums'],
    color: COLORS.muted,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  rowRule: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: COLORS.borderSoft,
  },
  rowMain: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACE.md,
    paddingVertical: SPACE.sm + 2,
  },
  thumb: { width: THUMB, height: THUMB, borderRadius: RADIUS.sm },
  thumbEmpty: {
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: COLORS.surface,
  },
  thumbGlyph: { fontSize: 16, color: COLORS.border },
  rowText: { flex: 1, gap: 1 },
  rowTitle: { fontSize: TYPE.body, fontWeight: '500', color: COLORS.text },
  rowTitleCurrent: { color: COLORS.accentBright, fontWeight: '700' },
  rowMeta: { fontSize: TYPE.micro, color: COLORS.muted },
  rowLive: { color: COLORS.live, fontWeight: '800', letterSpacing: 0.8 },
  action: {
    paddingHorizontal: SPACE.sm,
    paddingVertical: SPACE.md,
  },
  actionGlyph: { fontSize: TYPE.body, color: COLORS.muted },
  dim: { opacity: 0.4 },
  pressed: { opacity: 0.7 },
})
