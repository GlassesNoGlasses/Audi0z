import { useEffect, useRef } from 'react'

/**
 * Escape dismisses whatever modal is up. Bound to `document` because focus is legitimately outside
 * the dialog much of the time, and read through a ref so the listener registers once per dialog
 * while still seeing the current props and state.
 */
export function useEscapeKey(onEscape: () => void): void {
  const latest = useRef(onEscape)

  useEffect(() => {
    latest.current = onEscape
  }, [onEscape])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      // `defaultPrevented` leaves a nested handler (a native `<select>` popup) room to keep it open.
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
