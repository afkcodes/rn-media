/**
 * Repeat & shuffle — the wave-2 media-session pair, demonstrated end to end.
 *
 * What this group actually shows is the **fan-out contract**: these chips and
 * the notification's repeat/shuffle buttons are two views of the same
 * broadcast, not two features.
 *
 * - A chip here calls the *same* controller method the notification's button
 *   reaches through `DemoMediaHandler.onSetRepeatMode`/`onSetShuffle` — one
 *   implementation per command, however many surfaces.
 * - Neither surface trusts its own tap. Repeat renders from `ShellState.loop`
 *   (the player's observed property) and shuffle from the controller's flag;
 *   the media session renders from the `repeatMode`/`shuffleEnabled` fields of
 *   the next `setPlaybackState`. Same sources, so they cannot disagree — and
 *   on Android that broadcast is literally what completes media3's pending
 *   operation and flips the notification icon.
 *
 * The honest asymmetry, stated rather than hidden: **repeat is a player mode**
 * (mpv's `loop-file`/`loop-playlist`, mapped in `broadcast.ts`), but **mpv has
 * no shuffle mode** — so shuffle-on physically reorders the playlist
 * (`playlist.shuffle`; the playing entry moves too) and shuffle-off is mpv's
 * single level of unshuffle. The toggle state is app-owned. See
 * `Playback.setShuffleEnabled`.
 */
import React from 'react'
import type { MediaRepeatMode } from '@timbre/media-session'
import type { LoopMode } from '@timbre/player'
import { loopToRepeat } from '../playback/broadcast'
import { Chip, ChipRow, Detail, Section } from './ui'

const REPEAT_MODES: readonly { id: MediaRepeatMode; label: string }[] = [
  { id: 'off', label: 'Repeat off' },
  { id: 'one', label: 'One' },
  { id: 'all', label: 'All' },
]

export const PlaybackModes = React.memo(function PlaybackModes({
  loop,
  shuffleEnabled,
  ready,
  onRepeatMode,
  onShuffle,
}: {
  /** The player's observed loop mode — repeat's single source of truth. */
  loop: LoopMode
  /** The controller's toggle — shuffle's single source of truth. */
  shuffleEnabled: boolean
  ready: boolean
  onRepeatMode: (mode: MediaRepeatMode) => void
  onShuffle: (enabled: boolean) => void
}): React.JSX.Element {
  // Render through the same projection the broadcast uses, so this row and
  // the notification icon are the same translation of the same fact.
  const repeat = loopToRepeat(loop)

  return (
    <Section title="Repeat & shuffle">
      <ChipRow>
        {REPEAT_MODES.map((mode) => (
          <Chip
            key={mode.id}
            label={mode.label}
            active={repeat === mode.id}
            disabled={!ready}
            onPress={() => onRepeatMode(mode.id)}
          />
        ))}
        <Chip
          label={shuffleEnabled ? 'Shuffle on' : 'Shuffle off'}
          active={shuffleEnabled}
          disabled={!ready}
          onPress={() => onShuffle(!shuffleEnabled)}
        />
      </ChipRow>
      <Detail>
        Also on the expanded notification — both surfaces call one handler and
        redraw from one broadcast. Repeat is mpv's own loop; shuffle really
        reorders the queue (undo is one level, mpv's limit), with the toggle
        held by the app because mpv has no shuffle mode.
      </Detail>
    </Section>
  )
})
