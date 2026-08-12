import { describe, expect, it } from 'vitest'
import { toCommonMetadata } from '../common-metadata'

describe('toCommonMetadata', () => {
  it('normalises an ID3 tag map', () => {
    expect(
      toCommonMetadata({
        title: 'Blue in Green',
        artist: 'Miles Davis',
        album: 'Kind of Blue',
        album_artist: 'Miles Davis',
        track: '3/5',
        disc: '1/1',
        date: '1959-08-17',
        genre: 'Jazz',
        composer: 'Bill Evans',
        comment: 'Columbia CL 1355',
      })
    ).toEqual({
      title: 'Blue in Green',
      artist: 'Miles Davis',
      album: 'Kind of Blue',
      albumArtist: 'Miles Davis',
      trackNumber: 3,
      trackCount: 5,
      discNumber: 1,
      discCount: 1,
      year: 1959,
      genre: 'Jazz',
      composer: 'Bill Evans',
      comment: 'Columbia CL 1355',
    })
  })

  it('normalises upper-cased Vorbis/FLAC spellings', () => {
    expect(
      toCommonMetadata({
        TITLE: 'Ghosts',
        ARTIST: 'Japan',
        ALBUMARTIST: 'Japan',
        TRACKNUMBER: '4',
        TRACKTOTAL: '9',
        DISCNUMBER: '1',
        DATE: '1981',
      })
    ).toEqual({
      title: 'Ghosts',
      artist: 'Japan',
      albumArtist: 'Japan',
      trackNumber: 4,
      trackCount: 9,
      discNumber: 1,
      year: 1981,
    })
  })

  it('reads the ID3 frame spellings libavformat sometimes passes through', () => {
    expect(
      toCommonMetadata({ TPE2: 'Various Artists', TPOS: '2/3', TYER: '1994' })
    ).toEqual({
      albumArtist: 'Various Artists',
      discNumber: 2,
      discCount: 3,
      year: 1994,
    })
  })

  it('normalises an ICY radio stream', () => {
    const common = toCommonMetadata({
      'icy-name': 'Radio Paradise',
      'icy-title': 'Talk Talk - Life’s What You Make It',
      'icy-genre': 'Eclectic',
      'icy-br': '320',
    })
    expect(common.station).toBe('Radio Paradise')
    expect(common.streamTitle).toBe('Talk Talk - Life’s What You Make It')
    // The now-playing line also feeds `title`, because on a stream that is what
    // a title is — but it is never split into artist/title by this library.
    expect(common.title).toBe('Talk Talk - Life’s What You Make It')
    expect(common.artist).toBeUndefined()
    expect(common.genre).toBe('Eclectic')
    expect(common.bitrateKbps).toBe(320)
  })

  it('prefers a real title tag over the stream title', () => {
    const common = toCommonMetadata({ 'title': 'Real', 'icy-title': 'Stream' })
    expect(common.title).toBe('Real')
    expect(common.streamTitle).toBe('Stream')
  })

  it('extracts a year from every date spelling it trusts, and nothing else', () => {
    expect(toCommonMetadata({ date: '2006' }).year).toBe(2006)
    expect(toCommonMetadata({ date: '2006-05-01' }).year).toBe(2006)
    expect(toCommonMetadata({ date: '01/05/2006' }).year).toBe(2006)
    expect(toCommonMetadata({ date: 'MMVI' }).year).toBeUndefined()
    expect(toCommonMetadata({ date: '06' }).year).toBeUndefined()
  })

  it('drops empty and whitespace-only tags rather than reporting them', () => {
    expect(toCommonMetadata({ title: '   ', artist: '' })).toEqual({})
    expect(toCommonMetadata({ title: '  Padded  ' }).title).toBe('Padded')
  })

  it('survives a file with both ID3 and Vorbis tags', () => {
    // mpv hands both spellings through; the first non-empty one wins, and an
    // empty duplicate never shadows a real value.
    expect(toCommonMetadata({ TITLE: '', title: 'Real' }).title).toBe('Real')
  })

  it('returns an empty object for an untagged file', () => {
    expect(toCommonMetadata({})).toEqual({})
  })

  it('ignores a track tag that is not a number', () => {
    expect(toCommonMetadata({ track: 'A1' }).trackNumber).toBeUndefined()
  })
})
