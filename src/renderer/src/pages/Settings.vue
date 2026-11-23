<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useToast } from '@nuxt/ui/composables/useToast'
import type { Theme } from '../../../shared/ipc'
import { parseHttpUrl } from '../../../shared/workflow'
import { desktop, errorMessage, useDesktop } from '../model'

const store = useDesktop()
const toast = useToast()
const initial = store.data?.settings
const login = ref(initial?.login ?? false)
const aiUrl = ref(initial?.aiUrl ?? '')
const aiModel = ref(initial?.aiModel ?? '')
const aiKey = ref('')
const saving = ref(false)
const testingAi = ref(false)
const aiUrlError = ref('')
const savingTheme = ref(false)
const theme = computed(() => store.data?.settings.theme ?? 'light')
const themeOptions = [
  { label: '浅色', value: 'light' },
  { label: '深色', value: 'dark' }
]
const hasAiKey = computed(() => store.data?.settings.hasAiKey)
const update = computed(() => store.data?.update)
const version = computed(() => store.data?.version)
const updateAction = ref<Parameters<typeof desktop.update>[0]>()
const offeredVersion = ref<string>()
const updateOpen = ref(false)
const applyingUpdate = computed(() => updateAction.value === 'apply' ||
  update.value?.state === 'downloading' || update.value?.state === 'installing')

watch([update, updateAction], ([result, action]) => {
  if (action || !updateOpen.value || result?.state !== 'error') return
  updateOpen.value = false
  toast.add({ title: result.error ?? '更新失败', color: 'error' })
})

function validateAiUrl(): boolean {
  aiUrlError.value = ''
  try {
    if (aiUrl.value.trim()) parseHttpUrl(aiUrl.value.trim())
    return true
  } catch {
    aiUrlError.value = '请输入有效的 HTTP(S) 地址，地址中不能包含凭据'
    return false
  }
}

async function save(clearKey = false): Promise<void> {
  if (saving.value || testingAi.value || !validateAiUrl()) return
  saving.value = true
  try {
    await desktop.settings({
      login: login.value, aiUrl: aiUrl.value, aiModel: aiModel.value, aiKey: clearKey ? '' : aiKey.value || undefined
    })
    await store.refresh()
    aiKey.value = ''
    login.value = store.data?.settings.login ?? false
    toast.add({ title: clearKey ? '已移除密钥' : '已保存', color: 'success' })
  } catch (cause) {
    toast.add({ title: errorMessage(cause), color: 'error' })
  } finally {
    saving.value = false
  }
}

async function testAi(): Promise<void> {
  if (saving.value || testingAi.value || !validateAiUrl()) return
  if (typeof desktop.testAi !== 'function') {
    toast.add({ title: '请重启应用后再测试连接', color: 'error' })
    return
  }
  testingAi.value = true
  try {
    await desktop.testAi({ aiUrl: aiUrl.value, aiModel: aiModel.value, aiKey: aiKey.value || undefined })
    toast.add({ title: 'AI 服务测试成功', color: 'success' })
  } catch (cause) {
    toast.add({ title: errorMessage(cause), color: 'error' })
  } finally {
    testingAi.value = false
  }
}

async function changeTheme(next: Theme): Promise<void> {
  if (next === theme.value) return
  savingTheme.value = true
  try {
    await desktop.setTheme(next)
    await store.refresh()
  } catch (cause) {
    toast.add({ title: errorMessage(cause), color: 'error' })
  } finally {
    savingTheme.value = false
  }
}

async function updater(action: NonNullable<typeof updateAction.value>): Promise<void> {
  if (updateAction.value) return
  updateAction.value = action
  try {
    const result = await desktop.update(action)
    if (result.state === 'error') toast.add({ title: result.error ?? '更新失败', color: 'error' })
    else if (result.state === 'unpublished') toast.add({ title: '暂无已发布版本', color: 'primary' })
    else if (result.state === 'current') toast.add({ title: '已是最新版本', color: 'success' })
    else if (action === 'check' && result.state === 'available') {
      offeredVersion.value = result.version
      updateOpen.value = true
    }
    if (action === 'apply' && result.state !== 'installing') updateOpen.value = false
  } catch (cause) {
    updateOpen.value = false
    toast.add({ title: errorMessage(cause), color: 'error' })
  } finally {
    updateAction.value = undefined
  }
}
</script>

