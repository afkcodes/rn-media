/**
 * Castability heuristic against the Google Cast receiver codec table.
 *
 * Source of truth: https://developers.google.com/cast/docs/media (verified
 * 2026-08-13). Cast audio receivers (Chromecast built-in speakers included)
 * decode: HE-AAC, LC-AAC, MP3, FLAC (≤ 96 kHz / 24-bit), Opus, Vorbis,
 * WAV (LPCM) and WebM audio. mpv plays far more than that — this function
 * exists so apps can grey the cast route out per track instead of failing at
 * load time with a `cast-receiver-fetch` error.
 */

export interface CanCastInput {
  /** The URL (or local path) the receiver would be asked to fetch. */
  url: string
  /** Concrete MIME type when known — beats the extension heuristic. */
  mimeType?: string
  /** Per-request auth headers the source needs, if any. */
  headers?: Record<string, string>
}

export interface CanCastVerdict {
  castable: boolean
  /**
   * Why not, when `castable` is `false`:
   * - `codec` — the receiver codec table has no decoder for this format.
   * - `local-file` — the receiver fetches URLs itself; `file://`/`content://`
   *   and bare filesystem paths are unreachable from it (no local HTTP server
   *   in v1 — a documented decision, not an oversight).
   * - `headers` — per-source auth headers do not travel: the Default Media
   *   Receiver cannot attach them. Signed-query URLs work; header-auth needs
   *   a custom Web Receiver plus the `credentials` passthrough.
   */
  reason?: 'codec' | 'local-file' | 'headers'
}

/**
 * Extensions the receiver table covers. FLAC carries a ceiling the URL cannot
 * reveal: > 96 kHz or > 24-bit files will fail receiver-side even though the
 * extension passes here.
 */
const CASTABLE_EXTENSIONS: ReadonlySet<string> = new Set([
  'aac', // LC-AAC / HE-AAC elementary stream
  'm4a', // AAC in MP4
  'm4b', // AAC audiobook container (same demuxer)
  'mp4', // audio-only MP4
  'mp3',
  'flac', // ≤ 96 kHz / 24-bit only — not detectable from the name
  'opus',
  'ogg', // Vorbis/Opus
  'oga',
  'wav', // LPCM
  'webm', // Vorbis/Opus audio
])

/**
 * Extensions mpv decodes but no Cast receiver does — the honest-ceilings list
 * from the design doc: ALAC, WMA, APE, WavPack, TTA, DSD, AIFF, Matroska
 * audio, AC-3/DTS-as-audio, tracker/module formats.
 */
const NOT_CASTABLE_EXTENSIONS: ReadonlySet<string> = new Set([
  'alac',
  'wma',
  'ape',
  'wv',
  'tta',
  'dsf',
  'dff',
  'aiff',
  'aif',
  'aifc',
  'mka',
  'ac3',
  'eac3',
  'dts',
  'mod',
  'xm',
  's3m',
  'it',
  'mpc',
  'shn',
])

/** MIME types (bare, parameters stripped) the receiver table covers. */
const CASTABLE_MIME_TYPES: ReadonlySet<string> = new Set([
  'audio/aac',
  'audio/aacp',
  'audio/mp4',
  'audio/x-m4a',
  'audio/mp3',
  'audio/mpeg',
  'audio/flac',
  'audio/x-flac',
  'audio/opus',
  'audio/ogg',
  'audio/vorbis',
  'audio/wav',
  'audio/x-wav',
  'audio/webm',
  'application/x-mpegurl', // HLS with audio segments
  'application/vnd.apple.mpegurl',
  'application/dash+xml',
])

/**
 * Can this item be handed to a Cast receiver?
 *
 * Decision order (most fundamental first):
 * 1. **local-file** — non-HTTP(S) sources can never cast; nothing else
 *    matters.
 * 2. **headers** — the receiver fetches without them, so the fetch would 401.
 * 3. **codec** — MIME type when supplied, else the URL extension, against the
 *    receiver table. An extension we cannot classify (or no extension at all
 *    — live streams, signed URLs) is reported castable: this heuristic only
 *    *denies* what the table denies, and the `cast-receiver-fetch` error
 *    family catches the receiver's own verdict at load time.
 *
 * Ceilings the URL cannot reveal (documented, not detected): FLAC above
 * 96 kHz/24-bit; ALAC inside a `.m4a` (the extension says AAC).
 */
export function canCastMedia(item: CanCastInput): CanCastVerdict {
  if (isLocalSource(item.url)) {
    return { castable: false, reason: 'local-file' }
  }

  if (item.headers !== undefined && Object.keys(item.headers).length > 0) {
    return { castable: false, reason: 'headers' }
  }

  const mime = normalizeMimeType(item.mimeType)
  if (mime !== null) {
    if (CASTABLE_MIME_TYPES.has(mime)) return { castable: true }
    // An audio/* type not on the table is a codec verdict; anything else
    // (application/octet-stream and friends) is unclassifiable — fall through
    // to the extension.
    if (mime.startsWith('audio/')) {
      return { castable: false, reason: 'codec' }
    }
  }

  const extension = extensionOf(item.url)
  if (extension !== null) {
    if (NOT_CASTABLE_EXTENSIONS.has(extension)) {
      return { castable: false, reason: 'codec' }
    }
  }
  return { castable: true }
}

/** `file://`, `content://` (Android), `asset://`, or a bare filesystem path. */
function isLocalSource(url: string): boolean {
  const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(url)
  if (scheme?.[1] !== undefined) {
    const s = scheme[1].toLowerCase()
    return s === 'file' || s === 'content' || s === 'asset'
  }
  // No scheme at all: a filesystem path (absolute or relative).
  return true
}

/** Lowercased bare MIME type with parameters stripped, or null. */
function normalizeMimeType(mimeType: string | undefined): string | null {
  if (mimeType === undefined) return null
  const bare = mimeType.split(';')[0]?.trim().toLowerCase()
  return bare === undefined || bare === '' ? null : bare
}

/** Lowercased extension of the URL path (query/fragment stripped), or null. */
function extensionOf(url: string): string | null {
  const path = url.split(/[?#]/, 1)[0] ?? url
  const lastSegment = path.split('/').pop() ?? ''
  const dot = lastSegment.lastIndexOf('.')
  if (dot <= 0 || dot === lastSegment.length - 1) return null
  return lastSegment.slice(dot + 1).toLowerCase()
}

/** Exported for tests: the tables are the spec, so tests pin them. */
export const castabilityTables = {
  castableExtensions: CASTABLE_EXTENSIONS,
  notCastableExtensions: NOT_CASTABLE_EXTENSIONS,
  castableMimeTypes: CASTABLE_MIME_TYPES,
} as const
