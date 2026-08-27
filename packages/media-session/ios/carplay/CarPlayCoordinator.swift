//
//  CarPlayCoordinator.swift
//  RnMediaMediaSession
//
//  Everything the head unit shows, and the one object that owns it.
//

import CarPlay
import Foundation
import UIKit

/// `CPListTemplate.showsSpinnerWhileEmpty` is iOS 18.4+ (CI, 2026-08-26: "only
/// available in iOS 18.4 or newer" — the review table had it at 12.0, which is
/// the *template's* availability, not the property's). Below 18.4 an empty list
/// is simply empty until `updateSections` lands; the fill is the same.
@MainActor
private func spin(_ template: CPListTemplate, _ on: Bool) {
  if #available(iOS 18.4, *) { template.showsSpinnerWhileEmpty = on }
}

/**
 * Something changed on the session's side that the car may be showing.
 *
 * A value type with only `String`/`Bool` payloads so it can cross from the JS
 * thread to the main actor without dragging a non-`Sendable` reference with it
 * — the receiver looks the session back up through ``CarPlayLink``.
 */
enum CarPlayEvent: Sendable {
  /// `initialize` published a session, or `stopService` retracted one.
  case sourceChanged
  /// `invalidateBrowse(parentId)`; `nil` means everything.
  case browseInvalidated(parentId: String?)
  /// A broadcast changed what Now Playing should offer (buttons, Up Next).
  case nowPlayingChanged
}

/**
 * The CarPlay half of `@afkcodes/timbre-media-session`.
 *
 * ## Ownership
 * A singleton, for the reason CLAUDE.md permits one: iOS gives an app exactly
 * one CarPlay scene, and the scene delegate the system instantiates from
 * `Info.plist` has no way to be handed anything. It holds the interface
 * controller **weakly** — the scene owns that — and finds the session through
 * ``CarPlayLink`` on every use rather than storing it, because the session can
 * appear and disappear (`initialize`/`stopService`) under a connected car.
 *
 * ## Isolation
 * `@MainActor` throughout, because every CarPlay class is. The only entry point
 * from another thread is ``post(_:)``, which is `nonisolated` and hops.
 *
 * ## What it does not do
 * It does not own playback state, artwork for the *playing* item, or any remote
 * command: `MPNowPlayingInfoCenter` and `MPRemoteCommandCenter` already drive
 * the car's Now Playing screen and were already ours before CarPlay existed in
 * this package (I3). This file is the browse tree and nothing else, plus the
 * three buttons Apple only exposes through CarPlay's own template.
 */
@MainActor
final class CarPlayCoordinator: NSObject {
  static let shared = CarPlayCoordinator()

  /// Owned by the scene; `nil` whenever no car is attached.
  private weak var interfaceController: CPInterfaceController?

  /// One per root tab, in tab order. Empty until the root resolves.
  private var tabs: [BrowseLevel] = []
  /// Templates pushed on top of a tab, deepest last.
  private var stack: [BrowseLevel] = []

  private let artwork = CarPlayArtwork()

  /**
   * The generation of the current connection.
   *
   * Every asynchronous continuation checks it before touching a template: a
   * `getChildren` that resolves after the driver unplugged the phone must not
   * repopulate a dead interface controller, and — more subtly — a *reconnect*
   * that happens while the first connection's fetches are still in flight must
   * not have the old answers land in its brand-new templates. Comparing the
   * controller identity alone would not catch the second case.
   */
  private var generation = 0

  /// `nonisolated` because `NSObject.init()` is: a `@MainActor` override of a
  /// non-isolated initialiser is refused, and there is nothing isolated to do
  /// here anyway.
  private nonisolated override init() {
    super.init()
  }

  // MARK: - Cross-thread entry

