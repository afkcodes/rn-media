/**
 * The control row that closes the screen: Cast · Equaliser · Sleep · More.
 *
 * Everything that is not the player itself now lives behind one of these four
 * buttons and opens in a {@link BottomSheet}. The row is a slim bar of glyph +
 * caption buttons, separated from the queue above it by a single hairline — the
 * same flat, card-less language as the rest of the app.
 */
import React from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { COLORS, SPACE, TYPE } from '../theme'

/** The four sheets this bar opens. `null` is "none open". */
export type FeatureSheet = 'cast' | 'equalizer' | 'sleep' | 'more'

const ITEMS: readonly {
  readonly id: FeatureSheet
  readonly glyph: string
  readonly label: string
}[] = [
  { id: 'cast', glyph: '◫', label: 'Cast' },
  { id: 'equalizer', glyph: '≣', label: 'Equaliser' },
  { id: 'sleep', glyph: '☾', label: 'Sleep' },
  { id: 'more', glyph: '⋯', label: 'More' },
]

export const FeatureBar = React.memo(function FeatureBar({
  ready,
  onOpen,
}: {
  ready: boolean
  onOpen: (sheet: FeatureSheet) => void
}): React.JSX.Element {
  return (
    <View style={styles.bar}>
      {ITEMS.map((item) => (
        <Pressable
          key={item.id}
          accessibilityRole="button"
          accessibilityLabel={item.label}
          disabled={!ready}
          onPress={() => onOpen(item.id)}
          style={({ pressed }) => [
            styles.item,
            !ready && styles.dim,
            pressed && styles.pressed,
          ]}
        >
          <Text style={styles.glyph}>{item.glyph}</Text>
          <Text style={styles.label}>{item.label}</Text>
        </Pressable>
      ))}
    </View>
  )
})

const styles = StyleSheet.create({
  bar: {
    alignSelf: 'stretch',
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingTop: SPACE.lg,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: COLORS.border,
  },
  item: {
    flex: 1,
    alignItems: 'center',
    gap: SPACE.xs,
    paddingVertical: SPACE.sm,
  },
  glyph: { fontSize: 22, color: COLORS.text },
  label: {
    fontSize: TYPE.micro,
    letterSpacing: 0.6,
    color: COLORS.muted,
  },
  dim: { opacity: 0.4 },
  pressed: { opacity: 0.6 },
})
