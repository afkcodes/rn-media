/**
 * The queue — mpv's own playlist, which is what makes the transitions gapless.
 *
 * Feature map for this one card:
 *
 * - **tap a row** → `Playback.jumpTo` (`playlist.jumpTo`, behind the audio-focus
 *   gate, and never restarting the entry that is already open);
 * - **"Next"** → `playlist.add(uri, { position: 'next' })`, one atomic mpv
 *   `insert-next`. Press it on row 6 (the `demo://` entry) to insert a
 *   resolver-backed source — the combination most likely to be wrong;
 * - **Shuffle / Undo / Clear** → `playlist.shuffle`, `playlist.unshuffle` (one
 *   level of undo only — mpv's limitation, not ours) and `playlist.clear`
 *   (which keeps the entry that is playing).
 *
 * The rows are drawn from the app's *mirror* of mpv's playlist, rebuilt from
 * `playlist/N/filename` after every edit — see `Playback.#syncQueue` for why
 * that has to be read back rather than assumed.
 */
import React from 'react'
import { Image, Pressable, StyleSheet, Text, View } from 'react-native'
import { COLORS, RADIUS, SPACE, TYPE } from '../theme'
import type { Track } from '../data/tracks'
import { Chip, ChipRow, Detail, Section } from './ui'

export const QueueList = React.memo(function QueueList({
  queue,
  index,
  playing,
  ready,
  onJump,
  onPlayNext,
  onShuffle,
  onUnshuffle,
  onClear,
}: {
  queue: readonly Track[]
  index: number
  playing: boolean
  ready: boolean
  onJump: (index: number) => void
  onPlayNext: (track: Track) => void
  onShuffle: () => void
  onUnshuffle: () => void
  onClear: () => void
}): React.JSX.Element {
  return (
    <Section
      title="Queue"
      accessory={
        <Text style={styles.counter}>
          {index + 1} / {queue.length}
        </Text>
      }
    >
      <View style={styles.rows}>
        {queue.map((track, position) => (
          <Row
            key={`${track.id}-${position}`}
            track={track}
            position={position}
            current={position === index}
            playing={playing}
            ready={ready}
            onJump={onJump}
            onPlayNext={onPlayNext}
          />
        ))}
      </View>

      <ChipRow>
        <Chip label="Shuffle" disabled={!ready} onPress={onShuffle} />
        <Chip label="Undo shuffle" disabled={!ready} onPress={onUnshuffle} />
        <Chip label="Clear" tone="danger" disabled={!ready} onPress={onClear} />
      </ChipRow>
      <Detail>
        Shuffle moves the playing entry too — mpv keeps the *entry* current, not
        the index, so the music does not stop but the cursor jumps. Undo is one
        level deep. Clear keeps whatever is playing.
      </Detail>
    </Section>
  )
})

const Row = React.memo(function Row({
  track,
  position,
  current,
  playing,
  ready,
  onJump,
  onPlayNext,
}: {
  track: Track
  position: number
  current: boolean
  playing: boolean
  ready: boolean
  onJump: (index: number) => void
  onPlayNext: (track: Track) => void
}): React.JSX.Element {
  return (
    <View style={[styles.row, current && styles.rowCurrent]}>
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
          <Text numberOfLines={1} style={[styles.rowTitle, current && styles.rowTitleCurrent]}>
            {current ? (playing ? '▶ ' : '❚❚ ') : `${position + 1}. `}
            {track.title}
          </Text>
          <Text numberOfLines={1} style={styles.rowMeta}>
            {track.album ?? track.artist}
          </Text>
        </View>

        {track.live === true ? (
          <View style={styles.liveTag}>
            <Text style={styles.liveTagLabel}>LIVE</Text>
          </View>
        ) : null}
      </Pressable>

      {/* Atomic insert-next. Deliberately its own hit target so a fat thumb
          cannot start the track it meant to queue. */}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Play ${track.title} next`}
        disabled={!ready}
        onPress={() => onPlayNext(track)}
        style={({ pressed }) => [styles.nextButton, pressed && styles.pressed]}
      >
        <Text style={styles.nextLabel}>Next</Text>
      </Pressable>
    </View>
  )
})

const THUMB = 44

const styles = StyleSheet.create({
  counter: {
    fontSize: TYPE.micro,
    fontVariant: ['tabular-nums'],
    color: COLORS.muted,
  },
  rows: { gap: SPACE.xs },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: RADIUS.md,
    backgroundColor: COLORS.surfaceSunken,
    overflow: 'hidden',
  },
  rowCurrent: { backgroundColor: COLORS.surfaceActive },
  rowMain: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACE.md,
    padding: SPACE.sm,
  },
  thumb: { width: THUMB, height: THUMB, borderRadius: RADIUS.sm },
  thumbEmpty: {
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: COLORS.surface,
  },
  thumbGlyph: { fontSize: 18, color: COLORS.border },
  rowText: { flex: 1, gap: 1 },
  rowTitle: { fontSize: TYPE.body, fontWeight: '500', color: COLORS.text },
  rowTitleCurrent: { color: COLORS.accentBright, fontWeight: '700' },
  rowMeta: { fontSize: TYPE.micro, color: COLORS.muted },
  liveTag: {
    paddingHorizontal: SPACE.sm,
    paddingVertical: 2,
    borderRadius: RADIUS.pill,
    backgroundColor: COLORS.live,
  },
  liveTagLabel: {
    fontSize: 9,
    fontWeight: '800',
    letterSpacing: 0.8,
    color: COLORS.onAccent,
  },
  nextButton: {
    alignSelf: 'stretch',
    justifyContent: 'center',
    paddingHorizontal: SPACE.md,
    borderLeftWidth: StyleSheet.hairlineWidth,
    borderLeftColor: COLORS.borderSoft,
  },
  nextLabel: { fontSize: TYPE.micro, fontWeight: '600', color: COLORS.muted },
  pressed: { opacity: 0.7 },
})
