#pragma once

///
/// NodeReader.hpp — reading `mpv_node` trees, with no `mpv_handle` in sight.
///
/// `mpv_get_property(..., MPV_FORMAT_NODE, ...)` is how this library reads
/// anything that is not a scalar: the whole tag map in one round-trip, the whole
/// playlist in one *coherent* round-trip (mpv builds the node under its own
/// lock, so unlike an `N + 1` sub-property walk the answer cannot stitch two
/// generations of an edited playlist together). What comes back is a plain C
/// struct tree, and walking it is fiddly in the way that C structs are:
/// parallel `keys`/`values` arrays, a `num` that is a signed `int`, a format tag
/// per member, and any pointer in it possibly null.
///
/// **That walk is separated from `MpvClient` on purpose.** Everything here is
/// `mpv/client.h` structs plus std — no `mpv_handle`, no call into libmpv, so
/// nothing links against it — which means a test can hand-build an `mpv_node`
/// and check the walk on a dev machine with no device and no NDK. Same pattern
/// as `EventBatch.hpp` and `SourceResolution.hpp`, for the same reason: the
/// parts that can be wrong quietly are the parts that must be testable.
///
/// ### Ownership
/// Nothing here owns anything. Every `string_view` and every byte pointer points
/// into the caller's node, which for a property read is mpv's own memory and is
/// freed by `mpv_free_node_contents` the moment the read returns. A visitor that
/// wants to keep a value must copy it. That is also why this is a visitor API
/// rather than one returning a vector: the visualizer reads a multi-kilobyte
/// byte array up to 60 times a second, and a value-returning shape would
/// allocate and copy it twice per frame.
///

#include <cstddef>
#include <cstdint>
#include <functional>
#include <optional>
#include <string_view>

#include <mpv/client.h>

namespace rnmedia {

/// One member of an `MPV_FORMAT_NODE_MAP`, as handed to a visitor.
///
/// Every field is empty unless the member's format sets it (see
/// `visitNodeMap`), so a consumer reads the one it expects and gets `nullopt`
/// rather than a coerced value when mpv answers with something else.
struct NodeMember {
  std::string_view key;
  /// Set for `INT64`, `DOUBLE` and `FLAG` members (flags arrive as 0 / 1).
  std::optional<double> number;
  /// Set for `INT64` and `FLAG` members, without the double round-trip.
  std::optional<std::int64_t> integer;
  /// Set for `STRING` members.
  std::optional<std::string_view> text;
  /// Set for `BYTE_ARRAY` members; `nullptr` otherwise.
  const std::uint8_t* bytes = nullptr;
  std::size_t byteCount = 0;
};

/// Called once per member of a map, in mpv's own order.
using NodeMemberVisitor = std::function<void(const NodeMember&)>;
/// Called once per member of every element of an array of maps, tagged with the
/// element's 0-based index.
using IndexedNodeMemberVisitor = std::function<void(std::size_t index, const NodeMember&)>;

/// Walk one `MPV_FORMAT_NODE_MAP` node, handing each member to `visit`.
///
/// @returns `false` when `node` is not a map (or carries a null list), in which
/// case `visit` is never called. Not an error: mpv answers
/// `MPV_ERROR_PROPERTY_UNAVAILABLE`-shaped questions with whatever it has, and a
/// caller that asked for `metadata` on an idle core wants "nothing to read", not
/// an exception.
///
/// Members whose format has no consumer here — nested maps and arrays — are
/// visited with **only their key set**. They are deliberately not walked
/// recursively: this library reads flat maps (tag maps, playlist entries), and a
/// half-implemented tree walker would be a worse lie than an empty value. The
/// member is still visited rather than skipped so that a consumer counting keys
/// sees mpv's map as it really is.
inline bool visitNodeMap(const mpv_node& node, const NodeMemberVisitor& visit) {
  if (node.format != MPV_FORMAT_NODE_MAP || node.u.list == nullptr) {
    return false;
  }
  const mpv_node_list* list = node.u.list;
  // `keys` is null for a *list*, and mpv is not obliged to hand a map back with
  // one — an empty map legitimately carries `num == 0` and null arrays.
  if (list->num > 0 && (list->keys == nullptr || list->values == nullptr)) {
    return false;
  }
  for (int i = 0; i < list->num; i++) {
    const mpv_node& value = list->values[i];
    NodeMember member;
    member.key = list->keys[i] == nullptr ? std::string_view{} : std::string_view(list->keys[i]);
    switch (value.format) {
      case MPV_FORMAT_INT64:
        member.integer = value.u.int64;
        member.number = static_cast<double>(value.u.int64);
        break;
      case MPV_FORMAT_DOUBLE:
        member.number = value.u.double_;
        break;
      case MPV_FORMAT_FLAG:
        member.integer = value.u.flag;
        member.number = static_cast<double>(value.u.flag);
        break;
      case MPV_FORMAT_STRING:
      case MPV_FORMAT_OSD_STRING:
        if (value.u.string != nullptr) {
          member.text = std::string_view(value.u.string);
        }
        break;
      case MPV_FORMAT_BYTE_ARRAY:
        if (value.u.ba != nullptr) {
          member.bytes = static_cast<const std::uint8_t*>(value.u.ba->data);
          member.byteCount = value.u.ba->size;
        }
        break;
      default:
        // Nested maps/arrays, `MPV_FORMAT_NONE`, and anything a future mpv
        // adds. See the note above: key only, and no guessing.
        break;
    }
    visit(member);
  }
  return true;
}

/// Walk an `MPV_FORMAT_NODE_ARRAY` **of maps**, visiting every member of every
/// element in mpv's order, tagged with the element's 0-based index.
///
/// @returns `false` when `node` is not an array (or carries a null list).
///
/// Elements that are not maps contribute no members rather than aborting the
/// walk — `playlist` is an array of maps today, and an mpv that one day slips
/// something else into it should cost the caller the entries it cannot read,
/// not the ones it can.
inline bool visitNodeMapArray(const mpv_node& node, const IndexedNodeMemberVisitor& visit) {
  if (node.format != MPV_FORMAT_NODE_ARRAY || node.u.list == nullptr) {
    return false;
  }
  const mpv_node_list* list = node.u.list;
  if (list->num > 0 && list->values == nullptr) {
    return false;
  }
  for (int i = 0; i < list->num; i++) {
    const std::size_t index = static_cast<std::size_t>(i);
    visitNodeMap(list->values[i], [&](const NodeMember& member) { visit(index, member); });
  }
  return true;
}

} // namespace rnmedia
