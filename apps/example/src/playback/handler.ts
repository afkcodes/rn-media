/**
 * Fan-in: the single handler every remote surface funnels into.
 *
 * Notification buttons, the lock screen, a Bluetooth remote, a car head unit
 * and Google Assistant all arrive here. That is the whole contract of
 * `@timbre/media-session` — one interface, however many surfaces — and it is
 * why this file has no idea which of them called it.
 */
import {
  BaseMediaHandler,
  type BrowseItem,
  type MediaRepeatMode,
  type SearchFocus,
  type SessionError,
} from '@timbre/media-session'
import {
  assertSignedIn,
  childrenOf,
  itemFor,
  noteRecentlyPlayed,
  queueIndexFor,
  searchTracks,
} from './browse'

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
  /**
   * Stop playback, keep the session — the library's `stop` contract.
   *
   * Not the app's "stop & dismiss notification", which ends background
   * execution and is deliberately reachable only from the app's own UI.
   */
  stopPlayback(): Promise<void>
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
  /**
   * @param target the playback layer, resolved lazily — see the class docs.
   * @param onSessionError where a native failure with no caller goes. Injected
   * rather than logged here, because the point of the channel is that an app
   * can *render* the failure; this one puts it in a strip on screen.
   */
  constructor(
    private readonly target: () => PlaybackCommands,
    private readonly onError: (error: SessionError) => void
  ) {
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
    // `stopPlayback`, never the controller's `stop`: a remote stop must leave
    // the session standing so the surface keeps a play button. See
    // `Playback.stopPlayback`.
    return void this.target().stopPlayback()
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

  /**
   * The session could not do something, and there was no call to reject.
   *
   * The channel is the answer to a class of bug you cannot see from JavaScript:
   * Android refusing the foreground service (playback continues with no
   * notification and an unprotected process), a `notificationIcon` name that
   * does not resolve, a cover that 404s, an iOS `Info.plist` with no
   * `UIBackgroundModes: audio`. All of them used to be a native log line and
   * nothing else.
   *
   * This app does the two things a real app should: it draws the `fatal` ones
   * (`SessionErrorBanner`) and logs every one of them. Note what it does **not**
   * do — stop playback, or retry. Nothing here is recoverable from JS; the fix
   * is always in the app's configuration or in when it started playing.
   *
   * `super` is deliberately not called: `BaseMediaHandler.onSessionError` logs,
   * and this method already does.
   */
  override onSessionError(error: SessionError): void {
    console.warn(
      `[example] session error · ${error.severity} · ${error.code}: ${error.message}`
    )
    this.onError(error)
  }

  /* --- Android Auto / CarPlay --------------------------------------------- */

  /**
   * One screen of the car's browse tree.
   *
   * The whole tree is `src/playback/browse.ts` — data and pure functions, no
   * player — so what a car shows can be asserted in Node. This method is the
   * three lines that connect it: the sign-in simulation, the pull, the log
   * line that proves on a device that the car reached JavaScript.
   */
  override getChildren(parentId: string): Promise<BrowseItem[]> {
    this.#log(`getChildren(${parentId})`)
    assertSignedIn()
    return Promise.resolve(childrenOf(parentId))
  }

  override getMediaItem(id: string): Promise<BrowseItem | undefined> {
    this.#log(`getMediaItem(${id})`)
    assertSignedIn()
    return Promise.resolve(itemFor(id))
  }

  /**
   * A car tapped something playable.
   *
   * `jumpTo`, not a queue rebuild — see the note at the top of `browse.ts`.
   * The acknowledgement the car sees is this app's next broadcast, exactly as
   * it is for a notification play button.
   */
  override playFromMediaId(id: string): void {
    this.#log(`playFromMediaId(${id})`)
    const index = queueIndexFor(id)
    if (index === undefined) {
      // Deliberately not silent: an id the app cannot resolve is a bug in this
      // app's own tree, and a car that plays nothing looks like a broken app.
      console.warn(`[example] no queue entry for browse id "${id}"`)
      return
    }
    noteRecentlyPlayed(id)
    void this.target().jumpTo(index)
  }

  /**
   * "Play some jazz", from Assistant or the head unit's microphone.
   *
   * `focus` is what the assistant managed to classify; this app uses it to
   * narrow the substring match, and falls back to the whole query. An empty
   * query means "play something", which here is the first entry.
   */
  playFromSearch(query: string, focus: SearchFocus): void {
    this.#log(`playFromSearch("${query}", ${focus.kind})`)
    const needle = focus.artist ?? focus.album ?? focus.title ?? focus.genre ?? query
    const first = searchTracks(needle)[0]
    if (first === undefined) {
      console.warn(`[example] nothing matched the voice query "${query}"`)
      return
    }
    this.playFromMediaId(first.id)
  }

  /**
   * The car's search tab.
   *
   * Its presence is what makes the session advertise search at all — a handler
   * without this method makes Android Auto hide the tab
   * (`SEARCH_SUPPORTED=false`) rather than show one that answers nothing.
   */
  search(query: string): Promise<BrowseItem[]> {
    this.#log(`search("${query}")`)
    assertSignedIn()
    return Promise.resolve(searchTracks(query))
  }
}
