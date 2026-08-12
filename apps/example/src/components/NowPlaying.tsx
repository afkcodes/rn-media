/**
 * The hero: artwork, what is playing, and the scrubber.
 *
 * This is the one part of the screen that gets visual weight — everything
 * below it is quiet by design. No frame, no card, no glow: the artwork sits
 * directly on the background and the type does the rest.
 *
 * Three library features are visible here at once, and they are deliberately
 * drawn from three different places:
 *
 * - the **title/artist** come from the app's own queue (`MediaItem` metadata);
 * - the **♪ line** is the ICY now-playing title mpv surfaces through
 *   `media-title`, i.e. what the station says is on air *right now*;
 * - the **station line** under it comes from the `metadataChanged` event
 *   (`icy-name`/`icy-genre`/`icy-br`) — see the wiring in
 *   `src/playback/engine.ts`.
 *
 * The clock is `useProgress`, which projects the position locally from the
 * player's anchor: nothing is polled across the bridge, and the ticker stops
 * itself while paused, buffering or seeking.
 *
 * Two more, both conditional on the entry rather than always drawn:
 *
 * - **the chapter line**, for entries that have chapters (m4b audiobooks,
 *   chaptered podcasts). `state.chapter` is the cursor and `getChapters()` is
 *   the one-node-read list; nothing shows when a plain music track is playing,
 *   which is the common case.
 * - **the buffering percentage**, which `PlayerState` publishes *only* while
 *   `status === 'buffering'` — i.e. only while there is a spinner to label.
 */
import React from 'react'
import { Image, StyleSheet, Text, View } from 'react-native'
import type { ChapterEntry, Progress } from '@rn-media/player'
import { COLORS, RADIUS, SPACE, TYPE } from '../theme'
import type { Track } from '../data/tracks'
import type { ShellState } from '../playback/shell'
import { SeekBar, formatTime } from './SeekBar'
import { Dot } from './ui'

const STATUS_COLOR: Record<ShellState['status'], string> = {
  idle: COLORS.muted,
  loading: COLORS.warning,
  buffering: COLORS.warning,
  ready: COLORS.success,
  ended: COLORS.muted,
  error: COLORS.error,
}

export function NowPlaying({
  track,
  shell,
  progress,
  station,
  song,
  durationMs,
  live,
  ready,
  chapters,
  onSeek,
}: {
  track: Track | undefined
  shell: ShellState
  progress: Progress
  station: string | undefined
  /** The ICY line, already resolved by `nowPlaying()`. */
  song: string | undefined
  /** The *published* duration in ms — `undefined` on anything live. */
  durationMs: number | undefined
  live: boolean
  ready: boolean
  /**
   * The current entry's chapters, pulled by the composition root when the
   * player says they may have changed — a list, not a subscription.
   */
  chapters: readonly ChapterEntry[]
  onSeek: (seconds: number) => void
}): React.JSX.Element {
  const durationSeconds = durationMs === undefined ? undefined : durationMs / 1000
  // `chapter` is `undefined` on an entry with no chapters and `-1` before the
  // first one starts; both mean "nothing to name here".
  const chapter =
    shell.chapter === undefined || shell.chapter < 0
      ? undefined
      : chapters[shell.chapter]
  const chapterLabel =
    chapter === undefined
      ? undefined
      : (chapter.title ?? `Chapter ${String((shell.chapter ?? 0) + 1)}`)

  return (
    <View style={styles.container}>
      <Artwork track={track} />

      <View style={styles.headline}>
        {/* The live fact reads as type, not as a sticker on the artwork: a red
            dot and the word, on their own line above the title. */}
        {live ? (
          <View style={styles.onAir}>
            <Dot color={COLORS.live} />
            <Text style={styles.onAirLabel}>ON AIR</Text>
          </View>
        ) : null}
        <Text numberOfLines={2} style={styles.title}>
          {track?.title ?? '—'}
        </Text>
        <Text numberOfLines={1} style={styles.artist}>
          {track?.artist ?? ''}
        </Text>
        {/* What is actually on air right now, straight from the ICY stream. */}
        {song === undefined ? null : (
          <Text numberOfLines={2} style={styles.song}>
            ♪ {song}
          </Text>
        )}
        {station === undefined || !live ? null : (
          <Text numberOfLines={1} style={styles.station}>
            {station}
          </Text>
        )}
        {chapterLabel === undefined ? null : (
          <Text numberOfLines={1} style={styles.chapter}>
            ▸ {chapterLabel}
            <Text style={styles.chapterCount}>
              {'  '}
              {String((shell.chapter ?? 0) + 1)}/{String(chapters.length)}
            </Text>
          </Text>
        )}
      </View>

      <View style={styles.statusRow}>
        <Dot color={STATUS_COLOR[shell.status]} />
        <Text style={styles.status}>
          {shell.status}
          {/* Present only while stalled — mpv's own "% until we unpause". */}
          {shell.bufferingPercent === undefined
            ? ''
            : ` ${String(Math.round(shell.bufferingPercent))}%`}
        </Text>
        <Text style={styles.clock}>
          {formatTime(progress.position)}
          <Text style={styles.clockDim}>
            {' / '}
            {live ? 'live' : formatTime(durationSeconds)}
          </Text>
        </Text>
      </View>

      {/*
        The scrubber reads the *published* duration, not `state.duration`, so
        it goes to its live presentation on exactly the entries where the
        notification drops its seek bar. `onSeek` is the same call the remote
        `seekTo` command makes — one path, one place to break.
      */}
      <SeekBar
        position={progress.position}
        duration={durationSeconds}
        buffered={progress.buffered}
        live={live}
        disabled={!ready}
        onSeek={onSeek}
      />
    </View>
  )
}

