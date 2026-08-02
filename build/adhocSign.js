/**
 * electron-builder afterPack hook: applies an ad-hoc signature to the packed macOS .app.
 *
 * electron-builder's own `mac.identity: '-'` cannot do this reliably. In 26.15.3 the dash is handed
 * to the keychain identity search as a substring qualifier before the ad-hoc branch is ever
 * reached, and the non-Apple-certificate fallback matches any `security find-identity` line
 * containing "-" — so a self-signed "gdb-cert" debugging cert on the build machine wins, and
 * `codesign --sign gdb-cert` then fails with "no identity found". Which cert hijacks the dash
 * depends on the machine's keychain. Signing is therefore switched off in electron-builder.yml
 * (`identity: null`) and done here, where `--sign -` unambiguously means ad-hoc.
 *
 * `--deep` is discouraged for real signing because it does not propagate identity and entitlements
 * correctly across nested code; a blanket ad-hoc signature carries neither, so there is nothing to
 * propagate and it is the right tool for re-sealing every nested binary in one pass.
 *
 * CommonJS on purpose: electron-builder `require()`s the hook, and package.json is not a module.
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
