import { describe, expect, it, vi } from 'vitest'
import { createMockApi } from '../../tests/support/mockApi'

const exposeInMainWorld = vi.fn()

vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: (...args: unknown[]) => exposeInMainWorld(...args) },
  ipcRenderer: {
    invoke: vi.fn(async () => undefined),
    on: vi.fn(),
    removeListener: vi.fn()
  },
  webUtils: { getPathForFile: vi.fn(() => '/tmp/dropped.mp3') }
}))

const { api: preloadApi } = await import('../preload/index')

/** `{ namespace: [sorted member names] }` — the structural fingerprint of an Api implementation. */
function shapeOf(api: object): Record<string, string[]> {
  return Object.fromEntries(
    Object.entries(api).map(([namespace, members]) => [
      namespace,
      Object.keys(members as object).sort()
    ])
  )
}

function membersOf(api: object): [string, unknown][] {
  return Object.entries(api).flatMap(([namespace, members]) =>
    Object.entries(members as object).map(
      ([name, value]) => [`${namespace}.${name}`, value] as [string, unknown]
    )
  )
}

describe('Api contract', () => {
  it('exposes the preload api on the contextBridge as `api`', () => {
    expect(exposeInMainWorld).toHaveBeenCalledWith('api', preloadApi)
  })

  it('gives the mock and the preload identical namespaces and method names', () => {
    expect(shapeOf(preloadApi)).toEqual(shapeOf(createMockApi()))
  })

  it('has a non-empty namespace for every member of the contract', () => {
    const shape = shapeOf(preloadApi)
    expect(Object.keys(shape).sort()).toEqual([
      'download',
      'events',
      'files',
      'library',
      'playlists',
      'settings',
      'tags'
    ])
    for (const [namespace, members] of Object.entries(shape)) {
      expect(members.length, `${namespace} has no members`).toBeGreaterThan(0)
    }
  })

  /**
   * Named one by one on purpose. The structural-equality test above only says the two sides agree,
   * so dropping a method from BOTH still passes it — these are the members whose disappearance has
   * to fail a test that says their name.
   */
  it('carries the tag registry and the three newest library operations', () => {
    const shape = shapeOf(preloadApi)

    expect(shape.tags).toEqual(['create', 'list', 'remove', 'rename'])
    expect(shape.library).toContain('compress')
    expect(shape.library).toContain('showFolder')
    expect(shape.library).toContain('updateDurations')
  })

  it('implements every member as a function on both sides', () => {
    for (const [path, value] of membersOf(preloadApi)) {
      expect(typeof value, `preload ${path}`).toBe('function')
    }
    for (const [path, value] of membersOf(createMockApi())) {
      expect(typeof value, `mock ${path}`).toBe('function')
    }
  })
})
