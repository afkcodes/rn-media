/**
 * `@rn-media` reference integration.
 *
 * Wires all three packages together the way a real app should:
 *
 * - `@rn-media/player`      — one mpv core playing a 3-entry mpv playlist.
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
 */
import React, { useEffect, useReducer } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import {
  SafeAreaProvider,
  SafeAreaView,
} from 'react-native-safe-area-context';
import {
  Player,
  toPlayerError,
  usePlayerState,
  useProgress,
  type PlayerError,
  type PlayerState,
} from '@rn-media/player';
import {
  AudioSession,
  AudioSessionPresets,
  wireAudioSession,
} from '@rn-media/audio-session';
import {
  BaseMediaHandler,
  MediaService,
  type MediaItem,
  type MediaServiceApi,
  type PlaybackState,
} from '@rn-media/media-session';

/* -------------------------------------------------------------------------- */
/*                                  The queue                                  */
/* -------------------------------------------------------------------------- */

interface Track extends MediaItem {
  /** What the player loads. Kept out of `MediaItem`, which is metadata only. */
  readonly uri: string;
  /**
   * Endless stream with no meaningful total length.
   *
   * This is the app's own, *static* knowledge. The player now works this out on
   * its own — `PlayerState.isLive` is `true` once mpv reports `seekable = no`,
   * and `duration` is suppressed there — so this flag is only a head start for
   * the window before mpv has published seekability.
   *
   * Why either matters: on an Icecast stream mpv reports a `duration` equal to
   * how much it has *cached*, so it grows several times a second forever.
   * Broadcasting that would turn the media session into a ticker — the exact
   * thing the position anchor exists to avoid — and would draw a seek bar whose
   * end keeps running away from the listener.
   */
  readonly live?: boolean;
}

/**
 * Public HTTPS endpoints, so this runs on a clean device with no fixtures.
 *
 * Three deliberately different shapes, because each exercises a different part
 * of the stack:
 *
 * 1. **Icecast MP3, live** — plain chunked HTTPS, no container index.
 * 2. **HLS/AAC, live** — a master playlist with three variants.
 *
 *    KNOWN GAP, kept here on purpose: this entry **fails** with
 *    `unsupported-format` on the pinned prebuilt libmpv. The
 *    `libmpv-android-audio-build` binaries configure ffmpeg with
 *    `--disable-demuxers` plus an explicit allow-list that contains neither
 *    `hls` nor `mpegts` (the configure line is readable with
 *    `strings libmpv.so`), so neither the HLS demuxer nor the deprecated
 *    `hls+https://` protocol can work. TLS itself is fine — entry 1 is HTTPS.
 *    Supporting HLS needs a libmpv rebuild with
 *    `--enable-demuxer=hls --enable-demuxer=mpegts`.
 *
 * 3. **Finite MP3** — the only entry with a real duration, and therefore what
 *    proves `trackEnded`, duration reporting and the end-of-queue path.
 */
const TRACKS: readonly Track[] = [
  {
    id: 'groove-salad',
    title: 'Groove Salad',
    artist: 'SomaFM',
    album: 'Icecast MP3 · live',
    uri: 'https://ice1.somafm.com/groovesalad-128-mp3',
    live: true,
  },
  {
    id: 'fip-hls',
    title: 'FIP',
    artist: 'Radio France',
    album: 'HLS · AAC · unsupported by this libmpv build',
    uri: 'https://stream.radiofrance.fr/fip/fip.m3u8',
    live: true,
  },
  {
    id: 'mp3-test',
    title: 'MP3 Test File',
    artist: 'Internet Archive',
    album: 'Finite track',
    uri: 'https://archive.org/download/testmp3testfile/mpthreetest.mp3',
  },
];

/* -------------------------------------------------------------------------- */
/*                             Player → broadcast                              */
/* -------------------------------------------------------------------------- */

/** `PlayerStatus` (+ intent) collapsed onto the media-session vocabulary. */
function toMediaStatus(state: PlayerState): PlaybackState['status'] {
  switch (state.status) {
    case 'idle':
    case 'ended':
      return 'stopped';
    case 'loading':
    case 'buffering':
      return 'buffering';
    case 'ready':
      return state.playing ? 'playing' : 'paused';
    case 'error':
      return 'error';
  }
}

