import react from '@vitejs/plugin-react'
import { defineConfig } from 'electron-vite'

/**
 * Build layout:
 *   src/main/index.ts      -> out/main/index.js      (cjs, `__dirname` available)
 *   src/preload/index.ts   -> out/preload/index.js   (cjs)
 *   src/renderer/index.html-> out/renderer/          (chrome target of the installed Electron)
 *
 * `externalizeDeps` keeps `dependencies` (ffmpeg-static, @electron-toolkit/utils) out of the
 * main/preload bundles so their real files stay on disk — ffmpeg-static resolves a binary path
 * relative to its own package directory, which only works when it is not bundled.
 *
 */
export default defineConfig({
  main: {
    build: { externalizeDeps: true }
  },
  preload: {
    build: { externalizeDeps: true }
  },
  renderer: {
    plugins: [react()]
  }
})
