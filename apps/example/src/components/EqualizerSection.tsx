/**
 * Equaliser and DSP — the whole screen, on one hook.
 *
 * `useEqualizer` owns the curve, the preset bank, the persistence and the one
 * `af` write that puts it on the signal. What used to be in this file — a
 * `useState` for the selection, a hand-built `equalizerPresetChain` per chip, a
 * `try` around `setAudioFilters`, and no way to save anything — is gone. What
 * is left is a *view*, which is the point of the hook.
 *
 * Three things this section deliberately proves on device:
 *
 * 1. **The user half composes.** The chain chips feed `extraFilters`, so the EQ
 *    and the app's own DSP share one chain instead of clobbering each other.
 *    `Mono (proof)` is not an equaliser — it forces the output to one channel,
 *    which `adb shell dumpsys audio` shows as `channelMask` flipping from `0x3`
 *    (stereo) to mono. That is externally observable proof that the chain is
 *    genuinely processing samples, not merely accepted by the option parser.
 * 2. **Loudness normalisation is untouched.** Toggle it in the section above and
 *    watch `@rnmedia_loudnorm:` stay on the end of the read-back line while the
 *    bands move: it is a separately managed, labelled entry, and neither the
 *    hook nor this app has to think about it.
 * 3. **The read-back is mpv's, not ours.** The `af = …` line is
 *    `player.getAudioFilters()`. If a build's ffmpeg lacks a filter, mpv rejects
 *    the chain, keeps the old one, this line keeps showing the old one, and
 *    `eq.error` says why.
 *
 * The curve and the saved presets persist through the same MMKV engine the
 * media session uses — an *app* choice, injected; the library ships no storage
 * dependency (see `playback/persistence.ts`).
 */
import React from 'react'
import {
  PanResponder,
  StyleSheet,
  Text,
  View,
  type LayoutChangeEvent,
} from 'react-native'
import {
  AudioFilters,
  EQUALIZER_BANDS,
  useEqualizer,
  type AudioFilter,
  type Equalizer,
  type Player,
} from '@rn-media/player'
import { COLORS, RADIUS, SPACE, TYPE } from '../theme'
import { equalizerStorage } from '../playback/persistence'
import { Chip, ChipRow, Detail, Section } from './ui'

/** The non-EQ half of the chain, as selectable sets of `extraFilters`. */
const CHAINS: readonly {
  readonly id: string
  readonly label: string
  readonly filters: readonly AudioFilter[]
}[] = [
  { id: 'none', label: 'EQ only', filters: [] },
  {
    id: 'mono',
    label: 'Mono (proof)',
    filters: [AudioFilters.custom('aformat', { channel_layouts: 'mono' })],
  },
  {
    id: 'headphone',
    label: '+ Crossfeed & comp',
    filters: [
      AudioFilters.crossfeed({ strength: 0.6 }),
      AudioFilters.compressor(),
    ],
  },
]

const NO_FILTERS: readonly AudioFilter[] = []

