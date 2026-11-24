<script setup lang="ts">
import { computed, ref, toRaw, watch } from 'vue'
import { onBeforeRouteLeave, useRoute } from 'vue-router'
import { useToast } from '@nuxt/ui/composables/useToast'
import type { Connection, XYPosition } from '@xyflow/vue'
import {
  busyPolicies, createNode, instantiateComponent, isTrigger, nodeNames, sites, validateConnections, workflowSchema,
  type FlowEdge, type FlowNode, type NodeComponent, type Workflow
} from '../../../shared/workflow'
import { copy, dateTime, desktop, errorMessage, nodeDragType, nodeIcons, useDesktop } from '../model'
import FlowCanvas from '../components/FlowCanvas.vue'
import NodeConfig from '../components/NodeConfig.vue'

const route = useRoute()
const store = useDesktop()
const toast = useToast()
const saved = computed(() => store.data?.workflows.find((flow) => flow.id === route.params.id))
const sample = computed(() => store.data?.samples[String(route.params.id)])
const draft = ref<Workflow>()
const selection = ref<{ nodes: string[]; edges: string[] }>({ nodes: [], edges: [] })
const previewType = ref<FlowNode['type']>()
const draggedType = ref<FlowNode['type']>()
const pending = ref<'save' | 'enable' | 'disable' | 'run' | 'component' | 'reload' | 'revise'>()
const componentDraft = ref<{ name: string; node: FlowNode }>()
const aiOpen = ref(false)
const aiPrompt = ref('')
const aiReady = computed(() => {
  const settings = store.data?.settings
  return Boolean(settings?.aiUrl && settings.aiModel && settings.hasAiKey)
})
const busy = computed(() => pending.value !== undefined)
const nameError = ref('')
const dirty = computed(() => Boolean(draft.value && saved.value && JSON.stringify(draft.value) !== JSON.stringify(saved.value)))
const node = computed(() => selection.value.nodes.length === 1
  ? draft.value?.nodes.find((node) => node.id === selection.value.nodes[0]) : undefined)
const preview = computed(() => previewType.value && createNode(previewType.value, '', 0, 0))
const hasTrigger = computed(() => draft.value?.nodes.some(isTrigger))
const canRun = computed(() => saved.value?.enabled ? saved.value.nodes.some(isTrigger) : hasTrigger.value)
const libraryGroups = [
  { label: '触发器', types: ['manual', 'interval', 'ip', 'fileWatch', 'httpPoll', 'system'] },
  { label: '逻辑', types: ['condition', 'delay', 'data'] },
  { label: '操作', types: ['http', 'notification', 'fileRead', 'fileWrite', 'llm'] }
] as const
const nodeUses: Partial<Record<FlowNode['type'], string>> = {
  manual: '点击「手动运行」时执行流程。',
  ip: '轮询所选站点，检测到现在的公网 IPv4 与之前不同时执行流程。',
  condition: '比较上游字段的值，根据结果走「是」或「否」分支。',
  delay: '等待设定的秒数，再执行下一个节点。',
  data: '设置一个 JSON 值，供下游节点引用。',
  notification: '在 Windows 上显示一条系统通知。'
}

watch(saved, (current, previous) => {
  if (!current) {
    draft.value = undefined
    return
  }
  if (current.id !== previous?.id) {
    nameError.value = ''
    select('')
  }
  if (current.id !== previous?.id || !draft.value || JSON.stringify(draft.value) === JSON.stringify(previous)) {
    draft.value = copy(current)
  } else {
    draft.value.enabled = current.enabled
  }
}, { immediate: true })

onBeforeRouteLeave(async () => !dirty.value || await askConfirm({
  title: '未保存的修改',
  description: '当前流程有未保存的修改，离开后修改将丢失，确定离开？',
  confirmLabel: '离开'
}))

function select(id: string): void {
  previewType.value = undefined
  selection.value = { nodes: id ? [id] : [], edges: [] }
}

function inspect(type: FlowNode['type']): void {
  select('')
  previewType.value = type
}

function updateSelection(current: typeof selection.value): void {
  selection.value = current
  if (current.nodes.length || current.edges.length) previewType.value = undefined
}

