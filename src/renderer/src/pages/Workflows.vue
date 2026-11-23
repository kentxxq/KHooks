<script setup lang="ts">
import { computed, reactive, ref } from 'vue'
import { useRouter } from 'vue-router'
import { useToast } from '@nuxt/ui/composables/useToast'
import { copy, desktop, errorMessage, nodeIcons, useDesktop } from '../model'
import { isTrigger, nodeNames } from '../../../shared/workflow'
import type { Workflow } from '../../../shared/workflow'

const store = useDesktop()
const toast = useToast()
const router = useRouter()
const prompt = ref('')
const aiOpen = ref(false)
const action = ref<'new' | 'generate' | 'remove' | 'copy'>()
const toggling = ref<string>()
const running = reactive(new Set<string>())
const pending = computed(() => action.value !== undefined || toggling.value !== undefined)
const deletion = ref<{ id: string; name: string }>()
const copyDraft = ref<{ source: Workflow; name: string }>()

const trigger = (flow: Workflow) => flow.nodes.find(isTrigger)

async function run(flow: Workflow): Promise<void> {
  if (pending.value || running.has(flow.id) || !trigger(flow)) return
  const { id } = flow
  running.add(id)
  try {
    await desktop.run(id)
    await store.refresh()
  } catch (cause) {
    toast.add({ title: errorMessage(cause), color: 'error' })
  } finally {
    running.delete(id)
  }
}

async function toggleEnabled(flow: Workflow): Promise<void> {
  if (pending.value || running.has(flow.id)) return
  toggling.value = flow.id
  try {
    await desktop.enable(flow.id, !flow.enabled)
    await store.refresh()
  } catch (cause) {
    toast.add({ title: errorMessage(cause), color: 'error' })
  } finally {
    toggling.value = undefined
  }
}

function requestDeletion(flow: Workflow): void {
  if (pending.value || flow.enabled || running.has(flow.id)) return
  deletion.value = { id: flow.id, name: flow.name }
}

function closeDeletion(): void {
  if (!pending.value) deletion.value = undefined
}

async function confirmDeletion(): Promise<void> {
  const current = deletion.value
  if (pending.value || !current) return
  action.value = 'remove'
  try {
    await desktop.remove(current.id)
    deletion.value = undefined
    await store.refresh()
  } catch (cause) {
    toast.add({ title: errorMessage(cause), color: 'error' })
  } finally {
    action.value = undefined
  }
}

async function create(ai = false): Promise<void> {
  if (pending.value) return
  action.value = ai ? 'generate' : 'new'
  try {
    const flow = ai ? await desktop.generate(prompt.value) : {
      id: crypto.randomUUID(), name: '未命名流程', nodes: [], edges: [], enabled: false
    }
    if (!ai) await desktop.save(flow)
    await store.refresh()
    await router.push({ name: 'editor', params: { id: flow.id } })
  } catch (cause) {
    toast.add({ title: errorMessage(cause), color: 'error' })
  } finally {
    action.value = undefined
  }
}

function requestCopy(source: Workflow): void {
  if (pending.value) return
  const suffix = ' 副本'
  copyDraft.value = { source, name: source.name.slice(0, 100 - suffix.length).trimEnd() + suffix }
}

function closeCopyDialog(): void {
  if (!pending.value) copyDraft.value = undefined
}

async function confirmCopy(): Promise<void> {
  const draft = copyDraft.value
  const name = draft?.name.trim()
  if (pending.value || !draft || !name) return
  action.value = 'copy'
  try {
    const flow = { ...copy(draft.source), id: crypto.randomUUID(), name, enabled: false }
    await desktop.save(flow)
    copyDraft.value = undefined
    await store.refresh()
    await router.push({ name: 'editor', params: { id: flow.id } })
  } catch (cause) {
    toast.add({ title: errorMessage(cause), color: 'error' })
  } finally {
    action.value = undefined
  }
}

const flowSearch = ref('')
const displayedWorkflows = computed(() => {
  const list = store.data?.workflows ?? []
  const q = flowSearch.value.trim().toLowerCase()
  if (!q) return list
  return list.filter((flow) => flow.name.toLowerCase().includes(q))
})
</script>

