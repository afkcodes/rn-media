///
/// Host-compiled tests for `NodeReader.hpp` — the `mpv_node` walks behind
/// `MpvClient::getPropertyNodeMap` / `getPropertyNodeMapArray`.
///
/// `mpv_node` is a plain C struct, so the trees below are hand-built on the
/// stack and no libmpv is linked, loaded or mocked. That is the whole point of
/// the extraction: the failure modes here are the quiet kind — a missing
/// optional key read as zero, a member of an unexpected format coerced into a
/// number, a null pointer in an array mpv is allowed to hand back — and none of
/// them can be seen from a device without knowing what to look for.
///
/// Everything is built with a small builder rather than raw initialisers
/// because `mpv_node_list` is two parallel arrays: keeping keys and values in
/// step by hand in twenty tests is how a test suite starts testing itself.
///

#include "NodeReader.hpp"
#include "TestRunner.h"

#include <cstring>
#include <memory>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

using rnmedia::NodeMember;
using rnmedia::visitNodeMap;
using rnmedia::visitNodeMapArray;

namespace {

/// Builds one `MPV_FORMAT_NODE_MAP` and owns every string it points at.
///
/// The node borrows from this object, exactly as a real one borrows from mpv's
/// allocation, so it must outlive every walk. `deque`-like stability is what
/// the `std::string` indirection buys: the key/value vectors are only filled in
/// by `node()`, once everything has been added and nothing can reallocate.
class MapBuilder {
public:
  MapBuilder& string(std::string key, std::string value) {
    _keys.push_back(std::move(key));
    _strings.push_back(std::make_unique<std::string>(std::move(value)));
    mpv_node node{};
    node.format = MPV_FORMAT_STRING;
    node.u.string = _strings.back()->data();
    _values.push_back(node);
    return *this;
  }

  MapBuilder& osdString(std::string key, std::string value) {
    string(std::move(key), std::move(value));
    _values.back().format = MPV_FORMAT_OSD_STRING;
    return *this;
  }

  MapBuilder& integer(std::string key, std::int64_t value) {
    _keys.push_back(std::move(key));
    mpv_node node{};
    node.format = MPV_FORMAT_INT64;
    node.u.int64 = value;
    _values.push_back(node);
    return *this;
  }

  MapBuilder& number(std::string key, double value) {
    _keys.push_back(std::move(key));
    mpv_node node{};
    node.format = MPV_FORMAT_DOUBLE;
    node.u.double_ = value;
    _values.push_back(node);
    return *this;
  }

  MapBuilder& flag(std::string key, bool value) {
    _keys.push_back(std::move(key));
    mpv_node node{};
    node.format = MPV_FORMAT_FLAG;
    node.u.flag = value ? 1 : 0;
    _values.push_back(node);
    return *this;
  }

  MapBuilder& none(std::string key) {
    _keys.push_back(std::move(key));
    mpv_node node{};
    node.format = MPV_FORMAT_NONE;
    _values.push_back(node);
    return *this;
  }

  /// A member whose value is itself a map — what a nested tree looks like.
  MapBuilder& nested(std::string key) {
    _keys.push_back(std::move(key));
    mpv_node node{};
    node.format = MPV_FORMAT_NODE_MAP;
    node.u.list = nullptr;
    _values.push_back(node);
    return *this;
  }

  /// A `STRING` member whose pointer mpv left null.
  MapBuilder& nullString(std::string key) {
    _keys.push_back(std::move(key));
    mpv_node node{};
    node.format = MPV_FORMAT_STRING;
    node.u.string = nullptr;
    _values.push_back(node);
    return *this;
  }

  /// Materialise the node. Valid until this builder is mutated or destroyed.
  mpv_node node() {
    _keyPointers.clear();
    _keyPointers.reserve(_keys.size());
    for (auto& key : _keys) {
      _keyPointers.push_back(key.data());
    }
    _list.num = static_cast<int>(_values.size());
    _list.keys = _keyPointers.empty() ? nullptr : _keyPointers.data();
    _list.values = _values.empty() ? nullptr : _values.data();

    mpv_node node{};
    node.format = MPV_FORMAT_NODE_MAP;
    node.u.list = &_list;
    return node;
  }

