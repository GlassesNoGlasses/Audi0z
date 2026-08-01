import react from '@vitejs/plugin-react'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'

/**
 * Build layout (electron-vite defaults, kept deliberately):
 *   src/main/index.ts      -> out/main/index.js      (cjs, `__dirname` available)
 *   src/preload/index.ts   -> out/preload/index.js   (cjs)
 *   src/renderer/index.html-> out/renderer/          (chrome target of the installed Electron)
 *
 * `externalizeDepsPlugin` keeps `dependencies` (ffmpeg-static, @electron-toolkit/utils) out of the
 * main/preload bundles so their real files stay on disk — ffmpeg-static resolves a binary path
 * relative to its own package directory, which only works when it is not bundled.
 *
 * `@vitejs/plugin-react` owns the renderer's JSX transform and gives it React Fast Refresh, so a
 * component edit hot-swaps instead of reloading the window. It also pre-bundles the JSX runtime,
 * which is why there is no explicit `esbuild.jsx` or `optimizeDeps` block here.
 *
 * Pinned to plugin-react 5.x on purpose: 6.x requires vite 8, and this project pins vite 7.
 */
export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()]
  },
  preload: {
    plugins: [externalizeDepsPlugin()]
  },
  renderer: {
    plugins: [react()]
  }
})
