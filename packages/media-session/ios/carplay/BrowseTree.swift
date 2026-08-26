//
//  BrowseTree.swift
//  RnMediaMediaSession
//
//  The car browse tree as plain Swift values, plus every decision about it that
//  can be made without CarPlay.
//

import Foundation

/**
 * One node of the browse tree.
 *
 * ## Why this is not `NativeBrowseItem`
 * Exactly the reason ``NowPlayingItem`` is not `NativeMediaItem`: the generated
 * type is a view onto a C++ struct owned by the bridge call that produced it,
 * so it must not be stored, and reading it after a thread hop is not something
 * the ownership contract promises. Everything below is stored — a list template
 * holds its nodes for as long as the car shows it — so the bridge struct is
 * copied into this the moment it arrives (`CarPlayBridge.swift`), and every
 * file after that point is plain Swift.
 *
 * It also keeps the whole of this file, and every rule in it, compilable and
 * reviewable without nitrogen having run.
 *
 * `childStyle` and `mediaType` are deliberately absent: both are Android
 * content-style hints (F8), and CarPlay has no equivalent — a `CPListTemplate`
 * renders one way. Dropping them here rather than carrying them unused is the
 * honest shape.
 */
struct BrowseNode: Equatable, Sendable {
  let id: String
  let title: String
  let subtitle: String?
  let artworkUri: String?
  let browsable: Bool
  let playable: Bool
  /// Contiguous nodes sharing this render under one `CPListSection` header.
  let group: String?
  let explicit: Bool
  /// 0…1, or `nil` for "no progress to show". `1` renders as fully played.
  let completion: Double?
}

/// The car-facing failure an app raises from a browse method (F7, §1 `BrowseError`).
struct BrowseFailure: Equatable, Sendable {
  let code: String
  let message: String
  let resolutionLabel: String?
  let resolutionUrl: String?

  /// The "Sign in"-style action, present only when the app gave both halves of
  /// it. A label with no URL is a button that would do nothing.
  var resolution: (label: String, url: String)? {
    guard let resolutionLabel, let resolutionUrl else { return nil }
    return (resolutionLabel, resolutionUrl)
  }
}

/// What one browse call answered with. One shape for children and for search,
/// mirroring `NativeBrowseResult`.
enum BrowseAnswer: Equatable, Sendable {
  case items([BrowseNode])
  case failure(BrowseFailure)
}

/// A run of nodes that render under one heading.
struct BrowseSection: Equatable, Sendable {
  /// `nil` for the leading run of ungrouped nodes — a `CPListSection` with no
  /// header, which is what a plain list is.
  let header: String?
  let nodes: [BrowseNode]
}

/// Why a node offered as a root tab was not made one.
enum RootTabRejection: Equatable, Sendable {
  /// Playable-only: a root tab must open a list (F4, and CarPlay's tab bar
  /// holds templates, not actions).
  case notBrowsable(id: String)
  /// Past `CPTabBarTemplate.maximumTabCount`.
  case overTabLimit(id: String)

  var id: String {
    switch self {
    case .notBrowsable(let id), .overTabLimit(let id): return id
    }
  }
}

/// The outcome of turning `getChildren(BROWSE_ROOT)` into tabs.
struct RootTabs: Equatable, Sendable {
  let accepted: [BrowseNode]
  let rejected: [RootTabRejection]
}

/**
 * Every browse rule that is a function of its inputs and nothing else.
 *
 * Kept as free functions on a caseless enum, with no CarPlay import in sight,
 * so each one can be read (and, when a test target exists, tested) without a
 * head unit: what the car draws is then only ever a translation of these
 * answers, never a decision of its own.
 */
enum BrowseRules {
  /// The parent id that asks for the root tabs. Must equal `BROWSE_ROOT` in the
  /// TypeScript contract (§1); the app matches on this exact string.
  static let rootId = "rn-media-root"

