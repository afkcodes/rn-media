/**
 * Chromecast — a **self-contained advanced module**. Most apps never ship this,
 * so none of it lives in the core `playback.ts`; the everyday transport there
 * drives the local player and knows nothing about a receiver.
 *
 * This module bolts cast onto that clean core through three small, generic seams
 * the core exposes (`setHandlerDecorator`, `setBroadcastSuspended` +
 * `forceBroadcast`, `subscribe`) plus its plain getters — and it is wired in by
 * a bare import in `index.js`, not by the core. What it provides:
 *
 * 1. **Fan-in** — while a handoff is active, a notification / lock-screen button
 *    must steer the RECEIVER. It decorates the media handler so those commands
 *    route to the receiver when `cast.owns`, and fall through to the core (the
 *    local player) otherwise. The core handler stays cast-free.
 * 2. **Fan-out** — while casting, the receiver's state rides the SAME three
 *    channels every surface already reads (§3). It suspends the core's local
 *    broadcast and publishes the receiver's anchor instead.
 * 3. **Receiver transport for the UI** — routed `play/pause/next/…` the demo's
 *    own controls call, cast-or-local by the same `cast.owns` rule.
 */
import React from 'react'
import { CompositeMediaHandler, type MediaHandler } from '@timbre/media-session'
import type { CastReceiverSnapshot } from '@timbre/cast'
import { CastIntegration } from '../cast'
import { toCastMediaItem, toCastPlaybackState } from '../cast-broadcast'
import type { Track } from '../data/tracks'
import {
  forceBroadcast,
  getPlayer,
  getQueue,
  getService,
  play as coreResume,
  pause as corePause,
  toggle as coreToggle,
  next as coreNext,
  previous as corePrevious,
  jumpTo as coreJumpTo,
  seekTo as coreSeekTo,
  seekBy as coreSeekBy,
  setVolume as coreSetVolume,
  toggleMuted as coreToggleMuted,
  setBroadcastSuspended,
  setHandlerDecorator,
  subscribe,
} from '../playback'

/* --- the cast integration ------------------------------------------------- */

export const cast = new CastIntegration({
  player: () => getPlayer(),
  queue: () => getQueue(),
  resume: () => coreResume(), // a transfer-back is a sound-starting event → focus gate
  onReceiverState: (snapshot) => {
    if (snapshot === undefined) {
      // Casting over: take channels 1–2 back and repaint from the local player,
      // which has been silent (and un-broadcast) for the whole session.
      setBroadcastSuspended(false)
      lastCastItem = ''
      forceBroadcast()
    } else {
      // The receiver owns channels 1–2; the local player is deliberately paused.
      setBroadcastSuspended(true)
      const track =
        snapshot.itemIndex === undefined ? undefined : getQueue()[snapshot.itemIndex]
      publishCast(snapshot, track)
    }
    notifyCast()
  },
  // Tell the session the audio is on the speaker — what puts the phone's hardware
  // volume keys on it with the screen locked.
  onRemoteVolume: (volume) =>
    getService()?.setRemotePlayback(
      volume === undefined
        ? undefined
        : {
            volume: Math.max(0, Math.min(1, volume.volume)),
            muted: volume.muted,
            // Holds a silent local output so a locked-screen key press keeps
            // landing on this app (bug #53). On because this app demos at full
            // capability; a real app weighs it against idle battery.
            holdLocalAudioSlot: true,
          }
    ),
  onChange: () => notifyCast(),
})

/** While casting, the receiver drives channels 1–2 through the same setters. */
let lastCastItem = ''
function publishCast(snapshot: CastReceiverSnapshot, track: Track | undefined): void {
  const service = getService()
  if (service === undefined) return
  // The ITEM channel changes only on track boundaries; a receiver status arrives
  // every few seconds and each is a position discontinuity, so the state always
  // goes out but the item does not re-send metadata every surface already has.
  const itemSig = `${track?.id ?? ''}|${String(snapshot.duration)}|${String(snapshot.itemIndex)}`
  if (itemSig !== lastCastItem) {
    lastCastItem = itemSig
    service.setMediaItem(track === undefined ? undefined : toCastMediaItem(track, snapshot))
  }
  service.setPlaybackState(toCastPlaybackState(snapshot))
}

