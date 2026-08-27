/**
 * @format
 */

import { AppRegistry } from 'react-native';
/**
 * Playback resumption depends on this exact line — a bare, side-effect import
 * of the playback layer from the ENTRY file.
 *
 * `src/playback.ts` calls `MediaService.init` (via its `start()`) at module
 * scope, and a revived headless runtime only ever executes module
 * scope — no component mounts, no effect runs. But "module scope" alone is
 * not enough in a release build: Metro's inline requires (`inlineRequires:
 * true`, the RN default) rewrites every *binding* import — `import { x } from
 * './m'` — into a require at the first USE of `x`, and for anything used only
 * inside a component that first use is the first render, which a headless
 * runtime never performs. App.tsx importing `usePlayback` therefore does NOT
 * make the playback module load at boot. A bare side-effect import has no
 * bindings to defer, so it is the one form Metro must execute at bundle load.
 *
 * Regression history: the playback layer used to live at App.tsx module scope
 * where the entry's own import kept it eager; moving it into `src/playback/`
 * behind binding imports silently turned every cold revival into a 10-second
 * watchdog timeout ("MediaService.init was never called"), diagnosed on
 * device 2026-08-13 (task #47).
 */
import './src/playback';
import App from './App';
import { name as appName } from './app.json';

AppRegistry.registerComponent(appName, () => App);