export function EqualizerSection({
  player,
}: {
  player: Player | undefined
}): React.JSX.Element {
  const [chainId, setChainId] = React.useState('none')
  const extraFilters =
    CHAINS.find((chain) => chain.id === chainId)?.filters ?? NO_FILTERS

  const eq = useEqualizer(player, {
    extraFilters,
    storage: equalizerStorage,
    onStorageError: (cause) => {
      console.warn('[example] equaliser storage failed:', cause)
    },
  })

  // What mpv says the chain is. Read *after* the hook's own apply effect —
  // effects run in declaration order and `useEqualizer` is called above this
  // one — so this is the post-write truth, not a mirror of what was tapped.
  const [applied, setApplied] = React.useState('')
  React.useEffect(() => {
    setApplied(
      player === undefined || !eq.hydrated ? '' : player.getAudioFilters()
    )
  }, [player, eq])

  const ready = player !== undefined
  // Only a curve the user saved can be deleted; the built-ins ship with the
  // library and `deletePreset` refuses them.
  const deletable =
    eq.preset !== undefined && eq.savedPresets.includes(eq.preset)

  return (
    <Section
      title="Equaliser & DSP"
      accessory={
        <Text style={styles.meta}>
          {EQUALIZER_BANDS.length}-band · {EQUALIZER_BANDS[0]} Hz –{' '}
          {(EQUALIZER_BANDS[EQUALIZER_BANDS.length - 1] as number) / 1000} kHz
        </Text>
      }
    >
      {/* `eq.presets` is the built-ins in picker order followed by the user's
          saved curves; `eq.preset` is DERIVED from the gains, so dragging a
          band away from Rock deselects it and dragging back re-selects it. */}
      <ChipRow>
        {eq.presets.map((preset) => (
          <Chip
            key={preset.id}
            label={preset.name}
            active={preset.id === eq.preset?.id}
            disabled={!ready}
            onPress={() => eq.applyPreset(preset)}
          />
        ))}
      </ChipRow>

      <BandBank equalizer={eq} disabled={!ready} />

      <ChipRow>
        <Chip
          label={eq.enabled ? 'EQ on' : 'EQ off'}
          active={eq.enabled}
          disabled={!ready}
          onPress={() => eq.setEnabled(!eq.enabled)}
        />
        <Chip label="Reset" disabled={!ready} onPress={() => eq.reset()} />
        <Chip
          label="Save curve"
          disabled={!ready}
          onPress={() =>
            eq.savePreset(`Custom ${String(eq.savedPresets.length + 1)}`)
          }
        />
        <Chip
          label="Delete saved"
          tone="danger"
          disabled={!deletable}
          onPress={() => {
            if (eq.preset !== undefined) eq.deletePreset(eq.preset.id)
          }}
        />
      </ChipRow>

      {/* The rest of the chain, declared to the hook rather than written
          behind it — `setAudioFilters` replaces the whole user half. */}
      <ChipRow>
        {CHAINS.map((chain) => (
          <Chip
            key={chain.id}
            label={chain.label}
            active={chain.id === chainId}
            disabled={!ready}
            onPress={() => setChainId(chain.id)}
          />
        ))}
      </ChipRow>

      <Detail selectable>af = {applied === '' ? '(none)' : applied}</Detail>
      <Detail>
        Drag across the bars to shape the curve. The pre-amp that keeps the
        loudest band at unity is computed from the summed response — octave
        bells overlap and add — so nothing here can clip. Saved curves and the
        live setting persist through the app's own storage engine.
      </Detail>
      {eq.error === undefined ? null : (
        <Text style={styles.error}>
          {eq.error.code}: {eq.error.message}
        </Text>
      )}
    </Section>
  )
}

/**
 * Ten vertical faders under one gesture.
 *
 * React Native core ships no slider and this repository is not growing a native
 * dependency for a demo, so the bank is plain `View`s driven by a single
 * `PanResponder` — the same idiom `SeekBar` uses, including the two flags that
 * stop the enclosing `ScrollView` stealing a sloppy drag mid-gesture.
 *
 * One responder for all ten bands, not ten: the x coordinate picks the band and
 * the y coordinate picks the gain, so dragging *across* the bank draws a whole
 * curve in one stroke. That is both the cheapest thing to implement and the
 * fastest thing to use.
 */
