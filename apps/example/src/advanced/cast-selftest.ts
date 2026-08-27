/**
 * The scripted on-device cast verification — cast.md §5's checklist as a
 * button.
 *
 * This app is the on-device test bed, and casting is the one feature whose
 * acceptance evidence needs real hardware on a real LAN: discovery, a session
 * on a physical receiver, a queue handoff, receiver-side transport, and the
 * transfer back. This module runs that sequence programmatically, logs every
 * step under a greppable tag (`adb logcat -s ReactNativeJS | grep cast-test`),
 * and returns a one-line verdict the Cast section displays.
 *
 * Deliberately allowed to use JS timers: a self-test is user-initiated and
 * foreground — the one place timers are legal in this codebase.
 */
import { Cast } from '@timbre/cast'
import { cast, getPlayer, jumpTo, pause, play, seekTo } from '../playback'

const TAG = '[cast-test]'

export interface CastSelfTestResult {
  readonly ok: boolean
  readonly summary: string
  readonly lines: readonly string[]
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitFor(
  what: string,
  predicate: () => boolean,
  timeoutMs: number
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await sleep(250)
  }
  throw new Error(`timed out waiting for ${what} (${String(timeoutMs)} ms)`)
}

/**
 * Full programmatic session test:
 * discovery → requestSession → CONNECTING→CONNECTED → queue handoff →
 * receiver PLAYING with an advancing position (two reads) → pause/play/seek →
 * a live-entry jump and back (the live queue leg) →
 * endSession({transferBackToLocal:true}) → local resumes at the receiver's
 * position. Audible confirmation stays with the owner — a script cannot hear.
 */
export async function runCastSelfTest(): Promise<CastSelfTestResult> {
  const lines: string[] = []
  const log = (line: string): void => {
    lines.push(line)
    console.log(`${TAG} ${line}`)
  }

  try {
    log(`start — castState=${cast.state}, phase=${cast.phase}`)
    if (cast.state === 'unavailable') {
      throw new Error('cast framework unavailable on this device')
    }
    if (cast.engaged) {
      throw new Error(`already mid-cast (phase ${cast.phase}) — end it first`)
    }

    // 1. Local playback on a long finite entry (index 4: AAC/MP4 via CDN —
    //    castable, seekable, and long enough that nothing ends mid-test).
    await jumpTo(4)
    await waitFor(
      'local playback',
      () => getPlayer()?.state.playing === true,
      15_000
    )
    await sleep(3_000) // put a non-trivial position on the clock
    const localBefore = getPlayer()?.getPosition() ?? 0
    log(`local playing, position=${localBefore.toFixed(1)}s`)

    // 2. Discovery.
    await cast.scan()
    await waitFor('a discovered device', () => cast.devices.length > 0, 20_000)
    log(
      `devices: ${cast.devices
        .map((d) => `${d.name}${d.model !== undefined ? ` (${d.model})` : ''}`)
        .join(', ')}`
    )
    const device =
      cast.devices.find((d) => /speaker|mi\b/i.test(d.name)) ?? cast.devices[0]
    if (device === undefined) throw new Error('no device to cast to')
    log(`casting to "${device.name}" (${device.id})`)

    // 3. Session + handoff (connect before stopDiscovery — the ordering rule
    //    lives inside connect()).
    await cast.connect(device.id)
    await waitFor('cast-active', () => cast.phase === 'cast-active', 30_000)
    log(`phase=cast-active, transfer: ${cast.transferNote ?? '?'}`)
    if (cast.skipped.length > 0) {
      log(
        `skipped (expected — not castable): ${cast.skipped
          .map((s) => `${s.item.id}/${s.reason}`)
          .join(', ')}`
      )
    }

    // 4. Receiver playing, position advancing across two reads.
    await waitFor('receiver playing', () => cast.receiver?.playing === true, 20_000)
    const p1 = await Cast.getApproximatePosition()
    await sleep(3_000)
    const p2 = await Cast.getApproximatePosition()
    log(`receiver position ${p1.toFixed(1)}s → ${p2.toFixed(1)}s over 3s`)
    if (p2 <= p1) throw new Error('receiver position did not advance')

    // 5. Transport against the receiver.
    pause()
    await waitFor('receiver paused', () => cast.receiver?.playing === false, 10_000)
    log('pause acknowledged by receiver status')
    await play()
    await waitFor('receiver resumed', () => cast.receiver?.playing === true, 10_000)
    log('play acknowledged by receiver status')
    const seekTarget = Math.max(30, p2 + 15)
    seekTo(seekTarget)
    await waitFor(
      `receiver at ~${seekTarget.toFixed(0)}s`,
      () => {
        const r = cast.receiver
        return r !== undefined && Math.abs(r.position - seekTarget) < 5
      },
      10_000
    )
    log(`seek to ${seekTarget.toFixed(0)}s acknowledged`)

    // 5b. Live leg — the owner-reported bug class (2026-08-14). Jump the
    //     receiver to the live Icecast entry: a live item must reach PLAYING
    //     (the projection sends live items with NO start position — a nonzero
    //     one wedged the Default Media Receiver in BUFFERING forever,
    //     device-proven), then return to the finite entry.
    void jumpTo(0)
    await waitFor(
      'receiver playing the live entry',
      () => cast.receiverIndex === 0 && cast.receiver?.playing === true,
      25_000
    )
    log('live entry playing on the receiver (index 0)')
    void jumpTo(4)
    await waitFor(
      'receiver back on the finite entry',
      () => cast.receiverIndex === 4 && cast.receiver?.playing === true,
      25_000
    )
    log('back on the finite entry after the live leg')

    // 6. Transfer back.
    const receiverAt = cast.receiver?.position ?? 0
    await cast.disconnect(true)
    await waitFor('phase local', () => cast.phase === 'local', 20_000)
    await waitFor(
      'local playback resumed',
      () => getPlayer()?.state.playing === true,
      20_000
    )
    // The restore seeks once the entry is ready; give the projection a beat.
    await sleep(2_000)
    const localAfter = getPlayer()?.getPosition() ?? 0
    log(
      `transferred back: receiver was at ${receiverAt.toFixed(1)}s, ` +
        `local resumed at ${localAfter.toFixed(1)}s`
    )
    if (Math.abs(localAfter - receiverAt) > 8) {
      throw new Error(
        `resume position off by ${Math.abs(localAfter - receiverAt).toFixed(1)}s`
      )
    }

    const summary = `PASS — ${device.name}: handoff, transport and transfer-back verified (audible check is yours)`
    log(summary)
    return { ok: true, summary, lines }
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause)
    const summary = `FAIL — ${message}`
    log(summary)
    return { ok: false, summary, lines }
  }
}
