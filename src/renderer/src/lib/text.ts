/** Small string helpers shared by the dialogs. */

/** `/music/Great Track.mp3` -> `Great Track`. Works for both path separators. */
export function titleFromPath(filePath: string): string {
  const base = filePath.split(/[\\/]/).pop() ?? filePath
  return base.replace(/\.[A-Za-z0-9]+$/, '')
}

/** `" slowed , , reverb "` -> `['slowed', 'reverb']`. */
export function parseTags(input: string): string[] {
  return input
    .split(',')
    .map((tag) => tag.trim())
    .filter((tag) => tag !== '')
}
