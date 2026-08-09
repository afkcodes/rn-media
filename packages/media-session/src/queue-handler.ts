import { BaseMediaHandler } from './handler'
import { MediaService } from './media-service'
import { validateQueue } from './validate'
import type { MediaHandler, MediaItem } from './types'

/**
 * The one thing a queue-owning handler needs from the service: a way to push
 * the queue out on broadcast channel 3.
 *
 * Structural and injectable so the whole mixin is testable without a device.
 */
export interface QueueBroadcaster {
  setQueue(items: MediaItem[]): void
}

export interface QueueHandlerOptions {
  /**
   * `skipToNext` past the end lands on index 0, and `skipToPrevious` before the
   * start lands on the last item.
   *
   * @default false
   */
  wrapAround?: boolean
  /**
   * Where {@link QueueHandlerMethods.setQueue} publishes to. Defaults to the
   * `MediaService` singleton, which is what an app wants; tests pass a fake.
   */
  broadcaster?: QueueBroadcaster
}

/** The surface {@link withQueueHandling} adds on top of a {@link MediaHandler}. */
export interface QueueHandlerMethods {
  readonly queue: readonly MediaItem[]
  /** Index of the item last handed to {@link playQueueItem}, or `-1`. */
  readonly queueIndex: number
  readonly currentItem: MediaItem | undefined
  /** Whether skips wrap at the ends. Mutable — it is a user preference. */
  wrapAround: boolean

  /**
   * Replace the queue and broadcast it.
   *
   * @param startIndex index to treat as current *without* playing it. Pass the
   * index you are about to play, or leave it at `-1` and call
   * `skipToQueueItem` to start playback.
   */
  setQueue(items: MediaItem[], startIndex?: number): void

  /**
   * Play `item`. The only thing a subclass has to write.
   *
   * Called by `skipToNext`/`skipToPrevious`/`skipToQueueItem` after the index
   * has already been resolved and stored.
   */
  playQueueItem(item: MediaItem, index: number): void | Promise<void>
}

/**
 * Mixin constructor constraint.
 *
 * `any[]` is the standard (and only) way to express "a constructor with
 * whatever parameters the base class has" — TypeScript has no variadic
 * constructor constraint. It appears in a type position only; no `any` value
 * ever reaches the public API (CLAUDE.md principle 3).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type MediaHandlerConstructor = new (...args: any[]) => MediaHandler

/**
 * Give a handler default queue navigation over the data it broadcasts on
 * channel 3.
 *
 * The queue lives here, not in the session: resolving a skip may need to fetch
 * a URL, shuffle, or consult a recommender, all of which are app concerns. What
 * the mixin provides is the *boring* part — index arithmetic that is identical
 * in every media app and wrong in half of them.
 *
 * ```ts
 * class MyHandler extends QueueHandler {
 *   async playQueueItem(item: MediaItem) { await this.player.load(item.id) }
 * }
 * ```
 */
export function withQueueHandling<TBase extends MediaHandlerConstructor>(
  Base: TBase,
  options: QueueHandlerOptions = {}
  // The return type is written out rather than inferred: the class below uses
  // `#private` fields, which a declaration file cannot describe for an
  // anonymous class (TS4094). Spelling the *public* shape here is also the
  // honest contract — the fields are an implementation detail.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): TBase & (abstract new (...args: any[]) => MediaHandler & QueueHandlerMethods) {
  abstract class WithQueueHandling extends Base implements QueueHandlerMethods {
    #queue: MediaItem[] = []
    #index = -1

    wrapAround = options.wrapAround ?? false

    get queue(): readonly MediaItem[] {
      return this.#queue
    }

    get queueIndex(): number {
      return this.#index
    }

    get currentItem(): MediaItem | undefined {
      return this.#queue[this.#index]
    }

    setQueue(items: MediaItem[], startIndex = -1): void {
      const validated = validateQueue(items)
      this.#queue = validated
      // Clamp rather than reject: `setQueue([], 0)` is what a "clear the queue"
      // call looks like, and rejecting it would make the empty case special.
      this.#index =
        startIndex >= 0 && startIndex < validated.length ? startIndex : -1
      this.#broadcaster().setQueue(validated)
    }

    override skipToNext(): void | Promise<void> {
      const next = this.#step(1)
      if (next === undefined) return
      return this.skipToQueueItem(next)
    }

    override skipToPrevious(): void | Promise<void> {
      // Deliberately *not* "restart the track if position > 3s". That is a
      // player-state decision and this mixin has no player; an app that wants
      // it overrides `skipToPrevious` and calls `super` for the real skip.
      const previous = this.#step(-1)
      if (previous === undefined) return
      return this.skipToQueueItem(previous)
    }

    override skipToQueueItem(index: number): void | Promise<void> {
      const item = this.#queue[index]
      // Remote surfaces (a watch, a stale notification, Android Auto) can send
      // an index from a queue we have already replaced. That is not our bug and
      // not worth an exception — ignore it and leave the index where it was.
      if (item === undefined) return
      this.#index = index
      return this.playQueueItem(item, index)
    }

    abstract playQueueItem(item: MediaItem, index: number): void | Promise<void>

    /** Resolved target index for a ±1 move, or `undefined` for "nowhere to go". */
    #step(delta: 1 | -1): number | undefined {
      const length = this.#queue.length
      if (length === 0) return undefined

      // From "nothing selected", forward means the first item and backward
      // means the last — the same thing wrapping would do.
      if (this.#index < 0) return delta === 1 ? 0 : length - 1

      const target = this.#index + delta
      if (target >= 0 && target < length) return target
      if (!this.wrapAround) return undefined
      // Wrapping a single-item queue re-plays that item, which is what every
      // repeat-one implementation does.
      return delta === 1 ? 0 : length - 1
    }

    #broadcaster(): QueueBroadcaster {
      // Resolved per call, not captured at construction: `MediaService` is a
      // stable façade object whose native instance is created lazily, so
      // reading it here costs nothing and keeps `new MyHandler()` free of
      // native side effects.
      return options.broadcaster ?? MediaService
    }
  }

  return WithQueueHandling
}

/**
 * {@link withQueueHandling} applied to {@link BaseMediaHandler} — the class an
 * app extends when it has no other base.
 */
export const QueueHandler = withQueueHandling(BaseMediaHandler)

/** Instance type of {@link QueueHandler}. */
export type QueueHandler = InstanceType<typeof QueueHandler>
