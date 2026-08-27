# Recipe: a podcast / audiobook player

Chapters, speed, ±30 s, a sleep timer that survives the screen going off, and
resuming exactly where the listener stopped.

```ts
import { Player } from '@afkcodes/timbre-player'
import { BaseMediaHandler, MediaService, type MediaServiceApi } from '@afkcodes/timbre-media-session'

const player = await Player.create({ rate: 1.0 })

class Handler extends BaseMediaHandler {
  override play(): void { player.play() }
  override pause(): void { player.pause() }
  override async seekTo(ms: number): Promise<void> { await player.seekTo(ms / 1000) }
  override setRate(rate: number): void { player.setRate(rate) }   // the lock-screen rate control
  override onSleepTimer(): void { clearBadge() }  // already paused — this is a notification
}

const service: MediaServiceApi = await MediaService.init(() => new Handler(), {
  jumpForwardSeconds: 30,     // both platforms; resolved natively into an absolute
  jumpBackwardSeconds: 15,    // seek, so there is no jump handler to write
  ios: { supportedPlaybackRates: [0.8, 1, 1.25, 1.5, 1.75, 2] },
  android: { notificationChannelId: 'podcast', notificationChannelName: 'Podcasts' },
})

// Resume where they stopped. `startPosition` is seconds, applied by mpv at open,
// so there is no audible jump.
await player.load(episode.url, { startPosition: progress.get(episode.id) ?? 0 })

// Chapters come from the file (m4b, chaptered MP3/Opus) and need no parsing.
const chapters = player.getChapters()            // [{ title?, start }] — start is seconds
player.on('chapterChanged', ({ index }) => setChapterUi(index))
function jumpToChapter(i: number): void { player.setChapter(i) }

// Speed is pitch-corrected and composes with everything: mpv's scaletempo2 sits
// downstream of the filter chain, and ReplayGain is volume-domain.
function setSpeed(rate: number): void { player.setRate(rate) }

// ±30 s from your own UI. seekBy is immune to projection error — use it for
// buttons rather than getPosition() + 30.
const forward = () => player.seekBy(30)
const back = () => player.seekBy(-15)

// Both sleep-timer modes run on a native timer, because a JS timer stops firing
// once the Activity is gone — which is exactly when a sleep timer matters.
service.setSleepTimer(30 * 60)      // pause in 30 minutes
service.setSleepTimerToTrackEnd()   // pause when this episode ends
service.cancelSleepTimer()

const timer = service.getSleepTimer()
if (timer?.mode === 'trackEnd') {
  // A trackEnd timer may legitimately have no number yet — a live item, or a
  // duration that has not arrived. getSleepTimerRemaining() alone cannot tell
  // that apart from "not armed"; this can.
  badge(timer.remainingSeconds ?? 'end of episode')
}

// Save the position on every discontinuity you care about, not on a tick.
player.on('seekCompleted', ({ position }) => progress.set(episode.id, position))
player.on('trackEnded', () => progress.delete(episode.id))
```

Broadcast `capabilities: ['play', 'pause', 'seek', 'setRate']` and
`controls: ['rewind', 'play', 'fastForward']` to put the ±30 s pair on the
notification and the lock screen instead of next/previous.

## Constraints this shape runs into

| Constraint | What to do |
|---|---|
| `fastForward` / `rewind` resolve natively into an absolute `seekTo` | Implement only `seekTo`. The interval is `jumpForwardSeconds` / `jumpBackwardSeconds`, 15/15 by default. [Detail](../../ARCHITECTURE.md#23-remote-surface-parity-one-jump-interval-repeatshuffle-on-both-sides-and-an-honest-metadata-table) |
| `ios.supportedPlaybackRates` has no Android twin | media3 takes an arbitrary float and draws no rate control, so there is no list to hand it |
| `getChapters()` on a file with no chapters returns `[]` | It is never an error |
| An iOS sleep timer armed over silence may never fire | iOS suspends a backgrounded process once audio stops. Armed while audio plays it fires. [Detail](../../packages/media-session/README.md#sleep-timer-native) |
