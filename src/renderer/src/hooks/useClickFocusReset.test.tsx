import { describe, expect, it } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import type { ReactElement } from 'react'
import { useClickFocusReset } from './useClickFocusReset'

function Harness(): ReactElement {
  useClickFocusReset()
  return (
    <div>
      <button type="button">Plain</button>
      <input type="range" aria-label="Seek" />
      <input type="search" aria-label="Find" />
      <button type="button" aria-haspopup="menu">
        Trigger
      </button>
      <div role="menu">
        <button type="button" role="menuitem">
          Item
        </button>
      </div>
    </div>
  )
}

describe('useClickFocusReset', () => {
  it('drops focus to the body after a mouse click on a button', () => {
    render(<Harness />)
    const button = screen.getByRole('button', { name: 'Plain' })
    button.focus()
    fireEvent.click(button, { detail: 1 })
    expect(button).not.toHaveFocus()
    expect(document.body).toHaveFocus()
  })

  it('drops focus after a mouse click on a range slider', () => {
    render(<Harness />)
    const slider = screen.getByRole('slider', { name: 'Seek' })
    slider.focus()
    fireEvent.click(slider, { detail: 1 })
    expect(slider).not.toHaveFocus()
  })

  it('leaves a keyboard-activated click alone', () => {
    // Enter/Space on a focused button fire a click with detail 0 — that focus is deliberate.
    render(<Harness />)
    const button = screen.getByRole('button', { name: 'Plain' })
    button.focus()
    fireEvent.click(button, { detail: 0 })
    expect(button).toHaveFocus()
  })

  it('leaves typing controls alone', () => {
    render(<Harness />)
    const search = screen.getByRole('searchbox', { name: 'Find' })
    search.focus()
    fireEvent.click(search, { detail: 1 })
    expect(search).toHaveFocus()
  })

  it('leaves menu triggers and menu items alone', () => {
    // Menu focus is programmatic and load-bearing: the popup walks items with arrow keys and
    // the global shortcuts treat "inside [role=menu]" as spoken for.
    render(<Harness />)
    const trigger = screen.getByRole('button', { name: 'Trigger' })
    trigger.focus()
    fireEvent.click(trigger, { detail: 1 })
    expect(trigger).toHaveFocus()

    const item = screen.getByRole('menuitem', { name: 'Item' })
    item.focus()
    fireEvent.click(item, { detail: 1 })
    expect(item).toHaveFocus()
  })
})
