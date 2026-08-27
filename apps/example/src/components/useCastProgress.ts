/**
 * The receiver's clock, in `useProgress`'s shape — what lets the hero
 * section's scrubber and time readout follow the RECEIVER while casting.
 *
 * Without this the in-app seek bar keeps showing the local player, which is
 * deliberately paused for the whole session (found in the first on-device
 * round: "it was not able to seek" — the bar was projecting a frozen local
 * clock while the speaker played on).
 *
 * Same projection rule as everywhere: the handoff's last `mediaStatus` is a
 * position anchor `{position, at, rate}`; this hook projects from it locally
 * on a UI ticker. The ticker is screen-scoped React state — exactly the one
 * place JS timers are legal — and runs only while the receiver is advancing.
 */
import React from 'react'
import { projectReceiverPosition } from '@afkcodes/timbre-cast'
import type { Progress } from '@afkcodes/timbre-player'
import type { CastIntegration } from '../cast'

/** Re-render period while the receiver clock advances — matches `useProgress`. */
const TICK_MS = 250

export function useCastProgress(cast: CastIntegration): Progress | undefined {
  const [, bump] = React.useReducer((n: number) => n + 1, 0)
  const active = cast.controlsPlayback
  const receiver = cast.receiver

  React.useEffect(() => {
    if (!active || receiver === undefined || receiver.rate === 0) return
    const id = setInterval(bump, TICK_MS)
    return () => clearInterval(id)
  }, [active, receiver])

  if (!active || receiver === undefined) return undefined
  return {
    position: projectReceiverPosition(receiver, Date.now()),
    duration: receiver.duration,
    // The receiver does not report a buffered edge; omitting it is honest.
    buffered: undefined,
    // Live-ness stays the track's own fact — the composition root already
    // reads `track.isLive`, and the receiver's missing duration on a live
    // stream keeps the scrubber in its live presentation anyway.
    isLive: false,
  }
}
