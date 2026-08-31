# @afkcodes/timbre-player

## 0.2.0

### Minor Changes

- [`b56a7c5`](https://github.com/afkcodes/timbre/commit/b56a7c53dc366ecde8d0ccf37d3c04db10c9ccce) Thanks [@afkcodes](https://github.com/afkcodes)! - `trackChanged` now reports the current entry's stable identity (`entryId` + `uri`), not just its playlist index, so consumers can match the loaded track by identity instead of a position that drifts under shuffle/reorder/insert/remove.

## 0.1.0

### Minor Changes

- Initial release. libmpv-backed audio player exposed as a pure-C++ Nitro
  HybridObject: load / play / pause / seek, gapless queue, rate and pitch,
  a composable equaliser, ReplayGain gain modes, and a typed event and error
  taxonomy. Android device-verified end to end; iOS playback device-verified.
  Pre-1.0 — the API may still change.
