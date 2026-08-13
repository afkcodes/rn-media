/**
 * The cast → media-session projections, pinned without a device — the same
 * treatment `output.ts` gets: pure modules, workspace packages imported as
 * types only, plain Node.
 */
import { describe, expect, it } from 'vitest'
import type { CastReceiverSnapshot } from '@rn-media/cast'
import {
  DEMO_BROKEN_TARGET,
  DEMO_BROKEN_URI,
  TRACKS,
  type Track,
} from '../../data/tracks'
import {
  castMimeOf,
  castUrlOf,
  toCastMediaItem,
  toCastPlaybackState,
  toCastStatus,
} from '../cast-broadcast'

function snapshot(
  overrides: Partial<CastReceiverSnapshot> = {}
): CastReceiverSnapshot {
  return {
    playerState: 'playing',
    idleReason: 'none',
    playing: true,
    itemIndex: 4,
    position: 61.25,
    at: 1_755_000_000_000,
    rate: 1,
    duration: 180.4,
    queueEnded: false,
    ...overrides,
  }
}

describe('toCastStatus', () => {
  it('maps the receiver player states onto the media-session vocabulary', () => {
    expect(toCastStatus(snapshot({ playerState: 'playing' }))).toBe('playing')
    expect(toCastStatus(snapshot({ playerState: 'paused' }))).toBe('paused')
    expect(toCastStatus(snapshot({ playerState: 'buffering' }))).toBe('buffering')
    expect(toCastStatus(snapshot({ playerState: 'loading' }))).toBe('buffering')
    expect(toCastStatus(snapshot({ playerState: 'unknown' }))).toBe('buffering')
  })

  it('renders idle as stopped only when the queue actually finished', () => {
    expect(
      toCastStatus(snapshot({ playerState: 'idle', queueEnded: true }))
    ).toBe('stopped')
    expect(
      toCastStatus(snapshot({ playerState: 'idle', queueEnded: false }))
    ).toBe('paused')
  })
})

describe('toCastPlaybackState', () => {
  it('carries the receiver anchor as a ms PositionAnchor — a discontinuity, not a ticker', () => {
    const state = toCastPlaybackState(snapshot())
    expect(state.position).toEqual({
      value: 61_250,
      at: 1_755_000_000_000,
      rate: 1,
    })
    expect(state.queueIndex).toBe(4)
    expect(state.status).toBe('playing')
  })

  it('keeps the frozen rate the handoff computed — paused receivers do not drift', () => {
    const state = toCastPlaybackState(snapshot({ playerState: 'paused', rate: 0 }))
    expect(state.position.rate).toBe(0)
  })

  it('offers no repeat/shuffle controls — nothing wires them to the receiver', () => {
    const state = toCastPlaybackState(snapshot())
    expect(state.controls).toEqual(['skipToPrevious', 'stop', 'skipToNext'])
    expect(state.capabilities).not.toContain('setRepeatMode')
    expect(state.capabilities).not.toContain('setShuffle')
    expect(state.capabilities).toContain('seek')
  })
})

describe('toCastMediaItem', () => {
  const aariAari = TRACKS[4] as Track

  it('metadata comes from the JS queue (the source of truth), duration from the receiver', () => {
    const item = toCastMediaItem(aariAari, snapshot())
    expect(item).toMatchObject({
      id: 'aari-aari',
      title: aariAari.title,
      artist: aariAari.artist,
      artworkUri: aariAari.artworkUri,
      // 180.4 s → 180 400 ms: milliseconds carry the receiver's sub-second
      // truth (rounding the SECONDS first — the old bug — lost up to 500 ms).
      duration: 180_400,
    })
  })

  it('a live entry never gets a duration, whatever the receiver reports', () => {
    const live = TRACKS[0] as Track
    const item = toCastMediaItem(live, snapshot({ duration: 4_000 }))
    expect(item.duration).toBeUndefined()
    expect(item.isLive).toBe(true)
  })
})

describe('castUrlOf / castMimeOf — the resolver seam', () => {
  it('passes plain HTTPS sources through untouched', () => {
    const track = TRACKS[3] as Track
    expect(castUrlOf(track)).toBe(track.uri)
    expect(castMimeOf(track)).toBe('audio/mpeg')
  })

  it('resolves demo:// through the catalogue, like the player resolver does', () => {
    const resolved = TRACKS[5] as Track
    expect(resolved.uri.startsWith('demo://')).toBe(true)
    expect(castUrlOf(resolved)).toMatch(/^https:\/\/aac\.saavncdn\.com\//)
    expect(castMimeOf(resolved)).toBe('audio/mp4')
  })

  it('resolves the broken entry to the refused-connection target — the receiver-fetch demo', () => {
    const broken = TRACKS[6] as Track
    expect(broken.uri).toBe(DEMO_BROKEN_URI)
    expect(castUrlOf(broken)).toBe(DEMO_BROKEN_TARGET)
  })

  it('classifies HLS playlists and the Shoutcast stream by their real types', () => {
    expect(castMimeOf(TRACKS[1] as Track)).toBe('application/x-mpegurl')
    expect(castMimeOf(TRACKS[0] as Track)).toBe('audio/aacp')
  })

  it('the local-file entry keeps its file:// URL — canCastMedia’s local-file case', () => {
    const local = TRACKS[7] as Track
    expect(castUrlOf(local).startsWith('file://')).toBe(true)
    expect(castMimeOf(local)).toBe('audio/ogg')
  })
})
