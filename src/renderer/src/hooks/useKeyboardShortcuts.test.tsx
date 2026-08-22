import { renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest'
import { useKeyboardShortcuts, type KeyboardShortcutsOptions } from './useKeyboardShortcuts'

/** Driven straight at `document`; what the shortcuts actually do is covered in `App.test.tsx`. */

interface Harness {
  onTogglePlay: Mock
  onToggleMute: Mock
  onSeekBy: Mock
  rerender(options: Partial<KeyboardShortcutsOptions>): void
  unmount(): void
}

function setup(overrides: Partial<KeyboardShortcutsOptions> = {}): Harness {
  const onTogglePlay = vi.fn()
  const onToggleMute = vi.fn()
  const onSeekBy = vi.fn()
  const props = (extra: Partial<KeyboardShortcutsOptions>): KeyboardShortcutsOptions => ({
    enabled: true,
    hasCurrentSong: true,
    onTogglePlay,
    onToggleMute,
    onSeekBy,
    ...overrides,
    ...extra
  })

  const view = renderHook((options: KeyboardShortcutsOptions) => useKeyboardShortcuts(options), {
    initialProps: props({})
  })

  return {
    onTogglePlay,
    onToggleMute,
    onSeekBy,
    rerender: (extra) => view.rerender(props(extra)),
    unmount: view.unmount
  }
}

/** Dispatches a real `keydown` and hands back the event, so `defaultPrevented` can be read. */
function press(key: string, target: EventTarget = document.body, repeat = false): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key, repeat, bubbles: true, cancelable: true })
  target.dispatchEvent(event)
  return event
}

/** A `keydown` carrying a modifier — how a system or app shortcut (⌘M, Ctrl+M) arrives. */
function pressWith(key: string, modifier: 'metaKey' | 'ctrlKey' | 'altKey'): KeyboardEvent {
  const event = new KeyboardEvent('keydown', {
    key,
    [modifier]: true,
    bubbles: true,
    cancelable: true
  })
  document.body.dispatchEvent(event)
  return event
}

/** An element of `tag`, attached to the document so the event reaches `document`. */
function attach(tag: string): HTMLElement {
  const element = document.createElement(tag)
  document.body.append(element)
  return element
}

/** The same, marked the way a song row marks its title button to hand space to the transport. */
function optedIn(tag: string): HTMLElement {
  const element = attach(tag)
  element.setAttribute('data-space-transport', '')
  return element
}

/** An item of an open row menu, where the arrows walk the menu rather than the song. */
function menuItem(): HTMLElement {
  const menu = attach('div')
  menu.setAttribute('role', 'menu')
  const item = document.createElement('button')
  menu.append(item)
  return item
}

afterEach(() => {
  document.body.replaceChildren()
})

describe('useKeyboardShortcuts — space', () => {
  it('toggles playback and swallows the key, so the page does not scroll', () => {
    const { onTogglePlay } = setup()

    const event = press(' ')

    expect(onTogglePlay).toHaveBeenCalledTimes(1)
    expect(event.defaultPrevented).toBe(true)
  })

  it('does nothing with no song cued — space is not a cold start', () => {
    const { onTogglePlay } = setup({ hasCurrentSong: false })

    const event = press(' ')

    expect(onTogglePlay).not.toHaveBeenCalled()
    expect(event.defaultPrevented).toBe(false)
  })

  it('does nothing while disabled, and works again once re-enabled', () => {
    const { onTogglePlay, rerender } = setup({ enabled: false })

    press(' ')
    expect(onTogglePlay).not.toHaveBeenCalled()

    rerender({ enabled: true })
    press(' ')
    expect(onTogglePlay).toHaveBeenCalledTimes(1)
  })

  it.each(['input', 'textarea', 'select'])('leaves a key pressed inside a %s alone', (tag) => {
    const { onTogglePlay } = setup()

    press(' ', attach(tag))

    expect(onTogglePlay).not.toHaveBeenCalled()
  })

  it('leaves a key pressed inside an editable region alone', () => {
    const { onTogglePlay, onToggleMute } = setup()
    const editable = attach('div')
    // jsdom parses `contenteditable` but never derives `isContentEditable` from it.
    Object.defineProperty(editable, 'isContentEditable', { value: true })

    press(' ', editable)
    press('m', editable)

    expect(onTogglePlay).not.toHaveBeenCalled()
    expect(onToggleMute).not.toHaveBeenCalled()
  })

  it.each(['button', 'a'])('lets a %s keep its own space activation', (tag) => {
    const { onTogglePlay } = setup()

    press(' ', attach(tag))

    expect(onTogglePlay).not.toHaveBeenCalled()
  })

  it('claims space from a control marked data-space-transport and toggles the transport', () => {
    const { onTogglePlay } = setup()

    const event = press(' ', optedIn('button'))

    expect(onTogglePlay).toHaveBeenCalledTimes(1)
    // Preventing the keydown cancels the button's keyup click, which used to replay the song.
    expect(event.defaultPrevented).toBe(true)
  })

  it('hands an opted-in control its space back when no song is cued', () => {
    const { onTogglePlay } = setup({ hasCurrentSong: false })

    const event = press(' ', optedIn('button'))

    expect(onTogglePlay).not.toHaveBeenCalled()
    expect(event.defaultPrevented).toBe(false)
  })

  it('ignores a key held down', () => {
    const { onTogglePlay } = setup()

    press(' ', document.body, true)

    expect(onTogglePlay).not.toHaveBeenCalled()
  })
})

