<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { useToast } from '@nuxt/ui/composables/useToast'
import type { RunSource, RunStep } from '../../../shared/ipc'
import { nodeLabel, nodeNames, outputFields, type FlowNode } from '../../../shared/workflow'
import FlowCanvas from '../components/FlowCanvas.vue'
import { dateTime, nodeIcons, runLabels, useDesktop } from '../model'

type OutputMode = 'structured' | 'raw'

const route = useRoute()
const store = useDesktop()
const toast = useToast()

const sources: Record<RunSource, string> = { automatic: '自动触发', manual: '手动运行', preview: '草稿试跑' }
const run = computed(() => store.data?.runs.find((value) => value.id === route.params.id))

const selected = ref('')
const onlyFailed = ref(false)
const outputMode = ref<OutputMode>('structured')

watch(() => run.value?.id, () => {
  onlyFailed.value = false
  const steps = run.value?.steps ?? []
  const target = steps.find((step) => step.error) ?? steps[0]
  selected.value = target?.nodeId ?? ''
}, { immediate: true })

const failedCount = computed(() => (run.value?.steps ?? []).filter((step) => Boolean(step.error)).length)
const visibleSteps = computed(() => {
  const steps = run.value?.steps ?? []
  return onlyFailed.value ? steps.filter((step) => Boolean(step.error)) : steps
})

const result = computed(() => run.value?.steps.find((step) => step.nodeId === selected.value))

const selection = computed({
  get: () => ({ nodes: selected.value ? [selected.value] : [], edges: [] as string[] }),
  set: (value: { nodes: string[]; edges: string[] }) => { selected.value = value.nodes.at(-1) ?? '' }
})

function findNode(step: RunStep): FlowNode | undefined {
  return run.value?.workflow.nodes.find((item) => item.id === step.nodeId)
}

function stepLabel(step: RunStep): string {
  const workflow = run.value?.workflow
  const node = findNode(step)
  return workflow && node ? nodeLabel(workflow, node) : nodeNames[step.type as FlowNode['type']] ?? step.type
}

function stepIcon(step: RunStep): string {
  return nodeIcons[step.type as FlowNode['type']] ?? 'i-lucide-box'
}

function stepDuration(step: RunStep): string {
  if (!step.startedAt || !step.finishedAt) return '—'
  const ms = Math.max(0, new Date(step.finishedAt).getTime() - new Date(step.startedAt).getTime())
  if (ms < 1000) return `${ms}ms`
  const sec = ms / 1000
  if (sec < 60) return `${sec.toFixed(sec < 10 ? 2 : 1)}s`
  return `${Math.floor(sec / 60)}m ${Math.round(sec % 60)}s`
}

function stepData(step: RunStep): unknown {
  if (!step.details) return step.output
  const output = typeof step.output === 'object' && step.output !== null ? step.output : undefined
  return { ...step.details, ...output }
}

type StructuredField = {
  key: string
  label: string
  complex: boolean
  display: string
}

function structuredFields(step: RunStep): StructuredField[] {
  const data = stepData(step)
  if (data === undefined) return []
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    return [{
      key: 'output',
      label: '输出结果',
      complex: typeof data === 'object' && data !== null,
      display: typeof data === 'string' ? data : JSON.stringify(data, null, 2)
    }]
  }
  const node = findNode(step)
  const labelMap = new Map<string, string>()
  if (node) {
    for (const field of outputFields(node)) {
      if (!field.key.includes('.')) labelMap.set(field.key, field.label)
    }
  }
  return Object.entries(data as Record<string, unknown>).map(([key, value]) => {
    const complex = typeof value === 'object' && value !== null
    const display = typeof value === 'string'
      ? value
      : typeof value === 'boolean'
        ? (value ? 'true（是）' : 'false（否）')
        : complex
          ? JSON.stringify(value, null, 2)
          : String(value)
    return {
      key,
      label: labelMap.get(key) ?? key,
      complex: complex || display.length > 80 || display.includes('\n'),
      display
    }
  })
}

function formatJson(value: unknown): string {
  return JSON.stringify(value, null, 2)
}

function stepIndex(step: RunStep): number {
  return (run.value?.steps.findIndex((item) => item.nodeId === step.nodeId) ?? -1) + 1
}

async function copyText(text: string, label = '内容'): Promise<void> {
  try {
    await navigator.clipboard.writeText(text)
    toast.add({ title: `已复制${label}`, color: 'success' })
  } catch {
    toast.add({ title: '复制失败', color: 'error' })
  }
}
</script>

