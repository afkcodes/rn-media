#pragma once

///
/// HybridMpvClient.hpp — Nitro glue for `rnmedia::MpvClient`.
///
/// This layer only converts types, forwards calls, and owns lifetimes. All mpv
/// behaviour lives in `MpvClient.*`; all batching/coalescing logic lives in
/// `EventBatch.hpp`. Nothing here knows how mpv works, and nothing there knows
/// what JSI is.
///
/// Threading (see MpvClient.hpp for the full contract):
///  - Every `HybridMpvClientSpec` override runs on the caller's thread, which
///    for Nitro sync methods is the JS thread.
///  - `MpvFlushCoordinator::onBatchReady` runs on the mpv event thread.
///  - `PendingCommands::settle` runs on the mpv event thread. Resolving a Nitro
///    `Promise` from there is safe: the resolver Nitro installed is an
///    `AsyncJSCallback` that hops to the JS thread via the Dispatcher
///    (react-native-nitro-modules `JSIConverter+Promise.hpp` / `JSCallback.hpp`).
///  - `SourceResolutionDelivery::deliver` runs on the mpv event thread, and on
///    the play-time path that thread is holding an mpv hook open while it waits
///    for `completeResolution`. It must therefore only ever *schedule* — which
///    is all a Nitro `=> void` callback does.
///  - `PrefetchDelivery::deliver` runs on the mpv event thread too, but always
///    *after* the hook it describes was continued, so nothing is blocked on it.
///

#include <cstdint>
#include <functional>
#include <memory>
#include <mutex>
#include <optional>
#include <string>
#include <unordered_map>
#include <vector>

#include "HybridMpvClientSpec.hpp"
#include "MpvClient.hpp"
#include "PcmTap.hpp"

namespace margelo::nitro::rnmediaplayer {

///
/// Bookkeeping for in-flight `mpv_command_async` calls.
///
/// Owns a `Promise<void>` per `reply_userdata` until the matching
/// `MPV_EVENT_COMMAND_REPLY` arrives (or the client is destroyed, at which
/// point every one of them is rejected — no promise is ever left dangling).
///
class PendingCommands final {
public:
  void add(std::uint64_t replyId, const std::shared_ptr<Promise<void>>& promise);
  /// Removes and returns the promise for `replyId`, or nullptr if unknown.
  std::shared_ptr<Promise<void>> take(std::uint64_t replyId);
  /// Event thread. Resolves on success, rejects with mpv's error string.
  void settle(std::uint64_t replyId, int error);
  void rejectAll(const std::exception_ptr& error);

private:
  std::mutex _mutex;
  std::unordered_map<std::uint64_t, std::shared_ptr<Promise<void>>> _promises;
};

///
/// Turns "the batch went non-empty" (event thread) into "one JS callback with
/// the whole batch" (JS thread).
///
/// The hop itself is Nitro's: the listener is an async callback, so invoking it
/// from any thread marshals the arguments onto the JS thread. What this class
/// adds is *back-pressure* — it only ever has one batch in flight, because the
/// listener's `Promise<bool>` tells us when JS actually consumed the previous
/// one. Everything that arrives meanwhile accumulates (and coalesces) in the
/// `EventBatch` and rides the next flush.
///
/// Held by `shared_ptr` because the completion continuations outlive the call
/// that registered them; they hold a `weak_ptr` and no-op once the client is
/// gone.
///
class MpvFlushCoordinator final : public std::enable_shared_from_this<MpvFlushCoordinator> {
public:
  using Listener = std::function<std::shared_ptr<Promise<bool>>(const std::vector<MpvEvent>&)>;

  /// Called once, before the mpv event thread exists.
  void attach(rnmedia::MpvClient* client);
  /// Called from `HybridMpvClient::destroy()` after the event thread is joined.
  void detach();

  void setListener(const Listener& listener);
  void clearListener();

  /// Event thread. Cheap: schedules, never blocks on JS.
  void onBatchReady();

private:
  void flush();
  /// One drain + deliver. Returns true if it should run again immediately.
  bool runOneFlush();
  /// Closes the `EventBatch` flush cycle; true if more events are waiting.
  bool continueAfterFlush();

  std::mutex _mutex;
  rnmedia::MpvClient* _client = nullptr; // not owned; outlives us by construction
  Listener _listener;
  /// A batch became ready while no listener was registered. The `EventBatch`
  /// stays armed (so nothing re-schedules) and `setListener` picks it up.
  bool _deferred = false;
  bool _flushRunning = false;
  bool _flushAgain = false;
  /// Reused across flushes so a steady event stream stops allocating.
  std::vector<rnmedia::Event> _native;
  std::vector<MpvEvent> _js;
};

///
/// Delivers analysed visualizer windows to JS, with the same back-pressure
/// contract `MpvFlushCoordinator` applies to events — and one deliberate
/// difference.
///
/// Events accumulate and coalesce while JS is busy, because a property change
/// that was never seen still has to be applied. A spectrum has no such duty: a
/// window that arrived while JS was busy is, by the time JS is free, a picture
/// of the past. So `PcmTap` drops those ticks outright and reports how many
/// (`AnalysedFrame::dropped`) instead of queueing them. Keep-latest, taken to
/// its logical end: keep-latest-or-nothing.
///
/// Held by `shared_ptr` for the same reason as the flush coordinator — the
/// Promise continuations outlive the sampler thread's call.
///
class VisualizerDelivery final : public std::enable_shared_from_this<VisualizerDelivery> {
public:
  using Listener = std::function<std::shared_ptr<Promise<bool>>(const VisualizerCapture&)>;