  /**
   * Tell the coordinator something changed, from any thread.
   *
   * `Task { @MainActor in … }` rather than `DispatchQueue.main.async`: the body
   * touches main-actor-isolated CarPlay state, and a `DispatchQueue` block is
   * not isolated to anything as far as the compiler is concerned. Ordering
   * between two posts is FIFO on the main actor's executor, and nothing here
   * depends on ordering against the session's own `DispatchQueue.main.async`
   * broadcasts — every handler below re-reads the session's state rather than
   * carrying a copy.
   */
  nonisolated static func post(_ event: CarPlayEvent) {
    // Nothing to do — and, more to the point, nothing to *allocate* — when no
    // car is attached. Broadcasts are discontinuity-only, so this is a handful
    // of lock acquisitions per track for the overwhelmingly common case of a
    // phone that has never seen a head unit, and zero tasks.
    guard CarPlayLink.shared.isConnected else { return }
    Task { @MainActor in CarPlayCoordinator.shared.handle(event) }
  }

  private func handle(_ event: CarPlayEvent) {
    switch event {
    case .sourceChanged:
      // A session that arrives while a car is already connected is the ordinary
      // case, not the exotic one: the driver plugs in, CarPlay launches the app,
      // and the scene connects before JavaScript has finished starting.
      guard interfaceController != nil else { return }
      reload()
    case .browseInvalidated(let parentId):
      invalidate(parentId: parentId)
    case .nowPlayingChanged:
      refreshNowPlaying()
    }
  }

  // MARK: - Scene lifecycle (I1, I5)

  /// The head unit connected. Main actor (the scene delegate is `@MainActor`).
  func attach(interfaceController controller: CPInterfaceController) {
    interfaceController = controller
    controller.delegate = self
    // Registered exactly once per connection, and paired with the `remove` in
    // ``detach()``. Apple does not promise `add` is idempotent, and a second
    // registration would push two Up Next lists for one tap.
    CPNowPlayingTemplate.shared.add(self)
    CarPlayLink.shared.setConnected(true)
    CarPlayLink.shared.source?.carPlayConnectionChanged(connected: true)
    reload()
  }

  /// The head unit went away.
  func detach() {
    CPNowPlayingTemplate.shared.remove(self)
    interfaceController?.delegate = nil
    interfaceController = nil
    // Invalidates every fetch still in flight: their answers must not land in
    // the next connection's templates.
    generation &+= 1
    tabs = []
    stack = []
    artwork.clear()
    CarPlayLink.shared.setConnected(false)
    CarPlayLink.shared.source?.carPlayConnectionChanged(connected: false)
  }

  // MARK: - Root (I2)

  /// Rebuild everything from `getChildren(BROWSE_ROOT)`.
  private func reload() {
    guard let controller = interfaceController else { return }
    generation &+= 1
    let token = generation
    tabs = []
    stack = []

    // Shown for as long as the round trip to JavaScript takes. CarPlay wants a
    // root template promptly after `didConnect`; an app whose `getChildren` is
    // slow (or whose runtime is still booting) must not leave the car blank.
    let placeholder = CPListTemplate(title: nil, sections: [])
    spin(placeholder, true)
    controller.setRootTemplate(placeholder, animated: false, completion: nil)

    guard let source = CarPlayLink.shared.source else {
      // No session yet. `CarPlayLink.register` posts `.sourceChanged`, which
      // lands here again; the spinner is the honest thing to show until then.
      return
    }

    Task { @MainActor in
      let answer = await source.carPlayChildren(of: BrowseRules.rootId)
      guard self.generation == token, let controller = self.interfaceController else { return }

      switch answer {
      case .failure(let failure):
        spin(placeholder, false)
        self.present(failure)
      case .items(let nodes):
        self.installRoot(nodes, in: controller, token: token)
      }
    }
  }

