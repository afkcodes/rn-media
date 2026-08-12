/**
 * Normalising a raw tag map into the fields every music app actually renders.
 *
 * @packageDocumentation
 */

/**
 * The tags a now-playing screen needs, normalised across tag formats.
 *
 * Every field is optional, because every field genuinely is: a bare MP3 with no
 * tags produces `{}`, and a live stream produces a `station` and a
 * `streamTitle` and nothing else.
 */
export interface CommonMetadata {
  /** Track title (`title`, or a live stream's `icy-title`). */
  readonly title?: string
  /** Performing artist (`artist`, `author`, `icy-name` is *not* used here). */
  readonly artist?: string
  /** Album / release name (`album`). */
  readonly album?: string
  /** Album artist (`album_artist`, `albumartist`, ID3's `TPE2`). */
  readonly albumArtist?: string
  /** Track number within the disc, as a number (`track`, `tracknumber`). */
  readonly trackNumber?: number
  /** Total tracks, when the tag carried the `3/12` form. */
  readonly trackCount?: number
  /** Disc number (`disc`, `discnumber`, ID3's `TPOS`). */
  readonly discNumber?: number
  /** Total discs, when the tag carried the `1/2` form. */
  readonly discCount?: number
  /** Release year, extracted from `date` / `year` / `originaldate`. */
  readonly year?: number
  /** Genre (`genre`, or a stream's `icy-genre`). */
  readonly genre?: string
  /** Composer (`composer`). */
  readonly composer?: string
  /** Free-text comment (`comment`, `description`). */
  readonly comment?: string
  /** Station name of an Icecast/Shoutcast stream (`icy-name`). */
  readonly station?: string
  /**
   * The stream's current now-playing line (`icy-title`), verbatim.
   *
   * Kept separate from {@link title} even though it also *feeds* it: stations
   * conventionally send `Artist - Title` in one string, and an app that wants
   * to split it needs the original rather than this library's guess. This
   * library never splits it.
   */
  readonly streamTitle?: string
  /** Advertised stream bitrate in kbit/s (`icy-br`). */
  readonly bitrateKbps?: number
}

/** A raw mpv tag map, as {@link Player.getMetadata} returns it. */
type TagMap = Readonly<Record<string, string>>

/**
 * Read the first tag present, by lower-cased name.
 *
 * mpv preserves the demuxer's own spelling in the map — FLAC/Vorbis usually
 * upper-cases (`TITLE`), ID3 through libavformat lower-cases (`title`), MP4
 * yields `©nam` mapped to `title`, and ICY arrives as `icy-title` — so the map
 * is folded to lower case once and every lookup is done there.
 */
function pick(tags: TagMap, ...names: readonly string[]): string | undefined {
  for (const name of names) {
    const value = tags[name]
    if (value !== undefined && value.trim() !== '') return value.trim()
  }
  return undefined
}

/**
 * Parse the `<n>` or `<n>/<total>` form used by `track` and `disc`.
 *
 * ID3v2 defines both halves in one frame (`TRCK` = "4/12"), Vorbis comments
 * usually split them across `TRACKNUMBER`/`TRACKTOTAL`, and plenty of files do
 * something in between. Both halves are returned when present; a value that is
 * not a number at all yields nothing rather than `NaN`.
 */
function parsePair(value: string | undefined): {
  readonly index?: number
  readonly total?: number
} {
  if (value === undefined) return {}
  const [rawIndex, rawTotal] = value.split('/', 2)
  const index = toInteger(rawIndex)
  const total = toInteger(rawTotal)
  return {
    ...(index !== undefined ? { index } : {}),
    ...(total !== undefined ? { total } : {}),
  }
}

function toInteger(value: string | undefined): number | undefined {
  if (value === undefined) return undefined
  const parsed = Number.parseInt(value.trim(), 10)
  return Number.isFinite(parsed) ? parsed : undefined
}

/**
 * Pull a four-digit year out of a date tag.
 *
 * Date tags are the least consistent thing in music metadata: `2006`,
 * `2006-05-01`, `2006/05/01`, `01/05/2006`, and ID3v2.3's separate `TYER`. Only
 * a leading or trailing four-digit group in a plausible range is trusted;
 * anything else yields nothing, because a wrong year on a library screen is
 * worse than a missing one.
 */
function parseYear(value: string | undefined): number | undefined {
  if (value === undefined) return undefined
  const match = /(?:^|\D)(\d{4})(?:\D|$)/u.exec(value)
  const year = toInteger(match?.[1])
  if (year === undefined) return undefined
  return year >= 1000 && year <= 9999 ? year : undefined
}

