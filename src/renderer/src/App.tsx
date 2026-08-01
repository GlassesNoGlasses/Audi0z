import type { ReactElement } from 'react'

/**
 * Placeholder shell. The real library UI is built in a later work package — keep this a hello
 * shell so the foundation can boot and be smoke-tested.
 */
export function App(): ReactElement {
  return (
    <main className="app-shell">
      <h1>my-music-library</h1>
      <p>Foundation shell. The library UI arrives with the renderer work package.</p>
    </main>
  )
}
