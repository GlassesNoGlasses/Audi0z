import { useCallback } from 'react'
import { toastError } from '../lib/errors'
import { useAppDispatch } from '../state/AppContext'

/**
 * The memoised form of `toastError` for components: stable across renders, so it can sit in
 * effect and callback dep arrays without re-arming them.
 */
export function useToastError(): (error: unknown) => void {
  const dispatch = useAppDispatch()
  return useCallback((error: unknown) => toastError(dispatch, error), [dispatch])
}