  private func installRoot(
    _ nodes: [BrowseNode],
    in controller: CPInterfaceController,
    token: Int
  ) {
    let result = BrowseRules.rootTabs(
      from: nodes,
      maximumTabCount: CPTabBarTemplate.maximumTabCount
    )
    report(result.rejected)

    tabs = result.accepted.map { node in
      let template = CPListTemplate(title: node.title, sections: [])
      template.tabTitle = node.title
      spin(template, true)
      return BrowseLevel(parentId: node.id, template: template)
    }

    switch tabs.count {
    case 0:
      // Nothing browsable at the root — an app that has not implemented
      // `getChildren`, or one whose library is genuinely empty. An empty list
      // (spinner off: the answer arrived, it was just empty) rather than a tab
      // bar with no tabs, which CarPlay rejects, and rather than the spinner,
      // which would promise something still on its way.
      controller.setRootTemplate(
        CPListTemplate(title: nil, sections: []),
        animated: false,
        completion: nil
      )
    case 1:
      // One tab is not a tab bar — it is a list. Skipping the bar saves the
      // driver a row of chrome that can only ever select the thing on screen.
      let only = tabs[0]
      controller.setRootTemplate(only.template, animated: false, completion: nil)
      fill(only, token: token)
    default:
      let bar = CPTabBarTemplate(templates: tabs.map(\.template))
      bar.delegate = self
      controller.setRootTemplate(bar, animated: false, completion: nil)
      // Only the visible tab is fetched now; the rest are filled the first time
      // the driver selects them (`tabBarTemplate(_:didSelect:)`). Four eager
      // round trips to JavaScript at connect time would delay the one tab the
      // user is actually looking at.
      fill(tabs[0], token: token)
    }

    refreshNowPlaying()
  }

  // MARK: - Filling a level (I2)

  /**
   * Fetch `level`'s children and render them.
   *
   * Re-entrant by design — `invalidateBrowse` calls it on a level that is
   * already populated — but never concurrently with itself for the same level:
   * a second call while one is in flight is dropped, because both would ask the
   * app the same question and the later answer would win a race it did not know
   * it was in.
   */
  private func fill(_ level: BrowseLevel, token: Int) {
    guard !level.isLoading else { return }
    guard let source = CarPlayLink.shared.source else {
      spin(level.template, false)
      return
    }
    level.isLoading = true

    Task { @MainActor in
      let answer = await source.carPlayChildren(of: level.parentId)
      level.isLoading = false
      guard self.generation == token else { return }

      spin(level.template, false)
      switch answer {
      case .failure(let failure):
        level.nodes = []
        level.template.updateSections([])
        self.present(failure)
      case .items(let nodes):
        level.nodes = nodes
        self.render(level)
      }
    }
  }

  /// Turn `level.nodes` into sections. Cheap and synchronous: called again on
  /// every Now Playing change so the "playing" indicator can move.
  private func render(_ level: BrowseLevel) {
    let sections = BrowseRules.limited(
      BrowseRules.sections(from: level.nodes),
      maximumSectionCount: CPListTemplate.maximumSectionCount,
      maximumItemCount: CPListTemplate.maximumItemCount
    )
    let state = CarPlayLink.shared.source?.carPlayNowPlaying ?? .empty

    level.template.updateSections(
      sections.map { section in
        let items: [any CPListTemplateItem] = section.nodes.map {
          self.listItem(for: $0, state: state)
        }
        return CPListSection(items: items, header: section.header, sectionIndexTitle: nil)
      }
    )
  }

