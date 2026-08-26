//
//  CarPlayArtwork.swift
//  RnMediaMediaSession
//
//  Browse-list covers: downloaded once, scaled to what the car asked for, and
//  never in the way of a tap.
//

import Foundation
import UIKit

/**
 * Row artwork for CarPlay list templates.
 *
 * ## Why its own instance of ``ArtworkCache`` rather than the session's
 * The download, the coalescing of concurrent requests for one URI, the
 * file/HTTP split and the failure sentences are all ``ArtworkCache``'s and are
 * reused verbatim — this class adds one thing to it, scaling, and holds a
 * second cache of the scaled results.
 *
 * It does not *share* the session's instance, and that is the deliberate part:
 * the two surfaces have opposite working sets. The lock screen shows one cover
 * and re-requests it on every broadcast, which is why its cache is eight
 * entries of full-resolution images; a browse list asks for twenty covers at
 * once and would evict the playing track's cover on every scroll. Sharing one
 * eight-entry cache would make each surface the other's cache pressure. Two
 * instances cost one extra `URLSession` (whose shared `URLCache` still serves
 * the second request from disk) and nothing else.
 *
 * ## Why the scaled results are cached separately
 * `CPListItem.maximumImageSize` is typically 60×60 pt. Keeping the decoded
 * originals for a whole list would be tens of megabytes in a process whose only
 * job may be to keep playing; keeping the thumbnails is kilobytes. The
 * originals stay in the (small, `NSCache`-evicted) download cache only long
 * enough to be scaled.
 *
 * ## Threading
 * `image(for:fitting:completion:)` is called on the main queue and calls back
 * on the main queue. The scaling itself happens on the download's completion
 * queue — never on the main one, and never inside a `CPListItem.handler`.
 */
final class CarPlayArtwork {
  /// Enough covers for a screenful and its neighbours; they are thumbnails.
  private static let scaledCapacity = 64
  /// Originals live only long enough to be scaled.
  private static let downloadCapacity = 8

  private let downloads = ArtworkCache(capacity: CarPlayArtwork.downloadCapacity)
  private let thumbnails = NSCache<NSString, UIImage>()

  init() {
    thumbnails.countLimit = CarPlayArtwork.scaledCapacity
  }

  /// Drop everything. Called when the head unit goes away — the next
  /// connection may be a different car with a different `maximumImageSize`.
  func clear() {
    thumbnails.removeAllObjects()
  }

  /**
   * A cover scaled to fit `size`, if one is already in hand. Never does I/O.
   *
   * Separate from ``image(for:fitting:completion:)`` so a list can be built
   * synchronously with the covers it already has — the asynchronous path then
   * only ever *adds* images, and a re-render never flashes a row back to blank.
   */
  func cached(_ uri: String, fitting size: CGSize) -> UIImage? {
    thumbnails.object(forKey: Self.key(uri, size) as NSString)
  }

  /**
   * Load and scale `uri`, calling `completion` on the **main queue**.
   *
   * A failure is a `nil` image and nothing else: a cover that will not load is
   * a row without a picture, not an error worth interrupting the driver with.
   * The session's own artwork channel already reports unloadable covers for the
   * item that is *playing* (`SessionErrorCode.artworkFailed`), which is the one
   * the user can actually see something missing from.
   */
  func image(
    for uri: String,
    fitting size: CGSize,
    completion: @escaping (UIImage?) -> Void
  ) {
    if let hit = cached(uri, fitting: size) {
      completion(hit)
      return
    }

    let key = Self.key(uri, size) as NSString
    downloads.load(uri) { [weak self] image, _ in
      // Scaled here, off the main queue, on whichever queue the download
      // finished on: a full-resolution cover redrawn at 60pt is real work and
      // the main queue is driving the car's UI.
      let thumbnail = image.map { Self.scaled($0, toFit: size) }
      if let self, let thumbnail {
        self.thumbnails.setObject(thumbnail, forKey: key)
      }
      DispatchQueue.main.async { completion(thumbnail) }
    }
  }

  private static func key(_ uri: String, _ size: CGSize) -> String {
    // The size is part of the key because it is a property of the *car*, not of
    // this process: a phone moved between two head units with different
    // `maximumImageSize` values must not be served the first car's thumbnails.
    "\(Int(size.width.rounded()))x\(Int(size.height.rounded()))|\(uri)"
  }

  /**
   * Aspect-fit `image` into `size`, in points.
   *
   * Never upscales: a 32pt cover drawn into a 60pt box would be a blurry 60pt
   * cover, and CarPlay is perfectly happy to render an image smaller than
   * `maximumImageSize`. What it will not accept is a *larger* one — that is the
   * documented ceiling (`CPListItem.maximumImageSize`,
   * developer.apple.com/documentation/carplay/cplistitem, read 2026-08-26).
   *
   * `UIGraphicsImageRenderer` rather than `UIGraphicsBeginImageContext`: it is
   * usable off the main thread and it carries the scale factor, so the result
   * is a `@2x`/`@3x` bitmap of the right *point* size rather than a
   * quarter-sized one.
   */
  static func scaled(_ image: UIImage, toFit size: CGSize) -> UIImage {
    let source = image.size
    guard source.width > 0, source.height > 0, size.width > 0, size.height > 0 else {
      return image
    }
    let ratio = min(size.width / source.width, size.height / source.height)
    guard ratio < 1 else { return image }

    let target = CGSize(
      width: max(1, (source.width * ratio).rounded()),
      height: max(1, (source.height * ratio).rounded())
    )
    let format = UIGraphicsImageRendererFormat.default()
    format.opaque = false
    return UIGraphicsImageRenderer(size: target, format: format).image { _ in
      image.draw(in: CGRect(origin: .zero, size: target))
    }
  }
}
