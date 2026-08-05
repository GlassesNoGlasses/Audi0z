import { useEffect } from 'react'

/**
 * A mouse click should not leave focus parked on a control: a focused range slider swallows
 * Space/arrows/M outright (`isTyping`), a focused button turns Space into "press it again", and
 * Chromium draws its focus ring on whatever was last clicked the moment any key goes down. So
 * after a pointer-driven click on a button or slider, focus returns to the body and the global
 * shortcuts own the keyboard again.
 *
 * Deliberately untouched: keyboard-activated clicks (detail 0 — Tab-and-Enter users keep their
 * place), typing controls (text/search inputs), and everything menu-shaped, whose programmatic
 * focus the popup keyboard navigation depends on.
 */
export function useClickFocusReset(): void {
  useEffect(() => {
    function onClick(event: MouseEvent): void {
      if (event.detail === 0) return
      const target = event.target instanceof HTMLElement ? event.target : null
      const control = target?.closest<HTMLElement>('button, input[type="range"]')
      if (!control) return
      if (control.closest('[role="menu"]') !== null) return
      if (control.getAttribute('aria-haspopup') === 'menu') return
      if (control === document.activeElement) control.blur()
    }
    document.addEventListener('click', onClick)
    return () => document.removeEventListener('click', onClick)
  }, [])
}
