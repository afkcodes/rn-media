/**
 * Fan-in: the single handler every remote surface funnels into.
 *
 * Notification buttons, the lock screen, a Bluetooth remote, a car head unit
 * and Google Assistant all arrive here. That is the whole contract of
 * `@rn-media/media-session` — one interface, however many surfaces — and it is
 * why this file has no idea which of them called it.
 */
import { BaseMediaHandler, type MediaRepeatMode } from '@rn-media/media-session'

/**
 * What the handler needs from the app's playback layer.
 *
 * Declared here rather than importing the controller so the dependency points
 * one way: `controller.ts` imports this file, this file imports nothing of it.
 * In a bigger app this interface is also the seam a test uses to drive the
 * handler with no player at all.
 */
export interface PlaybackCommands {
  play(): Promise<void>
  pause(): void
  stop(): Promise<void>
  seekTo(seconds: number): void
  next(): void
  previous(): void
  jumpTo(index: number): Promise<void>
  setRate(rate: number): void
  setRepeatMode(mode: MediaRepeatMode): void
  setShuffleEnabled(enabled: boolean): Promise<void>
  /** `0..1`, routed to whichever output owns playback. */
  setVolume(volume: number): void
  setMuted(muted: boolean): void
}

/**
 * The handler this app installs.
 *
 * It resolves its target lazily rather than capturing it: `MediaService.init`
 * builds the handler once, at a moment when the player behind it may still be
 * starting.
 *
 * The `console.log` in each method is deliberate — it is how you confirm on a
 * real device that a notification button reached JavaScript
 * (`adb logcat -s ReactNativeJS`).
 */
export class DemoMediaHandler extends BaseMediaHandler {
  constructor(private readonly target: () => PlaybackCommands) {
    super()
  }

  #log(name: string): void {
    console.log(`[example] remote command: ${name}`)
  }

  override play(): void {
    this.#log('play')
    return void this.target().play()
  }
  override pause(): void {
    this.#log('pause')
    this.target().pause()
  }
  override stop(): void {
    this.#log('stop')
    return void this.target().stop()
  }
  override seekTo(position: number): void {
    this.#log('seekTo')
    this.target().seekTo(position / 1000)
  }
  override skipToNext(): void {
    this.#log('skipToNext')
    this.target().next()
  }
  override skipToPrevious(): void {
    this.#log('skipToPrevious')
    this.target().previous()
  }
  override skipToQueueItem(index: number): void {
    this.#log('skipToQueueItem')
    return void this.target().jumpTo(index)
  }
  override setRate(rate: number): void {
    this.#log('setRate')
    this.target().setRate(rate)
  }

  /**
   * The notification's repeat button. **A request, not a fact**: nothing on
   * any surface changes until the app writes the loop mode and the resulting
   * state snapshot is re-broadcast carrying the new `repeatMode` — on Android
   * that broadcast is literally what completes media3's pending operation and
   * flips the icon. The controller's `setRepeatMode` is that write.
   */
  override onSetRepeatMode(mode: MediaRepeatMode): void {
    this.#log(`onSetRepeatMode(${mode})`)
    this.target().setRepeatMode(mode)
  }

  /**
   * The shuffle button, same acknowledgement contract as
   * {@link onSetRepeatMode}. In this app "shuffle on" is a real reorder of
   * mpv's playlist (see `Playback.setShuffleEnabled` for the honest caveats),
   * so the toggle is also reachable from a car head unit — which is the point
   * of routing it through the one handler.
   */
  override onSetShuffle(enabled: boolean): void {
    this.#log(`onSetShuffle(${String(enabled)})`)
    return void this.target().setShuffleEnabled(enabled)
  }

  /**
   * The **remote device's** volume, asked for by a surface that speaks levels.
   *
   * Two things arrive here and both matter. One is the system's remote volume
   * slider (the panel Android draws while a session reports remote playback).
   * The other is a **hardware volume key press with this app in the background
   * or the screen locked** — the library turned the notch into a level using
   * the range the app published through `MediaService.setRemotePlayback`.
   * Neither is reachable without that publish, which is the whole point: an
   * Activity's `dispatchKeyEvent` cannot run when there is no Activity.
   *
   * `Playback.setVolume` routes by output ownership, so this lands on
   * `Cast.setDeviceVolume` while the receiver is playing. The acknowledgement
   * is the receiver's own `deviceVolume` event coming back and being
   * republished — the same request/acknowledge contract as every other command
   * here.
   */
  override onSetDeviceVolume(volume: number): void {
    this.#log(`onSetDeviceVolume(${volume.toFixed(2)})`)
    this.target().setVolume(volume)
  }

  /** Mute/unmute the remote device. See {@link onSetDeviceVolume}. */
  override onSetDeviceMuted(muted: boolean): void {
    this.#log(`onSetDeviceMuted(${String(muted)})`)
    this.target().setMuted(muted)
  }

  /**
   * The app was swiped out of Recents. The native default policy (keep playing
   * while playing, stop otherwise) has already been applied; this is only the
   * notification of it.
   */
  override onTaskRemoved(): void {
    this.#log('onTaskRemoved')
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
    this.#log('onSleepTimer (playback already paused natively)')
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
    this.#log('onPlaybackResumption (revived after process death)')
  }
}
