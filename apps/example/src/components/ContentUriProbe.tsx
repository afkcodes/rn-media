/**
 * A dev-only probe for Android `content://` playback.
 *
 * **Why this exists, and why it is `__DEV__`-gated.** `content://` is the URI a
 * storage picker hands back, and this app deliberately has no picker
 * dependency — its queue is a fixed demo list. But the rewrite that makes
 * `content://` playable (`ContentResolver` → mpv's `fd://`, see
 * `@timbre/player`'s README under "Platform parity") is exactly the kind of
 * thing a unit test cannot prove: the question is whether libmpv can read a
 * descriptor another process opened, and whether that descriptor seeks. So this
 * is the on-device harness for it — paste or type a `content://` URI, load it,
 * seek it, and read back what mpv says about `seekable` and `duration`.
 *
 * It ships behind `__DEV__` because it is a diagnostic, not a feature: a
 * release build has no free-text URI field.
 *
 * The `adb` recipe it is built for:
 *
 * ```
 * adb push track.mp3 /sdcard/Music/
 * adb shell am broadcast -a android.intent.action.MEDIA_SCANNER_SCAN_FILE \
 *   -d file:///sdcard/Music/track.mp3
 * adb shell content query --uri content://media/external/audio/media \
 *   --projection _id,_data
 * adb shell input text 123        # the id, into the field below
 * ```
 */
import React from 'react'
import { StyleSheet, Text, TextInput, View } from 'react-native'
import type { Player } from '@timbre/player'
import { COLORS, SPACE, TYPE } from '../theme'
import { Chip, ChipRow, Detail, Section } from './ui'

/** The `MediaStore` audio collection — the prefix `content query` reports ids for. */
const MEDIA_STORE_AUDIO = 'content://media/external/audio/media/'

export const ContentUriProbe = React.memo(function ContentUriProbe({
  player,
}: {
  player: Player | undefined
}): React.JSX.Element | null {
  const [id, setId] = React.useState('')
  const [note, setNote] = React.useState('idle')

  if (!__DEV__) return null

  const uri = `${MEDIA_STORE_AUDIO}${id.trim()}`

  /** Run one probe step, reporting whatever it throws rather than swallowing it. */
  const attempt = (label: string, run: () => Promise<void>): void => {
    if (player === undefined) {
      setNote('no player yet')
      return
    }
    setNote(`${label}…`)
    run().then(
      () => {
        const state = player.state
        setNote(
          `${label} ok — status=${state.status}` +
            ` seekable=${String(state.seekable)}` +
            ` isLive=${String(state.isLive)}` +
            ` duration=${state.duration === undefined ? '—' : state.duration.toFixed(2)}` +
            ` pos=${player.getPosition().toFixed(2)}`
        )
      },
      (thrown: unknown) => {
        const error = thrown as { playerError?: { code?: string } }
        setNote(
          `${label} FAILED — ${error.playerError?.code ?? 'error'}: ${String(thrown)}`
        )
      }
    )
  }

  return (
    <Section title="content:// probe (dev)">
      <View style={styles.row}>
        <Text style={styles.prefix}>{MEDIA_STORE_AUDIO}</Text>
        <TextInput
          accessibilityLabel="MediaStore audio id"
          keyboardType="number-pad"
          onChangeText={setId}
          placeholder="id"
          placeholderTextColor={COLORS.muted}
          style={styles.input}
          value={id}
        />
      </View>
      <ChipRow>
        <Chip
          label="Load"
          disabled={id.trim() === ''}
          onPress={() => {
            attempt('load', async () => {
              await player?.load(uri)
            })
          }}
        />
        <Chip
          label="Seek +30s"
          onPress={() => {
            attempt('seek', async () => {
              await player?.seekTo(30)
            })
          }}
        />
        <Chip
          label="Seek 0"
          onPress={() => {
            attempt('rewind', async () => {
              await player?.seekTo(0)
            })
          }}
        />
        <Chip
          label="Cover art?"
          onPress={() => {
            // The experiment behind the README's cover-art limitation. The
            // claim there is that `screenshot-raw` "needs a video output this
            // core deliberately never creates" — true of the *configuration*,
            // but `vo_null` and the image decoders are compiled into the
            // shipped binary. So: give the core a null VO, let it select the
            // attached-picture track, and ask.
            //
            // `command()` resolves only if mpv's command succeeded, and
            // `screenshot-raw` fails outright when `screenshot_get()` finds no
            // configured VO (mpv 0.41.0 `player/screenshot.c`). So resolve vs
            // reject IS the answer, even though the binding cannot carry the
            // bytes back yet (`command` returns no result node).
            attempt('cover-art', async () => {
              if (player === undefined) return
              player.setPropertyString('vo', 'null')
              player.setPropertyString('audio-display', 'embedded-first')
              await player.load(uri)
              await new Promise<void>((resolve) => {
                setTimeout(resolve, 1500)
              })
              await player.command(['screenshot-raw', 'video', 'bgra'])
            })
          }}
        />
        <Chip
          label="Replay"
          onPress={() => {
            // The `fd://` URL is minted once per URI and reopened, so a second
            // load of the same entry is the check that `fdclose://` would have
            // failed. See ARCHITECTURE §32.
            attempt('replay', async () => {
              await player?.load(uri)
            })
          }}
        />
      </ChipRow>
      <Detail>{note}</Detail>
    </Section>
  )
})

const styles = StyleSheet.create({
  row: {
    alignItems: 'center',
    flexDirection: 'row',
    marginBottom: SPACE.sm,
  },
  prefix: {
    color: COLORS.muted,
    fontSize: TYPE.micro,
  },
  input: {
    borderBottomColor: COLORS.border,
    borderBottomWidth: StyleSheet.hairlineWidth,
    color: COLORS.text,
    flex: 1,
    fontSize: TYPE.label,
    paddingVertical: SPACE.xs,
  },
})
