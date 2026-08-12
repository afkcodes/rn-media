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
 */
import React from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { COLORS, RADIUS, SHADOW, SPACE, TYPE } from '../theme'

export const TransportControls = React.memo(function TransportControls({
  playing,
  ready,
  hasNext,
  hasPrevious,
  onPrevious,
  onToggle,
  onNext,
  onSeekBy,
  onStop,
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
  onStop: () => void
}): React.JSX.Element {
  return (
    <View style={styles.container}>
      <View style={styles.row}>
        {/* ⏮ stays enabled at the head of the queue: past three seconds it
            restarts the entry, which is what every music app does and what
            `playlist.previous()` implements for us. */}
        <Round
          label="⏮"
          accessibilityLabel={
            hasPrevious ? 'Previous track' : 'Restart track'
          }
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
        <Round
          label="⏭"
          accessibilityLabel="Next track"
          disabled={!ready || !hasNext}
          onPress={onNext}
        />
      </View>

      {/* Relative jumps. `seekBy` is mpv's own relative seek — deriving an
          absolute target from the projected position races the projection. */}
      <View style={styles.row}>
        <Jump
          label="⏪ 15"
          accessibilityLabel="Back 15 seconds"
          disabled={!ready}
          onPress={() => onSeekBy(-15)}
        />
        <Jump
          label="30 ⏩"
          accessibilityLabel="Forward 30 seconds"
          disabled={!ready}
          onPress={() => onSeekBy(30)}
        />
      </View>

      <Pressable
        accessibilityRole="button"
        disabled={!ready}
        onPress={onStop}
        style={({ pressed }) => [
          styles.stop,
          !ready && styles.dim,
          pressed && styles.pressed,
        ]}
      >
        <Text style={styles.stopLabel}>■ Stop &amp; dismiss notification</Text>
      </Pressable>
    </View>
  )
})

function Round({
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
        styles.round,
        disabled && styles.dim,
        pressed && styles.pressed,
      ]}
    >
      <Text style={styles.roundGlyph}>{label}</Text>
    </Pressable>
  )
}

function Jump({
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
        styles.jump,
        disabled && styles.dim,
        pressed && styles.pressed,
      ]}
    >
      <Text style={styles.jumpLabel}>{label}</Text>
    </Pressable>
  )
}

const PRIMARY = 76

const styles = StyleSheet.create({
  container: { alignSelf: 'stretch', alignItems: 'center', gap: SPACE.md },
  row: { flexDirection: 'row', alignItems: 'center', gap: SPACE.xl },
  round: {
    width: 56,
    height: 56,
    borderRadius: RADIUS.pill,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: COLORS.borderSoft,
    backgroundColor: COLORS.surface,
  },
  roundGlyph: { fontSize: 20, color: COLORS.text },
  primary: {
    width: PRIMARY,
    height: PRIMARY,
    borderRadius: RADIUS.pill,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: COLORS.accent,
    ...SHADOW.accent,
  },
  primaryGlyph: { fontSize: 24, color: COLORS.onAccent },
  playGlyph: { marginLeft: 4, fontSize: 28 },
  stop: {
    paddingVertical: SPACE.md,
    paddingHorizontal: SPACE.lg,
    borderRadius: RADIUS.pill,
    borderWidth: 1,
    borderColor: COLORS.borderSoft,
    backgroundColor: COLORS.surfaceSunken,
  },
  stopLabel: { fontSize: TYPE.label, color: COLORS.muted },
  jump: {
    paddingVertical: SPACE.sm,
    paddingHorizontal: SPACE.lg,
    borderRadius: RADIUS.pill,
    borderWidth: 1,
    borderColor: COLORS.borderSoft,
    backgroundColor: COLORS.surface,
  },
  jumpLabel: { fontSize: TYPE.label, color: COLORS.text },
  dim: { opacity: 0.4 },
  pressed: { opacity: 0.75 },
})
