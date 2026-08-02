import {
  createContext,
  useContext,
  useReducer,
  type Dispatch,
  type ReactElement,
  type ReactNode
} from 'react'
import { createAppReducer, initialAppState, type AppAction, type AppState } from './appReducer'

/**
 * One store for the whole renderer: `useReducer` plus two contexts, so a component that only
 * dispatches never re-renders when unrelated state moves.
 *
 * The reducer is built once at module scope — rebuilding it per mount would reset the engine's
 * injected rng for no reason.
 */
const reducer = createAppReducer()

const StateContext = createContext<AppState | null>(null)
const DispatchContext = createContext<Dispatch<AppAction> | null>(null)

export function AppProvider({ children }: { children: ReactNode }): ReactElement {
  const [state, dispatch] = useReducer(reducer, undefined, initialAppState)
  return (
    <StateContext.Provider value={state}>
      <DispatchContext.Provider value={dispatch}>{children}</DispatchContext.Provider>
    </StateContext.Provider>
  )
}

export function useAppState(): AppState {
  const state = useContext(StateContext)
  if (state === null) throw new Error('useAppState must be used inside <AppProvider>')
  return state
}

export function useAppDispatch(): Dispatch<AppAction> {
  const dispatch = useContext(DispatchContext)
  if (dispatch === null) throw new Error('useAppDispatch must be used inside <AppProvider>')
  return dispatch
}
