/**
 * The advanced controls — everything a *first* app does not write on day one.
 *
 * The engine-tuning and platform demos: output routing (speed/pitch/volume),
 * ReplayGain and prefetch, loudness normalisation, the Android `content://`
 * probe, and the Android Auto / CarPlay browse tree. None of it is on the main
 * screen — it lives inside the "More" sheet, behind the control row — so this
 * renders its groups directly, with no collapse of its own.
 */
import React from 'react'
import { StyleSheet, View } from 'react-native'
import type { Player } from '@timbre/player'
import type { ReplayGainMode } from '@timbre/player'
import { SPACE } from '../theme'
import type { ShellState } from '../projections'
import { invalidateBrowse, setPitchSemitones, setRate } from './extras'
// Volume routes through the cast layer so the in-app slider drives the speaker
// while casting (and the local player otherwise).
import { setVolume, toggleMuted } from './cast-wiring'
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
  ready,
}: {
  player: Player | undefined
  shell: ShellState
  ready: boolean
}): React.JSX.Element {
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
    <View style={styles.body}>
          <OutputControls
            rate={shell.rate}
            pitch={shell.pitch}
            volume={shell.volume}
            muted={shell.muted}
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
  )
}

const styles = StyleSheet.create({
  body: { alignSelf: 'stretch', gap: SPACE.section },
})
