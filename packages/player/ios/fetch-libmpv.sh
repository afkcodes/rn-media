#!/bin/sh
#
# fetch-libmpv.sh — download, checksum-verify and extract the prebuilt libmpv
# xcframeworks that `RnMediaPlayer.podspec` vendors on iOS.
#
# Pattern mirrors media-kit's `libs/ios/media_kit_libs_ios_audio/ios/Makefile`
# (curl the `ios-universal-audio-default` bundle → `shasum -a 256 -c` → untar
# into `Frameworks/`), rewritten as POSIX sh so it can be invoked directly from
# the podspec and from CI without depending on GNU/BSD make differences.
#
# Everything version-related lives in `libmpv.pin` next to this file.
#
# Idempotent: a stamp file records the tag+sha that is currently extracted; a
# second run with an unchanged pin is a no-op. The downloaded tarball is kept in
# a cache dir (override with $RN_MEDIA_LIBMPV_CACHE_DIR) so re-extraction never
# hits the network.
#
# Usage:  packages/player/ios/fetch-libmpv.sh [--force]

set -eu

SCRIPT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
PIN_FILE="${SCRIPT_DIR}/libmpv.pin"
FRAMEWORKS_DIR="${SCRIPT_DIR}/Frameworks"
STAMP_FILE="${FRAMEWORKS_DIR}/.libmpv-stamp"
CACHE_DIR="${RN_MEDIA_LIBMPV_CACHE_DIR:-${SCRIPT_DIR}/.cache/libmpv}"

FORCE=0
if [ "${1:-}" = "--force" ]; then
  FORCE=1
fi

log() { printf '[libmpv] %s\n' "$*"; }
die() { printf '[libmpv] error: %s\n' "$*" >&2; exit 1; }

[ -f "${PIN_FILE}" ] || die "missing pin file: ${PIN_FILE}"
# shellcheck source=./libmpv.pin
. "${PIN_FILE}"

: "${LIBMPV_DARWIN_BUILD_REPO:?not set in libmpv.pin}"
: "${LIBMPV_DARWIN_BUILD_TAG:?not set in libmpv.pin}"
: "${LIBMPV_DARWIN_BUILD_VARIANT:?not set in libmpv.pin}"
: "${LIBMPV_DARWIN_BUILD_SHA256:?not set in libmpv.pin}"

ARCHIVE="libmpv-xcframeworks_${LIBMPV_DARWIN_BUILD_TAG}_${LIBMPV_DARWIN_BUILD_VARIANT}.tar.gz"
URL="https://github.com/${LIBMPV_DARWIN_BUILD_REPO}/releases/download/${LIBMPV_DARWIN_BUILD_TAG}/${ARCHIVE}"
CACHED_ARCHIVE="${CACHE_DIR}/${ARCHIVE}"
STAMP_CONTENT="${LIBMPV_DARWIN_BUILD_TAG} ${LIBMPV_DARWIN_BUILD_VARIANT} ${LIBMPV_DARWIN_BUILD_SHA256}"

# --- helpers ----------------------------------------------------------------

# sha256_of <file> → lowercase hex digest on stdout.
# macOS ships `shasum`, most Linux distros ship `sha256sum`; accept either so
# the script is testable off-device.
if command -v shasum >/dev/null 2>&1; then
  sha256_of() { shasum -a 256 "$1" | cut -d ' ' -f 1; }
elif command -v sha256sum >/dev/null 2>&1; then
  sha256_of() { sha256sum "$1" | cut -d ' ' -f 1; }
else
  die "neither shasum nor sha256sum is available; cannot verify the download"
fi

verify() {
  actual=$(sha256_of "$1")
  [ "${actual}" = "${LIBMPV_DARWIN_BUILD_SHA256}" ] || {
    printf '[libmpv] error: checksum mismatch for %s\n' "$1" >&2
    printf '[libmpv]   expected %s\n' "${LIBMPV_DARWIN_BUILD_SHA256}" >&2
    printf '[libmpv]   actual   %s\n' "${actual}" >&2
    return 1
  }
}

# --- 0. already up to date? -------------------------------------------------

if [ "${FORCE}" -eq 0 ] &&
  [ -f "${STAMP_FILE}" ] &&
  [ -d "${FRAMEWORKS_DIR}/Mpv.xcframework" ] &&
  [ "$(cat "${STAMP_FILE}")" = "${STAMP_CONTENT}" ]; then
  log "${LIBMPV_DARWIN_BUILD_VARIANT} ${LIBMPV_DARWIN_BUILD_TAG} already extracted (cached)"
  exit 0
fi

# --- 1. download (cached) ---------------------------------------------------

mkdir -p "${CACHE_DIR}"

if [ -f "${CACHED_ARCHIVE}" ] && verify "${CACHED_ARCHIVE}" 2>/dev/null; then
  log "using cached ${ARCHIVE}"
else
  rm -f "${CACHED_ARCHIVE}"
  log "downloading ${URL}"
  command -v curl >/dev/null 2>&1 || die "curl is required"
  curl --fail --location --show-error --silent \
    --retry 3 --retry-delay 2 --retry-connrefused \
    --output "${CACHED_ARCHIVE}.tmp" \
    "${URL}" || die "download failed: ${URL}"
  verify "${CACHED_ARCHIVE}.tmp" || { rm -f "${CACHED_ARCHIVE}.tmp"; exit 1; }
  mv "${CACHED_ARCHIVE}.tmp" "${CACHED_ARCHIVE}"
fi

# --- 2. extract -------------------------------------------------------------

log "extracting into ${FRAMEWORKS_DIR}"
rm -f "${STAMP_FILE}"
rm -rf "${FRAMEWORKS_DIR}"
mkdir -p "${FRAMEWORKS_DIR}"

# The bundle has a single top-level dir named after the variant; strip it so the
# podspec can glob `ios/Frameworks/*.xcframework`.
tar -xzf "${CACHED_ARCHIVE}" --strip-components 1 -C "${FRAMEWORKS_DIR}" ||
  die "failed to extract ${CACHED_ARCHIVE}"

# --- 3. sanity-check the extracted tree -------------------------------------

for framework in ${LIBMPV_EXPECTED_FRAMEWORKS:-Mpv}; do
  [ -d "${FRAMEWORKS_DIR}/${framework}.xcframework" ] ||
    die "expected ${framework}.xcframework in the bundle but it is missing"
  for slice in ios-arm64 ios-arm64_x86_64-simulator; do
    [ -f "${FRAMEWORKS_DIR}/${framework}.xcframework/${slice}/${framework}.framework/${framework}" ] ||
      die "${framework}.xcframework is missing the ${slice} slice"
  done
done

printf '%s' "${STAMP_CONTENT}" >"${STAMP_FILE}"
# libplacebo is named here even though it ships no framework of its own: it is
# linked statically into Mpv.framework (mandatory for mpv >= 0.37), so it is part
# of what was just downloaded and belongs in the one line a developer reads.
log "ready: mpv ${LIBMPV_MPV_VERSION:-?} / FFmpeg ${LIBMPV_FFMPEG_VERSION:-?} / libplacebo ${LIBMPV_LIBPLACEBO_VERSION:-?} (${LIBMPV_DARWIN_BUILD_VARIANT} ${LIBMPV_DARWIN_BUILD_TAG})"