  /// The last key added had its pointer nulled — mpv's `keys[i]` can be null.
  MapBuilder& withNullLastKey() {
    _nullLastKey = true;
    return *this;
  }

  mpv_node nodeWithNullKeys() {
    mpv_node built = node();
    if (_nullLastKey && !_keyPointers.empty()) {
      _keyPointers.back() = nullptr;
    }
    return built;
  }

private:
  std::vector<std::string> _keys;
  std::vector<std::unique_ptr<std::string>> _strings;
  std::vector<mpv_node> _values;
  std::vector<char*> _keyPointers;
  mpv_node_list _list{};
  bool _nullLastKey = false;
};

/// Builds an `MPV_FORMAT_NODE_ARRAY` out of already-built element nodes.
class ArrayBuilder {
public:
  ArrayBuilder& add(mpv_node element) {
    _values.push_back(element);
    return *this;
  }

  mpv_node node() {
    _list.num = static_cast<int>(_values.size());
    _list.keys = nullptr; // arrays carry no keys — mpv's own invariant
    _list.values = _values.empty() ? nullptr : _values.data();
    mpv_node node{};
    node.format = MPV_FORMAT_NODE_ARRAY;
    node.u.list = &_list;
    return node;
  }

private:
  std::vector<mpv_node> _values;
  mpv_node_list _list{};
};

/// One visited member, copied out of the borrowed view so assertions can run
/// after the node is gone — which is also what every real consumer must do.
struct Captured {
  std::size_t index = 0;
  std::string key;
  bool hasNumber = false;
  double number = 0;
  bool hasInteger = false;
  std::int64_t integer = 0;
  bool hasText = false;
  std::string text;
  const std::uint8_t* bytes = nullptr;
  std::size_t byteCount = 0;
};

Captured capture(const NodeMember& member, std::size_t index = 0) {
  Captured out;
  out.index = index;
  out.key = std::string(member.key);
  out.hasNumber = member.number.has_value();
  out.number = member.number.value_or(0);
  out.hasInteger = member.integer.has_value();
  out.integer = member.integer.value_or(0);
  out.hasText = member.text.has_value();
  out.text = member.text.has_value() ? std::string(*member.text) : std::string();
  out.bytes = member.bytes;
  out.byteCount = member.byteCount;
  return out;
}

std::vector<Captured> walkMap(const mpv_node& node, bool* accepted = nullptr) {
  std::vector<Captured> seen;
  const bool ok = visitNodeMap(node, [&](const NodeMember& member) { seen.push_back(capture(member)); });
  if (accepted != nullptr) {
    *accepted = ok;
  }
  return seen;
}

std::vector<Captured> walkArray(const mpv_node& node, bool* accepted = nullptr) {
  std::vector<Captured> seen;
  const bool ok = visitNodeMapArray(
      node, [&](std::size_t index, const NodeMember& member) { seen.push_back(capture(member, index)); });
  if (accepted != nullptr) {
    *accepted = ok;
  }
  return seen;
}

} // namespace

// ---------------------------------------------------------------------------
// Map extraction
// ---------------------------------------------------------------------------

TEST(NodeReader, extractsEveryScalarFormatIntoItsOwnField) {
  MapBuilder map;
  map.string("title", "Test Track").integer("id", 7).number("duration", 213.5).flag("current", true);
  mpv_node node = map.node();

  bool accepted = false;
  const auto seen = walkMap(node, &accepted);

  CHECK(accepted);
  CHECK_EQ(seen.size(), std::size_t{4});

  CHECK_EQ(seen[0].key, std::string("title"));
  CHECK(seen[0].hasText);
  CHECK_EQ(seen[0].text, std::string("Test Track"));
  // A string is *only* a string: nothing coerces it into a number, so a
  // consumer reading `number` gets an honest "absent".
  CHECK(!seen[0].hasNumber);
  CHECK(!seen[0].hasInteger);

  // An INT64 fills both numeric fields, so a caller wanting an id pays no
  // double round-trip and a caller wanting a quantity still gets one.
  CHECK_EQ(seen[1].key, std::string("id"));
  CHECK(seen[1].hasInteger);
  CHECK_EQ(seen[1].integer, std::int64_t{7});
  CHECK(seen[1].hasNumber);
  CHECK_EQ(seen[1].number, 7.0);
  CHECK(!seen[1].hasText);

  // A DOUBLE fills only `number`: truncating 213.5 into an integer field would
  // be a lie the caller could not detect.
  CHECK_EQ(seen[2].key, std::string("duration"));
  CHECK(seen[2].hasNumber);
  CHECK_EQ(seen[2].number, 213.5);
  CHECK(!seen[2].hasInteger);

  // A FLAG arrives as 0/1 in both numeric fields — this is how `current` and
  // `playing` are read off a playlist entry.
  CHECK_EQ(seen[3].key, std::string("current"));
  CHECK(seen[3].hasInteger);
  CHECK_EQ(seen[3].integer, std::int64_t{1});
  CHECK_EQ(seen[3].number, 1.0);
}

