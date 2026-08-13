import { describe, expect, it } from 'vitest'

import { canCastMedia, castabilityTables } from '../can-cast'

describe('canCastMedia', () => {
  describe('local files', () => {
    it.each([
      'file:///sdcard/Music/track.mp3',
      'content://media/external/audio/1',
      'asset://sounds/intro.wav',
      '/absolute/path/track.flac',
      'relative/path/track.mp3',
    ])('rejects %s as local-file', (url) => {
      expect(canCastMedia({ url })).toEqual({
        castable: false,
        reason: 'local-file',
      })
    })

    it('local-file wins over every other reason', () => {
      // A local ALAC with headers: the fundamental blocker is that the
      // receiver can never fetch it.
      expect(
        canCastMedia({
          url: 'file:///music/track.alac',
          headers: { Authorization: 'Bearer x' },
        })
      ).toEqual({ castable: false, reason: 'local-file' })
    })
  })

  describe('headers', () => {
    it('rejects sources needing per-request headers', () => {
      expect(
        canCastMedia({
          url: 'https://cdn.example.com/track.mp3',
          headers: { Authorization: 'Bearer token' },
        })
      ).toEqual({ castable: false, reason: 'headers' })
    })

    it('an empty headers object is no headers', () => {
      expect(
        canCastMedia({ url: 'https://cdn.example.com/track.mp3', headers: {} })
      ).toEqual({ castable: true })
    })
  })

  describe('codec table — extensions', () => {
    it.each([...castabilityTables.castableExtensions])('accepts .%s', (ext) => {
      expect(
        canCastMedia({ url: `https://cdn.example.com/track.${ext}` })
      ).toEqual({ castable: true })
    })

    it.each([...castabilityTables.notCastableExtensions])(
      'rejects .%s as codec',
      (ext) => {
        expect(
          canCastMedia({ url: `https://cdn.example.com/track.${ext}` })
        ).toEqual({ castable: false, reason: 'codec' })
      }
    )

    it('extension casing and query strings do not matter', () => {
      expect(
        canCastMedia({ url: 'https://cdn.example.com/TRACK.APE?sig=abc#f' })
      ).toEqual({ castable: false, reason: 'codec' })
      expect(
        canCastMedia({ url: 'https://cdn.example.com/TRACK.MP3?sig=abc' })
      ).toEqual({ castable: true })
    })

    it('no extension (live streams, signed URLs) is castable — the heuristic only denies what the table denies', () => {
      expect(canCastMedia({ url: 'https://ice.example.com/stream' })).toEqual({
        castable: true,
      })
      expect(canCastMedia({ url: 'https://cdn.example.com/v1/play' })).toEqual({
        castable: true,
      })
    })

    it('an unknown extension is castable (receiver gets the final say)', () => {
      expect(
        canCastMedia({ url: 'https://cdn.example.com/track.weird' })
      ).toEqual({ castable: true })
    })
  })

  describe('codec table — MIME types', () => {
    it.each([...castabilityTables.castableMimeTypes])('accepts %s', (mime) => {
      expect(
        canCastMedia({ url: 'https://x.example.com/a', mimeType: mime })
      ).toEqual({ castable: true })
    })

    it('MIME parameters and casing are stripped before the lookup', () => {
      expect(
        canCastMedia({
          url: 'https://x.example.com/a',
          mimeType: 'Audio/MP4; codecs="mp4a.40.2"',
        })
      ).toEqual({ castable: true })
    })

    it('an off-table audio/* MIME is a codec rejection even with a friendly extension', () => {
      expect(
        canCastMedia({
          url: 'https://x.example.com/track.mp3',
          mimeType: 'audio/x-ms-wma',
        })
      ).toEqual({ castable: false, reason: 'codec' })
    })

    it('a non-audio MIME falls through to the extension heuristic', () => {
      expect(
        canCastMedia({
          url: 'https://x.example.com/track.wv',
          mimeType: 'application/octet-stream',
        })
      ).toEqual({ castable: false, reason: 'codec' })
      expect(
        canCastMedia({
          url: 'https://x.example.com/track.mp3',
          mimeType: 'application/octet-stream',
        })
      ).toEqual({ castable: true })
    })
  })

  describe('the tables themselves', () => {
    it('no extension is both castable and not castable', () => {
      for (const ext of castabilityTables.castableExtensions) {
        expect(castabilityTables.notCastableExtensions.has(ext)).toBe(false)
      }
    })

    it('the honest-ceilings list from the design doc is all present', () => {
      // ALAC, hi-res FLAC (undetectable), WMA, APE, WavPack, TTA, DSD, AIFF,
      // .mka, AC-3/DTS, tracker formats — the documented not-castable set.
      for (const ext of [
        'alac',
        'wma',
        'ape',
        'wv',
        'tta',
        'dsf',
        'dff',
        'aiff',
        'mka',
        'ac3',
        'dts',
        'mod',
      ]) {
        expect(castabilityTables.notCastableExtensions.has(ext)).toBe(true)
      }
    })
  })
})
