# Vendored mpv client API headers

| | |
| --- | --- |
| Upstream | https://github.com/mpv-player/mpv |
| Tag | `v0.41.0` |
| Path upstream | `include/mpv/client.h` (was `libmpv/client.h` before mpv 0.38) |
| SHA-256 (`client.h`) | `3c073236a09cb456c6e80587d5523c8771c32fb22ca014e0f99cc3d43905b75c` |

`v0.41.0` is the mpv version the pinned prebuilt binaries are built from — see
`v_mpv` in
[`buildscripts/include/depinfo.sh`](https://github.com/afkcodes/libmpv-android-audio-build/blob/v1.1.9-rnmedia.5/buildscripts/include/depinfo.sh)
of `afkcodes/libmpv-android-audio-build` at tag `v1.1.9-rnmedia.5`. Keep this tag in sync
with the pinned release in `packages/player/android/libmpv.gradle` (Android) and
the iOS equivalent.

`MPV_CLIENT_API_VERSION` in this header is `MPV_MAKE_VERSION(2, 5)`.

**Both platforms build the same mpv now**, so for the first time this is a
single header truth rather than the lower bound of two. Previously Android
shipped 0.35.1 (API 2.0) and iOS 0.36.0 (API 2.1), and the vendored header had
to be the older of the two.

Nothing this library calls changed between 2.0 and 2.5 — the intervening minor
bumps are `mpv_del_property` (2.1), `mpv_time_ns` (2.2) and three render/VO-only
changes (2.3-2.5), and the `mpv_error` enum is byte-identical. The header is
bumped anyway, because a vendored header that lags the binary drifts silently.

## What is (deliberately) not here

Only `client.h` is vendored. `render.h` / `render_gl.h` are **intentionally
excluded**: the player core never links video code (project rule, `CLAUDE.md`
§ "Modular"). `stream_cb.h` is not vendored either — add it only when a custom
stream callback is actually implemented.

## License

`libmpv/client.h` is licensed under **ISC** so that non-GPL wrappers can use it.
The header carries its own license text; reproduced here for convenience:

```
Copyright (C) 2017 the mpv developers

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
```

The *binary* we link against is the `default` (LGPL) flavour of
`media-kit/libmpv-android-audio-build`, i.e. mpv built with `--enable-lgpl`
against LGPL ffmpeg. It is linked dynamically (`libmpv.so` shipped verbatim in
the AAR), which is what LGPL relinking requires.

## Downstream patch not reflected here

The prebuilt `libmpv.so` additionally exports `mpv_lavc_set_java_vm(void *vm)`,
added by our fork's
[`002.lavc_set_java_vm.patch`](https://github.com/afkcodes/libmpv-android-audio-build/blob/v1.1.9-rnmedia.5/buildscripts/patches/mpv/002.lavc_set_java_vm.patch)
(originally media-kit's, rebased onto 0.41 — mpv 0.37 deleted `libmpv/mpv.def`,
so the export now rides on the `MPV_EXPORT` attribute alone).
It is **not** part of upstream `client.h`, so it is not patched into this
vendored copy — it is declared locally in
`packages/player/android/src/main/cpp/cpp-adapter.cpp` (Android-only).
