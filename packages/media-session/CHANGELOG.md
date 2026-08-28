# @afkcodes/timbre-media-session

## 0.1.0

### Minor Changes

- Initial release. Player-agnostic media session: lock screen, notification,
  Bluetooth and remote commands, a queue, and persistence that survives process
  death — driving any player, not only timbre's. media3 `MediaSessionService` on
  Android; `MPNowPlayingInfoCenter` / `MPRemoteCommandCenter` on iOS. Android
  device-verified end to end; iOS playback and the media notification
  device-verified. Pre-1.0 — the API may still change.