  /// Called once, before the sampler thread can exist.
  void attach(rnmedia::PcmTap* tap);
  /// Called from `HybridMpvClient::destroy()` after the sampler thread is gone.
  void detach();

  void setListener(const Listener& listener);
  void clearListener();

  /// Sampler thread. Marshals to JS and returns; never blocks on it.
  void deliver(rnmedia::AnalysedFrame&& frame);

private:
  /// Releases the one in-flight slot. Re-reads `_tap` under the lock, so a
  /// continuation that fires after teardown finds nothing and does nothing.
  void complete();

  std::mutex _mutex;
  rnmedia::PcmTap* _tap = nullptr; // not owned
  Listener _listener;
};

///
/// Carries "mpv needs this URL resolved" from the event thread to JavaScript.
///
/// The thinnest of the three delivery classes, and deliberately so: there is no
/// back-pressure clock here because the answer does not come back through a
/// completion promise — it comes back as a separate `completeResolution()` call
/// on the JS thread, which settles the native gate the event thread is waiting
/// on. One in-flight request per core is guaranteed by mpv itself: hook events
/// are delivered one at a time.
///
class SourceResolutionDelivery final {
public:
  using Listener = std::function<void(const SourceResolutionRequest&)>;

  void setListener(const Listener& listener);
  void clearListener();

  /// Event thread. Throws nothing it can help; the caller treats a throw as
  /// "the JS runtime is gone" and stops waiting.
  void deliver(const std::string& url, std::optional<std::int64_t> entryId);

private:
  std::mutex _mutex;
  Listener _listener;
};

///
/// Carries "mpv started prefetching this entry" from the event thread to
/// JavaScript.
///
/// Thinner still than `SourceResolutionDelivery`, and for one reason: the hook
/// has already been continued when this runs, so nothing in mpv is waiting.
/// That is also why a missing listener is silence rather than a throw — an
/// unobserved prefetch is simply unobserved, whereas an unanswerable resolution
/// request has to stop the caller from holding mpv's core open.
///
class PrefetchDelivery final {
public:
  using Listener = std::function<void(const PrefetchStartedEvent&)>;

  void setListener(const Listener& listener);
  void clearListener();

  /// Event thread. Schedules onto JS and returns; never blocks, never throws.
  void deliver(const std::string& url, std::optional<std::int64_t> entryId);

private:
  std::mutex _mutex;
  Listener _listener;
};

class HybridMpvClient final : public HybridMpvClientSpec {
public:
  HybridMpvClient();
  ~HybridMpvClient() override;

  void initialize(const std::unordered_map<std::string, std::string>& options) override;
  void destroy() override;

  std::shared_ptr<Promise<void>> command(const std::vector<std::string>& args) override;

  std::optional<std::string> getPropertyString(const std::string& name) override;
  std::optional<double> getPropertyNumber(const std::string& name) override;
  std::optional<bool> getPropertyBool(const std::string& name) override;

  void setPropertyString(const std::string& name, const std::string& value) override;
  void setPropertyNumber(const std::string& name, double value) override;
  void setPropertyBool(const std::string& name, bool value) override;

  void observeProperty(const std::string& name, MpvFormat format) override;
  void unobserveProperty(const std::string& name) override;

  void setEventBatchListener(
      const std::function<std::shared_ptr<Promise<bool>>(const std::vector<MpvEvent>&)>& onEventBatch) override;

  void startVisualizer(double fftSize, double fps, bool waveform) override;
  void stopVisualizer() override;
  void setVisualizerListener(
      const std::function<std::shared_ptr<Promise<bool>>(const VisualizerCapture&)>& onCapture) override;

  void setSourceResolutionListener(const std::function<void(const SourceResolutionRequest&)>& onRequest) override;
  void setPrefetchStartedListener(const std::function<void(const PrefetchStartedEvent&)>& onPrefetchStarted) override;
  void installSourceResolver(double timeoutMs) override;
  void uninstallSourceResolver() override;
  void setResolvedSource(const std::string& logical, const std::string& resolved, double ttlMs) override;
  void clearResolvedSources() override;
  void completeResolution(const std::string& logical, const std::optional<std::string>& resolved,
                          double ttlMs) override;

  void attachVideoOutput(uint64_t handle) override;
  void detachVideoOutput() override;
  uint64_t getRawHandle() override;

  /// JS-side `dispose()` (and Nitro's GC backstop) must free mpv too.
  void dispose() override;

private:
  /// Declaration order is load-bearing: `_client` is constructed last and
  /// destroyed first, so the event thread is joined while the coordinator and
  /// the pending-command table it calls into are still alive.
  std::shared_ptr<MpvFlushCoordinator> _flusher;
  std::shared_ptr<PendingCommands> _pending;
  std::shared_ptr<VisualizerDelivery> _visualizer;
  std::shared_ptr<SourceResolutionDelivery> _resolution;
  std::shared_ptr<PrefetchDelivery> _prefetch;
  std::unique_ptr<rnmedia::MpvClient> _client;
  /// Created on the first `startVisualizer`, so a player nobody visualises
  /// never allocates a sampler thread, an FFT table or a window.
  std::unique_ptr<rnmedia::PcmTap> _tap;
};

} // namespace margelo::nitro::rnmediaplayer
