<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue'
import { useToast } from '@nuxt/ui/composables/useToast'
import type { ExternalLink, Theme } from '../../../shared/ipc'
import { releaseLinks } from '../../../shared/app-identity'
import { parseHttpUrl } from '../../../shared/workflow'
import { desktop, errorMessage, useDesktop } from '../model'

const store = useDesktop()
const toast = useToast()
const releasesUrl: string = releaseLinks.releases
const changelogUrl: string = releaseLinks.changelog
const initial = store.data?.settings
const login = ref(initial?.login ?? false)
const aiUrl = ref(initial?.aiUrl ?? '')
const aiModel = ref(initial?.aiModel ?? '')
const aiKey = ref('')
const showAiKey = ref(false)
const saving = ref(false)
const testingAi = ref(false)
const aiUrlError = ref('')
const savingTheme = ref(false)
const savingAutoCheck = ref(false)
const theme = computed(() => store.data?.settings.theme ?? 'light')
const autoCheckUpdate = computed(() => store.data?.settings.autoCheckUpdate ?? true)
const themeOptions: { label: string; value: Theme; icon: string }[] = [
  { label: '浅色', value: 'light', icon: 'i-lucide-sun' },
  { label: '深色', value: 'dark', icon: 'i-lucide-moon' }
]
const hasAiKey = computed(() => store.data?.settings.hasAiKey)
const update = computed(() => store.data?.update)
const version = computed(() => store.data?.version)
const updateAction = ref<Parameters<typeof desktop.update>[0]>()
const offeredVersion = ref<string>()
const updateOpen = ref(false)
const elapsedSeconds = ref(0)
let elapsedTimer: ReturnType<typeof setInterval> | undefined
const applyingUpdate = computed(
  () =>
    updateAction.value === 'apply' ||
    (updateOpen.value && update.value?.state === 'downloading') ||
    update.value?.state === 'installing'
)

const hasUnsavedChanges = computed(() => {
  const saved = store.data?.settings
  if (!saved) return false
  return (
    login.value !== saved.login ||
    aiUrl.value !== saved.aiUrl ||
    aiModel.value !== saved.aiModel ||
    aiKey.value.length > 0
  )
})

const aiConfigured = computed(() =>
  Boolean(aiUrl.value.trim() && aiModel.value.trim() && (hasAiKey.value || aiKey.value.trim()))
)
const updatePercent = computed(() => Math.min(100, Math.max(0, Math.round(update.value?.percent ?? 0))))

const updateStatusLabel = computed(() => {
  const state = update.value?.state
  if (state === 'disabled') return '开发版'
  if (state === 'downloaded') return `新版本 v${update.value?.version} 已就绪`
  if (state === 'downloading') return `正在下载 v${update.value?.version} · ${updatePercent.value}%`
  if (state === 'installing') return '正在启动安装程序'
  if (state === 'checking') return '正在检查更新'
  return '当前版本'
})

function resetDraft(): void {
  const saved = store.data?.settings
  if (!saved) return
  login.value = saved.login
  aiUrl.value = saved.aiUrl
  aiModel.value = saved.aiModel
  aiKey.value = ''
  showAiKey.value = false
  aiUrlError.value = ''
}

function stopElapsedTimer(): void {
  if (!elapsedTimer) return
  clearInterval(elapsedTimer)
  elapsedTimer = undefined
}

watch(applyingUpdate, (active) => {
  stopElapsedTimer()
  if (!active) return
  elapsedSeconds.value = 0
  elapsedTimer = setInterval(() => {
    elapsedSeconds.value += 1
  }, 1000)
})

onUnmounted(stopElapsedTimer)

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
      login: login.value,
      aiUrl: aiUrl.value,
      aiModel: aiModel.value,
      aiKey: clearKey ? '' : aiKey.value || undefined
    })
    await store.refresh()
    aiKey.value = ''
    showAiKey.value = false
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

