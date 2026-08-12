/**
 * The analyser's *drawing* — bars, LED grid, and nothing else.
 *
 * This is the half that runs at frame rate, so it is kept away from everything
 * that does not. See `VisualizerSection.tsx` for the subscription.
 */
import React from 'react'
import { StyleSheet, View } from 'react-native'
import { COLORS, RADIUS } from '../theme'

export const VISUALIZER_BANDS = 20
/**
 * 60 is the engine's ceiling and it is reached: a release build of this screen
 * measures 60.0 fps delivered with zero dropped frames. Worth asking for even
 * though new spectral content only arrives at the audio device's chunk rate
 * (~20-45 Hz) — the asymmetric smoothing animates *between* targets, and it can
 * only do that on frames it is handed.
 *
 * Measure this in a **release** build. The identical screen in debug manages
 * 24-26 fps, which is Hermes running unoptimised JavaScript, not the engine.
 * The header shows what actually landed.
 */
export const VISUALIZER_FPS = 60
/** LED rows per bar. Winamp's analyser was 16 segments tall. */
const SEGMENTS = 16
const BAR_HEIGHT = 128
const TRACK_HEIGHT = BAR_HEIGHT - 12
/**
 * Unlit LED colour — and, necessarily, the mask's colour too.
 *
 * It has to be **opaque**: the mask's whole job is to hide the colour column
 * underneath it, and a translucent one lets every bar read as full height
 * regardless of the audio (observed on device, 2026-08-11). This is
 * `rgba(255,255,255,0.06)` composited over `COLORS.background` once, by hand.
 */
const UNLIT = '#1c1f25'

/**
 * One bar: a **static** green→amber→red column that never re-renders, plus two
 * Views that do.
 *
 * Read it as a level meter — green through most of the travel, amber near the
 * top, red at the very top — so a bar's colours mean a level rather than
 * following it around. The LED segmentation is a single grid drawn *over* every
 * bar ({@link VisualizerGrid}), not 16 Views per bar toggled per frame, which is
 * the same look for 1/20th of the work.
 *
 * This is the whole point of the component. The obvious way to draw an LED
 * analyser is a stack of 16 segment Views per bar whose colours you toggle —
 * 320 Views changing style 30 times a second, which is a layout-and-commit
 * storm on the UI thread and would break this library's own performance rule
 * before the audio path ever got a chance to. Instead:
 *
 *  - the coloured column and the LED grid are laid out once and never touched;
 *  - the level is drawn by sliding an opaque **mask** down over that column, so
 *    the colours stay keyed to *position* (a bar's top reads as "hot") rather
 *    than to its current level;
 *  - the peak cap is one more View that only ever translates.
 *
 * Both moving Views change `transform` only. Transforms do not invalidate
 * layout, so a frame costs a commit and a draw and no measure pass. That is the
 * pattern to copy.
 */
export const VisualizerBar = React.memo(function VisualizerBar({
  value,
  peak,
}: {
  value: number
  peak: number
}): React.JSX.Element {
  return (
    <View style={styles.barColumn}>
      {/* Static: the full-height colour column, laid out once. */}
      <View style={styles.barLow} />
      <View style={styles.barMid} />
      <View style={styles.barHigh} />

      {/*
        The mask sits entirely above the bar at rest and slides down to cover
        whatever the level does not reach. translateY = height × (1 − value):
        0 leaves the bar fully lit, `height` hides it completely.
      */}
      <View
        pointerEvents="none"
        style={[
          styles.barMask,
          { transform: [{ translateY: TRACK_HEIGHT * (1 - value) }] },
        ]}
      />

      {/* The floating peak cap: also transform-only. */}
      <View
        pointerEvents="none"
        style={[
          styles.barPeak,
          {
            opacity: peak > 0.01 ? 1 : 0,
            transform: [{ translateY: -peak * (TRACK_HEIGHT - 2) }],
          },
        ]}
      />
    </View>
  )
})

/**
 * The LED grid: `SEGMENTS - 1` hairlines drawn once across every bar and never
 * re-rendered.
 *
 * It lives inside the bars *row* rather than the outer container on purpose.
 * The row's width is exactly the first bar's left edge to the last bar's right
 * edge, so `left: 0; right: 0` here means precisely "across the bars" — as a
 * sibling of the centering container it overhung both ends and read as stray
 * rules floating in the card.
 */
export const VisualizerGrid = React.memo(function VisualizerGrid(): React.JSX.Element {
  return (
    <View pointerEvents="none" style={styles.barGrid}>
      {Array.from({ length: SEGMENTS - 1 }, (_unused, row) => (
        <View key={row} style={styles.barGridLine} />
      ))}
    </View>
  )
})

/** The frame the bars sit in — fixed height, so nothing reflows per frame. */
export function VisualizerStage({
  children,
}: {
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <View style={styles.bars}>
      <View style={styles.barsRow}>
        {children}
        <VisualizerGrid />
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  bars: {
    alignItems: 'center',
    justifyContent: 'center',
    height: BAR_HEIGHT,
    width: '100%',
  },
  // Sized by its children, so it is exactly as wide as the bars — which is what
  // lets the LED grid span them and nothing else.
  barsRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 4,
    height: TRACK_HEIGHT,
  },
  barColumn: {
    height: TRACK_HEIGHT,
    width: 14,
    overflow: 'hidden',
    borderRadius: 3,
    // Unlit background, the way a real analyser's grid stays faintly visible.
    backgroundColor: UNLIT,
  },
  // The three colour zones are absolutely positioned so the column has a fixed
  // gradient regardless of the level: green at the bottom, amber, red on top.
  barLow: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    height: TRACK_HEIGHT * 0.72,
    backgroundColor: COLORS.success,
  },
  barMid: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: TRACK_HEIGHT * 0.72,
    height: TRACK_HEIGHT * 0.18,
    backgroundColor: COLORS.warning,
  },
  barHigh: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: TRACK_HEIGHT * 0.9,
    height: TRACK_HEIGHT * 0.1,
    backgroundColor: COLORS.live,
  },
  barMask: {
    position: 'absolute',
    left: 0,
    right: 0,
    // Parked one full height above the bar, then translated down to cover
    // whatever the level does not reach.
    top: -TRACK_HEIGHT,
    height: TRACK_HEIGHT,
    backgroundColor: UNLIT,
  },
  barPeak: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    height: 2,
    borderRadius: 1,
    backgroundColor: '#f2f2f7',
  },
  barGrid: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: 0,
    bottom: 0,
    justifyContent: 'space-evenly',
  },
  barGridLine: {
    height: 2,
    width: '100%',
    backgroundColor: COLORS.surface,
    borderRadius: RADIUS.sm,
  },
})
