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
import {
  AppState,
  Pressable,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import {
  SafeAreaProvider,
  SafeAreaView,
} from 'react-native-safe-area-context';
import {
  AudioFilters,
  EQUALIZER_BANDS,
  EQUALIZER_PRESET_LIST,
  Player,
  defineEqualizerPreset,
  equalizerPresetChain,
  toPlayerError,
  usePlayerState,
  useProgress,
  type AudioFilter,
  type EqualizerPreset,
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
  applyPersisted,
  restorePersisted,
  withPersistence,
  type MediaItem,
  type MediaSessionStorage,
  type PersistedMediaService,
  type PersistedSession,
  type PlaybackState,
} from '@rn-media/media-session';
import { createMMKV } from 'react-native-mmkv';
import { SeekBar, formatTime } from './SeekBar';
import { COLORS } from './theme';

/* -------------------------------------------------------------------------- */
/*                                  Storage                                    */
/* -------------------------------------------------------------------------- */

/**
 * Persistence storage for the media session — **an app-level choice, not the
 * library's**.
 *
 * `@rn-media/media-session` takes `{ getItem, setItem }` structurally and
 * depends on nothing; this app happens to use `react-native-mmkv` (an
 * example-only dependency) because it is *synchronous*, so a broadcast is on
 * disk before `setPlaybackState` returns — which is what makes surviving
 * `adb shell am force-stop` a certainty rather than a race. AsyncStorage
 * satisfies the same interface with two fewer lines and one more `await`.
 */
const mmkv = createMMKV({ id: 'rn-media-example' });

const sessionStorage: MediaSessionStorage = {
  getItem: key => mmkv.getString(key) ?? null,
  setItem: (key, value) => mmkv.set(key, value),
};

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
 * Deliberately different shapes, because each exercises a different part of
 * the stack:
 *
 * 1. **Icecast MP3, live** — plain chunked HTTPS, no container index.
 * 2. **HLS/AAC, live, master playlist** — three variants, AAC in MPEG-TS
 *    segments. Exercises the one thing entries 1/4/5 do not: a
 *    playlist-of-segments container, where ffmpeg (not our stream layer)
 *    fetches every segment itself, plus variant selection.
 * 3. **HLS/AAC, live, media playlist** — the *other* HLS shape: no master, the
 *    URL is the segment list directly, so there is no variant to pick. Kept
 *    alongside 2 because a build can get one right and the other wrong.
 *
 *    Both HLS entries work on Android since the libmpv pin moved to
 *    `v1.1.9-rnmedia.2` (packages/player/android/libmpv.gradle): media-kit's
 *    stock audio binaries configure ffmpeg with `--disable-demuxers` plus an
 *    allow-list that carried neither `hls` nor `mpegts`, so they used to fail
 *    with `unsupported-format` no matter what — `--enable-protocol=hls` was
 *    present, but that is the deprecated `hls://` protocol, not the demuxer.
 *    Our fork adds `--enable-demuxer=hls --enable-demuxer=mpegts` and nothing
 *    else. iOS ships the matching fork (`v0.7.2-rnmedia.2`), so both entries
 *    should work there too — CI-verified only; never run on an iOS device.
 *
 * 4. **Finite MP3, 12 s** — short enough to reach `trackEnded` while you are
 *    still looking at it, so it is what proves duration reporting and the
 *    end-of-queue path.
 * 5. **Finite AAC-in-MP4, full length** — a real commercial-CDN asset, so it
 *    covers the `mov` demuxer + `aac` decoder path that a plain `.mp3` does
 *    not, and it is long enough that the seek bar (in-app and on the lock
 *    screen) is actually usable: a 12-second track is under one thumb-width
 *    per 15 seconds of travel. Also the track the EQ presets are judged on.
 */
const TRACKS: readonly Track[] = [
  {
    id: 'diverse-fm',
    title: 'Diverse FM',
    artist: 'Diverse FM',
    album: 'Shoutcast AAC+ · live',
    // The trailing `/;` is the Shoutcast convention for "give me the stream,
    // not the status page" — verified to return `audio/aacp` with
    // `icy-name: Diverse FM`.
    uri: 'https://carol.epichosts.co.uk:8570/;',
    artworkUri:
      'https://static.mytuner.mobi/media/tvos_radios/621/diverse-fm-bollywood-music-mix.7ea30dfa.png',
    live: true,
  },
  {
    id: 'fip-hls',
    title: 'FIP',
    artist: 'Radio France',
    album: 'HLS master · AAC · live',
    uri: 'https://stream.radiofrance.fr/fip/fip.m3u8',
    live: true,
  },
  {
    id: 'vividh-bharati-hls',
    title: 'Vividh Bharati',
    artist: 'All India Radio',
    // No master playlist: this URL *is* the media playlist (`#EXTINF` +
    // `.ts` segments), so it covers the no-variant HLS path that entry 2
    // does not.
    album: 'HLS media · AAC · live',
    uri: 'https://radio.wavespb.com/live/146ed6ec6dea5a24/146ed6ec6dea5a24.m3u8',
    artworkUri:
      'https://airdco.pc.cdn.bitgravity.com/images/vividh-bharati.jpg',
    live: true,
  },
  {
    id: 'mp3-test',
    title: 'MP3 Test File',
    artist: 'Internet Archive',
    album: 'Finite · 12 s',
    uri: 'https://archive.org/download/testmp3testfile/mpthreetest.mp3',
  },
  {
    id: 'aari-aari',
    title: 'Aari Aari (Dhurandhar 2)',
    artist: 'Dhurandhar: The Revenge',
    // AAC in an MP4/M4A container, which is the shape every commercial music
    // CDN serves — so it also covers the `mov` demuxer + `aac` decoder path
    // that a plain `.mp3` does not.
    album: 'Finite · AAC/MP4 · seek + EQ test',
    uri: 'https://aac.saavncdn.com/905/f968ceef36dde517a2aee1b74e119166_160.mp4',
    artworkUri:
      'https://c.saavncdn.com/905/Dhurandhar-The-Revenge-Aari-Aari-From-Dhurandhar-The-Revenge-Hindi-2026-20260312141004-500x500.jpg',
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
    // The three collapsed slots, in `MediaButtons` terms: SLOT_BACK,
    // SLOT_CENTRAL, SLOT_FORWARD.
    //
    // The central one is a real choice, and this app deliberately does not
    // spend it on play/pause: Android's own media control already draws a
    // play/pause of its own from the `play`/`pause` *capabilities* below
    // (that is the big button top-right of the media card), so listing one
    // here too just buys a duplicate. `stop` — which ends the foreground
    // service, the one thing pause never does — is the useful thing to put
    // there instead.
    //
    // Any `MediaControl` works: `state.playing ? 'pause' : 'play'` for the
    // classic three-button transport, or `fastForward`/`rewind` (those take
    // the FORWARD/BACK slots, so they pair with dropping next/previous).
    controls: ['skipToPrevious', 'stop', 'skipToNext'],
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

/**
 * The ICY "now playing" line for a live entry, when the station sends one.
 *
 * `PlayerState.title` observes mpv's `media-title`, which resolves
 * `service_name` → `title` → `icy-title` → filename (mpv 0.35.1
 * `player/command.c`, `mp_property_media_title`). On a Shoutcast/Icecast
 * station that lands on the ICY `StreamTitle` — the song currently on air.
 * Verified on Diverse FM: `icy-title: Lata Mangeshkar & Udit Narayan - Dil To
 * Pagal Hai`, arriving ~1.7 s after the stream opened and again on every song
 * change.
 *
 * Read only for live entries, because the same chain bottoms out at the
 * *filename* for a plain file, and `SoundHelix-Song-1.mp3` is not an upgrade
 * on a curated title.
 */
function nowPlaying(track: Track, state: PlayerState): string | undefined {
  if (track.live !== true) return undefined;
  const title = state.title;
  return title !== undefined && title !== track.title ? title : undefined;
}

function toMediaItem(track: Track, state: PlayerState): MediaItem {
  const song = nowPlaying(track, state);
  return {
    id: track.id,
    // On air, the song is the headline and the station becomes the subtitle —
    // what a listener expects to read on the lock screen.
    title: song ?? track.title,
    artist: song === undefined ? track.artist : track.title,
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
    return void this.target().jumpTo(index);
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

  /**
   * The native sleep timer fired.
   *
   * Playback is **already paused** by the time this runs — natively, with no
   * Activity and no JS timer involved. This log line is the on-device proof
   * that the notification reached JavaScript
   * (`adb logcat -s ReactNativeJS`); the app does no pausing of its own.
   */
  override onSleepTimer(): void {
    this.#log('onSleepTimer (playback already paused natively)');
  }

  /**
   * This JS runtime was booted **by the media service**, after the process had
   * been killed, to finish a playback resumption the user started from the
   * System UI card / a Bluetooth remote.
   *
   * Nothing to do: the notification is already up with the persisted track, and
   * the `play` is replayed on this handler a moment later. The log line is the
   * on-device proof that the revival reached JavaScript, and is the middle link
   * in the evidence chain (`RnMediaMediaSession` logs either side of it).
   */
  override onPlaybackResumption(): void {
    this.#log('onPlaybackResumption (revived after process death)');
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
  #service: PersistedMediaService | undefined;
  #error: PlayerError | undefined;
  #startingPlayer: Promise<void> | undefined;
  #startingService: Promise<void> | undefined;
  #restoring: Promise<void> | undefined;
  /** What `restorePersisted` handed back on this launch, for the UI banner. */
  #restored: PersistedSession | undefined;
  /** Human-readable outcome of the restore, shown in the UI. */
  #restoreNote = 'not attempted';
  /** Track index to open on, recovered from the persisted session. */
  #resumeIndex: number | undefined;
  /**
   * Position to seek to once mpv has actually opened the resumed entry.
   *
   * Not `loadPlaylist({ startPosition })`: that is mpv's per-file `start`
   * option and this player applies it to *every* entry appended, so the whole
   * queue would start 1:23 in. Seeking once, when the entry is ready, resumes
   * exactly one track.
   */
  #pendingResumeMs: number | undefined;
  #unwireAudio: (() => void) | undefined;
  #unsubscribeState: (() => void) | undefined;
  /** Last broadcast discontinuity signature — see {@link #onStateChange}. */
  #lastSignature = '';
  /**
   * Published duration per track id, in ms, as the player learns them.
   *
   * Why the *queue* channel carries durations at all: on Android the media3
   * timeline — and with it the notification's seek bar — is built from the
   * queue. A queue entry with no duration is `C.TIME_UNSET`, which media3 reads
   * as "not seekable", and the scrubber then never appears however seekable the
   * playback state claims to be. Durations only exist once mpv has opened the
   * file, so the queue is re-broadcast the first time each one arrives: once
   * per track, on a discontinuity, never on a timer.
   */
  readonly #durations = new Map<string, number>();
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

  get restored(): PersistedSession | undefined {
    return this.#restored;
  }

  get restoreNote(): string {
    return this.#restoreNote;
  }

  /** Idempotent: safe to call from every mount, and from a Fast Refresh. */
  async start(): Promise<void> {
    // Before the player, so the queue can open on the entry the last process
    // died on rather than jumping to track 1 and then correcting itself.
    await (this.#restoring ??= this.#restore());
    await (this.#startingPlayer ??= this.#createPlayer());
    await this.#ensureService();
  }

  /**
   * Read back whatever the last process left behind.
   *
   * Every branch of {@link RestoreResult} is handled and none of them throws —
   * that is the point of the typed result. A first launch, an app downgrade and
   * a truncated write all land the app on the same happy path.
   */
  async #restore(): Promise<void> {
    try {
      const result = await restorePersisted(sessionStorage);
      switch (result.status) {
        case 'restored': {
          this.#restored = result.session;
          const id = result.session.mediaItem?.id;
          const index = TRACKS.findIndex(t => t.id === id);
          if (index >= 0) {
            this.#resumeIndex = index;
            const ms = result.session.playbackState?.position.value ?? 0;
            // `> 0` is the whole guard. A live entry is persisted at position
            // 0 by the session itself — it publishes no duration, which is the
            // library's live discriminator — so this app does not need its own
            // `track.live` check here, and would be wrong to trust one: the
            // authority on "is this seekable" is what was broadcast, not a
            // static flag in this file.
            if (ms > 0) this.#pendingResumeMs = ms;
          }
          const age = Math.round((Date.now() - result.session.savedAt) / 1000);
          this.#restoreNote =
            `restored "${result.session.mediaItem?.title ?? '—'}" ` +
            `@ ${formatTime(
              (result.session.playbackState?.position.value ?? 0) / 1000,
            )} ` +
            `· queue ${result.session.queue?.length ?? 0} · saved ${age}s ago`;
          console.log(
            `[example] persistence: ${this.#restoreNote}`,
            JSON.stringify(result.session.playbackState?.position),
          );
          break;
        }
        case 'empty':
          this.#restoreNote = 'nothing saved yet (first launch)';
          console.log('[example] persistence: nothing saved yet');
          break;
        case 'unsupportedVersion':
          this.#restoreNote = `saved by schema v${result.found ?? '?'}, this build reads v${result.expected}`;
          console.warn(`[example] persistence: ${this.#restoreNote}`);
          break;
        case 'corrupt':
          this.#restoreNote = `corrupt record ignored: ${result.reason}`;
          console.warn(`[example] persistence: ${this.#restoreNote}`);
          break;
      }
    } catch (cause) {
      // Only a broken storage engine reaches here — bad *data* is a result, not
      // an exception. Losing the saved session is survivable; hiding the reason
      // is not.
      this.#restoreNote = 'storage unavailable';
      console.error('[example] persistence: storage failed:', cause);
    }
  }

  /**
   * Bring the media session up if it is not up already.
   *
   * {@link stop} tears it down — that is what "stop" means here — and the
   * session contract is explicit that `init` may be called again once
   * `stopService()` has resolved. So every path that is about to make sound
   * goes through this first. Without it, playing after a stop would produce
   * audio with no notification and no remote controls forever, because
   * {@link #broadcast} drops every broadcast while `#service` is undefined and
   * nothing else ever calls {@link start} again (the mount effect runs once).
   *
   * Callers deliberately do not await it: `#createService` force-broadcasts the
   * player's current state when it resolves, so the session catches up by
   * itself rather than holding audio behind a native round trip.
   */
  #ensureService(): Promise<void> {
    return (this.#startingService ??= this.#createService());
  }

  async #createPlayer(): Promise<void> {
    try {
      const player = await Player.create({ volume: 0.8 });
      // Surface mpv's own warnings/errors in the JS console — the first thing
      // to check when a stream misbehaves. (Bump `logLevel` in `Player.create`
      // to 'verbose'/'debugging'/'trace' when digging deeper: 'trace' is what
      // exposed a Shoutcast server 401-ing mpv's default `libmpv` user-agent,
      // which is why the player now ships its own default UA.)
      player.on('log', e => console.log(`[mpv:${e.level}] ${e.prefix}: ${e.text.trim()}`));
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

      // No demuxer workaround needed: the player forces `demuxer=lavf` for
      // `.m3u8`/`.m3u` entries on its own (and only for those), so mpv's
      // playlist demuxer can't explode the queue with variant/segment entries.
      await player.loadPlaylist(
        TRACKS.map(t => t.uri),
        { startIndex: this.#resumeIndex ?? 0, autoPlay: false },
      );
    } catch (cause) {
      this.#error = toPlayerError(cause);
      console.error('[example] player start failed:', cause);
    }
    this.#notify();
  }

  async #createService(): Promise<void> {
    try {
      const api = await MediaService.init(
        () => new DemoMediaHandler(() => this),
        {
          android: {
            notificationChannelId: 'playback',
            notificationChannelName: 'Playback',
            notificationIcon: 'ic_notification',
            stopForegroundOnPause: true,
            // Deliberately far below media3's 10-minute default so the
            // demotion is observable in `dumpsys activity services` while
            // someone is watching. A shipping app would leave this alone (or
            // pick a value it can defend); this one is a test bed.
            stopForegroundTimeoutMs: 15_000,
            // Opt in to coming back from the dead. Paired with the
            // `MediaButtonReceiver` in this app's AndroidManifest.xml and with
            // `withPersistence` below — all three are required, and the
            // library logs which one is missing.
            playbackResumption: true,
          },
          onHandlerError: (method, cause) =>
            console.error(`[example] handler.${method} failed:`, cause),
        },
      );
      // One line, and every broadcast below persists itself. The library gains
      // no dependency from this — `sessionStorage` is ours.
      this.#service = withPersistence(api, sessionStorage, {
        onError: cause =>
          console.error('[example] persisting the session failed:', cause),
      });
      // Put the recovered session on every remote surface before the player has
      // anything to say. It is a *paused* state by construction, so this does
      // not start the foreground service — the notification appears on play,
      // exactly as it would without persistence.
      if (this.#restored !== undefined) {
        applyPersisted(this.#service, this.#restored);
      }
      // Channel 3. The entries never change; only their durations arrive late.
      this.#publishQueue();
      if (this.#player !== undefined) this.#broadcast(this.#player.state, true);
    } catch (cause) {
      console.error('[example] MediaService.init failed:', cause);
      // Let the next play retry: a failed init must not latch the app into a
      // permanently session-less state (`#ensureService` keys off this field).
      this.#startingService = undefined;
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
    this.#consumeResume(state);
    const track = currentTrack(state);
    const signature = [
      state.status,
      state.playing,
      state.playlist.index,
      state.playlist.count,
      // The *published* duration, not `state.duration`: on a live stream mpv's
      // raw duration is the cache length and grows forever. See `durationMs`.
      track === undefined ? undefined : durationMs(track, state),
      // The ICY now-playing line: changes once per song, so it is a genuine
      // discontinuity and not a ticker. Without it in the signature the
      // notification would keep showing whatever was on air when the station
      // was tuned in.
      track === undefined ? undefined : nowPlaying(track, state),
      state.seeking,
      state.positionAnchor.timestamp,
      state.error?.message,
    ].join('|');

    if (signature === this.#lastSignature) return;
    this.#lastSignature = signature;
    this.#broadcast(state, false);
  }

  /**
   * Seek to the restored position, once — and only once mpv has actually opened
   * the entry it belongs to.
   *
   * `autoPlay: false` means nothing is loaded at startup, so there is nothing
   * to seek *into* until the user presses play and the entry reaches `ready`.
   * The index check is what stops a resume point leaking onto a different
   * track if the user skips before pressing play.
   */
  #consumeResume(state: PlayerState): void {
    const ms = this.#pendingResumeMs;
    if (ms === undefined) return;
    if (state.status !== 'ready' || state.playlist.index !== this.#resumeIndex) {
      return;
    }
    this.#pendingResumeMs = undefined;
    console.log(`[example] persistence: resuming at ${ms} ms`);
    void this.#player?.seekTo(ms / 1000);
  }

  /** Channel 3, with whatever durations are known so far. See {@link #durations}. */
  #publishQueue(): void {
    this.#service?.setQueue(
      TRACKS.map(({ uri: _uri, live: _live, ...item }) => ({
        ...item,
        duration: this.#durations.get(item.id),
      })),
    );
  }

  #broadcast(state: PlayerState, force: boolean): void {
    const service = this.#service;
    if (service === undefined) return;
    if (force) this.#lastSignature = '';
    const track = currentTrack(state);

    // A duration we have not published yet: refresh the queue so the timeline
    // entry becomes seekable. Guarded on the value, so this is one extra
    // broadcast per track for the whole session.
    if (track !== undefined) {
      const ms = durationMs(track, state);
      if (ms !== undefined && this.#durations.get(track.id) !== ms) {
        this.#durations.set(track.id, ms);
        this.#publishQueue();
      }
    }

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
    void this.#ensureService();
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
    if (this.#player === undefined) return;
    void this.#ensureService();
    void this.#player.playlist.next();
  }

  previous(): void {
    if (this.#player === undefined) return;
    void this.#ensureService();
    void this.#player.playlist.previous();
  }

  /**
   * Tapping a queue row means "play this one".
   *
   * Two things this deliberately does that a naive `playlist.jumpTo` would not:
   *
   * 1. **Focus first.** `playlist.jumpTo` starts playback (its `autoPlay`
   *    default), so it is a sound-making call and goes through the same audio
   *    focus gate as {@link play}.
   * 2. **Never restart the entry that is already current.** mpv's
   *    `playlist-play-index` faithfully *restarts* it — which for a live
   *    stream means throwing away a warm, fully-buffered connection and paying
   *    TCP + TLS + probe again to hear exactly what was already in the cache.
   *    Measured on this device over LTE: 1.5–2.3 s to first audio for the
   *    re-open (1.1–1.5 s of it TCP+TLS alone), against 10–24 ms for the
   *    resume. A row that is *not* playable any more (errored, or ended)
   *    still gets the real jump, so this is a shortcut, never a dead end.
   */
  async jumpTo(index: number): Promise<void> {
    const player = this.#player;
    if (player === undefined) return;
    void this.#ensureService();
    if (!(await AudioSession.activate())) {
      console.warn('[example] audio focus denied — not starting');
      return;
    }
    const state = player.state;
    const alreadyOpen =
      index === state.playlist.index &&
      (state.status === 'ready' || state.status === 'buffering');
    if (alreadyOpen) player.play();
    else await player.playlist.jumpTo(index);
  }

  seekTo(seconds: number): void {
    void this.#player?.seekTo(seconds);
  }

  setRate(rate: number): void {
    this.#player?.setRate(rate);
  }

  /* --- sleep timer ------------------------------------------------------ */

  /**
   * Arm the **native** sleep timer.
   *
   * Note what is *not* here: a `setTimeout`. With the Activity destroyed, JS
   * timers stop firing, which is exactly the state a sleep timer is used in.
   * The session schedules this on the platform's own timer instead.
   */
  setSleepTimer(seconds: number): void {
    try {
      this.#service?.setSleepTimer(seconds);
      console.log(`[example] sleep timer armed for ${seconds}s`);
    } catch (cause) {
      console.warn('[example] sleep timer rejected:', cause);
    }
    this.#notify();
  }

  cancelSleepTimer(): void {
    this.#service?.cancelSleepTimer();
    console.log('[example] sleep timer cancelled');
    this.#notify();
  }

  /** Polled by the UI. Safe from JS *because the UI is on screen.* */
  sleepTimerRemaining(): number | undefined {
    return this.#service?.getSleepTimerRemaining();
  }

  /* --- persistence checkpoints ------------------------------------------ */

  /**
   * Write the session out *now*.
   *
   * The tee saves on every broadcast, and this app broadcasts only on
   * discontinuities — so a track played straight through produces no write at
   * all, and the position on disk stays wherever the last play/seek left it.
   * The library will not paper over that with a timer (a periodic save is the
   * per-tick write the whole design avoids, and the JS timer driving it would
   * freeze in the background anyway), so choosing the moment is the app's job.
   *
   * The moment this app picks is *leaving the foreground* — see the `AppState`
   * subscription below — which is the last instant it is guaranteed to run.
   */
  saveSession(): void {
    this.#service?.save();
  }

  /**
   * The only thing that ends background execution — pause never does.
   *
   * The player stays alive and so does the app; only the session goes. Clearing
   * `#startingService` is what re-arms {@link #ensureService}, so the next play
   * builds a fresh session and the notification comes back.
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
const scope = globalThis as typeof globalThis & {
  __rnMediaPlayback?: Playback;
  __rnMediaAppState?: { remove(): void };
};
const playback: Playback = (scope.__rnMediaPlayback ??= new Playback());

/**
 * Start everything **here**, at module scope — not from the `useEffect` below.
 *
 * This is what makes playback resumption possible at all. When the media
 * service revives a killed process it calls `ReactHost.start()`, which loads
 * this bundle and runs exactly this: module-scope code. It starts **no
 * surface**, so no component ever mounts and every `useEffect` in this file is
 * dead code in that process. An app whose `MediaService.init` lives in a hook
 * therefore boots a runtime that never registers a handler, the library waits,
 * logs "MediaService.init was never called", and stops the service.
 *
 * `start()` is idempotent, so the effect below is still correct — it just is
 * not the thing that matters after a kill.
 */
void playback.start();

/**
 * Checkpoint the session on the way out of the foreground.
 *
 * Module scope, not a component effect, for the same reason the player is:
 * this has to keep working after the React tree is gone. `background` is
 * emitted while the Activity is still being torn down, which is the last
 * moment JavaScript is guaranteed to run — after that the process may be
 * reclaimed with no warning, and whatever was written here is what the next
 * launch restores.
 */
scope.__rnMediaAppState ??= AppState.addEventListener('change', next => {
  if (next !== 'active') {
    playback.saveSession();
    console.log(`[example] persistence: checkpoint on "${next}"`);
  }
});

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
/*                              EQ / DSP demo                                  */
/* -------------------------------------------------------------------------- */

/**
 * What the picker offers: every tuned preset the library ships, plus two
 * entries this app builds itself to show the two escape hatches.
 *
 * `equalizerPresetChain` is what turns a curve into filters — it adds the
 * exact pre-amp needed to keep the loudest band at unity and a limiter behind
 * it, so no preset here can clip however hard it boosts.
 */
type FilterChoice = {
  readonly id: string;
  readonly label: string;
  readonly filters: readonly AudioFilter[];
};

/** A user-defined curve, exactly as an app with EQ sliders would build one. */
const CUSTOM_PRESET: EqualizerPreset = defineEqualizerPreset(
  'custom-smile',
  'Custom (smile)',
  // 31  62  125 250 500  1k   2k  4k  8k  16k
  [8, 7, 5, 2, -1, -2, -1, 2, 5, 6],
);

const FILTER_CHOICES: readonly FilterChoice[] = [
  ...EQUALIZER_PRESET_LIST.map(preset => ({
    id: preset.id,
    label: preset.name,
    filters: equalizerPresetChain(preset),
  })),
  { id: CUSTOM_PRESET.id, label: CUSTOM_PRESET.name, filters: equalizerPresetChain(CUSTOM_PRESET) },
  {
    // Not an EQ — a *measurement*. `aformat` forces the chain to one channel,
    // which mpv has to propagate to the audio output, so
    // `adb shell dumpsys audio` flips from `channelMask=0x3` (stereo) to mono.
    // That is externally observable proof that the filter chain is genuinely
    // processing samples, not merely accepted by the option parser.
    id: 'mono',
    label: 'Mono (proof)',
    filters: [AudioFilters.custom('aformat', { channel_layouts: 'mono' })],
  },
  {
    // The rest of the DSP set, none of which is an equaliser.
    id: 'headphone',
    label: 'Crossfeed + comp',
    filters: [AudioFilters.crossfeed({ strength: 0.6 }), AudioFilters.compressor()],
  },
];

/* -------------------------------------------------------------------------- */
/*                                 Sleep timer                                 */
/* -------------------------------------------------------------------------- */

/**
 * Durations offered by the demo UI.
 *
 * 45 seconds is not a plausible product choice — it is short enough to watch
 * the whole thing happen with the Activity destroyed, which is the only way to
 * prove the timer is not a JS timer.
 */
const SLEEP_TIMER_CHOICES: readonly number[] = [45, 300, 1800];

/**
 * Poll the native timer while this screen is on.
 *
 * A JS interval is the *right* tool here and nowhere else in this app: the
 * countdown only has to be correct while someone is looking at it, and while an
 * Activity is alive JS timers run normally. The timer that matters is native
 * and keeps counting whether or not this interval does.
 */
function useSleepTimerCountdown(): number | undefined {
  const [remaining, setRemaining] = React.useState<number | undefined>(
    undefined,
  );
  useEffect(() => {
    const id = setInterval(
      () => setRemaining(playback.sleepTimerRemaining()),
      500,
    );
    return () => clearInterval(id);
  }, []);
  return remaining;
}

/* -------------------------------------------------------------------------- */
/*                                    App                                      */
/* -------------------------------------------------------------------------- */

function App(): React.JSX.Element {
  const { player, error } = usePlayback();
  const state = usePlayerState(player);
  const progress = useProgress(player);
  const sleepRemaining = useSleepTimerCountdown();
  const [eqPreset, setEqPreset] = React.useState('flat');
  // What mpv says the chain is, read straight back from the `af` property.
  // Not a mirror of local state: if mpv rejected the chain (as it will on iOS
  // until the darwin binaries carry these filters) this stays on the old value,
  // and `eqError` says why.
  const [eqApplied, setEqApplied] = React.useState('');
  const [eqError, setEqError] = React.useState<string | undefined>(undefined);

  const applyEq = React.useCallback(
    (preset: FilterChoice) => {
      if (player === undefined) return;
      try {
        player.setAudioFilters(preset.filters);
        setEqPreset(preset.id);
        setEqError(undefined);
      } catch (thrown) {
        const failure = toPlayerError(thrown);
        setEqError(`${failure.code}: ${failure.message}`);
      }
      setEqApplied(player.getAudioFilters());
    },
    [player],
  );

  /* --- UI -------------------------------------------------------------- */

  const track = currentTrack(state);
  const failure = error ?? state.error;
  const ready = player !== undefined;
  // The same duration the media session gets — `undefined` for a live stream,
  // where mpv's raw `state.duration` is just how much it has cached.
  const published = track === undefined ? undefined : durationMs(track, state);
  const song = track === undefined ? undefined : nowPlaying(track, state);
  const live = progress.isLive || track?.live === true;

  return (
    <SafeAreaView style={styles.screen}>
      <StatusBar
        barStyle="light-content"
        backgroundColor={COLORS.background}
      />
      <ScrollView contentContainerStyle={styles.container}>
        <Text style={styles.kicker}>@rn-media reference integration</Text>

        <Text style={styles.title}>{track?.title ?? '—'}</Text>
        <Text style={styles.artist}>{track?.artist ?? ''}</Text>

        {/* What is actually on air right now, straight from the ICY stream. */}
        {song === undefined ? null : (
          <Text style={styles.nowPlaying}>♪ {song}</Text>
        )}

        <Text style={styles.status}>{state.status}</Text>

        <Text style={styles.time}>
          {formatTime(progress.position)} /{' '}
          {live
            ? 'live'
            : formatTime(published === undefined ? undefined : published / 1000)}
        </Text>

        {/*
          The scrubber reads the *published* duration, not `state.duration`, so
          it goes to its live presentation on exactly the entries where the
          notification drops its seek bar. `onSeek` is the same call the remote
          `seekTo` command makes — one path, one place to break.
        */}
        <SeekBar
          position={progress.position}
          duration={published === undefined ? undefined : published / 1000}
          buffered={progress.buffered}
          live={live}
          disabled={!ready}
          onSeek={seconds => playback.seekTo(seconds)}
        />

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
              onPress={() => void playback.jumpTo(index)}
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

        <View style={styles.queue}>
          <Text style={styles.detail}>
            Sleep timer (native ·{' '}
            {sleepRemaining === undefined
              ? 'off'
              : `${Math.ceil(sleepRemaining)}s left`}
            )
          </Text>
          <View style={styles.eqRow}>
            {SLEEP_TIMER_CHOICES.map(seconds => (
              <Pressable
                key={seconds}
                accessibilityRole="button"
                disabled={!ready}
                onPress={() => playback.setSleepTimer(seconds)}
                style={styles.eqChip}
              >
                <Text style={styles.eqChipLabel}>
                  {seconds < 60 ? `${seconds}s` : `${seconds / 60}m`}
                </Text>
              </Pressable>
            ))}
            <Pressable
              accessibilityRole="button"
              disabled={!ready}
              onPress={() => playback.cancelSleepTimer()}
              style={styles.eqChip}
            >
              <Text style={styles.eqChipLabel}>Cancel</Text>
            </Pressable>
          </View>
          <Text style={styles.detail}>
            Persistence · {playback.restoreNote}
          </Text>
        </View>

        <View style={styles.queue}>
          <Text style={styles.detail}>
            Equaliser · {EQUALIZER_BANDS.length}-band ({EQUALIZER_BANDS[0]} Hz –{' '}
            {(EQUALIZER_BANDS[EQUALIZER_BANDS.length - 1] as number) / 1000} kHz)
          </Text>
          <View style={styles.eqRow}>
            {FILTER_CHOICES.map(preset => (
              <Pressable
                key={preset.id}
                accessibilityRole="button"
                disabled={!ready}
                onPress={() => applyEq(preset)}
                style={[
                  styles.eqChip,
                  preset.id === eqPreset && styles.eqChipActive,
                ]}
              >
                <Text style={styles.eqChipLabel}>{preset.label}</Text>
              </Pressable>
            ))}
          </View>
          <Text style={styles.detail} selectable>
            af = {eqApplied === '' ? '(none)' : eqApplied}
          </Text>
          {eqError !== undefined ? (
            <Text style={styles.error}>{eqError}</Text>
          ) : null}
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
  screen: { flex: 1, backgroundColor: COLORS.background },
  container: { padding: 24, gap: 10, alignItems: 'center' },
  kicker: { fontSize: 13, color: COLORS.muted },
  title: {
    fontSize: 24,
    fontWeight: '600',
    textAlign: 'center',
    color: COLORS.text,
  },
  artist: { fontSize: 15, color: COLORS.muted },
  nowPlaying: {
    fontSize: 15,
    fontStyle: 'italic',
    textAlign: 'center',
    color: COLORS.accent,
  },
  status: {
    fontSize: 15,
    fontWeight: '600',
    letterSpacing: 1,
    color: COLORS.accent,
  },
  time: {
    fontSize: 22,
    fontVariant: ['tabular-nums'],
    color: COLORS.text,
  },
  detail: { fontSize: 12, color: COLORS.muted, textAlign: 'center' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 14, marginTop: 8 },
  primary: {
    paddingVertical: 14,
    paddingHorizontal: 36,
    borderRadius: 999,
    backgroundColor: COLORS.accent,
  },
  primaryLabel: { color: 'white', fontSize: 18, fontWeight: '600' },
  secondary: {
    paddingVertical: 12,
    paddingHorizontal: 18,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: COLORS.border,
    backgroundColor: COLORS.surface,
  },
  secondaryLabel: { fontSize: 15, color: COLORS.text },
  disabled: { opacity: 0.4 },
  pressed: { opacity: 0.7 },
  queue: { alignSelf: 'stretch', marginTop: 12, gap: 6 },
  eqRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, justifyContent: 'center' },
  eqChip: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: COLORS.muted,
  },
  eqChipActive: { borderColor: COLORS.text, backgroundColor: COLORS.surface },
  eqChipLabel: { fontSize: 13, color: COLORS.text },
  queueRow: {
    padding: 10,
    borderRadius: 10,
    backgroundColor: COLORS.surface,
  },
  queueRowCurrent: { backgroundColor: COLORS.surfaceActive },
  queueTitle: { fontSize: 15, fontWeight: '500', color: COLORS.text },
  queueArtist: { fontSize: 12, color: COLORS.muted },
  error: {
    marginTop: 12,
    fontSize: 13,
    color: COLORS.error,
    textAlign: 'center',
  },
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
