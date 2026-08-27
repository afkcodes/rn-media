// Entry point Expo CLI looks for when an app lists `"@afkcodes/timbre-media-session"`
// in `plugins`. It must sit at the package root and must be plain JS: the CLI
// requires it before any TypeScript tooling exists.
module.exports = require('./plugin/build')
