/**
 * The shared vocabulary every feature component is built from.
 *
 * Not a design system — just enough that a dozen independently-written
 * components still look like one app. The language is **flat and card-less**:
 * a {@link Section} is an uppercase micro label over a hairline rule, not a
 * box; grouping is whitespace's job and hierarchy is typography's. The only
 * things that keep a radius are {@link Chip}s — they are controls, and a
 * control needs an edge a finger can find. Anything feature-specific belongs
 * in the component that owns the feature.
 */
import React from 'react'
import { Pressable, StyleSheet, Text, View, type ViewStyle } from 'react-native'
import { COLORS, RADIUS, SPACE, TYPE } from '../theme'

/**
 * A titled group. No background, no border-box, no shadow — the label and the
 * hairline under it are the entire container.
 */
export const Section = React.memo(function Section({
  title,
  accessory,
  children,
  style,
}: {
  title?: string
  /** Right-aligned status text in the header — a count, a state, a warning. */
  accessory?: React.ReactNode
  children: React.ReactNode
  style?: ViewStyle
}): React.JSX.Element {
  return (
    <View style={[styles.section, style]}>
      {title === undefined && accessory === undefined ? null : (
        <View style={styles.sectionHeader}>
          <Text style={styles.sectionTitle}>{title}</Text>
          {accessory}
        </View>
      )}
      {children}
    </View>
  )
})

/**
 * A small rectangular control. `active` fills it with the accent; that is the
 * whole state. Flat otherwise: hairline outline, transparent fill.
 */
export const Chip = React.memo(function Chip({
  label,
  active = false,
  disabled = false,
  tone = 'neutral',
  onPress,
}: {
  label: string
  active?: boolean
  disabled?: boolean
  /** `danger` is for the one-way doors: stop, clear. */
  tone?: 'neutral' | 'danger'
  onPress: () => void
}): React.JSX.Element {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled, selected: active }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.chip,
        active && styles.chipActive,
        tone === 'danger' && styles.chipDanger,
        disabled && styles.dim,
        pressed && styles.pressed,
      ]}
    >
      <Text
        style={[
          styles.chipLabel,
          active && styles.chipLabelActive,
          tone === 'danger' && styles.chipLabelDanger,
        ]}
      >
        {label}
      </Text>
    </Pressable>
  )
})

/** Muted supporting copy — the line under a control that explains it. */
export function Detail({
  children,
  selectable = false,
  align = 'left',
}: {
  children: React.ReactNode
  selectable?: boolean
  align?: 'left' | 'center'
}): React.JSX.Element {
  return (
    <Text
      selectable={selectable}
      style={[styles.detail, align === 'center' && styles.centered]}
    >
      {children}
    </Text>
  )
}

/** A horizontal, wrapping run of {@link Chip}s. */
export function ChipRow({
  children,
}: {
  children: React.ReactNode
}): React.JSX.Element {
  return <View style={styles.chipRow}>{children}</View>
}

/** A small coloured dot — "on air", "prefetched", "armed". */
export function Dot({ color }: { color: string }): React.JSX.Element {
  return <View style={[styles.dot, { backgroundColor: color }]} />
}

/**
 * A status strip: a 2-pt coloured rule down the left of some text. This is the
 * card-less banner — the rule carries the severity, the copy carries the fact,
 * and there is no box.
 */
export function Strip({
  color,
  children,
}: {
  color: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <View style={[styles.strip, { borderLeftColor: color }]}>{children}</View>
  )
}

const styles = StyleSheet.create({
  section: {
    alignSelf: 'stretch',
    gap: SPACE.md,
  },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    gap: SPACE.sm,
    paddingBottom: SPACE.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: COLORS.borderSoft,
  },
  sectionTitle: {
    fontSize: TYPE.micro,
    fontWeight: '700',
    letterSpacing: 1.6,
    textTransform: 'uppercase',
    color: COLORS.muted,
  },
  chipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: SPACE.sm,
  },
  chip: {
    paddingHorizontal: SPACE.md,
    paddingVertical: 6,
    borderRadius: RADIUS.sm,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: COLORS.border,
  },
  chipActive: {
    borderColor: COLORS.accent,
    backgroundColor: COLORS.accent,
  },
  chipDanger: { borderColor: COLORS.error },
  chipLabel: { fontSize: TYPE.label, color: COLORS.text },
  chipLabelActive: { color: COLORS.onAccent, fontWeight: '600' },
  chipLabelDanger: { color: COLORS.error },
  detail: { fontSize: TYPE.caption, lineHeight: 17, color: COLORS.muted },
  centered: { textAlign: 'center' },
  dim: { opacity: 0.4 },
  pressed: { opacity: 0.7 },
  dot: { width: 7, height: 7, borderRadius: 4 },
  strip: {
    alignSelf: 'stretch',
    gap: SPACE.xs,
    paddingLeft: SPACE.md,
    borderLeftWidth: 2,
  },
})