async function changeAutoCheckUpdate(next: boolean): Promise<void> {
  if (next === autoCheckUpdate.value || savingAutoCheck.value) return
  savingAutoCheck.value = true
  try {
    await desktop.setAutoCheckUpdate(next)
    await store.refresh()
  } catch (cause) {
    toast.add({ title: errorMessage(cause), color: 'error' })
  } finally {
    savingAutoCheck.value = false
  }
}

async function openLink(target: ExternalLink): Promise<void> {
  try {
    await desktop.openExternal(target)
  } catch (cause) {
    toast.add({ title: errorMessage(cause), color: 'error' })
  }
}

async function updater(action: NonNullable<typeof updateAction.value>): Promise<void> {
  if (updateAction.value) return
  if (action === 'apply') {
    offeredVersion.value = update.value?.version ?? offeredVersion.value
    updateOpen.value = true
  }
  updateAction.value = action
  try {
    const result = await desktop.update(action)
    if (result.state === 'error') toast.add({ title: result.error ?? '更新失败', color: 'error' })
    else if (result.state === 'unpublished') toast.add({ title: '暂无已发布版本', color: 'primary' })
    else if (result.state === 'current') toast.add({ title: '已是最新版本', color: 'success' })
    else if (
      action === 'check' &&
      (result.state === 'available' || result.state === 'downloading' || result.state === 'downloaded')
    ) {
      offeredVersion.value = result.version
      updateOpen.value = true
    }
    if (action === 'apply' && result.state !== 'installing' && result.state !== 'downloading') updateOpen.value = false
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
    <div class="page-heading">
      <h1>设置</h1>
      <div class="overview-pills">
        <span class="status">v{{ version }}</span>
        <span class="status" :class="{ online: aiConfigured }">AI {{ aiConfigured ? '已配置' : '未配置' }}</span>
      </div>
    </div>

    <div class="settings-group">
      <div class="settings-group-label"><UIcon name="i-lucide-settings-2" /> 常规</div>
      <div class="surface settings-card">
        <div class="settings-row">
          <label for="launch-on-login" class="settings-key">登录 Windows 后自动启动</label>
          <div class="settings-control settings-control-end">
            <USwitch id="launch-on-login" v-model="login" :disabled="update?.state === 'disabled'" />
          </div>
        </div>
        <div class="settings-row">
          <span id="theme-label" class="settings-key">主题</span>
          <div class="settings-control settings-control-end">
            <div class="segmented" role="radiogroup" aria-labelledby="theme-label">
              <button
                v-for="opt in themeOptions"
                :key="opt.value"
                type="button"
                role="radio"
                :aria-checked="theme === opt.value"
                class="segmented-btn"
                :class="{ active: theme === opt.value }"
                :disabled="savingTheme"
                @click="changeTheme(opt.value)"
              >
                <UIcon :name="opt.icon" /> {{ opt.label }}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>

    <div class="settings-group">
      <div class="settings-group-head">
        <div class="settings-group-label"><UIcon name="i-lucide-sparkles" /> AI 服务</div>
        <div class="actions">
          <UButton
            color="neutral"
            variant="outline"
            size="xs"
            icon="i-lucide-plug-zap"
            :loading="testingAi"
            :disabled="saving"
            @click="testAi"
            >测试连接</UButton
          >
          <UButton
            v-if="hasAiKey"
            color="neutral"
            variant="ghost"
            size="xs"
            :disabled="saving || testingAi"
            @click="save(true)"
            >移除密钥</UButton
          >
        </div>
      </div>
      <div class="surface settings-card">
        <div class="settings-row settings-row-field">
          <label for="ai-url" class="settings-key">OpenAI 兼容服务地址</label>
          <div class="settings-control">
            <UInput
              id="ai-url"
              v-model="aiUrl"
              class="full-width"
              :maxlength="1000"
              placeholder="例如 https://api.openai.com/v1"
              :disabled="testingAi"
              :aria-invalid="Boolean(aiUrlError)"
              :aria-describedby="aiUrlError ? 'ai-url-error' : undefined"
              @update:model-value="aiUrlError = ''"
            />
            <p v-if="aiUrlError" id="ai-url-error" class="field-error" role="alert">{{ aiUrlError }}</p>
          </div>
        </div>
        <div class="settings-row settings-row-field">
          <label for="ai-model" class="settings-key">模型</label>
          <div class="settings-control">
            <UInput id="ai-model" v-model="aiModel" class="full-width" :maxlength="200" :disabled="testingAi" />
          </div>
        </div>
        <div class="settings-row settings-row-field">
          <label for="ai-key" class="settings-key">
            API 密钥
            <span v-if="hasAiKey" class="success-text">· 已保存</span>
          </label>
          <div class="settings-control">
            <div class="key-input-row">
              <UInput
                id="ai-key"
                :type="showAiKey ? 'text' : 'password'"
                v-model="aiKey"
                class="full-width"
                :maxlength="4000"
                autocomplete="off"
                :disabled="testingAi"
              />
              <UButton
                color="neutral"
                variant="outline"
                :icon="showAiKey ? 'i-lucide-eye-off' : 'i-lucide-eye'"
                :aria-label="showAiKey ? '隐藏密钥' : '显示密钥'"
                @click="showAiKey = !showAiKey"
              />
            </div>
          </div>
        </div>
      </div>
    </div>

    <div class="settings-group">
      <div class="settings-group-label"><UIcon name="i-lucide-download" /> 应用更新</div>
      <div class="surface settings-card">
        <div class="settings-row">
          <label for="auto-check-update" class="settings-key">自动检查并预下载新版本</label>
          <div class="settings-control settings-control-end">
            <USwitch
              id="auto-check-update"
              :model-value="autoCheckUpdate"
              :disabled="!update || update.state === 'disabled' || savingAutoCheck"
              @update:model-value="changeAutoCheckUpdate(Boolean($event))"
            />
          </div>
        </div>
        <div class="settings-row">
          <div class="settings-key version-inline">
            <strong>v{{ version }}</strong>
            <span class="version-meta" :class="update?.state === 'downloaded' ? 'success-text' : 'muted'"
              >· {{ updateStatusLabel }}</span
            >
          </div>
          <div class="settings-control settings-control-end">
            <UButton
              v-if="update?.state === 'downloaded' || update?.state === 'downloading'"
              size="sm"
              icon="i-lucide-download"
              :loading="updateAction === 'apply'"
              @click="updater('apply')"
            >
              立即更新
            </UButton>
            <UButton
              v-else
              size="sm"
              color="neutral"
              variant="outline"
              icon="i-lucide-refresh-cw"
              :loading="updateAction === 'check' || update?.state === 'checking'"
              :disabled="!update || update.state === 'disabled' || applyingUpdate"
              @click="updater('check')"
            >
              检查更新
            </UButton>
          </div>
        </div>
        <div v-if="update?.state === 'downloading'" class="settings-row">
          <div
            class="progress-track full-width"
            role="progressbar"
            :aria-valuenow="updatePercent"
            aria-valuemin="0"
            aria-valuemax="100"
          >
            <div class="progress-bar" :style="{ width: updatePercent + '%' }" />
          </div>
        </div>
        <div class="settings-row">
          <span class="settings-key muted">相关链接</span>
          <div class="settings-control settings-control-end actions">
            <a :href="releasesUrl" class="text-link inline-link" @click.prevent="openLink('releases')">
              Release 页面 <UIcon name="i-lucide-external-link" />
            </a>
            <a :href="changelogUrl" class="text-link inline-link" @click.prevent="openLink('changelog')">
              CHANGELOG <UIcon name="i-lucide-external-link" />
            </a>
          </div>
        </div>
      </div>
    </div>

    <div v-if="hasUnsavedChanges" class="floating-save-bar">
      <span class="dirty-pill">有未保存更改</span>
      <div class="actions">
        <UButton color="neutral" variant="ghost" size="sm" :disabled="saving || testingAi" @click="resetDraft"
          >放弃</UButton
        >
        <UButton size="sm" :loading="saving" :disabled="testingAi" @click="save()">保存设置</UButton>
      </div>
    </div>

    <UModal
      v-model:open="updateOpen"
      :title="'发现新版本 v' + offeredVersion"
      :description="applyingUpdate ? undefined : '更新完成后，KHooks 将自动重启。'"
      :close="!applyingUpdate"
      :dismissible="!applyingUpdate"
    >
      <template #body v-if="applyingUpdate">
        <p role="status">
          {{
            update?.state === 'installing'
              ? '正在启动安装程序 · 已用 ' + elapsedSeconds + ' 秒'
              : '正在下载 · ' + updatePercent + '% · 已用 ' + elapsedSeconds + ' 秒'
          }}
        </p>
      </template>
      <template #footer>
        <UButton color="neutral" variant="outline" :disabled="applyingUpdate" @click="updateOpen = false">稍后</UButton>
        <UButton :loading="applyingUpdate" @click="updater('apply')">立即更新</UButton>
      </template>
    </UModal>
  </main>
</template>

<style scoped>
.settings-page {
  max-width: 740px;
  padding-bottom: 84px;
}
.overview-pills {
  display: flex;
  align-items: center;
  gap: 8px;
}
.settings-group {
  margin-bottom: 18px;
}
.settings-group-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin-bottom: 8px;
}
.settings-group-label {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  font-weight: 650;
  color: var(--dim);
  padding: 0 4px;
  margin-bottom: 8px;
}
.settings-group-head .settings-group-label {
  margin-bottom: 0;
}
.settings-card {
  overflow: hidden;
}
.settings-row {
  display: grid;
  grid-template-columns: 200px minmax(0, 1fr);
  align-items: center;
  gap: 16px;
  padding: 13px 18px;
}
.settings-row + .settings-row {
  border-top: 1px solid var(--line);
}
.settings-row-field {
  align-items: start;
}
.settings-row-field .settings-key {
  padding-top: 6px;
}
.settings-key {
  font-size: 13px;
  color: var(--ui-text-toned);
}
.settings-control {
  display: grid;
  gap: 6px;
  min-width: 0;
}
.settings-control-end {
  justify-items: end;
  justify-content: end;
}
.segmented {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  padding: 3px;
  border-radius: 9px;
  background: var(--ui-bg-muted);
  border: 1px solid var(--line);
}
.segmented-btn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 5px 11px;
  border-radius: 6px;
  font-size: 13px;
  font-weight: 560;
  color: var(--dim);
}
.segmented-btn:hover:not(:disabled) {
  color: var(--ui-text-highlighted);
}
.segmented-btn.active {
  background: var(--surface);
  color: var(--ui-text-highlighted);
  box-shadow: 0 1px 3px rgb(0 0 0 / 8%);
}
.key-input-row {
  display: flex;
  align-items: center;
  gap: 6px;
}
.version-inline {
  display: flex;
  align-items: baseline;
  gap: 6px;
  white-space: nowrap;
}
.version-meta {
  font-size: 13px;
}
.inline-link {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 13px;
}
.progress-track {
  height: 6px;
  border-radius: 999px;
  background: var(--ui-bg-elevated);
  overflow: hidden;
}
.progress-bar {
  height: 100%;
  border-radius: 999px;
  background: var(--accent);
  transition: width 0.2s ease;
}
.floating-save-bar {
  position: sticky;
  bottom: 16px;
  margin-top: 18px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 14px;
  border-radius: 12px;
  background: color-mix(in srgb, var(--surface) 95%, transparent);
  backdrop-filter: blur(10px);
  border: 1px solid var(--ui-border-accented);
  box-shadow: 0 8px 24px rgb(0 0 0 / 12%);
}

@media (max-width: 820px) {
  .settings-row {
    grid-template-columns: 1fr;
    gap: 8px;
  }
  .settings-control-end {
    justify-items: start;
    justify-content: start;
  }
}
</style>
