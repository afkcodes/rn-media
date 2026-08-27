/**
 * Timbre — the reference integration, wired the simple way.
 *
 * This screen is **hooks-first**: it reads the player through `usePlayerState`
 * and `useProgress` and reads the handful of app-owned facts (queue, station,
 * errors, restore note) through `usePlayback`. It calls plain command functions
 * from `playback.ts` for everything else. There is no controller object — the
 * player, the audio session and the media session all live at module scope in
 * `playback.ts` (so they outlive this React tree, which on Android is destroyed
 * on the Back key), and this file only ever draws them.
 *
 * The one rule worth internalising: **broadcast state, never poll it.** The
 * position that moves on the lock screen is projected natively from an anchor
 * pushed on discontinuities only; nothing ticks across the bridge.
 *
 * The main screen is the **player only**: now playing, transport, and the
 * up-next queue. Everything else — cast, the equaliser, the sleep timer, and
 * the "More" bucket (visualizer, output routing, ReplayGain, loudness, the
 * `content://` probe, the car browse tree, the cast self-test) — lives behind
 * the four-button control row at the bottom, each opening a modal bottom sheet.
 * The sheets drive the exact same handlers; the features only moved behind a
 * control, and their explanatory prose moved into code comments and the docs.
 */
import React from 'react'
import { ScrollView, StatusBar, StyleSheet, Text, View } from 'react-native'
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context'
import {
  useMilestones,
  usePlayerState,
  useProgress,
  type ChapterEntry,
} from '@afkcodes/timbre-player'
import { COLORS, SPACE, TYPE } from './theme'
import * as pb from './playback'
// Transport is imported from the cast module: its routed play/pause/… drive the
// receiver while a handoff is active and the core player otherwise. Without cast
// installed, the App would import these straight from `./playback` instead.
import * as transport from './advanced/cast-wiring'
import {
  cancelSleepTimer,
  getChapters,
  getSleepTimer,
  setSleepTimer,
  setSleepTimerToTrackEnd,
} from './advanced/extras'
import { durationMs, nowPlaying, sameShell, selectShell } from './projections'
import { runCastSelfTest } from './advanced/cast-selftest'
import { AdvancedSection } from './advanced'
import { NowPlaying } from './components/NowPlaying'
import { TransportControls } from './components/TransportControls'
import { RetryBanner } from './components/RetryBanner'
import { ErrorBanner } from './components/ErrorBanner'
import { SessionErrorBanner } from './components/SessionErrorBanner'
import { QueueList } from './components/QueueList'
import { PlaybackModes } from './components/PlaybackModes'
import { CastSection } from './components/CastSection'
import { CastSelfTest } from './components/CastSelfTest'
import { useCastProgress } from './components/useCastProgress'
import { EqualizerSection } from './components/EqualizerSection'
import { VisualizerSection } from './components/VisualizerSection'
import { SleepTimerSection } from './components/SleepTimerSection'
import { PersistenceNote } from './components/PersistenceNote'
import { BottomSheet } from './components/BottomSheet'
import { FeatureBar, type FeatureSheet } from './components/FeatureBar'

