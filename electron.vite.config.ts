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
 * The renderer uses esbuild's automatic JSX runtime rather than @vitejs/plugin-react: React Fast
 * Refresh is the only thing given up, and it keeps the dependency surface minimal.
 */
export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()]
  },
  preload: {
    plugins: [externalizeDepsPlugin()]
  },
  renderer: {
    esbuild: {
      jsx: 'automatic',
      jsxImportSource: 'react'
    },
    // Vite's dependency scanner cannot see the JSX runtime imports esbuild injects, so without
    // this the first `dev` load discovers them late and forces a full reload.
    optimizeDeps: {
      include: ['react', 'react-dom/client', 'react/jsx-runtime', 'react/jsx-dev-runtime']
    }
  }
})
