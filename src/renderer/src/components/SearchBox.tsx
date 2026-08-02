import { useEffect, useState, type ReactElement } from 'react'
import { useAppDispatch, useAppState } from '../state/AppContext'

/** Long enough that a burst of keystrokes filters once, short enough to feel immediate. */
const SEARCH_DEBOUNCE_MS = 200

/**
 * The query lives in two places on purpose: the input is uncontrolled by the store so typing never
 * waits on a re-filter, and the store only learns about it once the user pauses.
 */
export function SearchBox(): ReactElement {
  const { query } = useAppState()
  const dispatch = useAppDispatch()
  const [value, setValue] = useState(query)

  useEffect(() => {
    if (value === query) return
    const timer = setTimeout(
      () => dispatch({ type: 'query/changed', query: value }),
      SEARCH_DEBOUNCE_MS
    )
    return () => clearTimeout(timer)
  }, [value, query, dispatch])

  return (
    <input
      className="search-box"
      type="search"
      aria-label="Search songs"
      placeholder="Search titles and tags"
      value={value}
      onChange={(event) => setValue(event.target.value)}
    />
  )
}
