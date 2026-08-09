const { getDefaultConfig, mergeConfig } = require('@react-native/metro-config');
const path = require('path');

const workspaceRoot = path.resolve(__dirname, '../..');

/**
 * Metro configuration
 * https://facebook.github.io/metro/docs/configuration
 *
 * Metro will only read files under `projectRoot` or a `watchFolder`. In this
 * npm-workspaces repo that has to be the monorepo root: it holds both the
 * `packages/*` sources this app consumes and the hoisted `node_modules`
 * (`react`, `react-native`, `@babel/runtime`, …) that nothing resolves without.
 *
 * Caveat worth knowing before adding a dynamic `import()` to any workspace
 * package: Metro turns it into a split bundle whose dev URL is the module path
 * *relative to `projectRoot`*. For anything under `packages/` that is
 * `/../../packages/…`, which escapes the server root and fails to load. Keep
 * imports static, or move `projectRoot` to the workspace root (which then needs
 * `getJSMainModuleName()` in MainApplication.kt to match).
 *
 * @type {import('metro-config').MetroConfig}
 */
const config = {
  watchFolders: [workspaceRoot],
  resolver: {
    // Walk to the workspace root explicitly rather than relying on the
    // node_modules ancestor walk, which stops at the project root.
    nodeModulesPaths: [
      path.join(__dirname, 'node_modules'),
      path.join(workspaceRoot, 'node_modules'),
    ],
  },
};

module.exports = mergeConfig(getDefaultConfig(__dirname), config);
