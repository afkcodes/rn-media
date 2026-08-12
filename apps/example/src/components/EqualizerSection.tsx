/**
 * Equaliser and DSP.
 *
 * Two escape hatches on show. `equalizerPresetChain` turns a 10-band curve into
 * a filter chain — adding the exact pre-amp needed to keep the loudest band at
 * unity plus a limiter behind it, so no preset here can clip however hard it
 * boosts. `AudioFilters.*` is the level below that, where anything ffmpeg can do
 * is one object away.
 *
 * The line under the chips is the honest part: it is mpv's `af` property read
 * *back*, not a mirror of what was clicked. If a build's ffmpeg lacks a filter,
 * the chain is rejected, this line keeps showing the old chain and the error
 * says why.
 */
import React from 'react'
import { StyleSheet, Text } from 'react-native'
import {
  AudioFilters,
  EQUALIZER_BANDS,
  EQUALIZER_PRESET_LIST,
  defineEqualizerPreset,
  equalizerPresetChain,
  toPlayerError,
  type AudioFilter,
  type EqualizerPreset,
  type Player,
} from '@rn-media/player'
import { COLORS, TYPE } from '../theme'
import { Chip, ChipRow, Detail, Section } from './ui'

type FilterChoice = {
  readonly id: string
  readonly label: string
  readonly filters: readonly AudioFilter[]
}

/** A user-defined curve, exactly as an app with EQ sliders would build one. */
const CUSTOM_PRESET: EqualizerPreset = defineEqualizerPreset(
  'custom-smile',
  'Custom (smile)',
  // 31  62  125 250 500  1k   2k  4k  8k  16k
  [8, 7, 5, 2, -1, -2, -1, 2, 5, 6]
)

const FILTER_CHOICES: readonly FilterChoice[] = [
  ...EQUALIZER_PRESET_LIST.map((preset) => ({
    id: preset.id,
    label: preset.name,
    filters: equalizerPresetChain(preset),
  })),
  {
    id: CUSTOM_PRESET.id,
    label: CUSTOM_PRESET.name,
    filters: equalizerPresetChain(CUSTOM_PRESET),
  },
  {
    // Not an EQ — a *measurement*. `aformat` forces the chain to one channel,
    // which mpv has to propagate to the audio output, so
    // `adb shell dumpsys audio` flips from `channelMask=0x3` (stereo) to mono.
    // That is externally observable proof that the filter chain is genuinely
    // processing samples, not merely accepted by the option parser.
    id: 'mono',
    label: 'Mono (proof)',
    filters: [AudioFilters.custom('aformat', { channel_layouts: 'mono' })],
  },
  {
    // The rest of the DSP set, none of which is an equaliser.
    id: 'headphone',
    label: 'Crossfeed + comp',
    filters: [
      AudioFilters.crossfeed({ strength: 0.6 }),
      AudioFilters.compressor(),
    ],
  },
]

export function EqualizerSection({
  player,
}: {
  player: Player | undefined
}): React.JSX.Element {
  const [selected, setSelected] = React.useState('flat')
  // What mpv says the chain is, read straight back from the `af` property.
  // Not a mirror of local state: if mpv rejected the chain (as it will on iOS
  // until the darwin binaries carry these filters) this stays on the old value,
  // and `error` says why.
  const [applied, setApplied] = React.useState('')
  const [error, setError] = React.useState<string | undefined>(undefined)

  const apply = React.useCallback(
    (choice: FilterChoice) => {
      if (player === undefined) return
      try {
        player.setAudioFilters(choice.filters)
        setSelected(choice.id)
        setError(undefined)
      } catch (thrown) {
        const failure = toPlayerError(thrown)
        setError(`${failure.code}: ${failure.message}`)
      }
      setApplied(player.getAudioFilters())
    },
    [player]
  )

  const first = EQUALIZER_BANDS[0]
  const last = EQUALIZER_BANDS[EQUALIZER_BANDS.length - 1] as number

  return (
    <Section
      title="Equaliser & DSP"
      accessory={
        <Text style={styles.meta}>
          {EQUALIZER_BANDS.length}-band · {first} Hz – {last / 1000} kHz
        </Text>
      }
    >
      <ChipRow>
        {FILTER_CHOICES.map((choice) => (
          <Chip
            key={choice.id}
            label={choice.label}
            active={choice.id === selected}
            disabled={player === undefined}
            onPress={() => apply(choice)}
          />
        ))}
      </ChipRow>

      <Detail selectable>af = {applied === '' ? '(none)' : applied}</Detail>
      {error === undefined ? null : <Text style={styles.error}>{error}</Text>}
    </Section>
  )
}

const styles = StyleSheet.create({
  meta: { fontSize: TYPE.micro, color: COLORS.muted },
  error: { fontSize: TYPE.caption, color: COLORS.error },
})
