/**
 * A modal bottom sheet — the one container this otherwise card-less app allows.
 *
 * The main screen is the player. Every *feature* (cast, EQ, sleep, the rest)
 * lives behind the control row and opens here: a panel anchored to the bottom
 * of the window, with a drag handle, a title and a close control. Built on RN's
 * own `Modal` — no native sheet dependency — so it is one file and works the
 * same on both platforms.
 *
 * The caller mounts the sheet's contents only while it is `visible`, so a heavy
 * feature (the EQ hook's filter graph, the visualizer's sampler) costs nothing
 * until someone opens it. That is why this takes `children` rather than always
 * rendering them behind an opacity.
 */
import React from 'react'
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { COLORS, RADIUS, SPACE, TYPE } from '../theme'

/** Rounded top corners — a raised surface, not a control. Bigger than the
 *  control radii the theme ships, on purpose: this is the one real container. */
const SHEET_RADIUS = 22

export function BottomSheet({
  visible,
  title,
  onClose,
  children,
}: {
  visible: boolean
  title: string
  onClose: () => void
  children: React.ReactNode
}): React.JSX.Element {
  const insets = useSafeAreaInsets()
  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      statusBarTranslucent
      onRequestClose={onClose}
    >
      <View style={styles.root}>
        {/* Tap the dimmed area above the panel to dismiss. */}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Close"
          style={styles.scrim}
          onPress={onClose}
        />
        <View style={styles.panel}>
          <View style={styles.handle} />
          <View style={styles.header}>
            <Text style={styles.title}>{title}</Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Close"
              onPress={onClose}
              hitSlop={SPACE.sm}
              style={({ pressed }) => [styles.close, pressed && styles.pressed]}
            >
              <Text style={styles.closeGlyph}>✕</Text>
            </Pressable>
          </View>
          <ScrollView
            style={styles.scroll}
            contentContainerStyle={[
              styles.body,
              { paddingBottom: SPACE.xl + insets.bottom },
            ]}
            showsVerticalScrollIndicator={false}
          >
            {children}
          </ScrollView>
        </View>
      </View>
    </Modal>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1, justifyContent: 'flex-end' },
  scrim: { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)' },
  panel: {
    maxHeight: '88%',
    backgroundColor: COLORS.surface,
    borderTopLeftRadius: SHEET_RADIUS,
    borderTopRightRadius: SHEET_RADIUS,
    paddingHorizontal: SPACE.xl,
    paddingTop: SPACE.md,
  },
  handle: {
    alignSelf: 'center',
    width: 36,
    height: 4,
    borderRadius: RADIUS.pill,
    backgroundColor: COLORS.border,
    marginBottom: SPACE.md,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingBottom: SPACE.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: COLORS.border,
  },
  title: {
    fontSize: TYPE.title,
    fontWeight: '700',
    color: COLORS.text,
  },
  close: {
    width: 32,
    height: 32,
    alignItems: 'center',
    justifyContent: 'center',
  },
  closeGlyph: { fontSize: TYPE.body, color: COLORS.muted },
  scroll: { alignSelf: 'stretch' },
  body: { paddingTop: SPACE.lg, gap: SPACE.xl },
  pressed: { opacity: 0.6 },
})
