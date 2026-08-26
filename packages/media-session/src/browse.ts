/**
 * The car browse tree: the one place the Android Auto and CarPlay shapes are
 * turned into the bridge's shape.
 *
 * Everything here is **pure**. The root cap, the error mapping, the defaults
 * and the focus widening all run in Node under vitest, and both platforms get
 * the identical answer because they call the identical function — which is what
 * "parity is a gate" has to mean for a feature whose two halves are written in
 * different languages by different lanes.
 */
import { invalidArgument } from './errors'
import type {
  BrowseItem,
  BrowseStyle,
  CarConnection,
  SearchFocus,
} from './types'
import type {
  BrowseErrorCode,
  BrowseMediaType,
  NativeBrowseError,
  NativeBrowseItem,
  NativeBrowseResult,
  NativeSearchFocus,
} from './specs/media-session.nitro'

/**
 * The id the car asks for when it wants the **root tabs**.
 *
 * A constant rather than `''` or `null` because it is also a legal argument to
 * {@link MediaServiceApi.invalidateBrowse} and it travels through the same
 * native cache as every other parent. The value matches the media3 session's
 * own root media id, so a `MediaBrowser` that read the root item and a handler
 * that hard-coded the constant are asking the same question.
 */
export const BROWSE_ROOT = 'rn-media-root'

/**
 * How many tabs the root may have.
 *
 * Google, on the content hierarchy: *"expect this number to be four"*. Android
 * Auto's own root hint (`EXTRAS_KEY_ROOT_CHILDREN_LIMIT`) can be smaller and is
 * honoured natively on top of this; CarPlay's `CPTabBarTemplate.maximumTabCount`
 * is a runtime value on the same footing. This is the floor both platforms
 * agree on, applied in TypeScript so a tree that works on one car works on the
 * other.
 *
 * https://developer.android.com/training/cars/media/create-media-browser/content-hierarchy
 */
export const MAX_ROOT_TABS = 4

/**
 * Throw this (or reject with it) from any browse method to put the car's
 * sign-in / upgrade screen on screen instead of an empty list.
 *
 * ```ts
 * override async getChildren(parentId: string) {
 *   if (!this.session) {
 *     throw new BrowseError('authenticationExpired', 'Sign in to browse your library.', {
 *       label: 'Sign in',
 *       url: 'myapp://signin',
 *     })
 *   }
 *   …
 * }
 * ```
 *
 * ## What each platform actually draws
 * - **CarPlay** draws all five codes as an alert with the message, plus the
 *   resolution button when one is given.
 * - **Android Auto** is narrower, and honestly so: media3 replicates a library
 *   error into the platform playback state — the thing a legacy browser like
 *   Android Auto renders — for `authenticationExpired` and
 *   `parentalControlRestricted` **only** (`MediaLibrarySessionImpl
 *   .isReplicationErrorCode`, media3 1.11.0). The other three are returned
 *   faithfully as a `LibraryResult` error and are shown by Auto as an empty
 *   list. Use `authenticationExpired` for anything you want a button on.
 */
export class BrowseError extends Error {
  /**
   * Always `'BrowseError'`, and load-bearing: {@link isBrowseError} tests this
   * rather than `instanceof`, so an error thrown by a copy of this package
   * inside a monorepo (or across a bundle boundary) is still recognised.
   */
  override readonly name = 'BrowseError'

  constructor(
    readonly code: BrowseErrorCode,
    message: string,
    /**
     * An optional button under the message: a label and a deep link **your app
     * handles**. The phone opens the URL; the car cannot render your sign-in
     * form itself.
     */
    readonly resolution?: { label: string; url: string }
  ) {
    super(message)
  }
}

/** Structural {@link BrowseError} test — see {@link BrowseError.name}. */
export function isBrowseError(error: unknown): error is BrowseError {
  return (
    error instanceof Error &&
    error.name === 'BrowseError' &&
    typeof (error as BrowseError).code === 'string'
  )
}