  private func listItem(for node: BrowseNode, state: CarPlayNowPlayingState) -> CPListItem {
    let size = CPListItem.maximumImageSize
    let item = CPListItem(
      text: node.title,
      detailText: node.subtitle,
      // Only what is already decoded — the asynchronous load below fills the
      // row in afterwards. Building the list must never wait on a CDN.
      image: node.artworkUri.flatMap { artwork.cached($0, fitting: size) },
      accessoryImage: nil,
      // A node that opens a list gets the chevron; one that only plays does
      // not, which is how the driver tells the two apart at a glance.
      accessoryType: node.browsable
        ? CPListItemAccessoryType.disclosureIndicator
        : CPListItemAccessoryType.none
    )
    item.isExplicitContent = node.explicit
    if let progress = BrowseRules.playbackProgress(for: node) {
      item.playbackProgress = CGFloat(progress)
    }
    item.isPlaying = state.currentMediaId == node.id

    // `handler` is a non-`@Sendable` closure formed in a `@MainActor` context,
    // so it inherits main-actor isolation — which is also where CarPlay invokes
    // it. `completion` is called exactly once on **every** path below,
    // including the ones that do nothing: CarPlay leaves the row spinning
    // forever otherwise.
    item.handler = { [weak self] _, completion in
      guard let self else {
        completion()
        return
      }
      self.select(node, completion: completion)
    }

    if let uri = node.artworkUri, artwork.cached(uri, fitting: size) == nil {
      let token = generation
      artwork.image(for: uri, fitting: size) { [weak self] image in
        guard let self, let image, self.generation == token else { return }
        // Set on the live item rather than re-rendering the section: CarPlay
        // animates `setImage` in place, and a full `updateSections` would drop
        // the driver's scroll position every time a cover arrived.
        item.setImage(image)
      }
    }

    return item
  }

  // MARK: - Selection (I2)

  /// Exactly one `completion()` on every path. See ``listItem(for:state:)``.
  private func select(_ node: BrowseNode, completion: @escaping () -> Void) {
    guard let controller = interfaceController else {
      completion()
      return
    }
    let source = CarPlayLink.shared.source

    // Both, in this order, when a node is both: the app starts playing the
    // album *and* the driver ends up looking at its tracks — which is what
    // "browsable and playable" means (§1) and what Apple's own music app does.
    if node.playable {
      source?.carPlayPlay(mediaId: node.id)
    }

    guard node.browsable else {
      // Nothing to push. Show the Now Playing screen, which is where a tap on a
      // track should land, and which is a *push* — never a modal presentation
      // (F11).
      //
      // `contains`, not "is it on top": `CPNowPlayingTemplate.shared` is a
      // singleton, so pushing it while it is already somewhere in the stack
      // would put one template in the hierarchy twice. The depth check is the
      // same one the browse push below makes, for the same reason.
      let already = controller.templates.contains(CPNowPlayingTemplate.shared)
      if node.playable, !already,
        controller.templates.count < BrowseRules.maximumTemplateDepth
      {
        controller.pushTemplate(
          CPNowPlayingTemplate.shared,
          animated: true,
          completion: { _, _ in completion() }
        )
      } else {
        completion()
      }
      return
    }

    // `templates` counts the root, so a stack already at the ceiling refuses
    // rather than pushing a level App Review would reject (F11).
    guard controller.templates.count < BrowseRules.maximumTemplateDepth else {
      completion()
      return
    }

    let token = generation
    let level = BrowseLevel(parentId: node.id, template: CPListTemplate(title: node.title, sections: []))
    spin(level.template, true)
    stack.append(level)

    controller.pushTemplate(level.template, animated: true) { [weak self] pushed, _ in
      completion()
      guard let self, self.generation == token else { return }
      guard pushed else {
        // CarPlay refused the push (depth, or a template it will not accept).
        // Drop the level rather than leaving an orphan in the stack that
        // `invalidateBrowse` would later try to refresh.
        self.stack.removeAll { $0 === level }
        return
      }
      self.fill(level, token: token)
    }
  }

  // MARK: - Now Playing (I3)

