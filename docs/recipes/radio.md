# Recipe: a radio app

Live streams have no duration, no scrubber and no end. A server that hangs up is
not the same event as a song finishing. All three are first-class.

```ts
import { Player, type Metadata } from '@rn-media/player'
import { BaseMediaHandler, MediaService, type MediaItem } from '@rn-media/media-session'

const player = await Player.create({
  // Real Shoutcast hosts reject the literal `libmpv`, which is why the default
  // UA is `rn-media (libmpv)`. Say who you are anyway.
  userAgent: 'MyRadio/1.0 (+https://example.com)',
  cacheSecs: 30,                                 // mpv's own default is ~1000 hours
  networkReconnect: { maxDelaySeconds: 20 },     // native, inside libavformat
  retry: { maxAttempts: 3, retryLiveEof: true }, // re-attempt a polite hang-up too
})

// Three commands is the whole handler: a station has nowhere to skip to.
class Handler extends BaseMediaHandler {
  override play(): void { player.play() }
  override pause(): void { player.pause() }
  override async stop(): Promise<void> { await player.stop() }
}
const service = await MediaService.init(() => new Handler(), {
  android: { notificationChannelId: 'radio', notificationChannelName: 'Radio' },
})

await player.load(station.url)
player.play()

// The song on air. mpv folds ICY `StreamTitle` into `media-title`, so it rides
// PlayerState and reaches the notification and the lock screen.
player.onStateChange((s) => {
  const item: MediaItem = {
    id: station.id,
    title: s.title ?? station.name,   // the song, when the station sends one
    artist: s.title === undefined ? undefined : station.name,
    artworkUri: station.logoUri,
    isLive: true,                     // drops the scrubber even if a duration shows up
  }
  service.setMediaItem(item)
  service.setPlaybackState({
    status: s.playing ? 'playing' : s.status === 'buffering' ? 'buffering' : 'paused',
    position: { value: 0, at: Date.now(), rate: 0 },   // live: there is no position
    controls: [s.playing ? 'pause' : 'play', 'stop'],
    capabilities: ['play', 'pause', 'stop'],           // no 'seek' — nothing to seek to
  })
})

// The station, as opposed to the song: a separate route, opt-in because
// building the tag map is a read into mpv's core.
player.on('metadataChanged', (tags: Metadata) => {
  setStationLine(tags['icy-name'], tags['icy-genre'], tags['icy-br'])
})

// A retry is not a failure. `retrying` fires while no `error` event does.
player.on('retrying', ({ attempt, maxAttempts }) => banner(`Reconnecting ${attempt}/${maxAttempts}`))
player.on('error', (e, { attempts }) => banner(`Gave up after ${attempts}: ${e.message}`))
```

## Constraints this shape runs into

| Constraint | What to do |
|---|---|
| `state.isLive` is `true` and `state.duration` is `undefined` | mpv's growing cache length is suppressed rather than published as a duration, so a scrubber never appears and never lies. `useProgress` still works, with `duration: undefined` |
| Position `0` is the honest anchor | An offset into a live stream has nothing to seek back to, which is also why persistence saves `0` for a live entry |
| `MediaItem.isLive: true` drops the scrubber | On both platforms, even when a duration is also present |
| Reconnection is two layers | FFmpeg's native retry answers "can this connection be re-made"; the player's `retry` answers "should the queue move on". [Detail](../../packages/player/README.md#recovering-from-network-failures) |
| A clean close is not an error by default | On a finite file the clean close *is* the end of the track. `retryLiveEof: true` opts a live entry into being re-attempted |
| ICY has two routes | `state.title` is the song and rides every broadcast; `metadataChanged` is the station and only fires while something listens. [Detail](../../packages/player/README.md#two-routes-to-a-title-and-which-one-you-want) |
