/**
 * Cast — discovery, the device sheet, the session, and the honest ceilings.
 *
 * Renders the handoff's §3 state machine as controls: the status line is the
 * phase, the device chips are the picker, and the two end-session chips are the
 * two meanings of "stop casting" (transfer back vs. leave the receiver
 * playing). While casting, the transport at the top of the screen and the
 * notification already steer the receiver, so this adds no second transport.
 *
 * Two entry points, both supported: the native `<CastButton/>` (the system
 * output switcher on Android 13+, the GCK dialog on iOS) and the headless
 * `getCastDevices()` + `requestSession(id)` path behind "Find devices", for
 * apps that want their own picker. Either one starts an ordinary session and
 * the same `wireCastHandoff` machine picks it up.
 *
 * This is the body of the Cast sheet — the sheet owns the title; the prose that
 * used to explain each control lives in code comments and the docs, not on
 * screen.
 */
import React from 'react'
import { StyleSheet, Text, View } from 'react-native'
import { CastButton } from '@timbre/cast'
import type { CastIntegration } from '../cast'
import { COLORS, SPACE, TYPE } from '../theme'
import { Chip, ChipRow, Detail, Dot, Section, Strip } from './ui'

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
  ready,
}: {
  cast: CastIntegration
  ready: boolean
}): React.JSX.Element {
  if (cast.state === 'unavailable') {
    return (
      <Section>
        <Detail>Cast is unavailable on this device.</Detail>
      </Section>
    )
  }

  const status = phaseLine(cast)
  const casting = cast.engaged

  return (
    <Section>
      <View style={styles.status}>
        <Dot color={status.color} />
        <Text style={styles.statusText}>{status.text}</Text>
      </View>

      {/* The platform's own affordance — the system output switcher on
          Android 13+, the GCK dialog on iOS. Hides itself when unavailable. */}
      <View style={styles.nativeRow}>
        <CastButton tintColor={COLORS.text} />
        <Text style={styles.nativeLabel}>System output</Text>
      </View>

      {/* Discovery + the device picker. Scan only while it is open; the connect
          path stops the scan after the session is up. */}
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
        <Detail>Scanning — receivers must be on the same Wi-Fi.</Detail>
      ) : null}

      {/* End-session: the two honest meanings of "stop casting". */}
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

      {/* Cast errors get their own strip. */}
      {cast.error === undefined ? null : (
        <Strip color={COLORS.error}>
          <Text style={styles.errorHead}>{cast.error.code}</Text>
          <Detail>{cast.error.message}</Detail>
          <ChipRow>
            <Chip label="Dismiss" onPress={() => cast.dismissError()} />
          </ChipRow>
        </Strip>
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
  nativeLabel: { fontSize: TYPE.caption, color: COLORS.muted },
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
})
