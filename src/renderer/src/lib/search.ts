/**
 * Library search: a pure, case-insensitive substring filter over titles and tags.
 *
 * Multi-word queries are an AND — every term must appear somewhere, in the title or in one of the
 * tags — which is what makes `slowed reverb` narrow instead of widen the list.
 */
export function filterSongs<T extends { title: string; tags: string[] }>(
  songs: readonly T[],
  query: string
): T[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (terms.length === 0) return [...songs]

  return songs.filter((song) => {
    const haystack = [song.title, ...song.tags].map((text) => text.toLowerCase())
    return terms.every((term) => haystack.some((text) => text.includes(term)))
  })
}
