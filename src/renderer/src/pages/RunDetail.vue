<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRoute } from 'vue-router'
import type { RunSource, RunStep } from '../../../shared/ipc'
import { nodeLabel, nodeNames, type FlowNode } from '../../../shared/workflow'
import FlowCanvas from '../components/FlowCanvas.vue'
import { dateTime, runLabels, useDesktop } from '../model'

const route = useRoute()
const store = useDesktop()
const sources: Record<RunSource, string> = { automatic: '自动触发', manual: '手动运行', preview: '草稿试跑' }
const run = computed(() => store.data?.runs.find((value) => value.id === route.params.id))
const selected = ref('')
const result = computed(() => run.value?.steps.find((step) => step.nodeId === selected.value))
const resultData = computed(() => {
  const step = result.value
  if (!step?.details) return step?.output
  const output = typeof step.output === 'object' && step.output !== null ? step.output : undefined
  return { ...step.details, ...output }
})
const selection = computed({
  get: () => ({ nodes: selected.value ? [selected.value] : [], edges: [] as string[] }),
  set: (value: { nodes: string[]; edges: string[] }) => { selected.value = value.nodes.at(-1) ?? '' }
})

function stepLabel(step: RunStep): string {
  const workflow = run.value?.workflow
  const node = workflow?.nodes.find((item) => item.id === step.nodeId)
  return workflow && node ? nodeLabel(workflow, node) : nodeNames[step.type as FlowNode['type']] ?? step.type
}
</script>

<template>
  <main v-if="run" class="editor">
    <header class="editor-header">
      <div class="editor-breadcrumb">
        <RouterLink :to="{ name: 'runs', query: { flow: run.workflowId } }" class="back-link" aria-label="返回运行记录">
          <UIcon name="i-lucide-arrow-left" />
        </RouterLink>
        <div><span class="muted">{{ dateTime(run.startedAt) }}</span><h1 class="run-title">{{ run.name }}</h1></div>
        <span class="status" :class="{ online: run.status === 'success', danger: run.status === 'failed' }">{{ runLabels[run.status] }}</span>
        <span v-if="run.source" class="muted">{{ sources[run.source] }}</span>
      </div>
    </header>
    <div class="editor-grid run-grid">
      <section class="canvas-panel">
        <div class="panel-title"><UIcon name="i-lucide-route" /> 执行路径</div>
        <FlowCanvas :key="run.id" v-model:selection="selection" :graph="run.workflow" :run="run" readonly />
      </section>
      <aside class="inspector">
        <div class="panel-title"><UIcon name="i-lucide-list-checks" /> 节点结果</div>
        <div class="inspector-content">
          <button v-for="step in run.steps" :key="step.nodeId" type="button" class="step-row" :class="{ chosen: selected === step.nodeId }"
            @click="selected = step.nodeId">
            <UIcon :name="step.error ? 'i-lucide-circle-x' : 'i-lucide-circle-check'" :class="step.error ? 'error-text' : 'success-text'" />
            <span class="min-w-0 text-left wrap-anywhere">{{ stepLabel(step) }}</span>
            <span v-if="step.attempts !== undefined" class="muted shrink-0">{{ step.attempts }} 次尝试</span>
          </button>
          <template v-if="result">
            <dl v-if="result.startedAt || result.finishedAt" class="mt-3 grid grid-cols-[auto_1fr] gap-x-3 text-sm">
              <dt v-if="result.startedAt" class="muted">开始时间</dt>
              <dd v-if="result.startedAt">{{ dateTime(result.startedAt) }}</dd>
              <dt v-if="result.finishedAt" class="muted">结束时间</dt>
              <dd v-if="result.finishedAt">{{ dateTime(result.finishedAt) }}</dd>
            </dl>
            <p v-if="result.error" class="error-text mt-3 whitespace-pre-wrap wrap-anywhere">{{ result.error }}</p>
            <dl v-if="result.notification" class="mt-3 space-y-1 text-sm">
              <dt class="muted">通知标题</dt>
              <dd class="whitespace-pre-wrap wrap-anywhere">{{ result.notification.title }}</dd>
              <dt class="muted">通知正文</dt>
              <dd class="whitespace-pre-wrap wrap-anywhere">{{ result.notification.body }}</dd>
            </dl>
            <pre v-if="resultData !== undefined" class="result-code">{{ JSON.stringify(resultData, null, 2) }}</pre>
          </template>
        </div>
      </aside>
    </div>
  </main>
  <main v-else class="page"><h1>运行记录不存在</h1><RouterLink to="/runs" class="text-link">返回运行记录</RouterLink></main>
</template>