/**
 * Turn a `PlayerState` snapshot into a broadcast.
 *
 * `positionAnchor` is seconds + `Date.now()`; the media session wants
 * milliseconds. `rate` is forced to `0` unless audio is genuinely advancing, so
 * the native projection freezes instead of drifting while buffering or paused.
 */
function toPlaybackState(state: PlayerState): PlaybackState {
  const status = toMediaStatus(state);
  const advancing = status === 'playing' && !state.seeking;

  return {
    status,
    position: {
      value: Math.round(state.positionAnchor.position * 1000),
      at: state.positionAnchor.timestamp,
      rate: advancing ? state.positionAnchor.rate : 0,
    },
    bufferedPosition:
      state.bufferedPosition === undefined
        ? undefined
        : Math.round(state.bufferedPosition * 1000),
    controls: ['skipToPrevious', state.playing ? 'pause' : 'play', 'skipToNext'],
    capabilities: [
      'play',
      'pause',
      'stop',
      'seek',
      'skipToNext',
      'skipToPrevious',
      'skipToQueueItem',
    ],
    // All three transport buttons fit the collapsed notification.
    compactControlIndices: [0, 1, 2],
    queueIndex: state.playlist.index,
    errorMessage: state.error?.message,
  };
}

/** Metadata for the entry mpv is currently on. */
function currentTrack(state: PlayerState): Track | undefined {
  return TRACKS[state.playlist.index];
}

/**
 * Duration to publish for `track`, in ms — `undefined` for anything live.
 *
 * Rounded to whole seconds so that a jittering estimate cannot, by itself,
 * produce a stream of broadcasts. See {@link Track.live}.
 */
function durationMs(track: Track, state: PlayerState): number | undefined {
  if (track.live === true || state.isLive || state.duration === undefined) {
    return undefined;
  }
  return Math.round(state.duration) * 1000;
}

function toMediaItem(track: Track, state: PlayerState): MediaItem {
  return {
    id: track.id,
    title: track.title,
    artist: track.artist,
    album: track.album,
    // Omitting duration is what tells the lock screen to render a live
    // indicator rather than a seek bar to nowhere.
    duration: durationMs(track, state),
  };
}

/* -------------------------------------------------------------------------- */
/*                                  Fan-in                                     */
/* -------------------------------------------------------------------------- */

/**
 * The single handler every remote surface funnels into.
 *
 * It resolves the {@link Playback} lazily rather than capturing it:
 * `MediaService.init` builds the handler once, at a moment when the player
 * behind it may still be starting.
 *
 * The `console.log` in each method is deliberate — it is how you confirm on a
 * real device that a notification button reached JavaScript
 * (`adb logcat -s ReactNativeJS`).
 */
class DemoMediaHandler extends BaseMediaHandler {
  constructor(private readonly target: () => Playback) {
    super();
  }

  #log(name: string): void {
    console.log(`[example] remote command: ${name}`);
  }

  override play(): void {
    this.#log('play');
    return void this.target().play();
  }
  override pause(): void {
    this.#log('pause');
    this.target().pause();
  }
  override stop(): void {
    this.#log('stop');
    return void this.target().stop();
  }
  override seekTo(position: number): void {
    this.#log('seekTo');
    this.target().seekTo(position / 1000);
  }
  override skipToNext(): void {
    this.#log('skipToNext');
    this.target().next();
  }
  override skipToPrevious(): void {
    this.#log('skipToPrevious');
    this.target().previous();
  }
  override skipToQueueItem(index: number): void {
    this.#log('skipToQueueItem');
    this.target().jumpTo(index);
  }
  override setRate(rate: number): void {
    this.#log('setRate');
    this.target().setRate(rate);
  }

  /**
   * The app was swiped out of Recents. The native default policy (keep playing
   * while playing, stop otherwise) has already been applied; this is only the
   * notification of it.
   */
  override onTaskRemoved(): void {
    this.#log('onTaskRemoved');
  }
}

/* -------------------------------------------------------------------------- */
/*                        Playback: owned outside React                        */
/* -------------------------------------------------------------------------- */

