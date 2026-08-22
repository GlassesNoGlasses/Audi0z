#!/usr/bin/env node
/**
 * Downloads the pinned yt-dlp binaries into `resources/bin/<platform>/`.
 * Usage: `node scripts/fetch-ytdlp.mjs [darwin|win32|linux ...]` — no args means all platforms.
 */

import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const YTDLP_VERSION = '2026.08.19'

const ASSETS = {
  darwin: 'yt-dlp_macos',
  win32: 'yt-dlp.exe',
  linux: 'yt-dlp_linux'
}

const RELEASE_BASE = `https://github.com/yt-dlp/yt-dlp/releases/download/${YTDLP_VERSION}`
const CHECKSUMS_URL = `${RELEASE_BASE}/SHA2-256SUMS`

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const binRoot = path.join(repoRoot, 'resources', 'bin')

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

async function download(url) {
  const res = await fetch(url, { redirect: 'follow' })
  if (!res.ok) {
    throw new Error(`GET ${url} failed: ${res.status} ${res.statusText}`)
  }
  return Buffer.from(await res.arrayBuffer())
}

// Parses `<sha256>  <filename>` lines SHA2-256SUMS
function parseChecksums(text) {
  const sums = new Map()
  for (const line of text.split('\n')) {
    const match = /^([0-9a-f]{64})\s+\*?(\S+)$/.exec(line.trim())
    if (match) sums.set(match[2], match[1])
  }
  return sums
}

async function alreadyValid(target, expected) {
  try {
    return sha256(await readFile(target)) === expected
  } catch {
    return false
  }
}

async function fetchForPlatform(platform, checksums) {
  const asset = ASSETS[platform]
  const expected = checksums.get(asset)
  if (!expected) {
    throw new Error(`SHA2-256SUMS for ${YTDLP_VERSION} has no entry for ${asset}`)
  }

  const dir = path.join(binRoot, platform)
  const target = path.join(dir, asset)

  if (await alreadyValid(target, expected)) {
    console.log(`yt-dlp ${YTDLP_VERSION} ${platform}: up to date`)
    return
  }

  console.log(`yt-dlp ${YTDLP_VERSION} ${platform}: downloading ${asset}`)
  const binary = await download(`${RELEASE_BASE}/${asset}`)
  const actual = sha256(binary)
  if (actual !== expected) {
    throw new Error(`checksum mismatch for ${asset}\n  expected ${expected}\n  actual   ${actual}`)
  }

  await mkdir(dir, { recursive: true })
  const tmp = `${target}.download`
  try {
    await writeFile(tmp, binary, { mode: 0o755 })
    await rename(tmp, target)
  } catch (err) {
    await rm(tmp, { force: true })
    throw err
  }
  console.log(`yt-dlp ${YTDLP_VERSION} ${platform}: wrote ${path.relative(repoRoot, target)}`)
}

async function main() {
  const requested = process.argv.slice(2)
  const platforms = requested.length > 0 ? requested : Object.keys(ASSETS)

  const unknown = platforms.filter((p) => !(p in ASSETS))
  if (unknown.length > 0) {
    throw new Error(
      `unknown platform(s): ${unknown.join(', ')} (expected ${Object.keys(ASSETS).join(', ')})`
    )
  }

  const checksums = parseChecksums((await download(CHECKSUMS_URL)).toString('utf8'))
  for (const platform of platforms) {
    await fetchForPlatform(platform, checksums)
  }
}

main().catch((err) => {
  console.error(`fetch-ytdlp failed: ${err.message}`)
  process.exitCode = 1
})
