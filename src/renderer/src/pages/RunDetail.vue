<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRoute } from 'vue-router'
import { useToast } from '@nuxt/ui/composables/useToast'
import { nodeNames, type FlowNode } from '../../../shared/workflow'
import FlowCanvas from '../components/FlowCanvas.vue'
import { dateTime, runLabels, useDesktop } from '../model'

const route = useRoute()
const store = useDesktop()
const toast = useToast()
const run = computed(() => store.data?.runs.find((value) => value.id === route.params.id))
const selected = ref('')
const result = computed(() => run.value?.steps.find((step) => step.nodeId === selected.value))
const selection = computed({
  get: () => ({ nodes: selected.value ? [selected.value] : [], edges: [] as string[] }),
  set: (value: { nodes: string[]; edges: string[] }) => selectStep(value.nodes.at(-1) ?? '')
})

function selectStep(id: string): void {
  selected.value = id
  if (result.value?.error) toast.add({ title: result.value.error, color: 'error' })
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
            @click="selectStep(step.nodeId)">
            <UIcon :name="step.error ? 'i-lucide-circle-x' : 'i-lucide-circle-check'" :class="step.error ? 'error-text' : 'success-text'" />
            {{ nodeNames[step.type as FlowNode['type']] }}
          </button>
          <pre v-if="result && !result.error" class="result-code">{{ JSON.stringify(result.output, null, 2) }}</pre>
        </div>
      </aside>
    </div>
  </main>
  <main v-else class="page"><h1>运行记录不存在</h1><RouterLink to="/runs" class="text-link">返回运行记录</RouterLink></main>
</template>
