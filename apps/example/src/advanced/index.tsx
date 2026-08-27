/**
 * The advanced drawer — everything a *first* app does not write on day one.
 *
 * Collapsed by default so the newcomer's screen stays the common path (now
 * playing, transport, queue, EQ, cast, sleep). Open it and you get the
 * engine-tuning and platform demos: output routing (speed/pitch/volume),
 * ReplayGain and prefetch, loudness normalisation, the Android `content://`
 * probe, and the Android Auto / CarPlay browse tree. Each keeps working exactly
 * as before; it is just not what you read first.
 */
import React from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import type { Player } from '@timbre/player'
import type { ReplayGainMode } from '@timbre/player'
import { COLORS, SPACE, TYPE } from '../theme'
import type { ShellState } from '../projections'
import { invalidateBrowse, setPitchSemitones, setRate } from './extras'
// Volume routes through the cast layer so the in-app slider drives the speaker
// while casting (and the local player otherwise).
import { setVolume, toggleMuted } from './cast-wiring'
import { formatTime } from '../components/SeekBar'
import { ReplayGainToggle } from '../components/ReplayGainToggle'
import { PrefetchBanner } from '../components/PrefetchBanner'
import { OutputControls } from './OutputControls'
import { LoudnessSection } from './LoudnessSection'
import { ContentUriProbe } from './ContentUriProbe'
import { CarSection } from './CarSection'
import { OutputOptions } from './output'
import { isSignInRequired, setSignInRequired } from './browse'

export function AdvancedSection({
  player,
  shell,
  buffered,
  ready,
}: {
  player: Player | undefined
  shell: ShellState
  buffered: number | undefined
  ready: boolean
}): React.JSX.Element {
  const [open, setOpen] = React.useState(false)
  const [, bump] = React.useReducer((n: number) => n + 1, 0)

  // The player arrives after `Player.create` resolves, so read it through a ref
  // rather than capturing the first (undefined) render in the closure.
  const playerRef = React.useRef(player)
  playerRef.current = player
  const output = React.useMemo(
    () =>
      new OutputOptions({
        player: () => playerRef.current,
        onChange: bump,
        onError: bump,
      }),
    []
  )

  const [signIn, setSignIn] = React.useState(isSignInRequired())

  return (
    <View style={styles.wrap}>
      <Pressable
        accessibilityRole="button"
        onPress={() => setOpen((v) => !v)}
        style={({ pressed }) => [styles.header, pressed && styles.pressed]}
      >
        <Text style={styles.headerLabel}>Advanced</Text>
        <Text style={styles.chevron}>{open ? '−' : '+'}</Text>
      </Pressable>

      {open ? (
        <View style={styles.body}>
          <OutputControls
            rate={shell.rate}
            pitch={shell.pitch}
            volume={shell.volume}
            muted={shell.muted}
            buffered={formatTime(buffered)}
            ready={ready}
            onRate={setRate}
            onPitchSemitones={setPitchSemitones}
            onVolume={setVolume}
            onToggleMute={toggleMuted}
          />

          <ReplayGainToggle
            mode={output.replayGain}
            ready={ready}
            onChange={(mode: ReplayGainMode) => output.setReplayGain(mode)}
          />

          <PrefetchBanner
            player={player}
            enabled={output.prefetchEnabled}
            ready={ready}
            onToggle={(enabled) => output.setPrefetchEnabled(enabled)}
          />

          <LoudnessSection player={player} />

          <ContentUriProbe player={player} />

          <CarSection
            signInRequired={signIn}
            onToggleSignIn={(required) => {
              setSignInRequired(required)
              setSignIn(required)
              // A car already showing a list does not ask again on its own.
              invalidateBrowse()
            }}
          />
        </View>
      ) : null}
    </View>
  )
}

const styles = StyleSheet.create({
  wrap: { alignSelf: 'stretch', gap: SPACE.section },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: SPACE.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: COLORS.border,
  },
  headerLabel: {
    fontSize: TYPE.micro,
    fontWeight: '700',
    letterSpacing: 1.6,
    textTransform: 'uppercase',
    color: COLORS.muted,
  },
  chevron: { fontSize: TYPE.title, color: COLORS.muted },
  body: { alignSelf: 'stretch', gap: SPACE.section },
  pressed: { opacity: 0.6 },
})
