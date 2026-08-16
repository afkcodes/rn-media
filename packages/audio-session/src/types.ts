import type {
  AudioInterruptionType,
  AudioRouteChangeReason,
  AudioSessionConfig,
} from './specs/audio-session.nitro'

/**
 * An interruption, as the JS layer sees it.
 *
 * This is the discriminated union from the spec doc. The bridge carries a flat
 * struct instead (`NativeInterruptionEvent`) because nitrogen cannot express a
 * string-literal discriminator; {@link narrowInterruptionEvent} is the single
 * place that converts one into the other.
 */
export type AudioSessionInterruptionEvent =
  | {
      readonly begin: true
      /** What the OS is asking us to do while the interruption lasts. */
      readonly type: AudioInterruptionType
      /**
       * `true` when the session is gone for good — Android `AUDIOFOCUS_LOSS`,
       * or an iOS media-services failure. A `begin: false` event with
       * `shouldResume: true` will never follow.
       *
       * An ordinary iOS interruption (a call, Siri, another app) is always
       * `false`: `AVAudioSession` carries no permanence information on
       * `.began`. See `NativeInterruptionEvent.permanent`.
       */
      readonly permanent: boolean
    }
  | {
      readonly begin: false
      /** `true` when the OS recommends resuming playback. */
      readonly shouldResume: boolean
    }

/** A route change, as the JS layer sees it. */
export interface AudioSessionRouteChangeEvent {
  readonly reason: AudioRouteChangeReason
}

/**
 * Payload delivered for each event name. `becomingNoisy` carries nothing —
 * `void` keeps `() => void` assignable as a listener.
 */
export interface AudioSessionEventMap {
  interruption: AudioSessionInterruptionEvent
  becomingNoisy: void
  routeChange: AudioSessionRouteChangeEvent
}

export type AudioSessionEventName = keyof AudioSessionEventMap

/** Removes the listener it was returned from. Idempotent. */
export type Unsubscribe = () => void

/**
 * The public singleton surface.
 *
 * Declared as an interface (rather than inferred from the implementation) so
 * that tests, and anyone wiring a different backend, can substitute a fake.
 */
export interface AudioSessionApi {
  /**
   * Apply an {@link AudioSessionConfig} (or a preset) to the OS session.
   *
   * Applies immediately on iOS; takes effect at the next {@link activate} on
   * Android. Configure before activating and the two agree — see
   * `RnMediaAudioSession.configure` for why the models differ.
   */
  configure(config: AudioSessionConfig): Promise<void>
  /**
   * Request the session/focus. Resolves `false` when the OS refuses — callers
   * must not start playback in that case. A rejection means the call itself was
   * wrong (or the media server is broken), never "denied"; see
   * `RnMediaAudioSession.activate` for the exact iOS error codes each side
   * takes.
   */
  activate(): Promise<boolean>
  /**
   * Release the session/focus.
   *
   * Rejects on iOS if audio is still playing (`AVAudioSessionErrorCode.isBusy`);
   * cannot reject on Android. Pause the player first.
   */
  deactivate(): Promise<void>
  /**
   * Subscribe to one of the three event streams.
   *
   * `becomingNoisy` and `routeChange` are delivered from the moment you
   * subscribe on both platforms. `interruption` additionally requires an
   * outstanding focus request on Android — see
   * `RnMediaAudioSession.addInterruptionListener`.
   */
  addListener<K extends AudioSessionEventName>(
    event: K,
    listener: (payload: AudioSessionEventMap[K]) => void
  ): Unsubscribe
}
