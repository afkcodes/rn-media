/**
 * `@rn-media` reference integration — the composition root.
 *
 * Wires all three packages together the way a real app should:
 *
 * - `@rn-media/player`      — one mpv core playing a 7-entry mpv playlist.
 * - `@rn-media/audio-session` — focus is requested before playback, and
 *                              interruptions / headphone unplugs are handled
 *                              by `wireAudioSession`.
 * - `@rn-media/media-session` — a `MediaHandler` subclass behind every remote
 *                              surface (notification, lock screen, Bluetooth),
 *                              fed by three broadcast channels.
 *
 * The one rule worth internalising: **broadcast state, never poll it.** The
 * position that moves on the lock screen is projected natively from the anchor
 * this app pushes on discontinuities only; nothing ticks across the bridge.
 *
 * ## The screen
 *
 * Flat and card-less on purpose: whitespace groups, hairline rules, uppercase
 * micro labels, one accent. The artwork and title carry the visual weight;
 * every control is quiet. The layout is a single scroll of feature groups —
 * hero, transport, status strips, queue, modes, output, DSP, visualizer,
 * timers, persistence — one component file per group.
 *
 * ## Where everything lives
 *
 * ```
 * src/data/tracks.ts      the demo queue, and nothing else
 * src/playback/           no React: player, audio session, media session
 *   controller.ts           the commands the UI and the remotes both call
 *   engine.ts               create the player → wire audio → subscribe → load
 *   transport.ts            play/pause/skip/seek, all behind the focus gate
 *   queue.ts                mpv's queue joined to this app's metadata + its edits
 *   output.ts               engine options changeable live (ReplayGain, prefetch)
 *   session.ts              fan-out — the three broadcast channels
 *   handler.ts              fan-in — every remote surface funnels here
 *   broadcast.ts            PlayerState → media-session shapes (pure)
 *   shell.ts                PlayerState → what this screen draws (pure)
 *   persistence.ts          storage + the typed restore result
 *   resolver.ts             demo:// → real URLs
 *   index.ts                the process-scoped instance + `usePlayback`
 * src/components/         one file per surface, self-contained
 * ```
 *
 * The split is not decoration: everything under `src/playback/` keeps working
 * after the React tree is gone, which on Android is every time the user presses
 * Back. See the header of `controller.ts`.
 */
import React from 'react'
import { ScrollView, StatusBar, StyleSheet, Text, View } from 'react-native'
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context'
import {
  useMilestones,
  usePlayerState,
  useProgress,
  type ChapterEntry,
} from '@rn-media/player'
import { COLORS, SPACE, TYPE } from './theme'
import { usePlayback } from './playback'
import { durationMs, nowPlaying } from './playback/broadcast'
import { runCastSelfTest } from './playback/cast-selftest'
import { sameShell, selectShell } from './playback/shell'
import { formatTime } from './components/SeekBar'
import { CastSection } from './components/CastSection'
import { useCastProgress } from './components/useCastProgress'
import { ErrorBanner } from './components/ErrorBanner'
import { EqualizerSection } from './components/EqualizerSection'
import { LoudnessSection } from './components/LoudnessSection'
import { NowPlaying } from './components/NowPlaying'
import { OutputControls } from './components/OutputControls'
import { PersistenceNote } from './components/PersistenceNote'
import { PlaybackModes } from './components/PlaybackModes'
import { PrefetchBanner } from './components/PrefetchBanner'
import { RetryBanner } from './components/RetryBanner'
import { QueueList } from './components/QueueList'
import { ReplayGainToggle } from './components/ReplayGainToggle'
import { SleepTimerSection } from './components/SleepTimerSection'
import { TransportControls } from './components/TransportControls'
import { VisualizerSection } from './components/VisualizerSection'

