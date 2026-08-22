/**
 * afterPack hook: ad-hoc signs the packed macOS .app. Done here rather than `mac.identity: '-'` —
 * electron-builder 26.15.3 hands the dash to the keychain search, where any stray self-signed cert
 * can hijack it; `codesign --sign -` is unambiguous. `--deep` is fine for ad-hoc (no
 * identity/entitlements to propagate). CommonJS: electron-builder `require()`s the hook.
 */
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { execFileSync } = require('node:child_process')
// eslint-disable-next-line @typescript-eslint/no-require-imports
const path = require('node:path')

exports.default = async function adhocSign(context) {
  if (context.electronPlatformName !== 'darwin') return

  const appPath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`)
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], { stdio: 'inherit' })
}
