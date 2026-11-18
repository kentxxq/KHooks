<script setup lang="ts">
import { computed, ref } from 'vue'
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
const pending = computed(() => action.value !== undefined)
const deletion = ref<{ id: string; name: string; final: boolean }>()

const trigger = (flow: Workflow) => flow.nodes.find(isTrigger)

function requestDeletion(flow: Workflow): void {
  if (pending.value || flow.enabled) return
  deletion.value = { id: flow.id, name: flow.name, final: false }
}

function closeDeletion(): void {
  if (!pending.value) deletion.value = undefined
}

async function confirmDeletion(): Promise<void> {
  const current = deletion.value
  if (pending.value || !current) return
  if (!current.final) {
    current.final = true
    return
  }
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

async function duplicate(source: Workflow): Promise<void> {
  if (pending.value) return
  action.value = 'copy'
  try {
    const suffix = ' 副本'
    const flow = {
      ...copy(source), id: crypto.randomUUID(),
      name: source.name.slice(0, 100 - suffix.length).trimEnd() + suffix, enabled: false
    }
    await desktop.save(flow)
    await store.refresh()
    await router.push({ name: 'editor', params: { id: flow.id } })
  } catch (cause) {
    toast.add({ title: errorMessage(cause), color: 'error' })
  } finally {
    action.value = undefined
  }
}
</script>

<template>
  <main class="page">
    <div class="page-heading">
      <div><h1>流程</h1><p class="muted">{{ store.data?.workflows.length ?? 0 }} 条流程</p></div>
      <div class="actions">
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
    <div v-if="store.data?.workflows.length" class="surface list">
      <div v-for="flow in store.data.workflows" :key="flow.id" class="workflow-list-row">
        <RouterLink :to="{ name: 'editor', params: { id: flow.id } }" class="flow-row">
          <span class="node-icon" :class="trigger(flow)?.type">
            <UIcon :name="trigger(flow) ? nodeIcons[trigger(flow)!.type] : 'i-lucide-workflow'" mode="svg" />
          </span>
          <span class="row-main"><strong>{{ flow.name }}</strong><small>{{ trigger(flow) ? nodeNames[trigger(flow)!.type] : '未配置触发器' }}</small></span>
          <span class="muted">{{ flow.nodes.length }} 个节点</span>
          <span class="status" :class="{ online: flow.enabled }">{{ flow.enabled ? '已启用' : '已停用' }}</span>
          <UIcon name="i-lucide-chevron-right" class="muted" />
        </RouterLink>
        <UButton color="neutral" variant="ghost" icon="i-lucide-copy" :aria-label="'复制流程 ' + flow.name"
          title="复制流程" :disabled="pending" @click="duplicate(flow)" />
        <UButton color="error" variant="ghost" icon="i-lucide-trash-2"
          :aria-label="'删除流程 ' + flow.name" :title="flow.enabled ? '请先停用流程' : '删除流程'"
          :disabled="pending || flow.enabled" @click="requestDeletion(flow)" />
      </div>
    </div>
    <div v-else class="surface empty-state">
      <span class="empty-icon"><UIcon name="i-lucide-workflow" /></span>
      <h2>暂无流程</h2>
      <UButton color="neutral" variant="soft" :disabled="pending" icon="i-lucide-plus" @click="create()">新建流程</UButton>
    </div>
    <UModal :open="Boolean(deletion)" :close="!pending" :dismissible="!pending"
      :title="deletion?.final ? '再次确认删除' : '删除流程'"
      :description="deletion ? (deletion.final ? '删除「' + deletion.name + '」后无法恢复。' : '确定要删除「' + deletion.name + '」吗？') : undefined"
      @update:open="!$event && closeDeletion()">
      <template #footer>
        <UButton color="neutral" variant="outline" :disabled="pending" @click="closeDeletion">取消</UButton>
        <UButton :key="String(deletion?.final)" :color="deletion?.final ? 'error' : 'neutral'" :loading="action === 'remove'"
          @click="confirmDeletion">{{ deletion?.final ? '确认删除' : '继续' }}</UButton>
      </template>
    </UModal>
  </main>
</template>