<template>
  <main class="page">
    <div class="page-heading">
      <div><h1>流程</h1><p class="muted">{{ store.data?.workflows.length ?? 0 }} 条流程</p></div>
      <div class="actions">
        <UInput v-if="store.data?.workflows.length" v-model="flowSearch"
          size="sm" icon="i-lucide-search" placeholder="筛选流程..." class="flow-search-input" />
        <UButton color="neutral" variant="outline" icon="i-lucide-sparkles" :disabled="pending" @click="aiOpen = !aiOpen">AI 生成</UButton>
        <UButton icon="i-lucide-plus" :loading="action === 'new'" :disabled="pending" @click="create()">新建流程</UButton>
      </div>
    </div>
    <div v-if="aiOpen" class="surface ai-panel">
      <div class="section-title"><UIcon name="i-lucide-sparkles" /> AI 生成流程</div>
      <label for="prompt">流程需求</label>
      <UTextarea id="prompt" v-model="prompt" :rows="4" :maxlength="8000" class="full-width" />
      <div class="actions">
        <UButton :loading="action === 'generate'" :disabled="pending || !prompt.trim()" @click="create(true)">生成草稿</UButton>
        <RouterLink v-if="!store.data?.settings.hasAiKey" to="/settings" class="text-link">配置 AI 服务</RouterLink>
      </div>
    </div>

    <div v-if="store.data?.workflows.length" class="flow-grid">
      <article v-for="flow in displayedWorkflows" :key="flow.id" class="flow-grid-card surface">
        <RouterLink :to="{ name: 'editor', params: { id: flow.id } }" class="flow-grid-card-body">
          <div class="flow-grid-card-top">
            <span class="node-icon" :class="trigger(flow)?.type">
              <UIcon :name="trigger(flow) ? nodeIcons[trigger(flow)!.type] : 'i-lucide-workflow'" mode="svg" />
            </span>
            <span class="status" :class="{ online: flow.enabled }">{{ flow.enabled ? '运行中' : '已停用' }}</span>
          </div>
          <strong class="flow-grid-name" :title="flow.name">{{ flow.name }}</strong>
          <div class="flow-grid-meta muted">
            <span>{{ trigger(flow) ? nodeNames[trigger(flow)!.type] : '未配置触发器' }}</span>
            <span>·</span>
            <span>{{ flow.nodes.length }} 个节点</span>
          </div>
        </RouterLink>
        <div class="flow-grid-card-footer">
          <UButton color="neutral" variant="outline" size="xs" icon="i-lucide-play"
            :aria-label="'手动运行流程 ' + flow.name" :loading="running.has(flow.id)"
            :disabled="pending || running.has(flow.id) || !trigger(flow)" @click="run(flow)">运行</UButton>
          <UButton :color="flow.enabled ? 'success' : 'neutral'" variant="soft" size="xs"
            :icon="flow.enabled ? 'i-lucide-pause' : 'i-lucide-power'"
            :aria-label="(flow.enabled ? '停用流程 ' : '启用流程 ') + flow.name"
            :disabled="pending || running.has(flow.id)" :loading="toggling === flow.id" @click="toggleEnabled(flow)">{{ flow.enabled ? '停用' : '启用' }}</UButton>
          <div class="ml-auto actions">
            <UButton color="neutral" variant="ghost" size="xs" icon="i-lucide-copy" :aria-label="'复制流程 ' + flow.name"
              title="复制流程" :disabled="pending" @click="requestCopy(flow)" />
            <UButton color="error" variant="ghost" size="xs" icon="i-lucide-trash-2"
              :aria-label="'删除流程 ' + flow.name" :title="flow.enabled ? '请先停用流程' : '删除流程'"
              :disabled="pending || flow.enabled || running.has(flow.id)" @click="requestDeletion(flow)" />
          </div>
        </div>
      </article>
    </div>
    <div v-else class="surface empty-state">
      <span class="empty-icon"><UIcon name="i-lucide-workflow" /></span>
      <h2>暂无流程</h2>
      <UButton color="neutral" variant="soft" :disabled="pending" icon="i-lucide-plus" @click="create()">新建流程</UButton>
    </div>
    <UModal :open="Boolean(copyDraft)" title="复制流程" :close="!pending" :dismissible="!pending"
      @update:open="!$event && closeCopyDialog()">
      <template #body>
        <form v-if="copyDraft" id="copy-workflow-form" class="fields" @submit.prevent="confirmCopy">
          <label for="copy-workflow-name">新流程名称</label>
          <UInput id="copy-workflow-name" v-model="copyDraft.name" :maxlength="100" :disabled="pending"
            autofocus class="full-width" />
        </form>
      </template>
      <template #footer>
        <UButton color="neutral" variant="outline" :disabled="pending" @click="closeCopyDialog">取消</UButton>
        <UButton type="submit" form="copy-workflow-form" :disabled="pending || !copyDraft?.name.trim()"
          :loading="action === 'copy'">复制</UButton>
      </template>
    </UModal>
    <UModal :open="Boolean(deletion)" :close="!pending" :dismissible="!pending" title="删除流程"
      :description="deletion ? '删除「' + deletion.name + '」后无法恢复。' : undefined"
      @update:open="!$event && closeDeletion()">
      <template #footer>
        <UButton color="neutral" variant="outline" :disabled="pending" @click="closeDeletion">取消</UButton>
        <UButton color="error" :loading="action === 'remove'" @click="confirmDeletion">确认删除</UButton>
      </template>
    </UModal>
  </main>
</template>
