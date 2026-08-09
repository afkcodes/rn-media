const path = require('path');

/**
 * Resolve every `@rn-media/*` import to the package's TypeScript source, so the
 * example app exercises the code under review rather than a stale `lib/` build.
 */
const alias = Object.fromEntries(
  ['player', 'audio-session', 'media-session'].map(dir => {
    const root = path.join(__dirname, '../../packages', dir);
    const pak = require(path.join(root, 'package.json'));
    return [pak.name, path.join(root, pak.source)];
  }),
);

module.exports = api => {
  api.cache(true);
  return {
    presets: ['module:@react-native/babel-preset'],
    plugins: [
      [
        'module-resolver',
        {
          extensions: ['.js', '.ts', '.json', '.jsx', '.tsx'],
          alias,
        },
      ],
    ],
  };
};