  /// Re-derive the Now Playing buttons and the Up Next affordance, and move the
  /// "playing" indicator in every list the driver can currently see.
  private func refreshNowPlaying() {
    guard interfaceController != nil else { return }
    let state = CarPlayLink.shared.source?.carPlayNowPlaying ?? .empty

    let template = CPNowPlayingTemplate.shared
    template.updateNowPlayingButtons(
      CarPlayNowPlayingButtonKind.buttons(for: state).map {
        CarPlayNowPlayingButtons.make($0) { CarPlayLink.shared.source }
      }
    )
    template.isUpNextButtonEnabled = CarPlayNowPlayingButtonKind.showsUpNext(for: state)

    for level in tabs + stack where !level.nodes.isEmpty {
      render(level)
    }
  }

  /// The Up Next list: the broadcast queue, tapping through to
  /// `skipToQueueItem` (I3). Rebuilt on every tap rather than cached — the
  /// queue may have changed since the button was last drawn.
  private func upNextTemplate() -> CPListTemplate {
    let state = CarPlayLink.shared.source?.carPlayNowPlaying ?? .empty
    let size = CPListItem.maximumImageSize

    let items: [any CPListTemplateItem] = state.queue.enumerated().prefix(
      CPListTemplate.maximumItemCount
    ).map { pair in
      let index = pair.offset
      let entry = pair.element
      let item = CPListItem(
        text: entry.title,
        detailText: entry.subtitle,
        image: entry.artworkUri.flatMap { self.artwork.cached($0, fitting: size) },
        accessoryImage: nil,
        accessoryType: CPListItemAccessoryType.none
      )
      item.isPlaying = entry.id == state.currentMediaId
      item.handler = { [weak self] _, completion in
        CarPlayLink.shared.source?.carPlaySkipToQueueItem(index: index)
        // Pop back to what the driver was looking at; the Now Playing screen
        // updates itself from `MPNowPlayingInfoCenter`.
        self?.interfaceController?.popTemplate(animated: true, completion: nil)
        completion()
      }

      if let uri = entry.artworkUri, self.artwork.cached(uri, fitting: size) == nil {
        let token = self.generation
        self.artwork.image(for: uri, fitting: size) { [weak self] image in
          guard let self, let image, self.generation == token else { return }
          item.setImage(image)
        }
      }
      return item
    }

    return CPListTemplate(title: nil, sections: [CPListSection(items: items)])
  }

  // MARK: - Invalidation (I5)

  /// Re-fetch every level that shows `parentId`, or all of them when `nil`.
  private func invalidate(parentId: String?) {
    guard interfaceController != nil else { return }
    let token = generation

    if parentId == nil || parentId == BrowseRules.rootId {
      // The set of tabs itself may have changed, which no `updateSections` can
      // express — the tab bar has to be rebuilt, and with it the whole stack.
      reload()
      return
    }

    for level in tabs + stack where level.parentId == parentId {
      fill(level, token: token)
    }
  }

  // MARK: - Errors (I2)

  /**
   * Show a browse failure as a modal alert with the app's own message.
   *
   * `CPAlertTemplate` is presented, never pushed — that is its documented
   * contract (developer.apple.com/documentation/carplay/cpalerttemplate, read
   * 2026-08-26) — and it always carries a way out, because an alert the driver
   * cannot dismiss is a car stuck on an error screen.
   *
   * The resolution action opens the app's deep link **on the phone**
   * (`UIApplication.open`): signing in is not something a head unit can do, and
   * Apple does not offer a text-entry template to an audio app. That is the
   * same shape as Android's `ERROR_RESOLUTION_ACTION_INTENT` (§2 A4).
   */
  private func present(_ failure: BrowseFailure) {
    guard let controller = interfaceController else { return }
    // One modal at a time is CarPlay's rule, and two browse calls can fail at
    // once (a tab fill racing a root reload). The first message stands; the
    // second would replace it with the same "you are signed out" sentence.
    guard controller.presentedTemplate == nil else { return }

    var actions: [CPAlertAction] = []
    if let resolution = failure.resolution, let url = URL(string: resolution.url) {
      actions.append(
        CPAlertAction(title: resolution.label, style: .default) { [weak self] _ in
          self?.interfaceController?.dismissTemplate(animated: true, completion: nil)
          UIApplication.shared.open(url, options: [:], completionHandler: nil)
        }
      )
    }
    actions.append(
      // Not localised, and deliberately the only string this package puts on a
      // car screen: everything else the driver reads — the message, the
      // resolution label — is the app's own, in the app's own language.
      CPAlertAction(title: "OK", style: .cancel) { [weak self] _ in
        self?.interfaceController?.dismissTemplate(animated: true, completion: nil)
      }
    )

    controller.presentTemplate(
      CPAlertTemplate(titleVariants: [failure.message], actions: actions),
      animated: true,
      completion: nil
    )
  }

