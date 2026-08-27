/**
 * Cast — discovery, the device sheet, the session, and the honest ceilings.
 *
 * The section renders the handoff's §3 state machine directly: the status
 * line is the phase, the device chips are the sheet, and the two end-session
 * chips are the two meanings of "stop casting" (transfer back vs. leave the
 * receiver playing). While casting, the transport at the top of the screen and
 * the notification both already steer the receiver — the controller forwards
 * every command to whichever backend owns playback — so this section
 * deliberately adds no second transport.
 *
 * Both entry points are demoed on purpose, because both are supported:
 * the native `<CastButton/>` (the platform's own affordance — the system
 * output switcher on Android 13+, the GCK dialog on iOS) and the headless
 * `getCastDevices()` + `requestSession(id)` path behind the "Find devices"
 * chip, for apps that want their own picker. Either one starts an ordinary
 * session, and the SAME `wireCastHandoff` machine picks it up.
 *
 * Degrades honestly: `castState === 'unavailable'` (no Google Play services,
 * or init not finished) renders the fact and no dead controls.
 */
import React from 'react'
import { StyleSheet, Text, View } from 'react-native'
import { CastButton, useCastState, useIsCasting } from '@timbre/cast'
import type { CastIntegration } from '../playback/cast'
import type { CastSelfTestResult } from '../playback/cast-selftest'
import type { Track } from '../data/tracks'
import { COLORS, SPACE, TYPE } from '../theme'
import { Chip, ChipRow, Detail, Dot, Section, Strip } from './ui'

/**
 * The framework's own connection state, straight from the library's hooks —
 * **with no controller involved**, which is the whole point of showing it.
 *
 * It is deliberately a *second* fact next to the status line above, not a
 * duplicate of it: `cast.phase` is our §3 handoff machine ("is the receiver
 * playing our queue yet?"), while `useCastState()` is the platform's session
 * state ("is there a session at all?"). They legitimately disagree for the
 * length of a handoff — connected, and still playing on the phone — and having
 * both on screen is how that window becomes observable on the test bed.
 *
 * This is also the entire integration cost of the two hooks: two calls, no
 * subscription to wire, no state to keep, nothing to tear down. An app without
 * a controller layer builds its cast UI on exactly this.
 */
function FrameworkState(): React.JSX.Element {
  const state = useCastState()
  const casting = useIsCasting()
  return (
    <Detail>
      useCastState() = {state} · useIsCasting() = {casting ? 'true' : 'false'}
    </Detail>
  )
}

/** Phase → status-line copy + dot colour. The §3 machine, rendered. */
function phaseLine(cast: CastIntegration): { text: string; color: string } {
  switch (cast.phase) {
    case 'local':
      return cast.state === 'connected'
        ? { text: `connected to ${cast.device?.name ?? 'receiver'} — playing on phone`, color: COLORS.warning }
        : { text: 'playing on phone', color: COLORS.muted }
    case 'connecting':
      return { text: 'connecting…', color: COLORS.warning }
    case 'handoff-to-cast':
      return { text: 'handing off to receiver…', color: COLORS.warning }
    case 'cast-active':
      return {
        text: `casting to ${cast.device?.name ?? 'receiver'}`,
        color: COLORS.success,
      }
    case 'handoff-to-local':
      return { text: 'transferring back…', color: COLORS.warning }
  }
}

