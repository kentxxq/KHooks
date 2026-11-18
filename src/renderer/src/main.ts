import { createApp } from 'vue'
import { createPinia } from 'pinia'
import { createRouter, createWebHashHistory } from 'vue-router'
import ui from '@nuxt/ui/vue-plugin'
import appIcon from '../../../resources/icon.png'
import App from './App.vue'
import Workflows from './pages/Workflows.vue'
import Editor from './pages/Editor.vue'
import Runs from './pages/Runs.vue'
import RunDetail from './pages/RunDetail.vue'
import SettingsPage from './pages/Settings.vue'
import './style.css'

const favicon = document.createElement('link')
favicon.rel = 'icon'
favicon.href = appIcon
document.head.append(favicon)

const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: '/', name: 'workflows', component: Workflows },
    { path: '/workflows/:id', name: 'editor', component: Editor },
    { path: '/runs', name: 'runs', component: Runs },
    { path: '/runs/:id', name: 'run', component: RunDetail },
    { path: '/settings', name: 'settings', component: SettingsPage }
  ]
})

createApp(App).use(createPinia()).use(router).use(ui).mount('#app')