/* -------------------------------------------------------------------------- */
/*                                  Mapping                                   */
/* -------------------------------------------------------------------------- */

const MEDIA_TYPES: ReadonlySet<string> = new Set<BrowseMediaType>([
  'mixed',
  'music',
  'podcastEpisode',
  'radioStation',
  'audiobookChapter',
  'folderAlbums',
  'folderArtists',
  'folderGenres',
  'folderPlaylists',
  'folderPodcasts',
  'folderRadioStations',
  'folderMixed',
])

const STYLES: ReadonlySet<string> = new Set<BrowseStyle>([
  'list',
  'grid',
  'categoryList',
  'categoryGrid',
])

const FOCUS_KINDS: ReadonlySet<string> = new Set<SearchFocus['kind']>([
  'any',
  'artist',
  'album',
  'title',
  'genre',
  'playlist',
])

/**
 * Resolve one item's defaults for the bridge.
 *
 * Validation is not decoration here: media3 *throws* on a browse item with an
 * empty media id (`LibraryResult.verifyMediaItem`, 1.11.0), and the throw
 * happens on the session's application thread where the app can neither catch
 * nor see it. Rejecting it in JavaScript turns a native crash into a named
 * error on the channel the app already reads.
 */
export function toNativeBrowseItem(item: BrowseItem): NativeBrowseItem {
  if (typeof item.id !== 'string' || item.id === '') {
    throw invalidArgument(
      'BrowseItem.id must be a non-empty string; media3 rejects a browse item without a media id.'
    )
  }
  if (typeof item.title !== 'string' || item.title === '') {
    throw invalidArgument(
      `BrowseItem.title must be a non-empty string (id "${item.id}").`
    )
  }
  if (
    item.completion !== undefined &&
    (!Number.isFinite(item.completion) ||
      item.completion < 0 ||
      item.completion > 1)
  ) {
    throw invalidArgument(
      `BrowseItem.completion must be between 0 and 1 (id "${item.id}", got ${String(item.completion)}).`
    )
  }
  if (item.childStyle !== undefined && !STYLES.has(item.childStyle)) {
    throw invalidArgument(
      `BrowseItem.childStyle "${String(item.childStyle)}" is not a BrowseStyle (id "${item.id}").`
    )
  }
  if (item.mediaType !== undefined && !MEDIA_TYPES.has(item.mediaType)) {
    throw invalidArgument(
      `BrowseItem.mediaType "${String(item.mediaType)}" is not a BrowseMediaType (id "${item.id}").`
    )
  }
  return {
    id: item.id,
    title: item.title,
    subtitle: item.subtitle,
    artworkUri: item.artworkUri,
    browsable: item.browsable ?? false,
    playable: item.playable ?? false,
    childStyle: item.childStyle,
    group: item.group,
    isExplicit: item.explicit ?? false,
    completion: item.completion,
    mediaType: item.mediaType ?? 'mixed',
  }
}

/** A successful browse answer. */
export function toNativeBrowseResult(items: BrowseItem[]): NativeBrowseResult {
  return { items: items.map(toNativeBrowseItem) }
}

/** A {@link BrowseError} as the error half of a result. */
export function toNativeBrowseError(error: BrowseError): NativeBrowseError {
  const resolution = error.resolution
  return {
    code: error.code,
    message: error.message,
    resolutionLabel: resolution?.label,
    resolutionUrl: resolution?.url,
  }
}

/**
 * The result an unhandled throw becomes.
 *
 * A {@link BrowseError} is the app saying something the car can draw. Anything
 * else is a bug in the handler, and the honest answer to the *car* is an empty
 * list (Google: prefer an empty list to an error code) while the exception goes
 * to `MediaServiceConfig.onHandlerError`, which is where every other handler
 * throw already goes. Never both: a car that shows "sign in" because a
 * `TypeError` escaped would be a lie.
 */
export function errorToNativeBrowseResult(
  error: unknown
): NativeBrowseResult | undefined {
  return isBrowseError(error)
    ? { items: [], error: toNativeBrowseError(error) }
    : undefined
}