  /**
   * CarPlay's hierarchy ceiling, counted in templates on the navigation stack.
   *
   * "All other app categories are restricted to 5 levels"
   * (developer.apple.com/documentation/carplay/cplisttemplate, read 2026-08-26).
   * The root template counts as one, so a stack of five is full and a sixth
   * push is refused — deliberately the conservative reading: refusing a push
   * shows the user the list they are on, while exceeding the limit is grounds
   * for App Review rejection.
   */
  static let maximumTemplateDepth = 5

  /**
   * Which of the app's root children can be tabs.
   *
   * Two rules, in this order, and the order is the whole point: a playable-only
   * node is rejected as *not browsable* even when it is the fifth one, because
   * that is the more useful thing to tell the app. Everything rejected is
   * reported on the sessionError channel as `browseRootRejected` — the same
   * code Android reports (§2 A3) — never silently dropped.
   *
   * `maximumTabCount` is a runtime value read from `CPTabBarTemplate`, not a
   * constant, because the car decides it (F11). A non-positive limit (which the
   * framework should never report) accepts nothing rather than trapping.
   */
  static func rootTabs(from nodes: [BrowseNode], maximumTabCount: Int) -> RootTabs {
    var accepted: [BrowseNode] = []
    var rejected: [RootTabRejection] = []

    for node in nodes {
      guard node.browsable else {
        rejected.append(.notBrowsable(id: node.id))
        continue
      }
      guard accepted.count < maximumTabCount else {
        rejected.append(.overTabLimit(id: node.id))
        continue
      }
      accepted.append(node)
    }

    return RootTabs(accepted: accepted, rejected: rejected)
  }

  /**
   * Group a child list into sections.
   *
   * **Contiguous** runs, not a sort: the app chose the order, and re-ordering a
   * list to gather two distant runs of `group: "Albums"` would silently move
   * items the app deliberately placed. Two separate runs of the same group
   * therefore produce two sections with the same header, which is exactly what
   * the app asked for.
   *
   * A run with no group becomes a headerless section, so an app that sets no
   * groups at all gets one plain list — the common case, and free.
   */
  static func sections(from nodes: [BrowseNode]) -> [BrowseSection] {
    var sections: [BrowseSection] = []
    var run: [BrowseNode] = []
    var header: String??

    for node in nodes {
      if let header, header == node.group {
        run.append(node)
        continue
      }
      if !run.isEmpty {
        sections.append(BrowseSection(header: header ?? nil, nodes: run))
      }
      header = node.group
      run = [node]
    }
    if !run.isEmpty {
      sections.append(BrowseSection(header: header ?? nil, nodes: run))
    }
    return sections
  }

  /**
   * Trim `sections` to what one `CPListTemplate` will accept.
   *
   * Both limits are runtime values the car reports
   * (`CPListTemplate.maximumSectionCount` / `.maximumItemCount`); handing the
   * template more than either is a framework exception, not a truncation, so
   * the trim happens here where it can be read and tested.
   *
   * Sections are dropped whole once the section limit is reached, and the item
   * limit is applied across the running total so a partially-filled last
   * section is kept rather than the whole section being lost. A section that
   * would be left with nothing is dropped instead of appearing empty.
   */
  static func limited(
    _ sections: [BrowseSection],
    maximumSectionCount: Int,
    maximumItemCount: Int
  ) -> [BrowseSection] {
    var kept: [BrowseSection] = []
    var items = 0

    for section in sections {
      guard kept.count < maximumSectionCount else { break }
      let room = maximumItemCount - items
      guard room > 0 else { break }
      let nodes = section.nodes.count <= room
        ? section.nodes
        : Array(section.nodes.prefix(room))
      guard !nodes.isEmpty else { continue }
      kept.append(BrowseSection(header: section.header, nodes: nodes))
      items += nodes.count
    }

    return kept
  }

  /**
   * `CPListItem.playbackProgress` for a node, or `nil` when there is none.
   *
   * Clamped rather than trusted: the value crosses the bridge as a `double` an
   * app computed, and CarPlay's contract is 0…1. A NaN — which every comparison
   * rejects — becomes `nil` rather than a progress bar of undefined width.
   */
  static func playbackProgress(for node: BrowseNode) -> Double? {
    guard let completion = node.completion, completion.isFinite else { return nil }
    return min(max(completion, 0), 1)
  }
}