<template>
  <main v-if="run" class="editor run-detail">
    <div class="editor-stage">
      <section class="canvas-panel">
        <div class="canvas-island canvas-island-left">
          <RouterLink :to="{ name: 'runs', query: { flow: run.workflowId } }" class="back-link" aria-label="返回运行记录">
            <UIcon name="i-lucide-arrow-left" />
          </RouterLink>
          <div class="run-meta">
            <strong>{{ run.name }}</strong>
            <small class="muted">
              {{ dateTime(run.startedAt) }}
              <template v-if="run.source"> · {{ sources[run.source] }}</template>
            </small>
          </div>
          <span class="status" :class="{ online: run.status === 'success', danger: run.status === 'failed' }">
            {{ runLabels[run.status] }}
          </span>
        </div>

        <FlowCanvas :key="run.id" v-model:selection="selection" :graph="run.workflow" :run="run" readonly />
      </section>

      <aside class="inspector run-inspector split-inspector">
        <div class="panel-title">
          <UIcon name="i-lucide-list-checks" />
          <span>节点结果</span>
          <span class="muted text-xs tabular">{{ run.steps.length }} 步</span>
          <div class="ml-auto flex items-center gap-1">
            <UButton
              v-if="failedCount > 0"
              size="xs"
              :color="onlyFailed ? 'error' : 'neutral'"
              :variant="onlyFailed ? 'soft' : 'ghost'"
              @click="onlyFailed = !onlyFailed"
            >
              失败 {{ failedCount }}
            </UButton>
          </div>
        </div>

        <div class="split-steps">
          <button
            v-for="step in visibleSteps"
            :key="step.nodeId"
            type="button"
            class="step-item"
            :class="{ chosen: selected === step.nodeId, failed: Boolean(step.error) }"
            @click="selected = step.nodeId"
          >
            <span class="step-idx tabular">{{ stepIndex(step) }}</span>
            <span class="node-icon mini-icon" :class="step.type">
              <UIcon :name="stepIcon(step)" mode="svg" />
            </span>
            <span class="step-name truncate">{{ stepLabel(step) }}</span>
            <span class="step-meta muted tabular">{{ stepDuration(step) }}</span>
            <UIcon
              :name="step.error ? 'i-lucide-circle-x' : 'i-lucide-circle-check'"
              :class="step.error ? 'error-text' : 'success-text'"
              class="shrink-0"
            />
          </button>
          <p v-if="!visibleSteps.length" class="muted text-xs p-3 text-center">暂无符合条件的节点</p>
        </div>

        <div class="inspector-scroll split-detail">
          <div v-if="result" class="detail-body">
            <div class="detail-header-card">
              <div class="detail-header-top">
                <span class="node-icon" :class="result.type">
                  <UIcon :name="stepIcon(result)" mode="svg" />
                </span>
                <div class="min-w-0 flex-1">
                  <strong class="block truncate">{{ stepLabel(result) }}</strong>
                  <small class="muted tabular">{{ stepDuration(result) }}<template v-if="result.attempts !== undefined"> · {{ result.attempts }} 次尝试</template></small>
                </div>
                <span class="status" :class="result.error ? 'danger' : 'online'">
                  {{ result.error ? '失败' : '成功' }}
                </span>
              </div>
              <div v-if="result.startedAt || result.finishedAt" class="detail-times muted tabular">
                <span v-if="result.startedAt">起 {{ dateTime(result.startedAt) }}</span>
                <span v-if="result.finishedAt">止 {{ dateTime(result.finishedAt) }}</span>
              </div>
            </div>

            <div v-if="result.error" class="error-box">
              <div class="box-head">
                <span class="error-text font-semibold flex items-center gap-1">
                  <UIcon name="i-lucide-alert-circle" /> 错误信息
                </span>
                <UButton size="xs" color="neutral" variant="ghost" icon="i-lucide-copy" @click="copyText(result.error, '错误信息')" />
              </div>
              <p class="error-text whitespace-pre-wrap wrap-anywhere text-xs">{{ result.error }}</p>
            </div>

            <div v-if="result.notification" class="info-box">
              <div class="box-head">
                <span class="font-semibold flex items-center gap-1">
                  <UIcon name="i-lucide-bell" /> 通知内容
                </span>
              </div>
              <div class="notif-preview">
                <strong>{{ result.notification.title }}</strong>
                <p class="muted whitespace-pre-wrap wrap-anywhere">{{ result.notification.body }}</p>
              </div>
            </div>

            <div v-if="stepData(result) !== undefined" class="output-section">
              <div class="output-bar">
                <span class="font-semibold text-xs">输出数据</span>
                <div class="flex items-center gap-1">
                  <UButton
                    size="xs"
                    :color="outputMode === 'structured' ? 'primary' : 'neutral'"
                    :variant="outputMode === 'structured' ? 'soft' : 'ghost'"
                    @click="outputMode = 'structured'"
                  >
                    结构化
                  </UButton>
                  <UButton
                    size="xs"
                    :color="outputMode === 'raw' ? 'primary' : 'neutral'"
                    :variant="outputMode === 'raw' ? 'soft' : 'ghost'"
                    @click="outputMode = 'raw'"
                  >
                    JSON
                  </UButton>
                  <UButton
                    size="xs"
                    color="neutral"
                    variant="ghost"
                    icon="i-lucide-copy"
                    @click="copyText(formatJson(stepData(result)), '输出 JSON')"
                  />
                </div>
              </div>

              <div v-if="outputMode === 'structured'" class="kv-list">
                <div v-for="field in structuredFields(result)" :key="field.key" class="kv-item" :class="{ stacked: field.complex }">
                  <div class="kv-key">
                    <span>{{ field.label }}</span>
                    <code v-if="field.label !== field.key" class="kv-raw-key">{{ field.key }}</code>
                  </div>
                  <pre v-if="field.complex" class="kv-code">{{ field.display }}</pre>
                  <span v-else class="kv-val wrap-anywhere">{{ field.display }}</span>
                </div>
              </div>
              <pre v-else class="result-code">{{ formatJson(stepData(result)) }}</pre>
            </div>
          </div>
          <div v-else class="detail-empty muted">
            <UIcon name="i-lucide-mouse-pointer-click" />
            <span>点击上方步骤或画布节点查看结果</span>
          </div>
        </div>
      </aside>
    </div>
  </main>
  <main v-else class="page">
    <h1>运行记录不存在</h1>
    <RouterLink to="/runs" class="text-link">返回运行记录</RouterLink>
  </main>