/**
 * The player, the audio session and the media session all live here, at module
 * scope, and that is the single most important thing in this file.
 *
 * On Android the JS runtime outlives the Activity — but the React tree does
 * not. Destroying the Activity calls `ReactHost.stopSurface`, which unmounts
 * every component. Anything a hook owns goes with it: `usePlayer` would destroy
 * the mpv core in its cleanup, and a `MediaService.init` effect would tear the
 * session down, so pressing Back would silently end background playback while
 * the notification was still on screen. (Measured: session went
 * `PLAYING → STOPPED` on the Back key when this was hook-owned.)
 *
 * Hooks are right for a screen-scoped player. A media app's player is
 * process-scoped, so it is created once, here, and React only ever reads it.
 */
class Playback {
  #player: Player | undefined;
  #service: MediaServiceApi | undefined;
  #error: PlayerError | undefined;
  #startingPlayer: Promise<void> | undefined;
  #startingService: Promise<void> | undefined;
  #unwireAudio: (() => void) | undefined;
  #unsubscribeState: (() => void) | undefined;
  /** Last broadcast discontinuity signature — see {@link #onStateChange}. */
  #lastSignature = '';
  readonly #listeners = new Set<() => void>();

  get player(): Player | undefined {
    return this.#player;
  }

  get error(): PlayerError | undefined {
    return this.#error;
  }

  /** Re-render notification for the UI. Nothing else depends on it. */
  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #notify(): void {
    for (const listener of this.#listeners) listener();
  }

  /** Idempotent: safe to call from every mount, and from a Fast Refresh. */
  async start(): Promise<void> {
    await (this.#startingPlayer ??= this.#createPlayer());
    await (this.#startingService ??= this.#createService());
  }

  async #createPlayer(): Promise<void> {
    try {
      const player = await Player.create({ volume: 0.8 });
      this.#player = player;

      this.#unwireAudio = wireAudioSession(player, {
        preset: AudioSessionPresets.music,
        duckVolume: 0.3,
        resumeAfterInterruption: true,
      });

      player.on('error', e => console.warn(`[example] ${e.code}: ${e.message}`));
      player.on('trackEnded', e => console.log(`[example] ended #${e.index}`));
      player.on('trackChanged', e =>
        console.log(`[example] track ${e.previousIndex} → ${e.index}`),
      );

      this.#unsubscribeState = player.onStateChange(state => {
        this.#onStateChange(state);
        this.#notify();
      });

      await player.loadPlaylist(
        TRACKS.map(t => t.uri),
        {
          startIndex: 0,
          autoPlay: false,
          mpvOptions: {
            // Force libavformat. Left to itself mpv hands a `.m3u8` to its own
            // *playlist* demuxer, which parses the master playlist as a plain
            // m3u and appends every variant — and then every media playlist's
            // `.ts` segments — as new queue entries, so a 3-entry queue became
            // 23 and HLS never played. A media app owns its own queue, so
            // losing playlist-file expansion costs nothing.
            'demuxer': 'lavf',
          },
        },
      );
    } catch (cause) {
      this.#error = toPlayerError(cause);
      console.error('[example] player start failed:', cause);
    }
    this.#notify();
  }

  async #createService(): Promise<void> {
    try {
      this.#service = await MediaService.init(
        () => new DemoMediaHandler(() => this),
        {
          android: {
            notificationChannelId: 'playback',
            notificationChannelName: 'Playback',
            notificationIcon: 'ic_notification',
            stopForegroundOnPause: true,
          },
          onHandlerError: (method, cause) =>
            console.error(`[example] handler.${method} failed:`, cause),
        },
      );
      // Channel 3. The queue never changes here, so it is broadcast once.
      this.#service.setQueue(TRACKS.map(({ uri: _uri, live: _live, ...m }) => m));
      if (this.#player !== undefined) this.#broadcast(this.#player.state, true);
    } catch (cause) {
      console.error('[example] MediaService.init failed:', cause);
    }
    this.#notify();
  }

  /**
   * Channels 1 and 2, driven off the player rather than off a React effect.
   *
   * Broadcast only when a *discontinuity* signature changes. `PlayerState` also
   * carries `bufferedPosition`, which mpv updates several times a second; keying
   * on the whole snapshot would put the media session back on a timer, which is
   * exactly what the position anchor exists to avoid. (Measured: ~6 broadcasts
   * per second before this, 4 in 22 s after.) The buffered figure still rides
   * along with the next real change.
   */
  #onStateChange(state: PlayerState): void {
    const track = currentTrack(state);
    const signature = [
      state.status,
      state.playing,
      state.playlist.index,
      state.playlist.count,
      // The *published* duration, not `state.duration`: on a live stream mpv's
      // raw duration is the cache length and grows forever. See `durationMs`.
      track === undefined ? undefined : durationMs(track, state),
      state.seeking,
      state.positionAnchor.timestamp,
      state.error?.message,
    ].join('|');

    if (signature === this.#lastSignature) return;
    this.#lastSignature = signature;
    this.#broadcast(state, false);
  }

  #broadcast(state: PlayerState, force: boolean): void {
    const service = this.#service;
    if (service === undefined) return;
    if (force) this.#lastSignature = '';
    const track = currentTrack(state);
    service.setMediaItem(track && toMediaItem(track, state));
    service.setPlaybackState(toPlaybackState(state));
  }

  /* --- transport ------------------------------------------------------- */

  /**
   * Audio focus is requested before every play. That is the app's job by
   * design: `wireAudioSession` handles what happens *after* focus is lost, but
   * only the app knows when it is about to make sound.
   */
  async play(): Promise<void> {
    const player = this.#player;
    if (player === undefined) return;
    if (await AudioSession.activate()) player.play();
    else console.warn('[example] audio focus denied — not starting');
  }

  pause(): void {
    this.#player?.pause();
  }

  toggle(): void {
    if (this.#player?.state.playing === true) this.pause();
    else void this.play();
  }

  next(): void {
    void this.#player?.playlist.next();
  }

  previous(): void {
    void this.#player?.playlist.previous();
  }

  jumpTo(index: number): void {
    void this.#player?.playlist.jumpTo(index);
  }

  seekTo(seconds: number): void {
    void this.#player?.seekTo(seconds);
  }

  setRate(rate: number): void {
    this.#player?.setRate(rate);
  }

  /**
   * The only thing that ends background execution — pause never does. Leaves
   * the player alive so `start()` can bring the session back.
   */
  async stop(): Promise<void> {
    this.pause();
    const service = this.#service;
    this.#service = undefined;
    this.#startingService = undefined;
    try {
      await service?.stopService();
    } finally {
      await AudioSession.deactivate();
      this.#notify();
    }
  }

  /** Not called by the UI — here so the teardown path is written down. */
  async dispose(): Promise<void> {
    await this.stop();
    this.#unsubscribeState?.();
    this.#unwireAudio?.();
    this.#player?.destroy();
    this.#player = undefined;
    this.#startingPlayer = undefined;
    this.#notify();
  }
}

