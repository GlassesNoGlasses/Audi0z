/**
 * CommonJS on purpose, like build/adhocSign.js: electron-builder `require()`s the hook, and
 * package.json is not a module.
 */
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { copyFile } = require('node:fs/promises')
// eslint-disable-next-line @typescript-eslint/no-require-imports
const os = require('node:os')
// eslint-disable-next-line @typescript-eslint/no-require-imports
const path = require('node:path')

/** Installer artifacts only: the blockmap is update metadata nobody double-clicks. */
const INSTALLER = /\.(dmg|exe|AppImage)$/i

/** Pure so the test can pin the selection without a filesystem. */
function desktopCopies(artifactPaths, desktopDir) {
  return (artifactPaths ?? [])
    .filter((artifact) => INSTALLER.test(artifact))
    .map((artifact) => ({ from: artifact, to: path.join(desktopDir, path.basename(artifact)) }))
}

/**
 * electron-builder afterAllArtifactBuild hook: the finished installer lands on the Desktop, where
 * the user asked to find it. dist/ keeps the original. Returns no extra artifacts.
 */
exports.default = async function copyArtifactsToDesktop(result) {
  const copies = desktopCopies(result.artifactPaths, path.join(os.homedir(), 'Desktop'))
  for (const { from, to } of copies) {
    await copyFile(from, to)
    console.log(`  • copied ${path.basename(from)} to the Desktop`)
  }
  return []
}

exports.desktopCopies = desktopCopies