/* --- fan-in: the handler decorator ---------------------------------------- */

/**
 * Wraps the core media handler: while a handoff owns playback, transport routes
 * to the receiver; otherwise it falls through to the core (the local player).
 * `CompositeMediaHandler` forwards everything else — browse, sleep, errors —
 * untouched, and preserves the inner handler's search capabilities.
 */
class CastAwareHandler extends CompositeMediaHandler {
  override play(): void | Promise<void> {
    if (cast.owns) return void cast.play()
    return super.play()
  }
  override pause(): void | Promise<void> {
    if (cast.owns) return cast.pause()
    return super.pause()
  }
  override stop(): void | Promise<void> {
    if (cast.owns) return cast.pause() // a remote stop while casting pauses the receiver
    return super.stop()
  }
  override seekTo(ms: number): void | Promise<void> {
    if (cast.owns) return cast.seekTo(ms / 1000)
    return super.seekTo(ms)
  }
  override skipToNext(): void | Promise<void> {
    if (cast.owns) return void cast.next()
    return super.skipToNext()
  }
  override skipToPrevious(): void | Promise<void> {
    if (cast.owns) return void cast.previous()
    return super.skipToPrevious()
  }
  override skipToQueueItem(index: number): void | Promise<void> {
    if (cast.owns) return void cast.jumpTo(index)
    return super.skipToQueueItem(index)
  }
  override onSetDeviceVolume(volume: number): void | Promise<void> {
    if (cast.owns) return cast.setVolume(volume)
    return super.onSetDeviceVolume(volume)
  }
  override onSetDeviceMuted(muted: boolean): void | Promise<void> {
    if (cast.owns) return cast.setMuted(muted)
    return super.onSetDeviceMuted(muted)
  }
}

// Registered at module scope (this file is a bare import in index.js), so the
// decorator is in place before the core builds the session. The seam is generic
// (`MediaHandler` in, `MediaHandler` out) — the core never names cast.
setHandlerDecorator((inner: MediaHandler): MediaHandler => new CastAwareHandler(inner))

// A queue edit while casting must reload the receiver's projection. The core
// notifies on every queue change; the integration's fingerprint guard makes this
// a no-op unless the contents actually moved.
subscribe(() => cast.onQueueChanged())

// Framework init is not on the critical path: it resolves 'unavailable' where
// casting cannot work, and the section renders that honestly.
void cast.start()

/* --- fan-out helper + UI reactivity --------------------------------------- */

const castListeners = new Set<() => void>()
function notifyCast(): void {
  for (const listener of castListeners) listener()
}

/** Re-render on cast state changes (phase, devices, receiver). Returns the cast. */
export function useCast(): CastIntegration {
  const [, bump] = React.useReducer((n: number) => n + 1, 0)
  React.useEffect(() => {
    castListeners.add(bump)
    return () => void castListeners.delete(bump)
  }, [])
  return cast
}

/* --- receiver transport for the UI: cast-or-local by the same rule -------- */

export function play(): void {
  if (cast.owns) return void cast.play()
  void coreResume()
}
export function pause(): void {
  if (cast.owns) return cast.pause()
  corePause()
}
export function toggle(): void {
  if (cast.owns) return cast.toggle()
  coreToggle()
}
export function next(): void {
  if (cast.owns) return cast.next()
  coreNext()
}
export function previous(): void {
  if (cast.owns) return cast.previous()
  corePrevious()
}
export function jumpTo(index: number): void {
  if (cast.owns) return cast.jumpTo(index)
  void coreJumpTo(index)
}
export function seekTo(seconds: number): void {
  if (cast.owns) return cast.seekTo(seconds)
  coreSeekTo(seconds)
}
export function seekBy(deltaSeconds: number): void {
  if (cast.owns) return cast.seekBy(deltaSeconds)
  coreSeekBy(deltaSeconds)
}
export function setVolume(volume: number): void {
  if (cast.owns) return cast.setVolume(volume)
  coreSetVolume(volume)
}
export function toggleMuted(): void {
  if (cast.owns) return cast.toggleMuted()
  coreToggleMuted()
}
