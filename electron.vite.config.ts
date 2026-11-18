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
      // 让编辑器和 @ 候选菜单共享 ProseMirror 的装饰对象类型。
      optimizeDeps: { include: ['@tiptap/pm/view', '@tiptap/suggestion'] },
      plugins: [vue(), ui({
        colorMode: false,
        icon: { clientBundle: { scan: true, icons: Object.values(nodeIcons) } },
        theme: { colors: ['primary', 'error', 'warning', 'success'] }
      })]
    }
  }
})