function canAdd(type: FlowNode['type']): boolean {
  const flow = draft.value
  const isTriggerType = isTrigger({ type })
  return Boolean(flow && !busy.value && !(isTriggerType && hasTrigger.value))
}

function startDrag(event: DragEvent, type: FlowNode['type']): void {
  if (!event.dataTransfer || !canAdd(type)) {
    event.preventDefault()
    return
  }
  draggedType.value = type
  event.dataTransfer.effectAllowed = 'copy'
  event.dataTransfer.setData(nodeDragType, type)
}

function addNode(source: FlowNode['type'] | NodeComponent, position?: XYPosition): void {
  const type = typeof source === 'string' ? source : source.config.type
  const flow = draft.value
  if (!flow || !canAdd(type)) return
  const index = flow.nodes.length
  const x = position?.x ?? (index ? flow.nodes.reduce((rightmost, node) => Math.max(rightmost, node.x), -Infinity) + 235 : 0)
  const y = position?.y ?? (index > 0 && index % 3 === 0 ? 125 : 0)
  const id = type + '-' + crypto.randomUUID().slice(0, 8)
  flow.nodes.push(typeof source === 'string' ? createNode(type, id, x, y) : instantiateComponent(toRaw(source), id, x, y))
  select(id)
}

function connect(connection: Connection): void {
  const flow = draft.value
  if (!flow || busy.value) return
  const edge: FlowEdge = {
    id: crypto.randomUUID(), from: connection.source, to: connection.target,
    port: (connection.sourceHandle ?? 'next') as FlowEdge['port']
  }
  const issue = validateConnections({ ...flow, edges: [...flow.edges, edge] })
  if (issue) toast.add({ title: issue, color: 'error' })
  else {
    flow.edges.push(edge)
    select(edge.to)
  }
}

function move(positions: { id: string; x: number; y: number }[]): void {
  if (!draft.value || busy.value) return
  for (const point of positions) {
    const current = draft.value.nodes.find((item) => item.id === point.id)
    if (current) Object.assign(current, point)
  }
}

function changeNode(updated: FlowNode): void {
  if (!draft.value || busy.value) return
  draft.value.nodes = draft.value.nodes.map((item) => item.id === updated.id ? updated : item)
}

function openComponentDialog(current: FlowNode): void {
  if (busy.value) return
  componentDraft.value = { name: current.name?.trim() || nodeNames[current.type], node: copy(current) }
}

function closeComponentDialog(): void {
  if (!busy.value) componentDraft.value = undefined
}

async function saveComponent(): Promise<void> {
  const current = componentDraft.value
  if (!current?.name.trim() || busy.value) return
  const { id, x, y, name, ...config } = copy(current.node)
  pending.value = 'component'
  try {
    await desktop.saveComponent({ name: current.name, config })
    componentDraft.value = undefined
    await store.refresh()
  } catch (cause) {
    toast.add({ title: errorMessage(cause), color: 'error' })
  } finally {
    pending.value = undefined
  }
}

function removeSelection({ nodes, edges } = selection.value): void {
  if (!draft.value || busy.value) return
  draft.value.nodes = draft.value.nodes.filter((node) => !nodes.includes(node.id))
  draft.value.edges = draft.value.edges.filter((edge) => !edges.includes(edge.id) &&
    !nodes.includes(edge.from) && !nodes.includes(edge.to))
  select('')
}

async function perform(action: 'save' | 'enable' | 'disable' | 'run'): Promise<void> {
  if (!draft.value || busy.value) return
  const runSaved = action === 'run' && saved.value?.enabled
  if (action !== 'disable' && !runSaved && !draft.value.name.trim()) {
    nameError.value = '请输入流程名称'
    return
  }
  pending.value = action
  const snapshot = copy(draft.value)
  try {
    if (action === 'save' || (action === 'enable' && dirty.value)) {
      await desktop.save(snapshot)
      if (draft.value?.id === snapshot.id) {
        draft.value = workflowSchema.parse({ ...snapshot, enabled: draft.value.enabled })
      }
      await store.refresh()
    }
    if (action === 'enable' || action === 'disable') {
      await desktop.enable(snapshot.id, action === 'enable')
      await store.refresh()
    }
    if (action === 'run') {
      const { id, name, nodes, edges } = snapshot
      await desktop.run(id, runSaved ? undefined : { name, nodes, edges })
      await store.refresh()
    }
  } catch (cause) {
    toast.add({ title: errorMessage(cause), color: 'error' })
  } finally {
    pending.value = undefined
  }
}

