/**
 * A live spectrum of exactly this player's output.
 *
 * Three things this demonstrates that the API docs can only assert:
 *
 * 1. **It is off until you switch it on.** Nothing exists until the toggle
 *    mounts `useVisualizer`: mpv's tap is disarmed, no ring is allocated and
 *    there is no sampler thread. Flipping it back releases all of it.
 * 2. **It needs no permission, on either platform.** The samples come from mpv
 *    itself, so there is no `RECORD_AUDIO` in this app's manifest and nothing to
 *    prompt for — which is the practical difference between tapping the engine
 *    and tapping the platform.
 * 3. **It switches itself off when nobody can see it.** Lock the screen with
 *    the visualizer running and the audio keeps playing while the tap, the
 *    sampler thread and the 60 Hz re-render all stop — `useVisualizer`'s
 *    `pauseWhenInactive` (on by default) drops the subscription on `AppState`
 *    **and** the device's own display state, and takes it back on return. This
 *    app passes nothing for it; the log line below is only so the transition is
 *    visible in logcat. That default matters because the frames are **native**
 *    callbacks: unlike a JS timer they do not freeze in the background, so an
 *    ungated visualizer would spend a locked screen rendering to nobody.
 */
import React from 'react'
import { StyleSheet, Text } from 'react-native'
import { useVisualizer, type Player } from '@rn-media/player'
import { COLORS, TYPE } from '../theme'
import { Chip, ChipRow, Section } from './ui'
import {
  VISUALIZER_BANDS,
  VISUALIZER_FPS,
  VisualizerBar,
  VisualizerStage,
} from './VisualizerBars'

export function VisualizerSection({
  player,
}: {
  player: Player | undefined
}): React.JSX.Element {
  const [on, setOn] = React.useState(false)
  const { frame, error, active } = useVisualizer(
    player,
    { bands: VISUALIZER_BANDS, fps: VISUALIZER_FPS },
    on
  )

  // Measured delivery rate, accumulated in a ref during a render that was going
  // to happen anyway. Reading it is free; *rendering* it is not, which is why
  // the stats line lives in its own component below.
  const stats = React.useRef({ last: 0, fps: 0, dropped: 0, gainDb: 0, rate: 0 })
  if (frame && frame.capturedAt > stats.current.last) {
    const delta = frame.capturedAt - stats.current.last
    if (stats.current.last > 0 && delta > 0 && delta < 1000) {
      const instant = 1000 / delta
      stats.current.fps =
        stats.current.fps === 0
          ? instant
          : stats.current.fps * 0.9 + instant * 0.1
    }
    stats.current.last = frame.capturedAt
    stats.current.dropped = frame.dropped
    stats.current.gainDb = frame.gainDb
    stats.current.rate = frame.sampleRate
  }

  // A failed subscribe leaves nothing running, so the toggle must not keep
  // claiming it is on — otherwise the button reads "Stop" over an error banner.
  React.useEffect(() => {
    if (error !== undefined) setOn(false)
  }, [error])

  // One line per foreground transition while the visualizer is switched on, so
  // a lock/unlock soak can be read straight off logcat. Cheap by construction:
  // `active` changes when the subscription does, which is twice per lock cycle.
  React.useEffect(() => {
    if (!on) return
    console.log(
      `[example] visualizer: ${
        active ? 'subscribed' : 'paused — app is not in the foreground'
      }`
    )
  }, [on, active])

  const supported = player?.visualizer.capabilities?.fft === true

  return (
    <Section
      title="Visualizer"
      accessory={
        <VisualizerStats stats={stats} supported={supported} active={active} />
      }
    >
      <VisualizerStage>
        {Array.from({ length: VISUALIZER_BANDS }, (_unused, band) => (
          <VisualizerBar
            key={band}
            value={active ? (frame?.bands[band] ?? 0) : 0}
            peak={active ? (frame?.peaks[band] ?? 0) : 0}
          />
        ))}
      </VisualizerStage>

      <ChipRow>
        <Chip
          label={on ? 'Stop' : 'Start'}
          active={on}
          disabled={!supported}
          onPress={() => setOn((current) => !current)}
        />
      </ChipRow>

      {error ? (
        <Text style={styles.error}>
          {error.code}: {error.message}
        </Text>
      ) : null}
    </Section>
  )
}

/**
 * The diagnostics line, on its own 2 Hz clock.
 *
 * It is a separate component for one measured reason: a `<Text>` whose string
 * changes re-measures and re-lays-out, and doing that 30 times a second next to
 * the bars cost enough main-thread time that the native sampler started dropping
 * ticks (23.5 fps measured against 30 requested, on device). The numbers are
 * accumulated in a ref by the parent and only *read* here, twice a second — the
 * moment a diagnostic sets state at frame rate it stops measuring the problem
 * and becomes it.
 */
function VisualizerStats({
  stats,
  supported,
  active,
}: {
  stats: React.RefObject<{
    fps: number
    dropped: number
    gainDb: number
    rate: number
  }>
  supported: boolean
  active: boolean
}): React.JSX.Element {
  const [, tick] = React.useState(0)
  React.useEffect(() => {
    if (!active) return
    const id = setInterval(() => tick((n) => n + 1), 500)
    return () => clearInterval(id)
  }, [active])

  const current = stats.current
  return (
    <Text style={styles.stats}>
      {supported
        ? `${VISUALIZER_BANDS} bands · ${VISUALIZER_FPS} fps` +
          (active && current.rate > 0
            ? ` · ${current.fps.toFixed(1)} measured · ${
                current.rate / 1000
              } kHz · gain ${current.gainDb.toFixed(1)} dB` +
              (current.dropped > 0 ? ` · ${current.dropped} dropped` : '')
            : '')
        : 'needs a libmpv with the rn-media PCM tap'}
    </Text>
  )
}

const styles = StyleSheet.create({
  stats: {
    flexShrink: 1,
    textAlign: 'right',
    fontSize: TYPE.micro,
    fontVariant: ['tabular-nums'],
    color: COLORS.muted,
  },
  error: { fontSize: TYPE.caption, color: COLORS.error },
})