function BandBank({
  equalizer,
  disabled,
}: {
  equalizer: Equalizer
  disabled: boolean
}): React.JSX.Element {
  const geometry = React.useRef({ width: 0, height: 0, originX: 0, originY: 0 })

  // The responder is built once and outlives every render, so the live hook
  // object is reached through a ref rather than captured.
  const latest = React.useRef(equalizer)
  React.useEffect(() => {
    latest.current = equalizer
  })

  const responder = React.useMemo(
    () =>
      PanResponder.create({
        // Claim on touch-down, so a tap is a drag with no movement.
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        // Without these two the vertical component of a drag hands the gesture
        // to the enclosing scroller and the curve stops following the finger.
        onPanResponderTerminationRequest: () => false,
        onShouldBlockNativeResponder: () => true,
        onPanResponderGrant: (event) => {
          const { pageX, pageY, locationX, locationY } = event.nativeEvent
          geometry.current.originX = pageX - locationX
          geometry.current.originY = pageY - locationY
          adjust(pageX, pageY)
        },
        onPanResponderMove: (event) => {
          adjust(event.nativeEvent.pageX, event.nativeEvent.pageY)
        },
      }),
    []
  )

  function adjust(pageX: number, pageY: number): void {
    const eq = latest.current
    const { width, height, originX, originY } = geometry.current
    if (width <= 0 || height <= 0) return
    const column = Math.floor(((pageX - originX) / width) * eq.bands.length)
    const index = Math.min(eq.bands.length - 1, Math.max(0, column))
    const fraction = Math.min(1, Math.max(0, (pageY - originY) / height))
    const { min, max } = eq.gainRangeDb
    // Top of the bank is maximum boost, bottom is maximum cut. The hook clamps
    // anyway; rounding to 0.1 dB just keeps the read-back line legible.
    eq.setBandGain(index, Number((max - fraction * (max - min)).toFixed(1)))
  }

  function onLayout(event: LayoutChangeEvent): void {
    geometry.current.width = event.nativeEvent.layout.width
    geometry.current.height = event.nativeEvent.layout.height
  }

  const { min, max } = equalizer.gainRangeDb
  const zero = (0 - min) / (max - min)

  return (
    <View
      accessibilityRole="adjustable"
      accessibilityLabel="Equaliser bands"
      accessibilityState={{ disabled }}
      style={[styles.bank, disabled && styles.dim]}
      onLayout={onLayout}
      {...(disabled ? {} : responder.panHandlers)}
    >
      {equalizer.bands.map((band) => {
        // 0 dB sits on the zero rule; the fill grows up for a boost and down
        // for a cut, which is what makes a curve readable at a glance.
        const fraction = (band.gainDb - min) / (max - min)
        return (
          <View key={band.frequency} style={styles.column}>
            <View style={styles.track}>
              <View style={[styles.zeroRule, { bottom: percent(zero) }]} />
              <View
                style={[
                  styles.fill,
                  {
                    bottom: percent(Math.min(fraction, zero)),
                    height: percent(Math.abs(fraction - zero)),
                  },
                  band.gainDb < 0 && styles.fillCut,
                ]}
              />
            </View>
            <Text style={styles.bandLabel}>{formatBand(band.frequency)}</Text>
            <Text style={styles.bandGain}>
              {band.gainDb > 0 ? '+' : ''}
              {band.gainDb.toFixed(1)}
            </Text>
          </View>
        )
      })}
    </View>
  )
}

function percent(fraction: number): `${number}%` {
  return `${fraction * 100}%`
}

/** `31`, `1k`, `16k` — the labels a hardware EQ prints. */
function formatBand(frequency: number): string {
  return frequency >= 1000 ? `${String(frequency / 1000)}k` : String(frequency)
}

const styles = StyleSheet.create({
  meta: { fontSize: TYPE.micro, color: COLORS.muted },
  error: { fontSize: TYPE.caption, color: COLORS.error },
  // Card-less like everything else: no box around the bank, just the ten
  // tracks and their labels.
  bank: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: SPACE.xs,
  },
  column: { flex: 1, alignItems: 'center', gap: 2 },
  track: {
    alignSelf: 'stretch',
    height: 96,
    borderRadius: RADIUS.sm,
    backgroundColor: COLORS.surface,
    overflow: 'hidden',
  },
  zeroRule: {
    position: 'absolute',
    left: 0,
    right: 0,
    height: StyleSheet.hairlineWidth,
    backgroundColor: COLORS.border,
  },
  fill: {
    position: 'absolute',
    left: 0,
    right: 0,
    backgroundColor: COLORS.accent,
  },
  fillCut: { backgroundColor: COLORS.muted },
  bandLabel: { fontSize: TYPE.micro, color: COLORS.muted },
  bandGain: {
    fontSize: TYPE.micro,
    fontVariant: ['tabular-nums'],
    color: COLORS.text,
  },
  dim: { opacity: 0.4 },
})