async function reloadWorkflow(): Promise<void> {
  const id = draft.value?.id
  if (!id || busy.value) return
  if (dirty.value && !await askConfirm({
    title: '放弃未保存的修改',
    description: '重新加载将放弃当前未保存的修改，确定继续？',
    confirmLabel: '重新加载'
  })) return
  pending.value = 'reload'
  try {
    const current = await desktop.getWorkflow(id)
    if (!current) throw new Error('流程不存在')
    await store.refresh()
    if (draft.value?.id !== id) return
    draft.value = copy(current)
    nameError.value = ''
    select('')
  } catch (cause) {
    toast.add({ title: errorMessage(cause), color: 'error' })
  } finally {
    pending.value = undefined
  }
}

async function reviseWorkflow(): Promise<void> {
  const current = draft.value
  if (!current || busy.value || !aiReady.value || !aiPrompt.value.trim()) return
  const { name, nodes, edges } = current
  pending.value = 'revise'
  try {
    const graph = await desktop.revise(aiPrompt.value, copy({ name, nodes, edges }))
    if (draft.value?.id !== current.id) return
    if (draft.value !== current && (draft.value.name !== name ||
      JSON.stringify(draft.value.nodes) !== JSON.stringify(nodes) || JSON.stringify(draft.value.edges) !== JSON.stringify(edges))) {
      throw new Error('流程已更新，请重新提交修改要求')
    }
    draft.value = { ...draft.value, ...graph }
    nameError.value = ''
    select('')
    aiOpen.value = false
    aiPrompt.value = ''
  } catch (cause) {
    toast.add({ title: errorMessage(cause), color: 'error' })
  } finally {
    pending.value = undefined
  }
}

const busyPolicyOptions = Object.entries(busyPolicies).map(([value, label]) => ({ value, label }))
const nodeSearch = ref('')
const moreOpen = ref(false)
const sampleDrawerOpen = ref(false)
const inspectorDismissed = ref(false)
const confirmDialog = ref<{ title: string; description: string; confirmLabel: string; resolve: (ok: boolean) => void }>()
const hasInspectorTarget = computed(() => Boolean(preview.value || node.value || selection.value.nodes.length > 1 || selection.value.edges.length))
const showInspector = computed(() => !inspectorDismissed.value && (hasInspectorTarget.value || sampleDrawerOpen.value))
const filteredLibraryGroups = computed(() => {
  const q = nodeSearch.value.trim().toLowerCase()
  if (!q) return libraryGroups
  return libraryGroups
    .map((group) => ({ ...group, types: group.types.filter((t) => nodeNames[t].toLowerCase().includes(q) || t.toLowerCase().includes(q)) }))
    .filter((group) => group.types.length > 0)
})
const filteredComponents = computed(() => {
  const list = store.data?.components ?? []
  const q = nodeSearch.value.trim().toLowerCase()
  if (!q) return list
  return list.filter((c) => c.name.toLowerCase().includes(q) || nodeNames[c.config.type].toLowerCase().includes(q))
})

watch([() => selection.value.nodes.join(','), () => selection.value.edges.join(','), previewType], () => {
  if (hasInspectorTarget.value) {
    inspectorDismissed.value = false
    sampleDrawerOpen.value = false
  }
})

function askConfirm(options: { title: string; description: string; confirmLabel: string }): Promise<boolean> {
  return new Promise((resolve) => {
    confirmDialog.value = { ...options, resolve }
  })
}

function resolveConfirm(ok: boolean): void {
  const current = confirmDialog.value
  if (!current) return
  confirmDialog.value = undefined
  current.resolve(ok)
}

function toggleSampleDrawer(): void {
  const next = !(sampleDrawerOpen.value && !inspectorDismissed.value)
  sampleDrawerOpen.value = next
  inspectorDismissed.value = !next
}

