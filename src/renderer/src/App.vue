<script setup lang="ts">
import { onMounted, onUnmounted, watch } from 'vue'
import { useRoute } from 'vue-router'
import productionIcon from '../../../resources/icon.png'
import developmentIcon from '../../../resources/icon-dev.png'
import { desktop, useDesktop } from './model'

const appIcon = import.meta.env.DEV ? developmentIcon : productionIcon
const route = useRoute()
const store = useDesktop()

watch(() => store.data?.settings.theme, (theme) => {
  const dark = theme ? theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches
  document.documentElement.classList.toggle('dark', dark)
  document.documentElement.classList.toggle('light', !dark)
}, { immediate: true, flush: 'sync' })
let unsubscribe: (() => void) | undefined

onMounted(() => {
  unsubscribe = desktop.subscribe(store.refresh)
  void store.refresh()
})
onUnmounted(() => unsubscribe?.())
</script>

<template>
  <UApp>
    <div class="shell">
      <header class="topbar">
        <RouterLink to="/" class="brand" aria-label="KHooks 首页">
          <img class="brand-mark" :src="appIcon" alt="" width="33" height="33">
          <span>KHooks</span>
        </RouterLink>
        <nav aria-label="主导航" class="navigation">
          <RouterLink to="/" :class="{ active: route.name === 'workflows' || route.name === 'editor' }">
            <UIcon name="i-lucide-workflow" /> 流程
          </RouterLink>
          <RouterLink to="/runs" :class="{ active: route.name === 'runs' || route.name === 'run' }">
            <UIcon name="i-lucide-history" /> 运行记录
          </RouterLink>
          <RouterLink to="/settings" :class="{ active: route.name === 'settings' }">
            <UIcon name="i-lucide-settings-2" /> 设置
          </RouterLink>
        </nav>
      </header>
      <div v-if="store.data" class="shell-content">
        <RouterView />
      </div>
    </div>
  </UApp>
</template>
