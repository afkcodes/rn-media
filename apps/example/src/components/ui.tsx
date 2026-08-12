/**
 * The four primitives every section on this screen is built from.
 *
 * Not a design system — just enough shared vocabulary that a dozen
 * independently-written components still look like one app. Anything
 * feature-specific belongs in the component that owns the feature.
 */
import React from 'react'
import { Pressable, StyleSheet, Text, View, type ViewStyle } from 'react-native'
import { COLORS, RADIUS, SHADOW, SPACE, TYPE } from '../theme'

/** A titled card. The one container shape on the screen. */
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

/** A pill button. `active` fills it with the accent; that is the whole state. */
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

const styles = StyleSheet.create({
  section: {
    alignSelf: 'stretch',
    padding: SPACE.lg,
    borderRadius: RADIUS.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: COLORS.borderSoft,
    backgroundColor: COLORS.surface,
    gap: SPACE.md,
    ...SHADOW.card,
  },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: SPACE.sm,
  },
  sectionTitle: {
    fontSize: TYPE.micro,
    fontWeight: '700',
    letterSpacing: 1.4,
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
    paddingVertical: SPACE.sm,
    borderRadius: RADIUS.pill,
    borderWidth: 1,
    borderColor: COLORS.border,
    backgroundColor: COLORS.surfaceSunken,
  },
  chipActive: {
    borderColor: COLORS.accentBright,
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
})
