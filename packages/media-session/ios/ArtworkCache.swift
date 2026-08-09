//
//  ArtworkCache.swift
//  RnMediaMediaSession
//
//  Async artwork loading with a small in-memory cache.
//

import Foundation
import MediaPlayer
import UIKit

/**
 * Loads artwork off the calling thread and remembers the last few results.
 *
 * Why a cache at all: a queue of tracks from one album broadcasts the same
 * `artworkUri` on every skip. Without this, each skip re-downloads and
 * re-decodes a full-resolution cover on the way to a 60pt lock-screen thumbnail.
 *
 * Why so small a cache: these are decoded `UIImage`s (megabytes each), held for
 * the lifetime of the process by a media session that may be the only thing
 * keeping the app alive. `NSCache` additionally evicts under memory pressure,
 * which a plain dictionary would not.
 *
 * Thread-safety: `NSCache` is thread-safe; the in-flight table is guarded by
 * `lock` because completions land on a URLSession delegate queue while requests
 * arrive on the main queue.
 */
final class ArtworkCache {
  static let defaultCapacity = 8

  private let cache = NSCache<NSString, UIImage>()
  private let lock = NSLock()
  /// uri -> callbacks waiting on the one request in flight for it.
  private var inFlight: [String: [(UIImage?) -> Void]] = [:]
  private let session: URLSession

  init(capacity: Int = ArtworkCache.defaultCapacity) {
    cache.countLimit = max(1, capacity)
    let configuration = URLSessionConfiguration.default
    // Artwork is decoration: never let it hold a foreground-service window or a
    // background-audio assertion open waiting on a slow CDN.
    configuration.timeoutIntervalForRequest = 15
    configuration.requestCachePolicy = .returnCacheDataElseLoad
    session = URLSession(configuration: configuration)
  }

  func setCapacity(_ capacity: Int) {
    cache.countLimit = max(1, capacity)
  }

  /// Already-decoded image for `uri`, if we have one. Never does I/O.
  func cached(_ uri: String) -> UIImage? {
    cache.object(forKey: uri as NSString)
  }

  /**
   * Fetch `uri`, calling `completion` on an arbitrary queue (possibly
   * synchronously, on a cache hit).
   *
   * Concurrent requests for the same URI are coalesced — a queue that skips
   * three times quickly must not open three connections to the same cover.
   */
  func load(_ uri: String, completion: @escaping (UIImage?) -> Void) {
    if let hit = cached(uri) {
      completion(hit)
      return
    }

    lock.lock()
    if inFlight[uri] != nil {
      inFlight[uri]?.append(completion)
      lock.unlock()
      return
    }
    inFlight[uri] = [completion]
    lock.unlock()

    guard let url = URL(string: uri) else {
      finish(uri, image: nil)
      return
    }

    if url.isFileURL || url.scheme == nil {
      DispatchQueue.global(qos: .utility).async { [weak self] in
        let data = try? Data(contentsOf: url)
        self?.finish(uri, image: data.flatMap(UIImage.init(data:)))
      }
      return
    }

    session.dataTask(with: url) { [weak self] data, _, _ in
      self?.finish(uri, image: data.flatMap(UIImage.init(data:)))
    }
    .resume()
  }

  private func finish(_ uri: String, image: UIImage?) {
    if let image {
      cache.setObject(image, forKey: uri as NSString)
    }
    lock.lock()
    let waiting = inFlight.removeValue(forKey: uri) ?? []
    lock.unlock()
    for callback in waiting {
      callback(image)
    }
  }

  /**
   * Wrap a decoded image for `MPNowPlayingInfoCenter`.
   *
   * `MPMediaItemArtwork(boundsSize:requestHandler:)` hands the system a
   * resizing block instead of a bitmap, so the shell asks for exactly the size
   * it renders — "The request handler returns the image in the newly requested
   * size" (developer.apple.com/documentation/mediaplayer/mpmediaitemartwork/init(boundssize:requesthandler:)).
   */
  static func artwork(from image: UIImage) -> MPMediaItemArtwork {
    MPMediaItemArtwork(boundsSize: image.size) { size in
      guard size != image.size else { return image }
      let format = UIGraphicsImageRendererFormat.default()
      format.scale = image.scale
      return UIGraphicsImageRenderer(size: size, format: format).image { _ in
        image.draw(in: CGRect(origin: .zero, size: size))
      }
    }
  }
}
