/**
 * Building the player, and everything that is wired to it once.
 *
 * Split out of the controller because it is the part a reader wants to copy
 * first: create → wire the audio session → subscribe → load. Four steps, in
 * that order, and the order matters (the subscription is live before the
 * playlist is loaded, so no early state is missed).
 */
import {
  Player,
  type PlayerError,
  type PlayerState,
  type Unsubscribe,
} from '@timbre/player'
import {
  AudioSessionPresets,
  wireAudioSession,
} from '@timbre/audio-session'
import { TRACKS } from '../data/tracks'
import { createDemoResolver } from './resolver'

/** What `retrying` last told us, for the banner. */
export interface RetryNote {
  readonly index: number
  readonly attempt: number
  readonly maxAttempts: number
  readonly message: string
}

export interface EngineHooks {
  /** Every reduced snapshot, in order. */
  readonly onState: (state: PlayerState) => void
  /** ICY station identity, or `undefined` when the tags carry none. */
  readonly onStation: (station: string | undefined) => void
  /** The queue's contents changed — re-read them. */
  readonly onQueueChanged: () => void
  /**
   * A retryable entry is being re-attempted, or (with `undefined`) is no longer
   * being re-attempted.
   */
  readonly onRetrying: (note: RetryNote | undefined) => void
  /**
   * An entry failed for good — after `attempts` automatic re-attempts, which is
   * `0` when nothing was retried.
   */
  readonly onFailed: (error: PlayerError, attempts: number) => void
}

export interface Engine {
  readonly player: Player
  /** Undo everything this module wired up. */
  dispose(): void
}

/**
 * Create the one mpv core this app uses and load the demo queue into it.
 *
 * @param startIndex - Entry to open on, recovered from the persisted session.
 * @throws a typed {@link PlayerError} if the core cannot be created.
 */
export async function createEngine(
  hooks: EngineHooks,
  startIndex: number
): Promise<Engine> {
  const player = await Player.create({
    volume: 0.8,
    // Two recovery layers, and they answer different questions.
    //
    // `networkReconnect` is FFmpeg's own, wired through mpv's `stream-lavf-o`:
    // native, inside libavformat's read loop, no JavaScript and no timers —
    // which is the only kind of retry that still works with the screen off. It
    // is on by default; it is named here only to widen the window a little,
    // because every entry in this queue is a network source.
    networkReconnect: { maxDelaySeconds: 8 },
    // `retry` is the layer FFmpeg cannot be: it answers "should the queue move
    // on?". mpv's own behaviour on a hard failure is to advance to the next
    // entry, which is right for a file that will never play and wrong for a
    // stream that was unlucky. There is deliberately no delay between attempts
    // — a JS-timer backoff would freeze with the screen off, which is exactly
    // when a radio app needs it. See `RetryOptions`.
    retry: { maxAttempts: 2 },
    // Open the *next* entry while the current one finishes. On by default in
    // this app because every entry here is a network source, which is the case
    // the option exists for — and because `prefetchStarted` has nothing to
    // report without it. The honest cost is written out in
    // `PlayerOptions.prefetchPlaylist`: mpv assumes you will not edit the
    // queue, so a "play next" issued after the opener has started drops the
    // prefetch in flight and that boundary opens cold. Correct either way, just
    // not gapless — and the banner shows you which happened.
    prefetchPlaylist: true,
    // Installed here rather than after `create()` so the very first entry is
    // resolved like every other one. See `resolver.ts`.
    sourceResolver: createDemoResolver(),
  })

  // Surface mpv's own warnings/errors in the JS console — the first thing to
  // check when a stream misbehaves. (Bump `logLevel` in `Player.create` to
  // 'verbose'/'debugging'/'trace' when digging deeper: 'trace' is what exposed
  // a Shoutcast server 401-ing mpv's default `libmpv` user-agent, which is why
  // the player now ships its own default UA.)
  player.on('log', (e) =>
    console.log(`[mpv:${e.level}] ${e.prefix}: ${e.text.trim()}`)
  )

  const unwireAudio = wireAudioSession(player, {
    preset: AudioSessionPresets.music,
    duckVolume: 0.3,
    resumeAfterInterruption: true,
  })

  wireEvents(player, hooks)
  const unsubscribe: Unsubscribe = player.onStateChange(hooks.onState)

  // No demuxer workaround needed: the player forces `demuxer=lavf` for
  // `.m3u8`/`.m3u` entries on its own (and only for those), so mpv's playlist
  // demuxer can't explode the queue with variant/segment entries.
  await player.loadPlaylist(
    TRACKS.map((t) => t.uri),
    { startIndex, autoPlay: false }
  )

  return {
    player,
    dispose(): void {
      unsubscribe()
      unwireAudio()
      player.destroy()
    },
  }
}

