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
} from '@timbre/player'
import { COLORS, RADIUS, SPACE, TYPE } from '../theme'
import type { ColumnRect } from './fader-geometry'
import { bandAtX, gainAtY } from './fader-geometry'
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

  // What mpv says the chain is — `player.getAudioFilters()`, its own property,
  // not a mirror of what was tapped.
  //
  // Read on a settle rather than on every change, for two reasons. It is a
  // synchronous native call and a drag produces one per frame; and while a
  // finger is down the hook is deliberately *not* writing that property (it
  // pushes the gains into the running filters instead), so reading it mid-drag
  // would only show the pre-drag string. Waiting out the hook's own commit
  // delay is what makes this line show what mpv finally settled on.
  const [applied, setApplied] = React.useState('')
  React.useEffect(() => {
    if (player === undefined || !eq.hydrated) {
      setApplied('')
      return undefined
    }
    const timer = setTimeout(() => {
      if (!player.destroyed) setApplied(player.getAudioFilters())
    }, 350)
    return () => {
      clearTimeout(timer)
    }
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
Touch a bar and drag up or down: the band you touched is the band that
        moves, for the whole stroke. Dragging is live — the gains go into the
        running filters, so the audio must not glitch, and the `af` line above
        only catches up once you let go. The pre-amp that keeps the loudest band
        at unity is computed from the summed response — octave bells overlap and
        add — and the `alimiter` on the tail catches what a magnitude bound
        cannot: the sample peaks a phase shift moves in time. It is on for any
        curve that is not flat, and below full scale it changes no sample. Saved
        curves and the live setting persist through the app's own storage
        engine.
      </Detail>
      {eq.error === undefined ? null : (
        <Text style={styles.error}>
          {eq.error.code}: {eq.error.message}
        </Text>
      )}
    </Section>
  )
}

/** Track height in px. The gain mapping is over exactly this — see below. */
const TRACK_HEIGHT = 96

/**
 * Ten vertical faders under one gesture.
 *
 * React Native core ships no slider and this repository is not growing a native
 * dependency for a demo, so the bank is plain `View`s driven by a single
 * `PanResponder` — the same idiom `SeekBar` uses, including the two flags that
 * stop the enclosing `ScrollView` stealing a sloppy drag mid-gesture.
 *
 * Three things here are deliberate, and the first version of this file got two
 * of them wrong badly enough that the owner reported the faders as broken:
 *
 * 1. **The band is chosen on touch-down and then held for the stroke.** A fader
 *    you can set is worth more than a curve you can sketch: with the band
 *    locked, a vertical drag adjusts exactly the bar you put your finger on,
 *    and a bit of horizontal drift cannot silently start moving its neighbour.
 * 2. **Everything inside the touchable row is `pointerEvents="none"`.** RN's
 *    `locationX/locationY` are relative to the *touch target*, which is the
 *    deepest hit-testable view under the finger — a track, or a fill — not the
 *    view holding the responder. Reading `pageX - locationX` without this gives
 *    the origin of whichever bar was touched, so every touch resolved to band 0
 *    and the whole bank looked dead. Making the children transparent to touches
 *    leaves the row as the only target, which is what makes the coordinates
 *    mean what they say.
 * 3. **The responder view is the track row alone**, so `TRACK_HEIGHT` is the
 *    full height of the gain mapping. The old bank measured the whole section
 *    (tracks *plus* the two label rows) and mapped ±12 dB over that, so the
 *    bottom of a visible bar was about −7 dB and no fader ever reached its
 *    stop.
 *
 * The arithmetic itself is in `fader-geometry.ts`, under test.
 */
function BandBank({
  equalizer,
  disabled,
}: {
  equalizer: Equalizer
  disabled: boolean
}): React.JSX.Element {
  const geometry = React.useRef({ height: TRACK_HEIGHT, originY: 0 })
  const columns = React.useRef<ColumnRect[]>([])
  const activeBand = React.useRef(0)

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
        // to the enclosing scroller and the fader stops following the finger.
        onPanResponderTerminationRequest: () => false,
        onShouldBlockNativeResponder: () => true,
        onPanResponderGrant: (event) => {
          const { pageY, locationX, locationY } = event.nativeEvent
          // Only correct because the row's children take no touches: see (2).
          geometry.current.originY = pageY - locationY
          activeBand.current = bandAtX(columns.current, locationX)
          adjust(pageY)
        },
        onPanResponderMove: (event) => {
          adjust(event.nativeEvent.pageY)
        },
      }),
    []
  )

  function adjust(pageY: number): void {
    const eq = latest.current
    const { height, originY } = geometry.current
    eq.setBandGain(
      activeBand.current,
      gainAtY(pageY - originY, height, eq.gainRangeDb)
    )
  }

  function onRowLayout(event: LayoutChangeEvent): void {
    geometry.current.height = event.nativeEvent.layout.height
  }

  function onColumnLayout(index: number, event: LayoutChangeEvent): void {
    const { x, width } = event.nativeEvent.layout
    columns.current[index] = { x, width }
  }

  const { min, max } = equalizer.gainRangeDb
  const zero = (0 - min) / (max - min)

  return (
    <View style={disabled ? styles.dim : undefined}>
      <View
        accessibilityRole="adjustable"
        accessibilityLabel="Equaliser bands"
        accessibilityState={{ disabled }}
        style={styles.bank}
        onLayout={onRowLayout}
        {...(disabled ? {} : responder.panHandlers)}
      >
        {equalizer.bands.map((band, index) => {
          // 0 dB sits on the zero rule; the fill grows up for a boost and down
          // for a cut, which is what makes a curve readable at a glance.
          const fraction = (band.gainDb - min) / (max - min)
          return (
            <View
              key={band.frequency}
              style={styles.column}
              pointerEvents="none"
              onLayout={(event) => {
                onColumnLayout(index, event)
              }}
            >
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
            </View>
          )
        })}
      </View>

      {/* Outside the responder, so the gain mapping is over the tracks only. */}
      <View style={styles.legend}>
        {equalizer.bands.map((band) => (
          <View key={band.frequency} style={styles.column}>
            <Text style={styles.bandLabel}>{formatBand(band.frequency)}</Text>
            <Text style={styles.bandGain}>
              {band.gainDb > 0 ? '+' : ''}
              {band.gainDb.toFixed(1)}
            </Text>
          </View>
        ))}
      </View>
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
  // The labels live in their own row so the touchable one is exactly the
  // tracks — the gain mapping's height is that row's, and nothing else.
  legend: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: SPACE.xs,
    marginTop: 2,
  },
  column: { flex: 1, alignItems: 'center', gap: 2 },
  track: {
    alignSelf: 'stretch',
    height: TRACK_HEIGHT,
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
