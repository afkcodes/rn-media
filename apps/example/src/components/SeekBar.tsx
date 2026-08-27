/**
 * A dependency-free scrubber for the example app.
 *
 * React Native core ships no slider, and this repository is not going to grow a
 * native dependency for a demo, so the bar is drawn with plain `View`s and
 * driven by a single `PanResponder`. That covers both gestures a transport bar
 * needs — a tap anywhere jumps there, and a press-and-drag scrubs — because
 * `onStartShouldSetPanResponder` claims the touch on *down*, so a tap is just a
 * drag with no movement.
 *
 * Three behaviours are worth calling out, since they are the difference between
 * a scrubber that feels right and one that fights the user:
 *
 * 1. **The thumb is never moved by the player while a finger is on it.** The
 *    incoming `position` prop keeps ticking during a drag; it is ignored for as
 *    long as `scrub` is set. Without this the thumb snaps back to the playhead
 *    ~4 times a second.
 * 2. **A seek is not instantaneous.** `seekTo` is a round trip through mpv, so
 *    on release the target is held (`pending`) until the player's own position
 *    arrives near it — otherwise the thumb jumps back to where playback still
 *    is, then forward again when the seek lands.
 * 3. **Everything inside the responder is `pointerEvents="none"`.** RN's
 *    `locationX` is relative to the *touch target* — the deepest hit-testable
 *    view under the finger — not to the view holding the responder, so
 *    `pageX - locationX` is only the bar's origin when the bar is the only
 *    thing that can be hit. It was not: the thumb is a hit-testable child, and
 *    because every RN `View` is `clipChildren = false`
 *    (`ReactViewGroup.kt:170`) and the track's overflow inset covers the part
 *    of the thumb hanging outside it, a touch anywhere on the *visible thumb*
 *    resolved to the thumb — whose origin is near the playhead, making the
 *    computed fraction ~0 and sending playback to 0:00. Grabbing the thumb is
 *    the most natural way to scrub, so that was the one gesture that could not
 *    work. Same bug the fader bank had, same fix.
 *
 * The bar is intentionally *disabled rather than hidden* on live streams: this
 * app is the on-device test bed, and "the scrubber is greyed out and says live"
 * is a check you can make with your eyes, whereas an absent view proves nothing.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react'
import {
  PanResponder,
  StyleSheet,
  Text,
  View,
  type LayoutChangeEvent,
} from 'react-native'
import { COLORS, RADIUS, SPACE, TYPE } from '../theme'
import { barOriginX, clamp01, fractionAtX } from './seek-geometry'

/** `m:ss`, or `--:--` when there is no number to show. */
export function formatTime(seconds: number | undefined): string {
  if (seconds === undefined || !Number.isFinite(seconds)) return '--:--'
  const total = Math.max(0, Math.floor(seconds))
  return `${Math.floor(total / 60)}:${(total % 60).toString().padStart(2, '0')}`
}

export interface SeekBarProps {
  /** Projected playhead, in seconds (`Progress.position`). */
  readonly position: number
  /** Total length in seconds, or `undefined` when unknown / live. */
  readonly duration: number | undefined
  /** Absolute buffered timestamp in seconds, if mpv has an estimate. */
  readonly buffered: number | undefined
  /** `Progress.isLive` — an endless stream has nothing to scrub through. */
  readonly live: boolean
  /** Set while the player has not been created yet. */
  readonly disabled?: boolean
  /** Fired once, on release, with the target position in seconds. */
  readonly onSeek: (seconds: number) => void
}

function percent(fraction: number): `${number}%` {
  return `${clamp01(fraction) * 100}%`
}