function wireEvents(player: Player, hooks: EngineHooks): void {
  // `error` now means "gave up", not "failed": with `retry` on, an entry that
  // failed and then played on the second attempt produces `retrying` and no
  // error at all. `info.attempts` is how many re-attempts it cost.
  player.on('error', (e, info) => {
    hooks.onRetrying(undefined)
    hooks.onFailed(e, info.attempts)
    console.warn(
      `[example] ${e.code}: ${e.message}` +
        (info.attempts > 0 ? ` (after ${info.attempts} attempts)` : '') +
        ` — retryable: ${e.retryable}`
    )
  })

  // The re-attempt banner. Nothing else reports this: no `error` event fires
  // while a retry is in flight, by design.
  player.on('retrying', (e) => {
    console.log(`[example] retrying #${e.index} ${e.attempt}/${e.maxAttempts}`)
    hooks.onRetrying({
      index: e.index,
      attempt: e.attempt,
      maxAttempts: e.maxAttempts,
      message: e.error.message,
    })
  })

  // The queue's *contents* moved. `reason` is honest about what the library
  // actually knows: `'resized'` comes from the observed `playlist-count`,
  // `'reordered'` is emitted by move/shuffle/unshuffle because a reorder
  // changes no observable mpv property at all.
  player.on('queueChanged', (e) => {
    console.log(`[example] queue ${e.reason} → ${e.count} entries`)
    hooks.onQueueChanged()
  })
  player.on('trackEnded', (e) => console.log(`[example] ended #${e.index}`))
  player.on('trackChanged', (e) => {
    console.log(`[example] track ${e.previousIndex} → ${e.index}`)
    // An entry that changed is an entry that is no longer being re-attempted.
    hooks.onRetrying(undefined)
  })

  // Live-stream identity. `metadataChanged` is the *event* route to mpv's tag
  // map — it fires at most once per native batch, and only while something is
  // listening, so a player nobody asks pays nothing. The now-playing *song*
  // comes from `state.title` instead (see `broadcast.ts`), because the media
  // session re-broadcasts state, not events.
  player.on('metadataChanged', (metadata) => {
    // Two routes to the same tag; `getMetadataValue` is the pull version, handy
    // when you want one key rather than the whole map.
    const song = player.getMetadataValue('icy-title')
    const parts = [
      metadata['icy-name'],
      metadata['icy-genre'],
      metadata['icy-br'] === undefined ? undefined : `${metadata['icy-br']} kbps`,
    ].filter((part): part is string => part !== undefined && part !== '')
    hooks.onStation(parts.length > 0 ? parts.join(' · ') : undefined)
    if (song !== undefined) console.log(`[example] icy-title: ${song}`)
  })

  // The typed prefetch event — not a log line being parsed. It fires when mpv's
  // opener thread is released on the next entry, which is seconds *into* the
  // current track, so seeing it is how you know a transition is going to be
  // gapless before you hear it. This log line is the raw-event route; the UI
  // banner no longer plumbs it through the controller — `usePrefetchStatus`
  // in `PrefetchBanner.tsx` is the library's own state over the same event.
  player.on('prefetchStarted', (e) => {
    console.log(`[example] prefetch: ${e.uri} (entry ${e.entryId ?? '?'})`)
  })
}
