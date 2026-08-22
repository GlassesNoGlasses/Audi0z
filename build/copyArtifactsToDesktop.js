/**
 * afterAllArtifactBuild hook: copies finished installers to the Desktop; dist/ keeps the
 * originals. CommonJS: electron-builder `require()`s the hook.
 */
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { copyFile } = require('node:fs/promises')
// eslint-disable-next-line @typescript-eslint/no-require-imports
const os = require('node:os')
// eslint-disable-next-line @typescript-eslint/no-require-imports
const path = require('node:path')

/** Installers only — not the blockmap. */
const INSTALLER = /\.(dmg|exe|AppImage)$/i

/** Pure so the test can pin the selection without a filesystem. */
function desktopCopies(artifactPaths, desktopDir) {
  return (artifactPaths ?? [])
    .filter((artifact) => INSTALLER.test(artifact))
    .map((artifact) => ({ from: artifact, to: path.join(desktopDir, path.basename(artifact)) }))
}

exports.default = async function copyArtifactsToDesktop(result) {
  const copies = desktopCopies(result.artifactPaths, path.join(os.homedir(), 'Desktop'))
  for (const { from, to } of copies) {
    await copyFile(from, to)
    console.log(`  • copied ${path.basename(from)} to the Desktop`)
  }
  return []
}

exports.desktopCopies = desktopCopies
