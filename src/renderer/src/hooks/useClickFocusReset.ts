import { useEffect } from 'react'

/**
 * A pointer click must not park focus on a control: a focused slider swallows Space/arrows/M and a
 * focused button turns Space into "press it again", so focus returns to the body. Left alone:
 * keyboard-activated clicks (detail 0), typing controls, and everything menu-shaped.
 */
export function useClickFocusReset(): void {
  useEffect(() => {
    function onClick(event: MouseEvent): void {
      if (event.detail === 0) return
      // `Element`, not `HTMLElement`: icon buttons put the click on an `<svg>`/`<path>`.
      const target = event.target instanceof Element ? event.target : null
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