function App(): React.JSX.Element {
  const { player, playback } = usePlayback()
  // Selector-scoped, not the whole snapshot: see `playback/shell.ts`. The
  // selector and its comparison are module-level functions so their identities
  // are stable across renders — an inline arrow here would rebuild the
  // subscription every time and defeat the memoisation inside the hook.
  const shell = usePlayerState(player, selectShell, sameShell)
  // Its own ticker, so only the clock line and the scrubber re-render.
  const progress = useProgress(player)
  // Scrobbling, the honest way: milestones are a HOOK, not a player feature,
  // because a mid-track time event needs a tick and this design has none — a
  // timer inside the player would freeze with the screen off. This one rides
  // the ticker `useProgress` already runs and starts nothing of its own.
  useMilestones(player, ({ percent, index }) => {
    console.log(`[example] milestone ${String(percent)}% of entry ${String(index)}`)
  })

  // While casting the RECEIVER owns the clock: its anchor (projected on a UI
  // ticker) replaces the local player's progress, and the current row is the
  // receiver's reconciled queue index — so the hero, the scrubber and the
  // notification all describe the same playback, which is the §3 contract.
  const castProgress = useCastProgress(playback)
  const casting = castProgress !== undefined
  const index = playback.cast.receiverIndex ?? shell.index

  const ready = player !== undefined
  // The queue is app state, not player state — it can be edited — so the
  // current track is looked up here, where both subscriptions have been read.
  const track = playback.queue[index]
  // The same duration the media session gets: `undefined` for a live stream,
  // where mpv's raw `state.duration` is just how much it has cached. One
  // function, so the notification and this screen cannot disagree. While
  // casting, the receiver's duration is that number.
  const published = casting
    ? castProgress.duration === undefined
      ? undefined
      : Math.round(castProgress.duration * 1000)
    : track === undefined
      ? undefined
      : durationMs(track, shell)
  const song =
    track === undefined || casting ? undefined : nowPlaying(track, shell)
  const live = track?.isLive === true || (!casting && progress.isLive)
  // Chapters are a PULL, like the queue's contents: one node read, taken when
  // the entry changes rather than kept in state and pushed on every update.
  // Most entries have none, and this costs exactly one native call per track.
  const [chapters, setChapters] = React.useState<readonly ChapterEntry[]>([])
  React.useEffect(() => {
    setChapters(ready ? playback.chapters() : [])
  }, [playback, ready, shell.index, shell.status])

  return (
    <SafeAreaView style={styles.screen}>
      {/*
        No `backgroundColor`: React Native 0.87 removed the prop (it was a
        no-op under the edge-to-edge display that Android 15+ enforces for
        targetSdk 35+). The status bar takes the window background instead,
        which `styles.screen` already paints with the same COLORS.background.
      */}
      <StatusBar barStyle="light-content" />
      <ScrollView
        contentContainerStyle={styles.container}
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.header}>
          <Text style={styles.wordmark}>rn-media</Text>
          <Text style={styles.kicker}>reference integration</Text>
        </View>

        <NowPlaying
          track={track}
          shell={shell}
          progress={castProgress ?? progress}
          station={playback.station}
          song={song}
          durationMs={published}
          live={live}
          ready={ready}
          chapters={chapters}
          onSeek={(seconds) => playback.seekTo(seconds)}
        />

        <TransportControls
          playing={casting ? playback.cast.receiver?.playing === true : shell.playing}
          ready={ready}
          hasNext={shell.hasNext}
          hasPrevious={shell.hasPrevious}
          onPrevious={() => playback.previous()}
          onToggle={() => playback.toggle()}
          onNext={() => playback.next()}
          onSeekBy={(delta) => playback.seekBy(delta)}
          onStop={() => void playback.stop()}
        />

        {/* While the player is re-attempting a failed entry, NO `error` event
            fires — an app that only drew the banner below would show nothing at
            all while a stream reconnects. */}
        <RetryBanner note={playback.retrying} />

        {/* `retryable` comes from the error itself; this screen keeps no table
            of which codes are worth retrying. `Dismiss` calls
            `player.clearError()`, which clears STATE only — the event already
            fired and is already in the log. */}
        <ErrorBanner
          error={playback.error ?? shell.error}
          attempts={playback.errorAttempts}
          onRetry={() => void playback.jumpTo(shell.index)}
          onDismiss={() => playback.dismissError()}
        />

        {/* The banner's state IS the library's `usePrefetchStatus` hook — the
            app wires no events and keeps no note. See the component header. */}
        <PrefetchBanner
          player={player}
          enabled={playback.prefetchEnabled}
          ready={ready}
          onToggle={(enabled) => playback.setPrefetchEnabled(enabled)}
        />

        <QueueList
          queue={playback.queueRows}
          index={index}
          playing={casting ? playback.cast.receiver?.playing === true : shell.playing}
          ready={ready}
          onJump={(index) => void playback.jumpTo(index)}
          onPlayNext={(item) => void playback.playNext(item)}
          onAddLast={(item) => void playback.addLast(item)}
          onRemove={(index) => void playback.removeAt(index)}
          onClear={() => void playback.clearQueue()}
        />

        {/* Cast is a URL handoff to a second, remote player behind the same
            broadcast channels: while casting, the transport above and the
            notification both steer the RECEIVER, because the controller
            forwards every command to whichever backend owns playback. */}
        <CastSection
          cast={playback.cast}
          queue={playback.queue}
          ready={ready}
          onSelfTest={() => runCastSelfTest(playback)}
        />

        {/* Repeat renders from the player (`shell.loop`), shuffle from the
            controller — the same two sources the media-session broadcast
            projects, so this row and the notification cannot disagree. */}
        <PlaybackModes
          loop={shell.loop}
          shuffleEnabled={playback.shuffleEnabled}
          ready={ready}
          onRepeatMode={(mode) => playback.setRepeatMode(mode)}
          onShuffle={(enabled) => void playback.setShuffleEnabled(enabled)}
        />

        {/* While casting, the volume row shows and drives the SPEAKER's
            device volume — the controller routes `setVolume` to whichever
            output owns playback, and this reads the matching fact back. */}
        <OutputControls
          rate={shell.rate}
          pitch={shell.pitch}
          volume={
            casting
              ? (playback.cast.deviceVolume?.volume ?? shell.volume)
              : shell.volume
          }
          muted={
            casting ? playback.cast.deviceVolume?.muted === true : shell.muted
          }
          buffered={formatTime(progress.buffered)}
          ready={ready}
          onRate={(rate) => playback.setRate(rate)}
          onPitchSemitones={(semitones) =>
            playback.setPitchSemitones(semitones)
          }
          onVolume={(volume) => playback.setVolume(volume)}
          onToggleMute={() => playback.toggleMuted()}
        />

        <ReplayGainToggle
          mode={playback.replayGain}
          ready={ready}
          onChange={(mode) => playback.setReplayGain(mode)}
        />

        {/* Deliberately adjacent to ReplayGain: both level loudness, and the
            section copy says why an app should ship one of them, not both. */}
        <LoudnessSection player={player} />

        <EqualizerSection player={player} />

        <VisualizerSection player={player} />

        <SleepTimerSection
          ready={ready}
          getTimer={() => playback.sleepTimer()}
          onArm={(seconds) => playback.setSleepTimer(seconds)}
          onArmTrackEnd={() => playback.setSleepTimerToTrackEnd()}
          onCancel={() => playback.cancelSleepTimer()}
        />

        <PersistenceNote note={playback.restoreNote} />
      </ScrollView>
    </SafeAreaView>
  )
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: COLORS.background },
  container: {
    paddingHorizontal: SPACE.xl,
    paddingTop: SPACE.lg,
    paddingBottom: SPACE.section * 2,
    // Whitespace is the container: one generous, uniform gap between groups
    // is the whole grouping mechanism of this card-less screen.
    gap: SPACE.section,
  },
  header: { gap: 2 },
  wordmark: {
    fontSize: TYPE.label,
    fontWeight: '800',
    letterSpacing: 3,
    textTransform: 'uppercase',
    color: COLORS.text,
  },
  kicker: {
    fontSize: TYPE.micro,
    letterSpacing: 1.2,
    textTransform: 'uppercase',
    color: COLORS.muted,
  },
})

/** `SafeAreaProvider` has to sit above anything using the insets. */
export default function Root(): React.JSX.Element {
  return (
    <SafeAreaProvider>
      <App />
    </SafeAreaProvider>
  )
}