  private func report(_ rejections: [RootTabRejection]) {
    guard !rejections.isEmpty, let source = CarPlayLink.shared.source else { return }
    for rejection in rejections {
      let reason: String
      switch rejection {
      case .notBrowsable(_):
        reason =
          "it is not browsable — a root tab has to open a list, so a playable-only "
          + "node cannot be one"
      case .overTabLimit(_):
        reason =
          "this car shows at most \(CPTabBarTemplate.maximumTabCount) tabs and it "
          + "came after those"
      }
      source.carPlayReport(
        CarPlayErrorCode.browseRootRejected,
        "CarPlay dropped the root item \"\(rejection.id)\": \(reason). Return at most "
          + "\(CPTabBarTemplate.maximumTabCount) browsable items from "
          + "getChildren(BROWSE_ROOT) — Android Auto's own limit is four, so four is "
          + "the number that works in every car."
      )
    }
  }
}

// MARK: - Tab selection

extension CarPlayCoordinator: CPTabBarTemplateDelegate {
  /// Fill a tab the first time the driver opens it (I2's "lazily").
  func tabBarTemplate(_ tabBarTemplate: CPTabBarTemplate, didSelect selectedTemplate: CPTemplate) {
    guard let level = tabs.first(where: { $0.template === selectedTemplate }) else { return }
    guard level.nodes.isEmpty else { return }
    fill(level, token: generation)
  }
}

// MARK: - Navigation

extension CarPlayCoordinator: CPInterfaceControllerDelegate {
  /**
   * Forget levels the driver navigated back out of.
   *
   * Without this, `stack` is append-only: every list ever pushed would be
   * retained for the lifetime of the connection, `invalidateBrowse` would
   * re-fetch templates nobody can see, and a Now Playing change would re-render
   * them. Asking the controller what it still holds — rather than assuming a
   * disappearance is a pop — is what makes it correct for
   * `popToRootTemplate` and for CarPlay's own back button alike.
   */
  func templateDidDisappear(_ aTemplate: CPTemplate, animated: Bool) {
    guard let controller = interfaceController else { return }
    let live = controller.templates
    stack.removeAll { level in !live.contains(level.template) }
  }
}

// MARK: - Up Next

extension CarPlayCoordinator: CPNowPlayingTemplateObserver {
  func nowPlayingTemplateUpNextButtonTapped(_ nowPlayingTemplate: CPNowPlayingTemplate) {
    guard let controller = interfaceController else { return }
    guard controller.templates.count < BrowseRules.maximumTemplateDepth else { return }
    controller.pushTemplate(upNextTemplate(), animated: true, completion: nil)
  }
}

/**
 * One list template and the browse node whose children it shows.
 *
 * A reference type on purpose: an asynchronous fetch resolves onto *this*
 * level, and a struct copied into the continuation would update a value nothing
 * is looking at.
 */
@MainActor
private final class BrowseLevel {
  let parentId: String
  let template: CPListTemplate
  /// What the app last answered for `parentId`. Kept so a Now Playing change
  /// can re-render the "playing" indicator without asking again.
  var nodes: [BrowseNode] = []
  var isLoading = false

  init(parentId: String, template: CPListTemplate) {
    self.parentId = parentId
    self.template = template
  }
}
