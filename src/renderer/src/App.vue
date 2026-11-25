<script setup lang="ts">
import { onMounted, onUnmounted, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import productionIcon from '../../../resources/icon.png'
import developmentIcon from '../../../resources/icon-dev.png'
import { desktop, useDesktop } from './model'

const appIcon = import.meta.env.DEV ? developmentIcon : productionIcon
const route = useRoute()
const router = useRouter()
const store = useDesktop()
const navItems = [
  { to: '/', label: '流程', icon: 'i-lucide-workflow', match: ['workflows', 'editor'] },
  { to: '/runs', label: '运行记录', icon: 'i-lucide-history', match: ['runs', 'run'] },
  { to: '/settings', label: '设置', icon: 'i-lucide-settings-2', match: ['settings'] }
] as const

watch(
  () => store.data?.settings.theme,
  (theme) => {
    const dark = theme ? theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches
    document.documentElement.classList.toggle('dark', dark)
    document.documentElement.classList.toggle('light', !dark)
  },
  { immediate: true, flush: 'sync' }
)
let unsubscribe: (() => void) | undefined
let unlistenNavigate: (() => void) | undefined

onMounted(() => {
  unsubscribe = desktop.subscribe(store.refresh)
  unlistenNavigate = desktop.onNavigate((path) => {
    void router.push(path)
  })
  void store.refresh()
})
onUnmounted(() => {
  unsubscribe?.()
  unlistenNavigate?.()
})
</script>

<template>
  <UApp :toaster="{ duration: 3000, max: 3, position: 'top-right' }">
    <div class="shell">
      <header class="topbar">
        <RouterLink to="/" class="brand" aria-label="KHooks 首页">
          <img class="brand-mark" :src="appIcon" alt="" width="26" height="26" />
          <span>KHooks</span>
        </RouterLink>
        <nav aria-label="主导航" class="navigation">
          <RouterLink
            v-for="item in navItems"
            :key="item.to"
            :to="item.to"
            :class="{ active: (item.match as readonly string[]).includes(String(route.name ?? '')) }"
          >
            <UIcon :name="item.icon" /> {{ item.label }}
            <span
              v-if="item.to === '/settings' && store.data?.update.state === 'downloaded'"
              class="nav-dot"
              aria-label="有可安装的新版本"
            />
          </RouterLink>
        </nav>
        <div class="topbar-spacer" />
      </header>
      <div v-if="store.data" class="shell-content">
        <RouterView />
      </div>
    </div>
  </UApp>
</template>