TEST(NodeReader, readsAnOsdStringLikeAString) {
  MapBuilder map;
  map.osdString("media-title", "Diverse FM");
  mpv_node node = map.node();

  const auto seen = walkMap(node);
  CHECK_EQ(seen.size(), std::size_t{1});
  CHECK(seen[0].hasText);
  CHECK_EQ(seen[0].text, std::string("Diverse FM"));
}

TEST(NodeReader, aFalseFlagIsPresentAndZeroRatherThanAbsent) {
  // The distinction the playlist reader depends on: "not the current entry" is
  // a value, "mpv did not say" is not, and a consumer that cannot tell them
  // apart marks every entry current or none.
  MapBuilder map;
  map.flag("current", false);
  mpv_node node = map.node();

  const auto seen = walkMap(node);
  CHECK_EQ(seen.size(), std::size_t{1});
  CHECK(seen[0].hasInteger);
  CHECK_EQ(seen[0].integer, std::int64_t{0});
}

TEST(NodeReader, anAbsentOptionalMemberIsSimplyNotVisited) {
  // mpv omits `current` from every playlist entry but one, and omits `title`
  // from an entry with no metadata. Nothing here invents a member for them.
  MapBuilder map;
  map.string("filename", "https://cdn.example.com/a.mp3").integer("id", 1);
  mpv_node node = map.node();

  const auto seen = walkMap(node);
  CHECK_EQ(seen.size(), std::size_t{2});
  CHECK_EQ(seen[0].key, std::string("filename"));
  CHECK_EQ(seen[1].key, std::string("id"));
}

TEST(NodeReader, visitsAMemberOfAnUnreadableFormatWithItsKeyAndNothingElse) {
  // Nested maps/arrays and `MPV_FORMAT_NONE` are deliberately not walked. The
  // member is still reported so a consumer counting keys sees mpv's map as it
  // is; every value field is empty, so nothing can be misread as data.
  MapBuilder map;
  map.string("filename", "a.mp3").nested("chapters").none("nothing").integer("id", 3);
  mpv_node node = map.node();

  const auto seen = walkMap(node);
  CHECK_EQ(seen.size(), std::size_t{4});

  CHECK_EQ(seen[1].key, std::string("chapters"));
  CHECK(!seen[1].hasText);
  CHECK(!seen[1].hasNumber);
  CHECK(!seen[1].hasInteger);
  CHECK(seen[1].bytes == nullptr);

  CHECK_EQ(seen[2].key, std::string("nothing"));
  CHECK(!seen[2].hasNumber);

  // …and the walk carries on: one unreadable member must not cost the caller
  // the ones after it.
  CHECK_EQ(seen[3].key, std::string("id"));
  CHECK_EQ(seen[3].integer, std::int64_t{3});
}

TEST(NodeReader, aNullStringPointerIsAnAbsentValueRatherThanACrash) {
  MapBuilder map;
  map.nullString("title").integer("id", 2);
  mpv_node node = map.node();

  const auto seen = walkMap(node);
  CHECK_EQ(seen.size(), std::size_t{2});
  CHECK_EQ(seen[0].key, std::string("title"));
  CHECK(!seen[0].hasText);
  CHECK_EQ(seen[1].integer, std::int64_t{2});
}

TEST(NodeReader, aNullKeyBecomesAnEmptyKeyRatherThanADereference) {
  MapBuilder map;
  map.string("filename", "a.mp3").integer("id", 4);
  map.withNullLastKey();
  mpv_node node = map.nodeWithNullKeys();

  const auto seen = walkMap(node);
  CHECK_EQ(seen.size(), std::size_t{2});
  CHECK_EQ(seen[1].key, std::string(""));
  CHECK_EQ(seen[1].integer, std::int64_t{4});
}

