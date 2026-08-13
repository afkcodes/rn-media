const path = require('path')

/** Every workspace package this app links against, by directory name. */
const LOCAL_PACKAGES = ['player', 'audio-session', 'cast', 'media-session']

/**
 * @type {import('@react-native-community/cli-types').Config}
 */
module.exports = {
    project: {
        ios: {
            automaticPodsInstallation: true,
        },
    },
    // Point autolinking at the workspace sources rather than at whatever npm
    // symlinked into node_modules, so an edit in packages/* is picked up
    // without a reinstall.
    dependencies: Object.fromEntries(
        LOCAL_PACKAGES.map(dir => {
            const root = path.join(__dirname, '../../packages', dir)
            return [require(path.join(root, 'package.json')).name, { root }]
        })
    ),
}