describe('useKeyboardShortcuts — arrows', () => {
  it.each([
    ['ArrowRight', 10],
    ['ArrowLeft', -10]
  ])('skips ten seconds on %s', (key, delta) => {
    const { onSeekBy } = setup()

    const event = press(key)

    expect(onSeekBy).toHaveBeenCalledWith(delta)
    expect(event.defaultPrevented).toBe(true)
  })

  it('does nothing with no song cued', () => {
    const { onSeekBy } = setup({ hasCurrentSong: false })

    const event = press('ArrowRight')

    expect(onSeekBy).not.toHaveBeenCalled()
    expect(event.defaultPrevented).toBe(false)
  })

  /** The menu's own arrow handler is a React one, so it runs first and marks the event. */
  it('leaves the arrows to an open menu', () => {
    const { onSeekBy } = setup()

    press('ArrowRight', menuItem())

    expect(onSeekBy).not.toHaveBeenCalled()
  })

  it('leaves an arrow somebody else already answered alone', () => {
    const { onSeekBy } = setup()

    const event = new KeyboardEvent('keydown', {
      key: 'ArrowRight',
      bubbles: true,
      cancelable: true
    })
    event.preventDefault()
    document.body.dispatchEvent(event)

    expect(onSeekBy).not.toHaveBeenCalled()
  })

  /** A range slider steps itself with the arrows; the seek and volume sliders both depend on it. */
  it.each(['input', 'textarea', 'select'])('leaves an arrow pressed inside a %s alone', (tag) => {
    const { onSeekBy } = setup()

    press('ArrowRight', attach(tag))

    expect(onSeekBy).not.toHaveBeenCalled()
  })

  it('does nothing while disabled', () => {
    const { onSeekBy } = setup({ enabled: false })

    press('ArrowLeft')

    expect(onSeekBy).not.toHaveBeenCalled()
  })

  it('ignores a key held down', () => {
    const { onSeekBy } = setup()

    press('ArrowRight', document.body, true)

    expect(onSeekBy).not.toHaveBeenCalled()
  })

  it.each(['metaKey', 'ctrlKey', 'altKey'] as const)('leaves %s combinations alone', (modifier) => {
    const { onSeekBy } = setup()

    const event = pressWith('ArrowLeft', modifier)

    expect(onSeekBy).not.toHaveBeenCalled()
    expect(event.defaultPrevented).toBe(false)
  })
})

describe('useKeyboardShortcuts — m', () => {
  it.each(['m', 'M'])('toggles mute on %s', (key) => {
    const { onToggleMute } = setup()

    press(key)

    expect(onToggleMute).toHaveBeenCalledTimes(1)
  })

  it('still reaches a button, which has no use for the key', () => {
    const { onToggleMute } = setup()

    press('m', attach('button'))

    expect(onToggleMute).toHaveBeenCalledTimes(1)
  })

  it('does nothing while disabled', () => {
    const { onToggleMute } = setup({ enabled: false })

    press('m')

    expect(onToggleMute).not.toHaveBeenCalled()
  })

  it('does nothing while typing', () => {
    const { onToggleMute } = setup()

    press('m', attach('input'))

    expect(onToggleMute).not.toHaveBeenCalled()
  })

  it('ignores a key held down', () => {
    const { onToggleMute } = setup()

    press('m', document.body, true)

    expect(onToggleMute).not.toHaveBeenCalled()
  })
})

/** ⌘M is Minimize on macOS: answering it here would silently mute the player, and persist it. */
describe('useKeyboardShortcuts — modifiers', () => {
  it.each(['metaKey', 'ctrlKey', 'altKey'] as const)('leaves %s combinations alone', (modifier) => {
    const { onTogglePlay, onToggleMute } = setup()

    const space = pressWith(' ', modifier)
    pressWith('m', modifier)

    expect(onTogglePlay).not.toHaveBeenCalled()
    expect(onToggleMute).not.toHaveBeenCalled()
    expect(space.defaultPrevented).toBe(false)
  })

  /** Shift is not a combination here — it is how the keyboard produces `M` at all. */
  it('still mutes on Shift+M', () => {
    const { onToggleMute } = setup()

    const event = new KeyboardEvent('keydown', { key: 'M', shiftKey: true, bubbles: true })
    document.body.dispatchEvent(event)

    expect(onToggleMute).toHaveBeenCalledTimes(1)
  })
})

describe('useKeyboardShortcuts — lifecycle', () => {
  it('sees the latest callbacks without re-registering the listener', () => {
    const addListener = vi.spyOn(document, 'addEventListener')
    const { rerender } = setup()
    const registrations = addListener.mock.calls.filter(([type]) => type === 'keydown').length

    const later = vi.fn()
    rerender({ onTogglePlay: later })
    press(' ')

    expect(later).toHaveBeenCalledTimes(1)
    expect(addListener.mock.calls.filter(([type]) => type === 'keydown')).toHaveLength(
      registrations
    )
    addListener.mockRestore()
  })

  it('stops listening once unmounted', () => {
    const { onTogglePlay, onToggleMute, unmount } = setup()

    unmount()
    press(' ')
    press('m')

    expect(onTogglePlay).not.toHaveBeenCalled()
    expect(onToggleMute).not.toHaveBeenCalled()
  })
})