<template>
  <main class="page settings-page">
    <div class="page-heading"><h1>设置</h1></div>
    <div class="surface settings-section">
      <div class="section-title"><UIcon name="i-lucide-settings-2" /> 常规</div>
      <div class="section-row">
        <label for="launch-on-login">登录 Windows 后自动启动</label>
        <USwitch id="launch-on-login" v-model="login" :disabled="update?.state === 'disabled'" />
      </div>
      <div class="section-row">
        <label for="appearance">主题</label>
        <USelect id="appearance" class="appearance-select" :model-value="theme" :items="themeOptions"
          :disabled="savingTheme" @update:model-value="changeTheme($event as Theme)" />
      </div>
    </div>
    <div class="surface settings-section">
      <div class="section-title"><UIcon name="i-lucide-sparkles" /> AI 服务</div>
      <div class="fields">
        <label for="ai-url">OpenAI 兼容服务地址</label>
        <UInput id="ai-url" v-model="aiUrl" class="full-width" :maxlength="1000" placeholder="例如 https://api.openai.com/v1"
          :disabled="testingAi" :aria-invalid="Boolean(aiUrlError)"
          :aria-describedby="aiUrlError ? 'ai-url-error' : undefined" @update:model-value="aiUrlError = ''" />
        <p v-if="aiUrlError" id="ai-url-error" class="field-error" role="alert">{{ aiUrlError }}</p>
        <label for="ai-model">模型</label>
        <UInput id="ai-model" v-model="aiModel" class="full-width" :maxlength="200" :disabled="testingAi" />
        <label for="ai-key">API 密钥 <span v-if="hasAiKey" class="success-text">· 已保存</span></label>
        <UInput id="ai-key" type="password" v-model="aiKey" class="full-width" :maxlength="4000" autocomplete="off" :disabled="testingAi" />
      </div>
      <div class="actions">
        <UButton :loading="saving" :disabled="testingAi" @click="save()">保存设置</UButton>
        <UButton color="neutral" variant="outline" :loading="testingAi" :disabled="saving" @click="testAi">测试连接</UButton>
        <UButton v-if="hasAiKey" color="neutral" variant="ghost" :disabled="saving || testingAi" @click="save(true)">移除密钥</UButton>
      </div>
    </div>
    <div class="surface settings-section">
      <div class="section-title"><UIcon name="i-lucide-download" /> 应用更新</div>
      <div class="section-row">
        <div>
          <strong>v{{ version }}</strong>
          <p v-if="update?.state === 'disabled'" class="muted">开发版</p>
        </div>
        <UButton color="neutral" variant="outline" icon="i-lucide-refresh-cw"
          :loading="updateAction === 'check' || update?.state === 'checking'" :disabled="!update || update.state === 'disabled' || applyingUpdate"
          @click="updater('check')">检查更新</UButton>
      </div>
    </div>
    <UModal v-model:open="updateOpen" :title="'发现新版本 v' + offeredVersion"
      :description="applyingUpdate ? undefined : '更新完成后，KHooks 将自动重启。'"
      :close="!applyingUpdate" :dismissible="!applyingUpdate">
      <template #body v-if="applyingUpdate">
        <p role="status">{{ update?.state === 'installing' ? '正在安装并重启' : '正在下载 · ' + Math.round(update?.percent ?? 0) + '%' }}</p>
      </template>
      <template #footer>
        <UButton color="neutral" variant="outline" :disabled="applyingUpdate" @click="updateOpen = false">稍后</UButton>
        <UButton :loading="applyingUpdate" @click="updater('apply')">立即更新</UButton>
      </template>
    </UModal>
  </main>
</template>