/* -------------------------------------------------------------------------- */
/*                                 Root tabs                                  */
/* -------------------------------------------------------------------------- */

/** What {@link capRootTabs} kept, and what it had to drop. */
export interface RootTabs {
  tabs: BrowseItem[]
  /** One human-readable sentence per dropped item. Empty when nothing was. */
  rejected: string[]
}

/**
 * Enforce the two rules every car's root has, in one place for both platforms.
 *
 * 1. **Browsable only.** Android Auto's root supports `FLAG_BROWSABLE` and
 *    nothing else — a playable root entry is not "a shortcut that plays", it is
 *    an entry the car may drop or hide. CarPlay's root is a tab bar of
 *    templates, which a playable leaf cannot be either.
 * 2. **At most {@link MAX_ROOT_TABS}.**
 *
 * Dropping is right and rejecting the whole root is not: a fifth tab must not
 * cost the user the four that fit. But it is never silent — every caller feeds
 * `rejected` to the session-error channel as `browseRootRejected`
 * (ARCHITECTURE §27).
 *
 * @param limit the effective cap; defaults to {@link MAX_ROOT_TABS}. Android
 * passes the browser's own `EXTRAS_KEY_ROOT_CHILDREN_LIMIT` when it is smaller.
 */
export function capRootTabs(
  items: readonly BrowseItem[],
  limit: number = MAX_ROOT_TABS
): RootTabs {
  const tabs: BrowseItem[] = []
  const rejected: string[] = []
  for (const item of items) {
    if (item.browsable !== true) {
      rejected.push(
        `"${item.title}" (${item.id}) is not browsable — a car's root can only hold browsable tabs`
      )
      continue
    }
    if (tabs.length >= limit) {
      rejected.push(
        `"${item.title}" (${item.id}) is over the ${limit}-tab root limit`
      )
      continue
    }
    tabs.push(item)
  }
  return { tabs, rejected }
}

/** The `browseRootRejected` message for a non-empty {@link RootTabs.rejected}. */
export function rootRejectionMessage(rejected: readonly string[]): string {
  return (
    `getChildren(BROWSE_ROOT) returned ${rejected.length} root ` +
    `${rejected.length === 1 ? 'entry' : 'entries'} the car cannot show, and ` +
    `${rejected.length === 1 ? 'it was' : 'they were'} dropped: ` +
    `${rejected.join('; ')}. Return at most ${MAX_ROOT_TABS} browsable items ` +
    `from BROWSE_ROOT and put everything else one level down.`
  )
}

/* -------------------------------------------------------------------------- */
/*                              Inbound widening                              */
/* -------------------------------------------------------------------------- */

/**
 * Widen the bridge's focus struct into the public union.
 *
 * `kind` is a plain string on the bridge because it is parsed from a MIME type
 * the platform may extend (`android.intent.extra.focus`); an unknown one is
 * `'any'`, which is exactly what it means — the assistant could not classify
 * the query.
 */
export function toSearchFocus(focus: NativeSearchFocus): SearchFocus {
  return {
    kind: FOCUS_KINDS.has(focus.kind)
      ? (focus.kind as SearchFocus['kind'])
      : 'any',
    artist: focus.artist,
    album: focus.album,
    title: focus.title,
    genre: focus.genre,
    playlist: focus.playlist,
  }
}

/**
 * Widen the bridge's connection string into the public union.
 *
 * Unknown values are `'none'`: a kind this version of the TypeScript layer does
 * not know about is a kind it cannot describe, and claiming a car is connected
 * would be worse than saying nothing.
 */
export function toCarConnection(kind: string): CarConnection {
  switch (kind) {
    case 'androidAuto':
      return { kind: 'androidAuto' }
    case 'automotiveOs':
      return { kind: 'automotiveOs' }
    case 'carPlay':
      return { kind: 'carPlay' }
    default:
      return { kind: 'none' }
  }
}
