/**
 * ReplayGain: loudness normalisation from the tags already in the file.
 *
 * Worth understanding before shipping it, because two of the three modes do
 * nothing at all on an untagged file:
 *
 * - `track` applies `REPLAYGAIN_TRACK_GAIN` — every song at the same perceived
 *   loudness, which is what a shuffle wants;
 * - `album` prefers `REPLAYGAIN_ALBUM_GAIN` and falls back to the track gain,
 *   which preserves the loudness *relationships* inside an album;
 * - `no` (mpv's default, and this app's start state) honours nothing.
 *
 * A file with no tags gets `fallback` and nothing else — mpv takes the fallback
 * branch *instead of* the tag branch. This app passes `fallback: -6` dB, which
 * is why switching modes is audible on the untagged demo entries too.
 *
 * The fallback branch is also what `no` lands in: mpv applies
 * `replaygain-fallback` whenever the tag branch is inactive, *including*
 * `replaygain=no` ("always applied if the replaygain logic is somehow
 * inactive" — mpv 0.41.0 `options.rst`). That is why `output.ts` writes
 * `fallback: 0` together with `mode: 'no'` — leaving the −6 dB in place would
 * keep every track quieter than before ReplayGain was ever touched.
 *
 * All four mpv options behind this carry `UPDATE_VOL`, so the change lands on
 * the track that is already playing: no reload, no gap.
 */
import React from 'react'
import type { ReplayGainMode } from '@afkcodes/timbre-player'
import { Chip, ChipRow, Section } from './ui'

const MODES: readonly { id: ReplayGainMode; label: string }[] = [
  { id: 'no', label: 'Off' },
  { id: 'track', label: 'Track gain' },
  { id: 'album', label: 'Album gain' },
]

export const ReplayGainToggle = React.memo(function ReplayGainToggle({
  mode,
  ready,
  onChange,
}: {
  mode: ReplayGainMode
  ready: boolean
  onChange: (mode: ReplayGainMode) => void
}): React.JSX.Element {
  return (
    <Section title="ReplayGain">
      <ChipRow>
        {MODES.map((entry) => (
          <Chip
            key={entry.id}
            label={entry.label}
            active={mode === entry.id}
            disabled={!ready}
            onPress={() => onChange(entry.id)}
          />
        ))}
      </ChipRow>
    </Section>
  )
})