/**
 * Normalise a raw mpv tag map into {@link CommonMetadata}.
 *
 * @param metadata - The map from `Player.getMetadata()`.
 * @returns The normalised view. Fields with no usable tag are absent, never
 * empty strings.
 *
 * @remarks
 * **The whole mapping table, so nothing here is a mystery.** The left column is
 * matched case-insensitively, in order, and the first non-empty tag wins:
 *
 * | field | tags, in priority order |
 * | --- | --- |
 * | `title` | `title`, `icy-title` |
 * | `artist` | `artist`, `author`, `performer` |
 * | `album` | `album` |
 * | `albumArtist` | `album_artist`, `albumartist`, `album artist`, `tpe2` |
 * | `trackNumber` / `trackCount` | `track`, `tracknumber`, `trck` (+ `tracktotal`, `totaltracks`) |
 * | `discNumber` / `discCount` | `disc`, `discnumber`, `tpos` (+ `disctotal`, `totaldiscs`) |
 * | `year` | `date`, `year`, `originaldate`, `originalyear`, `tyer` |
 * | `genre` | `genre`, `icy-genre` |
 * | `composer` | `composer` |
 * | `comment` | `comment`, `description` |
 * | `station` | `icy-name` |
 * | `streamTitle` | `icy-title` |
 * | `bitrateKbps` | `icy-br` |
 *
 * Everything else in the file is still in `getMetadata()`; this is a
 * convenience over that map, not a filter on it. It reads the map it is given
 * and performs no I/O, which is what makes it testable with a plain object —
 * and why it is exported rather than hidden inside the player.
 */
export function toCommonMetadata(metadata: TagMap): CommonMetadata {
  const tags: Record<string, string> = {}
  for (const [key, value] of Object.entries(metadata)) {
    // Last spelling wins only if the earlier one was empty — mpv can carry both
    // `TITLE` and `title` when a file has ID3 *and* Vorbis tags.
    const folded = key.toLowerCase()
    const existing = tags[folded]
    if (existing === undefined || existing.trim() === '') tags[folded] = value
  }

  const track = parsePair(
    pick(tags, 'track', 'tracknumber', 'trck') ?? undefined
  )
  const trackTotal = toInteger(pick(tags, 'tracktotal', 'totaltracks'))
  const disc = parsePair(pick(tags, 'disc', 'discnumber', 'tpos') ?? undefined)
  const discTotal = toInteger(pick(tags, 'disctotal', 'totaldiscs'))

  const title = pick(tags, 'title', 'icy-title')
  const artist = pick(tags, 'artist', 'author', 'performer')
  const album = pick(tags, 'album')
  const albumArtist = pick(
    tags,
    'album_artist',
    'albumartist',
    'album artist',
    'tpe2'
  )
  const year = parseYear(
    pick(tags, 'date', 'year', 'originaldate', 'originalyear', 'tyer')
  )
  const genre = pick(tags, 'genre', 'icy-genre')
  const composer = pick(tags, 'composer')
  const comment = pick(tags, 'comment', 'description')
  const station = pick(tags, 'icy-name')
  const streamTitle = pick(tags, 'icy-title')
  const bitrateKbps = toInteger(pick(tags, 'icy-br'))
  const trackNumber = track.index
  const trackCount = track.total ?? trackTotal
  const discNumber = disc.index
  const discCount = disc.total ?? discTotal

  return {
    ...(title !== undefined ? { title } : {}),
    ...(artist !== undefined ? { artist } : {}),
    ...(album !== undefined ? { album } : {}),
    ...(albumArtist !== undefined ? { albumArtist } : {}),
    ...(trackNumber !== undefined ? { trackNumber } : {}),
    ...(trackCount !== undefined ? { trackCount } : {}),
    ...(discNumber !== undefined ? { discNumber } : {}),
    ...(discCount !== undefined ? { discCount } : {}),
    ...(year !== undefined ? { year } : {}),
    ...(genre !== undefined ? { genre } : {}),
    ...(composer !== undefined ? { composer } : {}),
    ...(comment !== undefined ? { comment } : {}),
    ...(station !== undefined ? { station } : {}),
    ...(streamTitle !== undefined ? { streamTitle } : {}),
    ...(bitrateKbps !== undefined ? { bitrateKbps } : {}),
  }
}