export function SeekBar({
  position,
  duration,
  buffered,
  live,
  disabled = false,
  onSeek,
}: SeekBarProps): React.JSX.Element {
  const seekable = !disabled && !live && duration !== undefined && duration > 0

  /** Fraction under the finger, `undefined` when not dragging. */
  const [scrub, setScrub] = useState<number | undefined>(undefined)
  /** Target of the seek we are still waiting for the player to reach. */
  const [pending, setPending] = useState<number | undefined>(undefined)

  /**
   * Track geometry: `width` and the track's offset inside the responder come
   * from `onLayout`, `originX` from the grant event. See `seek-geometry.ts` —
   * the page-space origin is the one offset a `View` will not tell you without
   * an async `measure`, and reconstructing it from a touch is only sound
   * because the responder's children take no touches.
   */
  const geometry = useRef({ width: 0, originX: 0, trackX: 0 })

  /**
   * The responder is built once and outlives every render, so everything it
   * needs is read through this ref rather than captured.
   */
  const latest = useRef({ duration, onSeek })
  useEffect(() => {
    latest.current = { duration, onSeek }
  })

  // Stop holding the post-release target once the player has actually moved
  // there — or after a grace period, so a seek that never lands cannot freeze
  // the display.
  useEffect(() => {
    if (pending === undefined) return undefined
    if (Math.abs(position - pending) < 1) {
      setPending(undefined)
      return undefined
    }
    const id = setTimeout(() => setPending(undefined), 1500)
    return () => clearTimeout(id)
  }, [pending, position])

  const responder = useMemo(
    () =>
      PanResponder.create({
        // Claim on touch-down: that is what turns a tap into a seek.
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        // The bar lives inside a ScrollView. Without these two the vertical
        // component of a sloppy drag hands the gesture to the scroller
        // mid-scrub and the thumb is left stranded.
        onPanResponderTerminationRequest: () => false,
        onShouldBlockNativeResponder: () => true,

        onPanResponderGrant: (event) => {
          const { pageX, locationX } = event.nativeEvent
          // Only correct because the hit area's children take no touches.
          geometry.current.originX = barOriginX(
            pageX,
            locationX,
            geometry.current.trackX
          )
          setScrub(fractionAt(pageX))
        },
        onPanResponderMove: (event) => {
          setScrub(fractionAt(event.nativeEvent.pageX))
        },
        onPanResponderRelease: (event) => {
          const fraction = fractionAt(event.nativeEvent.pageX)
          const total = latest.current.duration
          setScrub(undefined)
          if (total === undefined) return
          const target = fraction * total
          setPending(target)
          latest.current.onSeek(target)
        },
        // Cancelled (a call, a system gesture): drop the drag, seek nothing.
        onPanResponderTerminate: () => setScrub(undefined),
      }),
    []
  )

  function fractionAt(pageX: number): number {
    return fractionAtX(pageX, geometry.current)
  }

  function onLayout(event: LayoutChangeEvent): void {
    const { width, x } = event.nativeEvent.layout
    geometry.current.width = width
    // The track's offset within the hit area, so the two are free to stop
    // sharing a left edge without the mapping quietly going wrong.
    geometry.current.trackX = x
  }

  const total = duration ?? 0
  // While a finger is down the player is not allowed near the thumb; after
  // release the target holds until the seek lands. See the header comment.
  const shown = scrub !== undefined ? scrub * total : (pending ?? position)
  const playedFraction = seekable && total > 0 ? shown / total : 0
  const bufferedFraction =
    seekable && total > 0 && buffered !== undefined ? buffered / total : 0

  return (
    <View style={styles.container}>
      <View
        accessibilityRole="adjustable"
        accessibilityLabel="Seek"
        accessibilityState={{ disabled: !seekable }}
        accessibilityValue={{
          min: 0,
          max: Math.round(total),
          now: Math.round(shown),
        }}
        style={styles.hitArea}
        {...(seekable ? responder.panHandlers : {})}
      >
        {/* Transparent to touches, so the hit area is the only target and
            `locationX` means what the grant handler assumes it means. */}
        <View
          onLayout={onLayout}
          pointerEvents="none"
          style={[styles.track, !seekable && styles.trackDisabled]}
        >
          <View style={[styles.buffered, { width: percent(bufferedFraction) }]} />
          <View style={[styles.played, { width: percent(playedFraction) }]} />
          {seekable ? (
            <View
              style={[
                styles.thumb,
                scrub !== undefined && styles.thumbActive,
                { left: percent(playedFraction) },
              ]}
            />
          ) : null}
        </View>
      </View>

      <View style={styles.labels}>
        <Text style={[styles.label, scrub !== undefined && styles.labelActive]}>
          {seekable ? formatTime(shown) : formatTime(position)}
        </Text>
        {live ? (
          <View style={styles.livePill}>
            <Text style={styles.livePillText}>LIVE</Text>
          </View>
        ) : (
          <Text style={styles.label}>
            {seekable ? formatTime(total) : 'duration unknown'}
          </Text>
        )}
      </View>
    </View>
  )
}

// A slim bar suits the flat screen; the *hit area* is what stays generous.
const BAR = 4

const styles = StyleSheet.create({
  container: { alignSelf: 'stretch' },
  // Generous vertical padding: the touch target is 28pt tall, the bar is 4.
  // Horizontal padding is now safe — the track's own `layout.x` is folded into
  // the origin (see `seek-geometry.ts`) — but there is none to add.
  hitArea: { paddingVertical: SPACE.md },
  track: {
    height: BAR,
    borderRadius: BAR / 2,
    backgroundColor: COLORS.border,
    justifyContent: 'center',
    overflow: 'visible',
  },
  trackDisabled: { opacity: 0.5 },
  buffered: {
    position: 'absolute',
    left: 0,
    height: BAR,
    borderRadius: BAR / 2,
    backgroundColor: COLORS.track,
  },
  // The played fill is plain accent — its *length* is the information, and on
  // a flat screen a glow would be the only glow. Emphasis by restraint.
  played: {
    position: 'absolute',
    left: 0,
    height: BAR,
    borderRadius: BAR / 2,
    backgroundColor: COLORS.accent,
  },
  thumb: {
    position: 'absolute',
    width: 14,
    height: 14,
    borderRadius: 7,
    marginLeft: -7,
    borderWidth: 3,
    borderColor: COLORS.background,
    backgroundColor: COLORS.text,
  },
  thumbActive: { transform: [{ scale: 1.4 }] },
  labels: { flexDirection: 'row', justifyContent: 'space-between' },
  label: {
    fontSize: TYPE.caption,
    color: COLORS.muted,
    fontVariant: ['tabular-nums'],
  },
  labelActive: { fontWeight: '600', color: COLORS.accentBright },
  // The live badge as a small filled pill — cleaner than the old
  // "live · not seekable" caption, and it reads at a glance.
  livePill: {
    backgroundColor: COLORS.live,
    borderRadius: RADIUS.pill,
    paddingHorizontal: SPACE.sm,
    paddingVertical: 1,
  },
  livePillText: {
    fontSize: TYPE.micro,
    fontWeight: '800',
    letterSpacing: 0.8,
    color: COLORS.onAccent,
  },
})