TEST(NodeReader, anEmptyMapIsAcceptedAndVisitsNothing) {
  MapBuilder map;
  mpv_node node = map.node();

  bool accepted = false;
  const auto seen = walkMap(node, &accepted);
  // Accepted, not rejected: mpv answering "no tags yet" with an empty map is a
  // real answer, and a caller must be able to tell it from "not a map".
  CHECK(accepted);
  CHECK(seen.empty());
}

TEST(NodeReader, rejectsANodeThatIsNotAMap) {
  for (const int format : {MPV_FORMAT_NONE, MPV_FORMAT_STRING, MPV_FORMAT_INT64, MPV_FORMAT_NODE_ARRAY}) {
    mpv_node node{};
    node.format = static_cast<mpv_format>(format);
    bool accepted = true;
    const auto seen = walkMap(node, &accepted);
    CHECK(!accepted);
    CHECK(seen.empty());
  }
}

TEST(NodeReader, rejectsAMapWithANullList) {
  mpv_node node{};
  node.format = MPV_FORMAT_NODE_MAP;
  node.u.list = nullptr;

  bool accepted = true;
  const auto seen = walkMap(node, &accepted);
  CHECK(!accepted);
  CHECK(seen.empty());
}

TEST(NodeReader, rejectsANonEmptyMapWhoseArraysAreNull) {
  // Degenerate rather than expected — but `num` and the arrays are independent
  // fields in a C struct, and walking them on trust is a segfault on a device.
  mpv_node_list list{};
  list.num = 3;
  list.keys = nullptr;
  list.values = nullptr;
  mpv_node node{};
  node.format = MPV_FORMAT_NODE_MAP;
  node.u.list = &list;

  bool accepted = true;
  const auto seen = walkMap(node, &accepted);
  CHECK(!accepted);
  CHECK(seen.empty());
}

TEST(NodeReader, aNegativeCountVisitsNothing) {
  // `num` is a signed int in mpv's ABI. Nothing should ever produce a negative
  // one; the loop must not care if something does.
  MapBuilder map;
  map.string("filename", "a.mp3");
  mpv_node node = map.node();
  const_cast<mpv_node_list*>(node.u.list)->num = -1;

  bool accepted = false;
  const auto seen = walkMap(node, &accepted);
  CHECK(accepted);
  CHECK(seen.empty());
}

// ---------------------------------------------------------------------------
// Array of maps — the `playlist` shape
// ---------------------------------------------------------------------------

TEST(NodeReader, tagsEveryMemberWithItsElementIndex) {
  MapBuilder first;
  first.string("filename", "a.mp3").integer("id", 1).flag("current", true);
  MapBuilder second;
  second.string("filename", "b.mp3").integer("id", 2);
  MapBuilder third;
  third.string("filename", "c.mp3").integer("id", 3);

  ArrayBuilder array;
  array.add(first.node()).add(second.node()).add(third.node());
  mpv_node node = array.node();

  bool accepted = false;
  const auto seen = walkArray(node, &accepted);

  CHECK(accepted);
  // 3 + 2 + 2: only the current entry carries a `current` flag.
  CHECK_EQ(seen.size(), std::size_t{7});
  CHECK_EQ(seen[0].index, std::size_t{0});
  CHECK_EQ(seen[2].key, std::string("current"));
  CHECK_EQ(seen[2].index, std::size_t{0});
  // Entries 2 and 3 have no `current` member at all — this is the case that
  // makes an index-tagged visitor necessary: the member count per element is
  // not fixed, so nothing downstream can divide by it.
  CHECK_EQ(seen[3].index, std::size_t{1});
  CHECK_EQ(seen[3].key, std::string("filename"));
  CHECK_EQ(seen[4].index, std::size_t{1});
  CHECK_EQ(seen[5].index, std::size_t{2});
  CHECK_EQ(seen[6].index, std::size_t{2});
  CHECK_EQ(seen[6].integer, std::int64_t{3});
}

