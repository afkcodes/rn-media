/**
 * Loudness normalization — ffmpeg's `loudnorm` behind one managed toggle.
 *
 * `setLoudnessNormalization` owns exactly one labelled `af` entry
 * (`@rnmedia_loudnorm:loudnorm=…`) at the tail of the chain, so it composes
 * with whatever the Equaliser section below has set — flip presets and the
 * normalizer stays; toggle the normalizer and the preset stays. That
 * coexistence is the thing this section demonstrates.
 *
 * The honest print is in the detail line: this is one-pass *dynamic*
 * normalization (the linear mode needs a prior analysis pass a live player
 * cannot run), it resamples the chain through 192 kHz, and it buffers ~3 s of
 * lookahead — so the toggle costs a short hiccup and the filter costs real
 * CPU. It exists for untagged material; for tagged files the ReplayGain
 * section above does the same job for free, and running both stacks their
 * gains — pick one.
 */
import React from 'react'
import { StyleSheet, Text } from 'react-native'
import {
  DEFAULT_LOUDNESS_TARGET_LUFS,
  toPlayerError,
  type LoudnessNormalizationOptions,
  type Player,
} from '@timbre/player'
import { COLORS, TYPE } from '../theme'
import { Chip, ChipRow, Section } from '../components/ui'

type LoudnessChoice = {
  readonly id: string
  readonly label: string
  /** `undefined` is the off switch. */
  readonly options: LoudnessNormalizationOptions | undefined
}

const CHOICES: readonly LoudnessChoice[] = [
  { id: 'off', label: 'Off', options: undefined },
  // The library default: AES TD1008's −16 LUFS for track-normalized music.
  {
    id: 'music',
    label: `Music (−${Math.abs(DEFAULT_LOUDNESS_TARGET_LUFS)})`,
    options: {},
  },
  // TD1008's speech figure — music normalized 2 LU above speech reads equal.
  { id: 'spoken', label: 'Spoken (−18)', options: { targetLufs: -18 } },
  // The loudest defensible target (Spotify/YouTube's ballpark). More gain ride
  // and more limiter engagement — audibly the most processed choice here.
  { id: 'hot', label: 'Hot (−14)', options: { targetLufs: -14 } },
]

export function LoudnessSection({
  player,
}: {
  player: Player | undefined
}): React.JSX.Element {
  const [selected, setSelected] = React.useState('off')
  const [error, setError] = React.useState<string | undefined>(undefined)

  const apply = React.useCallback(
    (choice: LoudnessChoice) => {
      if (player === undefined) return
      try {
        if (choice.options === undefined) {
          player.setLoudnessNormalization(false)
        } else {
          player.setLoudnessNormalization(true, choice.options)
        }
        setSelected(choice.id)
        setError(undefined)
      } catch (thrown) {
        const failure = toPlayerError(thrown)
        setError(`${failure.code}: ${failure.message}`)
      }
    },
    [player]
  )

  return (
    <Section title="Loudness" accessory={<Text style={styles.meta}>LUFS</Text>}>
      <ChipRow>
        {CHOICES.map((choice) => (
          <Chip
            key={choice.id}
            label={choice.label}
            active={choice.id === selected}
            disabled={player === undefined}
            onPress={() => apply(choice)}
          />
        ))}
      </ChipRow>
      {error === undefined ? null : <Text style={styles.error}>{error}</Text>}
    </Section>
  )
}

const styles = StyleSheet.create({
  meta: { fontSize: TYPE.micro, color: COLORS.muted },
  error: { fontSize: TYPE.caption, color: COLORS.error },
})
