/**
 * Rate, volume and mute — the three properties every player has, and the three
 * places an app usually gets the units wrong.
 *
 * - **Rate** is mpv's `speed`, clamped by the library to mpv's documented
 *   0.01–100. It is also a *remote* command (`setRate` on the handler), so a
 *   car head unit can change it and this row will follow.
 * - **Volume** is normalised to `0..1` here, where `1` is mpv's `volume=100`,
 *   i.e. no attenuation. mpv's curve is `gain = (volume / 100) ** 3`, so 50 %
 *   is much quieter than half as loud — which is why the presets below are not
 *   evenly spaced.
 * - **Mute** is its own property, not `volume = 0`: unmuting restores the level
 *   the user chose, and the audio session's ducking (`wireAudioSession`) does
 *   read-modify-restore on volume and would fight a zero.
 */
import React from 'react'
import { StyleSheet, Text } from 'react-native'
import { COLORS, TYPE } from '../theme'
import { Chip, ChipRow, Detail, Section } from './ui'

const RATES: readonly number[] = [0.75, 1, 1.25, 1.5, 2]
const VOLUMES: readonly number[] = [0.2, 0.5, 0.8, 1]

export const OutputControls = React.memo(function OutputControls({
  rate,
  volume,
  muted,
  buffered,
  ready,
  onRate,
  onVolume,
  onToggleMute,
}: {
  rate: number
  volume: number
  muted: boolean
  /** Absolute buffered timestamp, formatted by the caller. */
  buffered: string
  ready: boolean
  onRate: (rate: number) => void
  onVolume: (volume: number) => void
  onToggleMute: () => void
}): React.JSX.Element {
  return (
    <Section
      title="Output"
      accessory={
        <Text style={styles.meta}>
          {rate}× · {Math.round(volume * 100)}%{muted ? ' · muted' : ''}
        </Text>
      }
    >
      <ChipRow>
        {RATES.map((value) => (
          <Chip
            key={value}
            label={`${value}×`}
            active={Math.abs(rate - value) < 0.001}
            disabled={!ready}
            onPress={() => onRate(value)}
          />
        ))}
      </ChipRow>

      <ChipRow>
        {VOLUMES.map((value) => (
          <Chip
            key={value}
            label={`${Math.round(value * 100)}%`}
            active={!muted && Math.abs(volume - value) < 0.005}
            disabled={!ready}
            onPress={() => onVolume(value)}
          />
        ))}
        <Chip
          label={muted ? 'Unmute' : 'Mute'}
          active={muted}
          disabled={!ready}
          onPress={onToggleMute}
        />
      </ChipRow>

      <Detail>Buffered to {buffered} — mpv's `demuxer-cache-time`, second-granular so a filling cache cannot become a ticker.</Detail>
    </Section>
  )
})

const styles = StyleSheet.create({
  meta: {
    fontSize: TYPE.micro,
    fontVariant: ['tabular-nums'],
    color: COLORS.muted,
  },
})
