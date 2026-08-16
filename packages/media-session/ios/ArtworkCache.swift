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
  private var inFlight: [String: [(UIImage?, String?) -> Void]] = [:]
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
   *
   * The second completion argument is **why** there is no image, and it is the
   * whole reason this signature is not `(UIImage?) -> Void` any more: every one
   * of the four ways to fail here used to be an ignored `nil` — an unparseable
   * URI, a `try?` on a file read, a discarded `URLSession` error, data
   * `UIImage` refused — so the lock screen showed no cover and nothing anywhere
   * said why. It is a sentence, ready to be handed to the app through
   * `SessionErrorCode.artworkFailed`. `nil` means the image is there.
   */
  func load(_ uri: String, completion: @escaping (UIImage?, String?) -> Void) {
    if let hit = cached(uri) {
      completion(hit, nil)
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
      finish(uri, image: nil, failure: "the URI could not be parsed")
      return
    }

    if url.isFileURL || url.scheme == nil {
      DispatchQueue.global(qos: .utility).async { [weak self] in
        do {
          let data = try Data(contentsOf: url)
          self?.finish(
            uri,
            image: UIImage(data: data),
            failure: "the file's \(data.count) bytes are not an image UIImage can decode"
          )
        } catch {
          self?.finish(
            uri,
            image: nil,
            failure: "the file could not be read (\(error.localizedDescription))"
          )
        }
      }
      return
    }

    session.dataTask(with: url) { [weak self] data, response, error in
      if let error {
        self?.finish(uri, image: nil, failure: "the request failed (\(error.localizedDescription))")
        return
      }
      if let status = (response as? HTTPURLResponse)?.statusCode, !(200..<300).contains(status) {
        self?.finish(uri, image: nil, failure: "the server answered HTTP \(status)")
        return
      }
      guard let data, !data.isEmpty else {
        self?.finish(uri, image: nil, failure: "the response carried no data")
        return
      }
      self?.finish(
        uri,
        image: UIImage(data: data),
        failure: "the \(data.count) bytes returned are not an image UIImage can decode"
      )
    }
    .resume()
  }

  /**
   * Publish the result. `failure` is only used when `image` is `nil`, so a
   * caller that has bytes in hand can pass the decode-failure reason
   * unconditionally rather than branching twice.
   */
  private func finish(_ uri: String, image: UIImage?, failure: String) {
    if let image {
      cache.setObject(image, forKey: uri as NSString)
    }
    lock.lock()
    let waiting = inFlight.removeValue(forKey: uri) ?? []
    lock.unlock()
    for callback in waiting {
      callback(image, image == nil ? failure : nil)
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
