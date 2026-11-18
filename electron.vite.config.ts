import { defineConfig } from 'electron-vite'
import vue from '@vitejs/plugin-vue'
import ui from '@nuxt/ui/vite'
import { nodeIcons } from './src/renderer/src/node-icons'

export default defineConfig(async ({ command }) => {
  if (command === 'serve' && process.platform === 'win32' && !process.env.ELECTRON_EXEC_PATH) {
    const { prepareWindowsDevExecutable } = await import('./scripts/windows-dev')
    process.env.ELECTRON_EXEC_PATH = await prepareWindowsDevExecutable(import.meta.dirname)
  }
  return {
    main: {},
    preload: { build: { externalizeDeps: false } },
    renderer: {
      plugins: [vue(), ui({
        colorMode: false,
        icon: { clientBundle: { scan: true, icons: Object.values(nodeIcons) } },
        theme: { colors: ['primary', 'error', 'warning', 'success'] }
      })]
    }
  }
})