TEST(NodeReader, anElementThatIsNotAMapCostsOnlyItself) {
  MapBuilder first;
  first.string("filename", "a.mp3");
  MapBuilder third;
  third.string("filename", "c.mp3");

  mpv_node stray{};
  stray.format = MPV_FORMAT_INT64;
  stray.u.int64 = 99;

  ArrayBuilder array;
  array.add(first.node()).add(stray).add(third.node());
  mpv_node node = array.node();

  bool accepted = false;
  const auto seen = walkArray(node, &accepted);

  CHECK(accepted);
  CHECK_EQ(seen.size(), std::size_t{2});
  CHECK_EQ(seen[0].index, std::size_t{0});
  // The index still counts the skipped element, so it keeps meaning "position
  // in mpv's playlist" rather than "position among the readable ones".
  CHECK_EQ(seen[1].index, std::size_t{2});
  CHECK_EQ(seen[1].text, std::string("c.mp3"));
}

TEST(NodeReader, anEmptyArrayIsAcceptedAndVisitsNothing) {
  ArrayBuilder array;
  mpv_node node = array.node();

  bool accepted = false;
  const auto seen = walkArray(node, &accepted);
  // An idle core's `playlist` is exactly this, and it is not an error.
  CHECK(accepted);
  CHECK(seen.empty());
}

TEST(NodeReader, rejectsANodeThatIsNotAnArray) {
  MapBuilder map;
  map.string("filename", "a.mp3");
  mpv_node node = map.node();

  bool accepted = true;
  const auto seen = walkArray(node, &accepted);
  CHECK(!accepted);
  CHECK(seen.empty());
}

TEST(NodeReader, rejectsAnArrayWithANullList) {
  mpv_node node{};
  node.format = MPV_FORMAT_NODE_ARRAY;
  node.u.list = nullptr;

  bool accepted = true;
  const auto seen = walkArray(node, &accepted);
  CHECK(!accepted);
  CHECK(seen.empty());
}

TEST(NodeReader, rejectsANonEmptyArrayWithNullValues) {
  mpv_node_list list{};
  list.num = 2;
  list.values = nullptr;
  mpv_node node{};
  node.format = MPV_FORMAT_NODE_ARRAY;
  node.u.list = &list;

  bool accepted = true;
  const auto seen = walkArray(node, &accepted);
  CHECK(!accepted);
  CHECK(seen.empty());
}

TEST(NodeReader, walksADeepArrayWithoutLosingTheIndex) {
  // 64 entries, three members each: the shape a real queue has, checked for
  // the one thing a hand-written loop gets wrong — the tag drifting.
  std::vector<std::unique_ptr<MapBuilder>> maps;
  ArrayBuilder array;
  for (int i = 0; i < 64; i++) {
    auto map = std::make_unique<MapBuilder>();
    map->string("filename", "track-" + std::to_string(i) + ".mp3").integer("id", i + 1).flag("current", i == 17);
    array.add(map->node());
    maps.push_back(std::move(map));
  }
  mpv_node node = array.node();

  const auto seen = walkArray(node);

  CHECK_EQ(seen.size(), std::size_t{64 * 3});
  for (std::size_t i = 0; i < 64; i++) {
    const Captured& filename = seen[i * 3];
    const Captured& id = seen[i * 3 + 1];
    const Captured& current = seen[i * 3 + 2];
    CHECK_EQ(filename.index, i);
    CHECK_EQ(id.index, i);
    CHECK_EQ(current.index, i);
    CHECK_EQ(id.integer, static_cast<std::int64_t>(i + 1));
    CHECK_EQ(current.integer, static_cast<std::int64_t>(i == 17 ? 1 : 0));
  }
}

TEST(NodeReader, aThrowingVisitorPropagatesRatherThanBeingSwallowed) {
  // `MpvClient` frees mpv's node with an RAII guard precisely because a visitor
  // can throw. If the walk swallowed it, that guard would be pointless and the
  // failure would vanish.
  MapBuilder map;
  map.string("filename", "a.mp3").integer("id", 1);
  mpv_node node = map.node();

  bool threw = false;
  try {
    visitNodeMap(node, [](const NodeMember& member) {
      if (member.key == "id") {
        throw std::runtime_error("visitor gave up");
      }
    });
  } catch (const std::runtime_error&) {
    threw = true;
  }
  CHECK(threw);
}