function App(): React.JSX.Element {
  // App-owned facts + the player instance. Player STATE has its own subscription
  // below — this one fires only for the queue, the station line, errors and the
  // restore note, which change a handful of times per session.
  const {
    player,
    queueRows,
    queue,
    station,
    retrying,
    error,
    errorAttempts,
    sessionError,
    shuffleEnabled,
    restoreNote,
  } = pb.usePlayback()
  // Cast lives in the advanced layer; the composition root is allowed to know
  // about it (the core `playback.ts` is not). `undefined`-safe when cast is off.
  const cast = transport.useCast()

  // Which feature sheet is open, if any. The main scroll is the player; every
  // feature opens from the control row into a modal bottom sheet, and its
  // contents are mounted only while it is open (so the EQ's filter graph and
  // the visualizer's sampler cost nothing until someone reaches for them).
  const [sheet, setSheet] = React.useState<FeatureSheet | null>(null)
  const closeSheet = React.useCallback(() => setSheet(null), [])

  // Selector-scoped, not the whole snapshot: a buffered-position tick must not
  // re-render the tree. Module-level functions so their identity is stable.
  const shell = usePlayerState(player, selectShell, sameShell)
  // Its own ticker, so only the clock line and the scrubber re-render.
  const progress = useProgress(player)
  // Scrobbling the honest way: milestones ride the ticker `useProgress` already
  // runs — a timer inside the player would freeze with the screen off.
  useMilestones(player, ({ percent, index }) =>
    console.log(`[example] milestone ${String(percent)}% of entry ${String(index)}`)
  )

  // While casting the RECEIVER owns the clock: its projected anchor replaces the
  // local player's progress and the current row is the receiver's queue index —
  // so the hero, the scrubber and the notification all describe the same audio.
  const castProgress = useCastProgress(cast)
  const casting = castProgress !== undefined
  const index = cast.receiverIndex ?? shell.index

  const ready = player !== undefined
  // The queue is app state (it can be edited), so the current track is looked up
  // here, where both subscriptions have been read.
  const track = queue[index]
  // The same duration the media session gets: `undefined` on a live stream. One
  // function, so the notification and this screen cannot disagree.
  const published = casting
    ? castProgress.duration === undefined
      ? undefined
      : Math.round(castProgress.duration * 1000)
    : track === undefined
      ? undefined
      : durationMs(track, shell)
  const song = track === undefined || casting ? undefined : nowPlaying(track, shell)
  const live = track?.isLive === true || (!casting && progress.isLive)
  const playing = casting ? cast.receiver?.playing === true : shell.playing

  // Chapters are a pull, like the queue's contents: one node read when the entry
  // changes, not kept in state. Most tracks have none.
  const [chapters, setChapters] = React.useState<readonly ChapterEntry[]>([])
  React.useEffect(() => {
    setChapters(ready ? getChapters() : [])
  }, [ready, shell.index, shell.status])

  return (
    <SafeAreaView style={styles.screen}>
      <StatusBar barStyle="light-content" />
      <ScrollView
        contentContainerStyle={styles.container}
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.header}>
          <Text style={styles.kicker}>Now Playing</Text>
        </View>

        <NowPlaying
          track={track}
          shell={shell}
          progress={castProgress ?? progress}
          station={station}
          song={song}
          durationMs={published}
          live={live}
          ready={ready}
          chapters={chapters}
          onSeek={transport.seekTo}
        />

        <TransportControls
          playing={playing}
          ready={ready}
          hasNext={shell.hasNext}
          hasPrevious={shell.hasPrevious}
          onPrevious={transport.previous}
          onToggle={transport.toggle}
          onNext={transport.next}
          onSeekBy={transport.seekBy}
        />

        {/* While the player re-attempts a failed entry NO `error` event fires —
            an app that only drew the error banner would show nothing at all. */}
        <RetryBanner note={retrying} />
        <ErrorBanner
          error={error ?? shell.error}
          attempts={errorAttempts}
          onRetry={() => void pb.jumpTo(shell.index)}
          onDismiss={pb.dismissError}
        />
        {/* The media SESSION failing (a refused foreground service, a 404 cover)
            — everything above is the PLAYER failing. */}
        <SessionErrorBanner error={sessionError} onDismiss={pb.dismissSessionError} />

        <QueueList
          queue={queueRows}
          index={index}
          playing={playing}
          ready={ready}
          onJump={transport.jumpTo}
          onRemove={(i) => void pb.removeAt(i)}
          onClear={() => void pb.clearQueue()}
        />

        {/* Repeat renders from the player (`shell.loop`), shuffle from app state
            — the same two sources the broadcast projects, so this row and the
            notification cannot disagree. */}
        <PlaybackModes
          loop={shell.loop}
          shuffleEnabled={shuffleEnabled}
          ready={ready}
          onRepeatMode={pb.setRepeatMode}
          onShuffle={(enabled) => void pb.setShuffleEnabled(enabled)}
        />

        {/* The screen closes here: every feature that is not the player lives
            behind this row and opens into a modal bottom sheet. */}
        <FeatureBar ready={ready} onOpen={setSheet} />
      </ScrollView>

      {sheet === 'cast' && (
        <BottomSheet visible title="Cast" onClose={closeSheet}>
          <CastSection cast={cast} ready={ready} />
        </BottomSheet>
      )}

      {sheet === 'equalizer' && (
        <BottomSheet visible title="Equaliser" onClose={closeSheet}>
          <EqualizerSection player={player} />
        </BottomSheet>
      )}

      {sheet === 'sleep' && (
        <BottomSheet visible title="Sleep timer" onClose={closeSheet}>
          <SleepTimerSection
            ready={ready}
            getTimer={getSleepTimer}
            onArm={setSleepTimer}
            onArmTrackEnd={setSleepTimerToTrackEnd}
            onCancel={cancelSleepTimer}
          />
        </BottomSheet>
      )}

      {sheet === 'more' && (
        <BottomSheet visible title="More" onClose={closeSheet}>
          <VisualizerSection player={player} />
          <AdvancedSection player={player} shell={shell} ready={ready} />
          <CastSelfTest
            ready={ready}
            disabled={casting}
            onSelfTest={() => runCastSelfTest()}
          />
          <PersistenceNote note={restoreNote} />
        </BottomSheet>
      )}
    </SafeAreaView>
  )
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: COLORS.background },
  container: {
    paddingHorizontal: SPACE.xl,
    paddingTop: SPACE.lg,
    paddingBottom: SPACE.section * 2,
    // Whitespace is the container: one generous, uniform gap between groups is
    // the whole grouping mechanism of this card-less screen.
    gap: SPACE.section,
  },
  header: { gap: 2 },
  wordmark: {
    fontSize: TYPE.hero,
    fontWeight: '800',
    letterSpacing: -0.5,
    color: COLORS.text,
  },
  kicker: {
    fontSize: TYPE.micro,
    letterSpacing: 1.6,
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
