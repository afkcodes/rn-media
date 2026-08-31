---
"@afkcodes/timbre-player": minor
---

`trackChanged` now reports the current entry's stable identity (`entryId` + `uri`), not just its playlist index, so consumers can match the loaded track by identity instead of a position that drifts under shuffle/reorder/insert/remove.
