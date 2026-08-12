/**
 * `@rn-media` reference integration — the composition root.
 *
 * Wires all three packages together the way a real app should:
 *
 * - `@rn-media/player`      — one mpv core playing a 6-entry mpv playlist.
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
import { sameShell, selectShell } from './playback/shell'
import { formatTime } from './components/SeekBar'
import { ErrorBanner } from './components/ErrorBanner'
import { EqualizerSection } from './components/EqualizerSection'
import { NowPlaying } from './components/NowPlaying'
import { OutputControls } from './components/OutputControls'
import { PersistenceNote } from './components/PersistenceNote'
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

  const ready = player !== undefined
  // The queue is app state, not player state — it can be edited — so the
  // current track is looked up here, where both subscriptions have been read.
  const track = playback.queue[shell.index]
  // The same duration the media session gets: `undefined` for a live stream,
  // where mpv's raw `state.duration` is just how much it has cached. One
  // function, so the notification and this screen cannot disagree.
  const published = track === undefined ? undefined : durationMs(track, shell)
  const song = track === undefined ? undefined : nowPlaying(track, shell)
  const live = progress.isLive || track?.live === true
  // Chapters are a PULL, like the queue's contents: one node read, taken when
  // the entry changes rather than kept in state and pushed on every update.
  // Most entries have none, and this costs exactly one native call per track.
  const [chapters, setChapters] = React.useState<readonly ChapterEntry[]>([])
  React.useEffect(() => {
    setChapters(ready ? playback.chapters() : [])
  }, [playback, ready, shell.index, shell.status])

  return (
    <SafeAreaView style={styles.screen}>
      <StatusBar barStyle="light-content" backgroundColor={COLORS.background} />
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
          progress={progress}
          station={playback.station}
          song={song}
          durationMs={published}
          live={live}
          ready={ready}
          chapters={chapters}
          onSeek={(seconds) => playback.seekTo(seconds)}
        />

        <TransportControls
          playing={shell.playing}
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

        <PrefetchBanner
          note={playback.prefetch}
          enabled={playback.prefetchEnabled}
          ready={ready}
          onToggle={(enabled) => playback.setPrefetchEnabled(enabled)}
        />

        <QueueList
          queue={playback.queueRows}
          index={shell.index}
          playing={shell.playing}
          ready={ready}
          onJump={(index) => void playback.jumpTo(index)}
          onPlayNext={(item) => void playback.playNext(item)}
          onShuffle={() => void playback.shuffle()}
          onUnshuffle={() => void playback.unshuffle()}
          onClear={() => void playback.clearQueue()}
        />

        <OutputControls
          rate={shell.rate}
          pitch={shell.pitch}
          volume={shell.volume}
          muted={shell.muted}
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

        <EqualizerSection player={player} />

        <VisualizerSection player={player} />

        <SleepTimerSection
          ready={ready}
          getRemaining={() => playback.sleepTimerRemaining()}
          onArm={(seconds) => playback.setSleepTimer(seconds)}
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
    padding: SPACE.xl,
    paddingBottom: SPACE.xxl * 2,
    gap: SPACE.lg,
    alignItems: 'center',
  },
  header: { alignItems: 'center', gap: 2 },
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
