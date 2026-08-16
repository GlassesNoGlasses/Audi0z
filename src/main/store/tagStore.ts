import { randomUUID } from 'node:crypto'
import type { Tag, TagsFile } from '../../shared/types'
import { tagsJsonPath } from '../paths'
import { ConflictError, NotFoundError } from './errors'
import { loadOnce, readJsonFile, writeJsonFile } from './jsonFile'
import type { CreateTagStore } from './storeTypes'

/**
 * `tags.json` behind the `TagStore` interface.
 *
 * The registry is an *index* over the tag strings songs already carry: it owns a tag's identity,
 * display name and colour, and nothing else. Keeping `library.json` in step when a tag is renamed
 * or deleted is the IPC layer's job, which keeps this store from knowing songs exist at all — and
 * it runs that pass *before* it calls in here, because two files cannot be replaced in one commit
 * and this is the file the app treats as the truth about which tags exist. A write here is
 * therefore the last step of a rename or a delete rather than the first, which is what makes an
 * interrupted one look to the user like it simply did not happen. `resolveRename` is how the caller
 * still refuses a clashing name before a single song moves.
 *
 * Structurally identical to `playlistStore`: `loadOnce` over an atomically written file, validators
 * that let a corrupt document degrade to "no tags" rather than to a broken app, and clones on the
 * way out so the cached array stays the single source of truth.
 */

/** Saturation and lightness are fixed so every generated colour sits in the same readable band. */
const TAG_SATURATION = 0.65
const TAG_LIGHTNESS = 0.55

function isTag(value: unknown): value is Tag {
  if (typeof value !== 'object' || value === null) return false
  const tag = value as Partial<Tag>
  return typeof tag.id === 'string' && typeof tag.name === 'string' && typeof tag.color === 'string'
}

function isTagsFile(value: unknown): value is TagsFile {
  if (typeof value !== 'object' || value === null) return false
  const file = value as Partial<TagsFile>
  return file.version === 1 && Array.isArray(file.tags) && file.tags.every(isTag)
}

const emptyTags = (): TagsFile => ({ version: 1, tags: [] })

function cloneTag(tag: Tag): Tag {
  return { ...tag }
}

/**
 * HSL -> `#rrggbb`, per CSS Color 4. Local because this is the only colour arithmetic in the app
 * and a dependency for six lines of maths would not pay for itself.
 */
function hslToHex(hue: number, saturation: number, lightness: number): string {
  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation
  const second = chroma * (1 - Math.abs(((hue / 60) % 2) - 1))
  const min = lightness - chroma / 2

  const [r, g, b] =
    hue < 60
      ? [chroma, second, 0]
      : hue < 120
        ? [second, chroma, 0]
        : hue < 180
          ? [0, chroma, second]
          : hue < 240
            ? [0, second, chroma]
            : hue < 300
              ? [second, 0, chroma]
              : [chroma, 0, second]

  const channel = (value: number): string =>
    Math.round((value + min) * 255)
      .toString(16)
      .padStart(2, '0')
  return `#${channel(r)}${channel(g)}${channel(b)}`
}

export const createTagStore: CreateTagStore = (dir, rng = Math.random) => {
  const filePath = tagsJsonPath(dir)
  // Loaded once and kept for the life of the process — see `libraryStore` for why that forces ONE
  // instance per library directory.
  const load = loadOnce(async () => {
    const file = await readJsonFile(filePath, isTagsFile, emptyTags)
    return file.tags
  })

  async function persist(current: Tag[]): Promise<void> {
    const file: TagsFile = { version: 1, tags: current }
    await writeJsonFile(filePath, file)
  }

  /**
   * Trims, refuses empty, and refuses a name another tag already holds — case-insensitively,
   * because "Slowed" and "slowed" being two different tags is never what anyone meant.
   *
   * `exceptId` is the tag doing the renaming, so it can change its own name's case.
   */
  function validateName(current: Tag[], raw: string, exceptId?: string): string {
    const name = raw.trim()
    if (name === '') throw new Error('A tag name must not be empty')
    const clash = current.find(
      (tag) => tag.id !== exceptId && tag.name.toLowerCase() === name.toLowerCase()
    )
    if (clash) throw new ConflictError(`A tag named "${clash.name}" already exists`)
    return name
  }

  return {
    async list() {
      return (await load()).map(cloneTag)
    },

    async getTag(id) {
      const found = (await load()).find((tag) => tag.id === id)
      return found ? cloneTag(found) : undefined
    },

    async create(name) {
      const current = await load()
      const tag: Tag = {
        id: randomUUID(),
        name: validateName(current, name),
        color: hslToHex(Math.floor(rng() * 360), TAG_SATURATION, TAG_LIGHTNESS)
      }
      current.push(tag)
      await persist(current)
      return cloneTag(tag)
    },

    /**
     * What `rename` would store, without storing it — so the caller can cascade onto the songs
     * first and still refuse a clash before anything moves.
     */
    async resolveRename(id, name) {
      const current = await load()
      if (!current.some((tag) => tag.id === id)) {
        throw new NotFoundError(`No tag with id "${id}"`)
      }
      return validateName(current, name, id)
    },

    /** Re-validates rather than trusting `resolveRename`: any other caller gets the same rules. */
    async rename(id, name) {
      const current = await load()
      const index = current.findIndex((tag) => tag.id === id)
      if (index === -1) throw new NotFoundError(`No tag with id "${id}"`)

      const renamed: Tag = { ...current[index], name: validateName(current, name, id) }
      current[index] = renamed
      await persist(current)
      return cloneTag(renamed)
    },

    /** Removing an id that is already gone is a no-op, not an error. */
    async remove(id) {
      const current = await load()
      const index = current.findIndex((tag) => tag.id === id)
      if (index === -1) return
      current.splice(index, 1)
      await persist(current)
    }
  }
}
