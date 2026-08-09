# Vendored mpv client API headers

| | |
| --- | --- |
| Upstream | https://github.com/mpv-player/mpv |
| Tag | `v0.35.1` |
| Path upstream | `libmpv/client.h` |
| SHA-256 (`client.h`) | `deb873281b5bfc9041160be0e263f7f3428d91b15894a71bb037ba492ac28ad9` |

`v0.35.1` is the mpv version the pinned prebuilt binaries are built from — see
`v_mpv` in
[`buildscripts/include/depinfo.sh`](https://github.com/media-kit/libmpv-android-audio-build/blob/v1.1.9/buildscripts/include/depinfo.sh)
of `media-kit/libmpv-android-audio-build` at tag `v1.1.9`. Keep this tag in sync
with the pinned release in `packages/player/android/libmpv.gradle` (Android) and
the iOS equivalent.

`MPV_CLIENT_API_VERSION` in this header is `MPV_MAKE_VERSION(2, 0)`.

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
added by media-kit's
[`002.lavc_set_java_vm.patch`](https://github.com/media-kit/libmpv-android-audio-build/blob/v1.1.9/buildscripts/patches/mpv/002.lavc_set_java_vm.patch).
It is **not** part of upstream `client.h`, so it is not patched into this
vendored copy — it is declared locally in
`packages/player/android/src/main/cpp/cpp-adapter.cpp` (Android-only).
