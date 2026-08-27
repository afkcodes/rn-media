/**
 * A live spectrum of exactly this player's output.
 *
 * Off until switched on: nothing exists until the toggle mounts `useVisualizer`
 * — mpv's tap is disarmed, no ring is allocated, no sampler thread. It needs no
 * permission on either platform (the samples come from mpv, not the mic), and
 * it switches itself off when nobody can see it (`pauseWhenInactive`, on by
 * default, drops the subscription on `AppState` and the display state). The
 * diagnostics readout that used to sit here — measured fps, drop count, gain —
 * belonged to the test bed, not a music app; it is gone from the UI.
 */
import React from 'react'
import { StyleSheet, Text } from 'react-native'
import { useVisualizer, type Player } from '@afkcodes/timbre-player'
import { COLORS, TYPE } from '../theme'
import { Chip, ChipRow, Detail, Section } from './ui'
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

  // A failed subscribe leaves nothing running, so the toggle must not keep
  // claiming it is on — otherwise the button reads "Stop" over an error banner.
  React.useEffect(() => {
    if (error !== undefined) setOn(false)
  }, [error])

  const supported = player?.visualizer.capabilities?.fft === true

  return (
    <Section title="Visualizer">
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

      {supported ? null : (
        <Detail>Not supported by this build.</Detail>
      )}

      {error ? (
        <Text style={styles.error}>
          {error.code}: {error.message}
        </Text>
      ) : null}
    </Section>
  )
}

const styles = StyleSheet.create({
  error: { fontSize: TYPE.caption, color: COLORS.error },
})
