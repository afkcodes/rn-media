/**
 * Previous / play-pause / next, plus the one control people forget to build.
 *
 * **Stop is not pause.** Pause leaves the media session up, the notification on
 * screen and the process eligible to keep running; `stop()` is the only thing
 * that ends background execution and takes the notification with it. Both are
 * here because a media app needs both, and conflating them is the most common
 * bug in this corner of the platform.
 *
 * Every play path — this button, the notification, a Bluetooth remote — goes
 * through the same `Playback.play()`, which requests audio focus first. That is
 * the app's job by design: only the app knows when it is about to make sound.
 *
 * Visually the row is flat on purpose: the accent-filled play circle is the
 * only filled control on the whole screen, the skip and jump buttons are bare
 * glyphs with generous hit areas, and stop is a line of quiet text — the
 * hierarchy is "one loud thing, everything else whispers".
 */
import React from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { COLORS, RADIUS, SPACE, TYPE } from '../theme'

export const TransportControls = React.memo(function TransportControls({
  playing,
  ready,
  hasNext,
  hasPrevious,
  onPrevious,
  onToggle,
  onNext,
  onSeekBy,
}: {
  playing: boolean
  ready: boolean
  /** From `PlayerState`, loop-aware and atomic — never recomputed here. */
  hasNext: boolean
  hasPrevious: boolean
  onPrevious: () => void
  onToggle: () => void
  onNext: () => void
  onSeekBy: (deltaSeconds: number) => void
}): React.JSX.Element {
  return (
    <View style={styles.container}>
      <View style={styles.row}>
        {/* Relative jumps flank the transport. `seekBy` is mpv's own relative
            seek — deriving an absolute target from the projected position
            races the projection. The 15/30 asymmetry matches the media-session
            config's jumpBackwardSeconds/jumpForwardSeconds, so the lock screen
            and this row move by the same amounts. */}
        <Quiet
          label="↺ 15"
          accessibilityLabel="Back 15 seconds"
          disabled={!ready}
          onPress={() => onSeekBy(-15)}
        />

        {/* ⏮ stays enabled at the head of the queue: past three seconds it
            restarts the entry, which is what every music app does and what
            `playlist.previous()` implements for us. */}
        <Glyph
          label="⏮"
          accessibilityLabel={hasPrevious ? 'Previous track' : 'Restart track'}
          disabled={!ready}
          onPress={onPrevious}
        />

        <Pressable
          accessibilityRole="button"
          accessibilityLabel={playing ? 'Pause' : 'Play'}
          disabled={!ready}
          onPress={onToggle}
          style={({ pressed }) => [
            styles.primary,
            !ready && styles.dim,
            pressed && styles.pressed,
          ]}
        >
          {/* Nudged right by an optical hair: a triangle's visual centre is not
              its bounding box's centre. */}
          <Text style={[styles.primaryGlyph, !playing && styles.playGlyph]}>
            {playing ? '❚❚' : '▶'}
          </Text>
        </Pressable>

        {/* …but ⏭ genuinely has nothing to do at the end of a queue, and
            `hasNext` already knows about the loop mode. */}
        <Glyph
          label="⏭"
          accessibilityLabel="Next track"
          disabled={!ready || !hasNext}
          onPress={onNext}
        />

        <Quiet
          label="30 ↻"
          accessibilityLabel="Forward 30 seconds"
          disabled={!ready}
          onPress={() => onSeekBy(30)}
        />
      </View>

    </View>
  )
})

/** A bare transport glyph — no outline, no fill, just a generous hit area. */
function Glyph({
  label,
  accessibilityLabel,
  disabled,
  onPress,
}: {
  label: string
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
        styles.glyph,
        disabled && styles.dim,
        pressed && styles.pressed,
      ]}
    >
      <Text style={styles.glyphLabel}>{label}</Text>
    </Pressable>
  )
}

/** The quietest control on the row: a small tabular label, nothing around it. */
function Quiet({
  label,
  accessibilityLabel,
  disabled,
  onPress,
}: {
  label: string
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
        styles.quiet,
        disabled && styles.dim,
        pressed && styles.pressed,
      ]}
    >
      <Text style={styles.quietLabel}>{label}</Text>
    </Pressable>
  )
}

const PRIMARY = 68

const styles = StyleSheet.create({
  container: { alignSelf: 'stretch', alignItems: 'center', gap: SPACE.md },
  row: {
    alignSelf: 'stretch',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: SPACE.lg,
  },
  glyph: {
    width: 52,
    height: 52,
    alignItems: 'center',
    justifyContent: 'center',
  },
  glyphLabel: { fontSize: 24, color: COLORS.text },
  primary: {
    width: PRIMARY,
    height: PRIMARY,
    borderRadius: RADIUS.pill,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: COLORS.accent,
  },
  primaryGlyph: { fontSize: 22, color: COLORS.onAccent },
  playGlyph: { marginLeft: 4, fontSize: 26 },
  stop: { paddingVertical: SPACE.xs, paddingHorizontal: SPACE.md },
  stopLabel: {
    fontSize: TYPE.caption,
    letterSpacing: 0.4,
    color: COLORS.muted,
  },
  quiet: {
    paddingVertical: SPACE.md,
    paddingHorizontal: SPACE.xs,
  },
  quietLabel: {
    fontSize: TYPE.label,
    fontVariant: ['tabular-nums'],
    color: COLORS.muted,
  },
  dim: { opacity: 0.4 },
  pressed: { opacity: 0.75 },
})