function closeInspector(): void {
  inspectorDismissed.value = true
  sampleDrawerOpen.value = false
  previewType.value = undefined
  select('')
}
</script>

<template>
  <main v-if="draft" class="editor">
    <div class="editor-stage">
      <!-- 左侧固定节点面板 -->
      <aside class="library">
        <div class="library-search">
          <UInput v-model="nodeSearch" size="sm" icon="i-lucide-search" placeholder="搜索节点..." class="full-width" />
        </div>
        <div class="library-scroll">
          <div v-for="group in filteredLibraryGroups" :key="group.label" class="library-group">
            <h3>{{ group.label }}</h3>
            <div v-for="kind in group.types" :key="kind" class="library-item" :class="{ chosen: previewType === kind }">
              <button type="button" class="library-preview" :draggable="canAdd(kind)" :aria-pressed="previewType === kind"
                @click="inspect(kind)" @dragstart="startDrag($event, kind)" @dragend="draggedType = undefined">
                <span class="node-icon" :class="kind"><UIcon :name="nodeIcons[kind]" mode="svg" /></span>{{ nodeNames[kind] }}
              </button>
              <UButton class="library-add" color="neutral" variant="ghost" size="xs" icon="i-lucide-plus"
                :aria-label="'添加' + nodeNames[kind]" :disabled="!canAdd(kind)"
                @click="addNode(kind)" />
            </div>
          </div>
          <div v-if="filteredComponents.length" class="library-group">
            <h3>组件</h3>
            <div v-for="component in filteredComponents" :key="component.id" class="library-item">
              <div class="library-component">
                <span class="node-icon" :class="component.config.type"><UIcon :name="nodeIcons[component.config.type]" mode="svg" /></span>
                <span class="node-titles">
                  <span :title="component.name">{{ component.name }}</span>
                  <small>{{ nodeNames[component.config.type] }}</small>
                </span>
              </div>
              <UButton class="library-add" color="neutral" variant="ghost" size="xs" icon="i-lucide-plus"
                :aria-label="'添加组件 ' + component.name" :disabled="!canAdd(component.config.type)" @click="addNode(component)" />
            </div>
          </div>
        </div>
      </aside>

      <!-- 画布主舞台 -->
      <section class="canvas-panel">
        <!-- 左上悬浮胶囊 -->
        <div class="canvas-island canvas-island-left">
          <RouterLink to="/" class="back-link" aria-label="返回流程"><UIcon name="i-lucide-arrow-left" /></RouterLink>
          <div class="editor-name">
            <UInput id="flow-name" v-model="draft.name" variant="none" size="sm" :disabled="busy" :maxlength="100"
              aria-label="流程名称" :aria-invalid="Boolean(nameError)" :aria-describedby="nameError ? 'flow-name-error' : undefined"
              @update:model-value="nameError = ''" />
            <p v-if="nameError" id="flow-name-error" class="field-error" role="alert">{{ nameError }}</p>
          </div>
          <span v-if="dirty" class="dirty-pill" title="有未保存修改">未保存</span>
          <span class="canvas-stat muted">{{ draft.nodes.length }} 节点 · {{ draft.edges.length }} 连线</span>
        </div>

        <!-- 右上悬浮胶囊 -->
        <div class="canvas-island canvas-island-right">
          <UButton color="neutral" variant="ghost" size="sm" icon="i-lucide-sparkles" :disabled="busy"
            @click="aiOpen = true">AI 修改</UButton>
          <UButton v-if="sample" :color="sampleDrawerOpen && !inspectorDismissed ? 'primary' : 'neutral'"
            :variant="sampleDrawerOpen && !inspectorDismissed ? 'soft' : 'ghost'"
            size="sm" icon="i-lucide-history" aria-label="最近一次检测" title="最近一次检测"
            @click="toggleSampleDrawer" />
          <UButton color="neutral" variant="outline" size="sm" icon="i-lucide-play" :disabled="busy || !canRun"
            :loading="pending === 'run'" @click="perform('run')">运行</UButton>
          <UButton :color="dirty ? 'primary' : 'neutral'" :variant="dirty ? 'soft' : 'outline'" size="sm" icon="i-lucide-save"
            :disabled="busy || !dirty" @click="perform('save')">保存</UButton>
          <UButton :color="draft.enabled ? 'neutral' : 'primary'" size="sm"
            :icon="draft.enabled ? 'i-lucide-pause' : 'i-lucide-power'" :disabled="busy"
            @click="perform(draft.enabled ? 'disable' : 'enable')">{{ draft.enabled ? '停用' : '启用' }}</UButton>
          <UPopover v-model:open="moreOpen" :content="{ align: 'end', sideOffset: 8 }">
            <UButton color="neutral" variant="ghost" size="sm" icon="i-lucide-sliders-horizontal" aria-label="流程选项" />
            <template #content>
              <div class="more-popover">
                <div class="more-field">
                  <label>流程忙碌策略</label>
                  <USelect class="full-width" size="sm" aria-label="流程忙碌策略"
                    :model-value="draft.busyPolicy ?? 'skip'" :items="busyPolicyOptions" :disabled="busy"
                    @update:model-value="draft.busyPolicy = $event as Workflow['busyPolicy']" />
                </div>
                <UButton color="neutral" variant="ghost" size="sm" icon="i-lucide-history" class="full-width justify-start"
                  :to="{ name: 'runs', query: { flow: draft.id } }" @click="moreOpen = false">运行记录</UButton>
                <UButton color="neutral" variant="ghost" size="sm" icon="i-lucide-refresh-cw" class="full-width justify-start"
                  :disabled="busy" :loading="pending === 'reload'" @click="moreOpen = false; reloadWorkflow()">重新加载</UButton>
              </div>
            </template>
          </UPopover>
        </div>

        <div v-if="selection.nodes.length > 1" class="canvas-selection-bar">
          <UButton color="error" variant="soft" size="xs" icon="i-lucide-trash-2" :disabled="busy"
            @click="removeSelection()">删除所选（{{ selection.nodes.length }}）</UButton>
        </div>

        <FlowCanvas :key="draft.id" :selection="selection" :graph="draft" :readonly="busy" :dragged-type="draggedType"
          :allow-save-component="!busy" @update:selection="updateSelection" @connect="connect" @move="move" @drop-node="addNode"
          @pane-click="previewType = undefined; sampleDrawerOpen = false" @remove-selection="removeSelection" @save-component="openComponentDialog" />
      </section>

      <!-- 右侧配置侧栏（与左侧节点侧栏统一风格） -->
      <aside v-if="showInspector" class="inspector">
        <div class="panel-title">
          <UIcon name="i-lucide-sliders-horizontal" />
          <span>{{ sampleDrawerOpen && !hasInspectorTarget ? '最近一次检测' : '节点配置' }}</span>
          <UButton class="ml-auto" color="neutral" variant="ghost" size="xs" icon="i-lucide-x"
            aria-label="关闭配置面板" @click="closeInspector" />
        </div>
        <div class="inspector-scroll">
          <div v-if="preview" class="inspector-content">
            <div class="section-row">
              <h2><span class="node-icon" :class="preview.type"><UIcon :name="nodeIcons[preview.type]" mode="svg" /></span>{{ nodeNames[preview.type] }}</h2>
              <span class="muted">预览</span>
            </div>
            <p v-if="nodeUses[preview.type]" class="node-use">{{ nodeUses[preview.type] }}</p>
            <NodeConfig :key="preview.type" :node="preview" :graph="draft" readonly />
          </div>
          <div v-else-if="node" class="inspector-content">
            <div class="section-row">
              <h2><span class="node-icon" :class="node.type"><UIcon :name="nodeIcons[node.type]" mode="svg" /></span>{{ nodeNames[node.type] }}</h2>
              <UButton color="neutral" variant="ghost" icon="i-lucide-trash-2" aria-label="删除节点"
                :disabled="busy" @click="removeSelection()" />
            </div>
            <div class="fields node-name-field">
              <label for="node-name">节点名称</label>
              <UInput id="node-name" :model-value="node.name ?? ''" :maxlength="100" :disabled="busy"
                class="full-width" @update:model-value="changeNode({ ...node, name: String($event) || undefined })" />
            </div>
            <NodeConfig :key="node.id" :node="node" :graph="draft" :readonly="busy" @change="changeNode" />
          </div>
          <div v-else-if="selection.nodes.length > 1" class="inspector-content">
            <h2>已选中 {{ selection.nodes.length }} 个节点</h2>
          </div>
          <div v-else-if="selection.edges.length" class="inspector-content">
            <div class="section-row"><h2>{{ selection.edges.length === 1 ? '连线' : '已选中 ' + selection.edges.length + ' 条连线' }}</h2>
              <UButton color="neutral" variant="ghost" icon="i-lucide-trash-2" aria-label="删除连线"
                :disabled="busy" @click="removeSelection()" />
            </div>
          </div>
          <div v-if="sample" class="inspector-content sample" data-testid="latest-ip">
            <div class="section-row"><h2>最近一次检测</h2><span class="muted">{{ dateTime(sample.checkedAt) }}</span></div>
            <dl class="sample-metrics">
              <div><dt>现在的 IP</dt><dd>{{ sample.winnerIp ?? '未确定' }}</dd></div>
              <div><dt>之前的 IP</dt><dd>{{ sample.previousIp ?? '—' }}</dd></div>
              <div><dt>不同 IP 数量</dt><dd>{{ sample.distinctIpCount }}</dd></div>
            </dl>
            <div v-for="result in sample.results" :key="result.id" class="sample-row">
              <span>{{ sites[result.id].name }}</span>
              <code v-if="result.ip">{{ result.ip }}</code>
              <button v-else type="button" class="error-text" :aria-label="'查看 ' + sites[result.id].name + ' 的错误'"
                @click="toast.add({ title: result.error, color: 'error' })">查看错误</button>
            </div>
          </div>
        </div>
      </aside>
    </div>
    <UModal :open="aiOpen" title="AI 修改流程" :close="!busy" :dismissible="!busy"
      @update:open="!busy && (aiOpen = $event)">
      <template #body>
        <form id="revise-workflow-form" class="fields" @submit.prevent="reviseWorkflow">
          <label for="revise-workflow-prompt">修改要求</label>
          <UTextarea id="revise-workflow-prompt" v-model="aiPrompt" :rows="4" :maxlength="8000"
            :disabled="busy" class="full-width" />
        </form>
      </template>
      <template #footer>
        <RouterLink v-if="!aiReady" to="/settings" class="text-link">配置 AI 服务</RouterLink>
        <UButton color="neutral" variant="outline" :disabled="busy" @click="aiOpen = false">取消</UButton>
        <UButton type="submit" form="revise-workflow-form" :disabled="busy || !aiReady || !aiPrompt.trim()"
          :loading="pending === 'revise'">发送草稿给 AI 修改</UButton>
      </template>
    </UModal>
    <UModal :open="Boolean(componentDraft)" title="另存为组件" :close="!busy" :dismissible="!busy"
      @update:open="!$event && closeComponentDialog()">
      <template #body>
        <form v-if="componentDraft" id="component-form" class="fields" @submit.prevent="saveComponent">
          <label for="component-name">组件名称</label>
          <UInput id="component-name" v-model="componentDraft.name" :maxlength="100" :disabled="busy" class="full-width" />
        </form>
      </template>
      <template #footer>
        <UButton color="neutral" variant="outline" :disabled="busy" @click="closeComponentDialog">取消</UButton>
        <UButton type="submit" form="component-form" :disabled="!componentDraft?.name.trim() || busy"
          :loading="pending === 'component'">保存组件</UButton>
      </template>
    </UModal>
    <UModal :open="Boolean(confirmDialog)" :title="confirmDialog?.title" :description="confirmDialog?.description"
      @update:open="!$event && resolveConfirm(false)">
      <template #footer>
        <UButton color="neutral" variant="outline" @click="resolveConfirm(false)">取消</UButton>
        <UButton color="error" @click="resolveConfirm(true)">{{ confirmDialog?.confirmLabel }}</UButton>
      </template>
    </UModal>
  </main>
  <main v-else class="page"><h1>流程不存在</h1><RouterLink to="/" class="text-link">返回流程</RouterLink></main>
</template>