/**
 * Parked on `globalThis` so a Fast Refresh of this module reuses the running
 * player and session instead of building a second one on top of them.
 */
const scope = globalThis as typeof globalThis & { __rnMediaPlayback?: Playback };
const playback: Playback = (scope.__rnMediaPlayback ??= new Playback());

/** Start playback infrastructure on first mount; re-render on its changes. */
function usePlayback(): { player: Player | undefined; error: PlayerError | undefined } {
  const [, bump] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    void playback.start();
    return playback.subscribe(bump);
  }, []);
  return { player: playback.player, error: playback.error };
}

/* -------------------------------------------------------------------------- */
/*                                    App                                      */
/* -------------------------------------------------------------------------- */

function formatTime(seconds: number | undefined): string {
  if (seconds === undefined || !Number.isFinite(seconds)) return '--:--';
  const total = Math.max(0, Math.floor(seconds));
  return `${Math.floor(total / 60)}:${(total % 60).toString().padStart(2, '0')}`;
}

function App(): React.JSX.Element {
  const { player, error } = usePlayback();
  const state = usePlayerState(player);
  const progress = useProgress(player);

  /* --- UI -------------------------------------------------------------- */

  const track = currentTrack(state);
  const failure = error ?? state.error;
  const ready = player !== undefined;
  // The same duration the media session gets — `undefined` for a live stream,
  // where mpv's raw `state.duration` is just how much it has cached.
  const published = track === undefined ? undefined : durationMs(track, state);

  return (
    <SafeAreaView style={styles.screen}>
      <ScrollView contentContainerStyle={styles.container}>
        <Text style={styles.kicker}>@rn-media reference integration</Text>

        <Text style={styles.title}>{track?.title ?? '—'}</Text>
        <Text style={styles.artist}>{track?.artist ?? ''}</Text>

        <Text style={styles.status}>{state.status}</Text>

        <Text style={styles.time}>
          {formatTime(progress.position)} /{' '}
          {progress.isLive || track?.live === true
            ? 'live'
            : formatTime(published === undefined ? undefined : published / 1000)}
        </Text>

        <Text style={styles.detail}>
          track {state.playlist.index + 1} of {state.playlist.count} · buffered{' '}
          {formatTime(progress.buffered)} · {state.rate}× · vol{' '}
          {Math.round(state.volume * 100)}%{state.muted ? ' · muted' : ''}
        </Text>

        <View style={styles.row}>
          <Pressable
            accessibilityRole="button"
            disabled={!ready}
            onPress={() => playback.previous()}
            style={styles.secondary}
          >
            <Text style={styles.secondaryLabel}>◀◀</Text>
          </Pressable>

          <Pressable
            accessibilityRole="button"
            disabled={!ready}
            onPress={() => playback.toggle()}
            style={({ pressed }) => [
              styles.primary,
              !ready && styles.disabled,
              pressed && styles.pressed,
            ]}
          >
            <Text style={styles.primaryLabel}>
              {state.playing ? 'Pause' : 'Play'}
            </Text>
          </Pressable>

          <Pressable
            accessibilityRole="button"
            disabled={!ready}
            onPress={() => playback.next()}
            style={styles.secondary}
          >
            <Text style={styles.secondaryLabel}>▶▶</Text>
          </Pressable>
        </View>

        <View style={styles.queue}>
          {TRACKS.map((item, index) => (
            <Pressable
              key={item.id}
              accessibilityRole="button"
              disabled={!ready}
              onPress={() => playback.jumpTo(index)}
              style={[
                styles.queueRow,
                index === state.playlist.index && styles.queueRowCurrent,
              ]}
            >
              <Text style={styles.queueTitle}>
                {index + 1}. {item.title}
              </Text>
              <Text style={styles.queueArtist}>{item.album}</Text>
            </Pressable>
          ))}
        </View>

        <Pressable
          accessibilityRole="button"
          disabled={!ready}
          onPress={() => void playback.stop()}
          style={styles.secondary}
        >
          <Text style={styles.secondaryLabel}>
            Stop &amp; dismiss notification
          </Text>
        </Pressable>

        {failure ? (
          <Text style={styles.error}>
            {failure.code}: {failure.message}
          </Text>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  container: { padding: 24, gap: 10, alignItems: 'center' },
  kicker: { fontSize: 13, opacity: 0.5 },
  title: { fontSize: 24, fontWeight: '600', textAlign: 'center' },
  artist: { fontSize: 15, opacity: 0.7 },
  status: { fontSize: 15, fontWeight: '600', opacity: 0.8, letterSpacing: 1 },
  time: { fontSize: 22, fontVariant: ['tabular-nums'] },
  detail: { fontSize: 12, opacity: 0.7, textAlign: 'center' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 14, marginTop: 8 },
  primary: {
    paddingVertical: 14,
    paddingHorizontal: 36,
    borderRadius: 999,
    backgroundColor: '#1f6feb',
  },
  primaryLabel: { color: 'white', fontSize: 18, fontWeight: '600' },
  secondary: {
    paddingVertical: 12,
    paddingHorizontal: 18,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: '#8888',
  },
  secondaryLabel: { fontSize: 15 },
  disabled: { opacity: 0.4 },
  pressed: { opacity: 0.7 },
  queue: { alignSelf: 'stretch', marginTop: 12, gap: 6 },
  queueRow: { padding: 10, borderRadius: 10, backgroundColor: '#8881' },
  queueRowCurrent: { backgroundColor: '#1f6feb22' },
  queueTitle: { fontSize: 15, fontWeight: '500' },
  queueArtist: { fontSize: 12, opacity: 0.6 },
  error: { marginTop: 12, fontSize: 13, color: '#d1242f', textAlign: 'center' },
});

/** `SafeAreaProvider` has to sit above anything using the insets. */
function Root(): React.JSX.Element {
  return (
    <SafeAreaProvider>
      <App />
    </SafeAreaProvider>
  );
}

export default Root;