/**
 * Remote artwork, with a typographic fallback.
 *
 * Two of the queue entries ship no `artworkUri`, and a music app with a hole
 * in it looks broken — so the fallback is a designed state rather than an
 * empty box. The sleeve keeps a small radius (it is an object, not a
 * container) and nothing else: no frame, no shadow, no colour bleed.
 */
const Artwork = React.memo(function Artwork({
  track,
}: {
  track: Track | undefined
}): React.JSX.Element {
  const uri = track?.artworkUri
  return uri === undefined ? (
    <View style={[styles.art, styles.artFallback]}>
      <Text style={styles.artInitial}>
        {(track?.title ?? '♪').slice(0, 1).toUpperCase()}
      </Text>
    </View>
  ) : (
    <Image source={{ uri }} style={styles.art} resizeMode="cover" />
  )
})

const ART = 224

const styles = StyleSheet.create({
  container: { alignSelf: 'stretch', alignItems: 'center', gap: SPACE.lg },
  art: {
    width: ART,
    height: ART,
    borderRadius: RADIUS.md,
    backgroundColor: COLORS.surface,
  },
  artFallback: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  artInitial: { fontSize: 72, fontWeight: '200', color: COLORS.border },
  onAir: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACE.xs,
    marginBottom: 2,
  },
  onAirLabel: {
    fontSize: TYPE.micro,
    fontWeight: '800',
    letterSpacing: 1.6,
    color: COLORS.live,
  },
  headline: { alignSelf: 'stretch', alignItems: 'center', gap: 2 },
  title: {
    fontSize: TYPE.hero,
    fontWeight: '700',
    letterSpacing: -0.4,
    textAlign: 'center',
    color: COLORS.text,
  },
  artist: { fontSize: TYPE.body, color: COLORS.muted },
  song: {
    marginTop: SPACE.xs,
    fontSize: TYPE.body,
    fontStyle: 'italic',
    textAlign: 'center',
    color: COLORS.accentBright,
  },
  station: { fontSize: TYPE.micro, color: COLORS.muted, letterSpacing: 0.3 },
  chapter: { fontSize: TYPE.micro, color: COLORS.text, letterSpacing: 0.3 },
  chapterCount: { color: COLORS.muted },
  statusRow: {
    alignSelf: 'stretch',
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACE.sm,
  },
  status: {
    flex: 1,
    fontSize: TYPE.micro,
    fontWeight: '700',
    letterSpacing: 1.2,
    textTransform: 'uppercase',
    color: COLORS.muted,
  },
  clock: {
    fontSize: TYPE.title,
    fontWeight: '600',
    fontVariant: ['tabular-nums'],
    color: COLORS.text,
  },
  clockDim: { fontWeight: '400', color: COLORS.muted },
})
