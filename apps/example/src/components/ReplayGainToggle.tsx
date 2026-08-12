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
 * All four mpv options behind this carry `UPDATE_VOL`, so the change lands on
 * the track that is already playing: no reload, no gap.
 */
import React from 'react'
import type { ReplayGainMode } from '@rn-media/player'
import { Chip, ChipRow, Detail, Section } from './ui'

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
      <Detail>
        Applied live — no reload. Untagged files fall back to −6 dB; tagged ones
        use their own gain. Clipping prevention stays on (mpv's `replaygain-clip`
        defaults to off, and the polarity in mpv 0.35's manual is stale — the
        library's TSDoc has the receipts).
      </Detail>
    </Section>
  )
})
