import { useEffect, useRef } from 'react'

/**
 * Escape dismisses whatever modal is up.
 *
 * Bound to `document` rather than to the dialog element: focus is legitimately outside the dialog
 * much of the time (the backdrop, `document.body` after a click on nothing), and a modal the
 * keyboard cannot dismiss is a dead end — which is exactly what a hung probe or download turned
 * the Add dialog into. `App` renders at most one dialog at a time, so there is no stack to
 * arbitrate between listeners.
 *
 * The handler is read through a ref so the listener is registered once per dialog rather than
 * re-registered on every keystroke, while still seeing the current props and state.
 */
export function useEscapeKey(onEscape: () => void): void {
  const latest = useRef(onEscape)

  useEffect(() => {
    latest.current = onEscape
  }, [onEscape])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      // `defaultPrevented` leaves room for anything nested that has already handled the key —
      // a native `<select>` popup closing, say — to keep the dialog open.
      if (event.key !== 'Escape' || event.defaultPrevented) return
      event.preventDefault()
      latest.current()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [])
}