export const CastSection = React.memo(function CastSection({
  cast,
  queue,
  ready,
  onSelfTest,
}: {
  cast: CastIntegration
  queue: readonly Track[]
  ready: boolean
  /** Runs the scripted §5 verification (`cast-selftest.ts`); resolves a verdict. */
  onSelfTest: () => Promise<CastSelfTestResult>
}): React.JSX.Element {
  const [testing, setTesting] = React.useState(false)
  const [testSummary, setTestSummary] = React.useState<string | undefined>(
    undefined
  )

  if (cast.state === 'unavailable') {
    return (
      <Section title="cast">
        <Detail>
          Cast is unavailable on this device — the framework loads from Google
          Play services at runtime, and this device has none (or initialization
          has not finished). That is a typed capability answer, not an error.
        </Detail>
      </Section>
    )
  }

  const status = phaseLine(cast)
  const casting = cast.engaged

  return (
    <Section
      title="cast"
      accessory={
        <View style={styles.status}>
          <Dot color={status.color} />
          <Text style={styles.statusText}>{status.text}</Text>
        </View>
      }
    >
      {/* The platform's own button. Always mounted — it is the affordance
          Google's design checklist expects, it is live during a session too
          (tapping it while connected offers "disconnect"), and on this
          Android 13+ device it opens the SYSTEM output switcher rather than
          an in-app dialog. The component hides itself when cast is
          unavailable, so there is no dead control to guard here. */}
      <View style={styles.nativeRow}>
        <CastButton tintColor={COLORS.text} />
        <View style={styles.nativeCopy}>
          <Detail>
            The native cast button — the system output switcher on Android 13+,
            the GCK dialog on iOS. The chips below are the same feature done
            headlessly, for apps that want their own picker.
          </Detail>
          <FrameworkState />
        </View>
      </View>

      {/* Discovery + the device sheet. Battery rule: scan only while the
          "sheet" is open; the connect path stops the scan itself, AFTER the
          session is up (the ordering rule). */}
      {casting ? null : (
        <ChipRow>
          <Chip
            label={cast.discovering ? 'Stop scanning' : 'Find devices'}
            active={cast.discovering}
            disabled={!ready}
            onPress={() => void (cast.discovering ? cast.stopScan() : cast.scan())}
          />
          {cast.devices.map((device) => (
            <Chip
              key={device.id}
              label={device.name}
              disabled={!ready || cast.phase !== 'local'}
              onPress={() => void cast.connect(device.id)}
            />
          ))}
        </ChipRow>
      )}
      {cast.discovering && cast.devices.length === 0 ? (
        <Detail>
          Scanning the local network… receivers must be on the same Wi-Fi.
        </Detail>
      ) : null}

      {/* End-session: the two honest meanings of "stop casting". The second
          is narrower on Android than its name suggests — see the Detail
          below; the platform stops receiver playback on session end
          (device-verified ceiling, ARCHITECTURE §25). */}
      {casting ? (
        <ChipRow>
          <Chip
            label="Play on phone"
            disabled={cast.phase !== 'cast-active'}
            onPress={() => void cast.disconnect(true)}
          />
          <Chip
            label="Disconnect"
            tone="danger"
            disabled={cast.phase !== 'cast-active'}
            onPress={() => void cast.disconnect(false)}
          />
        </ChipRow>
      ) : null}

      {cast.transferNote === undefined ? null : (
        <Detail>Last transfer: {cast.transferNote}.</Detail>
      )}

      {/* Skipped items from the live projection — typed, never silent. */}
      {cast.skipped.length > 0 ? (
        <Strip color={COLORS.warning}>
          <Detail>
            Not on the receiver:{' '}
            {cast.skipped
              .map((s) => `${s.item.metadata?.title ?? s.item.id} (${s.reason})`)
              .join(', ')}
            .
          </Detail>
        </Strip>
      ) : null}

      {/* Cast errors get their own strip — `cast-receiver-fetch` means the
          RECEIVER could not fetch the URL; its network is not the phone's. */}
      {cast.error === undefined ? null : (
        <Strip color={COLORS.error}>
          <Text style={styles.errorHead}>{cast.error.code}</Text>
          <Detail>{cast.error.message}</Detail>
          <ChipRow>
            <Chip label="Dismiss" onPress={() => cast.dismissError()} />
          </ChipRow>
        </Strip>
      )}

      {/* Per-track castability, from canCastMedia — the receiver decodes far
          less than mpv, and the route greys out per track instead of failing
          at load. */}
      <View style={styles.tracks}>
        {queue.map((track, index) => {
          const verdict = cast.castability(track)
          return (
            <View key={`${track.id}-${String(index)}`} style={styles.trackRow}>
              <Text
                style={[styles.trackTitle, !verdict.castable && styles.dim]}
                numberOfLines={1}
              >
                {track.title}
              </Text>
              <Text
                style={[
                  styles.trackVerdict,
                  !verdict.castable && styles.verdictNo,
                ]}
              >
                {verdict.castable ? 'castable' : (verdict.reason ?? 'no')}
              </Text>
            </View>
          )
        })}
      </View>
      <Detail>
        The receiver fetches URLs itself: local files cannot cast, per-source
        auth headers do not travel, and the codec ceiling is the receiver’s,
        not mpv’s. The “retry &amp; errors” entry is castable on paper and
        fails on the receiver — that is the `cast-receiver-fetch` family, live.
      </Detail>

      {/* The scripted §5 verification — the on-device test bed earning its
          name. Logs under [cast-test] for logcat evidence. */}
      <ChipRow>
        <Chip
          label={testing ? 'Verifying…' : 'Run cast self-test'}
          disabled={!ready || testing || casting}
          onPress={() => {
            setTesting(true)
            setTestSummary(undefined)
            void onSelfTest()
              .then((result) => setTestSummary(result.summary))
              .finally(() => setTesting(false))
          }}
        />
      </ChipRow>
      {testSummary === undefined ? null : (
        <Detail selectable>{testSummary}</Detail>
      )}
    </Section>
  )
})

const styles = StyleSheet.create({
  nativeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACE.sm,
  },
  nativeCopy: { flex: 1 },
  status: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACE.sm,
    flexShrink: 1,
  },
  statusText: {
    fontSize: TYPE.caption,
    color: COLORS.muted,
    flexShrink: 1,
  },
  errorHead: {
    fontSize: TYPE.label,
    fontWeight: '700',
    color: COLORS.error,
  },
  tracks: { gap: SPACE.xs },
  trackRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    gap: SPACE.md,
  },
  trackTitle: {
    flexShrink: 1,
    fontSize: TYPE.caption,
    color: COLORS.text,
  },
  trackVerdict: {
    fontSize: TYPE.micro,
    letterSpacing: 0.6,
    textTransform: 'uppercase',
    color: COLORS.muted,
  },
  verdictNo: { color: COLORS.warning },
  dim: { opacity: 0.4 },
})