</template>

<style scoped>
.tabular { font-variant-numeric: tabular-nums; }
.truncate { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.mini-icon { width: 24px; height: 24px; font-size: 13px; border-radius: 6px; }
.step-idx {
  width: 18px; height: 18px; border-radius: 999px; display: grid; place-items: center;
  font-size: 11px; color: var(--dim); background: var(--ui-bg-muted); flex: none;
}

.split-inspector { width: 430px; }
.split-steps {
  flex: none; max-height: 36%; overflow-y: auto; scrollbar-gutter: stable;
  padding: 8px; border-bottom: 1px solid var(--line); display: flex; flex-direction: column; gap: 4px;
}
.split-detail { flex: 1; min-height: 0; scrollbar-gutter: stable; }

.step-item {
  width: 100%; display: flex; align-items: center; gap: 8px; padding: 7px 9px;
  border-radius: 8px; border: 1px solid transparent; text-align: left; font-size: 13px;
  transition: background .12s, border-color .12s;
}
.step-item:hover { background: var(--ui-bg-muted); }
.step-item.chosen { background: var(--ui-bg-elevated); border-color: var(--accent); }
.step-item.failed .step-idx { background: var(--danger-bg); color: var(--danger); }
.step-name { flex: 1; min-width: 0; font-weight: 550; }
.step-meta { font-size: 11px; flex: none; }

.detail-body { padding: 14px; display: flex; flex-direction: column; gap: 12px; }
.detail-header-card {
  padding: 12px; border-radius: 10px; background: var(--ui-bg-muted); border: 1px solid var(--line);
  display: flex; flex-direction: column; gap: 8px;
}
.detail-header-top { display: flex; align-items: center; gap: 10px; }
.detail-times { display: flex; gap: 12px; flex-wrap: wrap; font-size: 11px; }
.box-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 4px; }
.error-box {
  padding: 10px 12px; border-radius: 9px;
  background: var(--danger-bg); border: 1px solid var(--danger-border);
}
.info-box {
  padding: 10px 12px; border-radius: 9px;
  background: var(--ui-bg-muted); border: 1px solid var(--line);
}
.notif-preview { display: grid; gap: 3px; font-size: 12px; }

.output-section { display: flex; flex-direction: column; gap: 8px; }
.output-bar { display: flex; align-items: center; justify-content: space-between; gap: 8px; }

.kv-list { display: flex; flex-direction: column; gap: 6px; }
.kv-item {
  display: flex; align-items: baseline; justify-content: space-between; gap: 10px;
  padding: 7px 10px; border-radius: 8px; background: var(--ui-bg-muted); border: 1px solid var(--line);
  font-size: 12px;
}
.kv-item.stacked { flex-direction: column; align-items: stretch; gap: 6px; }
.kv-key { display: flex; align-items: center; gap: 6px; color: var(--dim); flex-shrink: 0; }
.kv-raw-key {
  font-family: Consolas, monospace; font-size: 10px; padding: 1px 5px;
  border-radius: 4px; background: var(--surface); border: 1px solid var(--line);
}
.kv-val { font-weight: 550; text-align: right; font-family: Consolas, monospace; }
.kv-code {
  margin: 0; padding: 8px; border-radius: 6px; background: var(--surface); border: 1px solid var(--line);
  font-family: Consolas, monospace; font-size: 11px; overflow: auto; max-height: 240px; white-space: pre-wrap; word-break: break-word;
}
.detail-empty {
  height: 100%; min-height: 140px; display: grid; place-items: center; align-content: center; gap: 8px; font-size: 12px;
}

@media (max-width: 900px) {
  .split-inspector { width: min(360px, calc(100% - 24px)); }
}
</style>
