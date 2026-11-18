<script setup lang="ts">
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import { dateTime, runLabels, useDesktop } from '../model'

const route = useRoute()
const store = useDesktop()
const flow = computed(() => store.data?.workflows.find((item) => item.id === route.query.flow))
const runs = computed(() => (store.data?.runs ?? []).filter((run) => !route.query.flow || run.workflowId === route.query.flow))
</script>

<template>
  <main class="page">
    <div class="page-heading">
      <div>
        <h1>运行记录</h1>
        <p v-if="flow" class="muted">{{ flow.name }} · {{ runs.length }} 次运行</p>
      </div>
      <UButton v-if="route.query.flow" to="/runs" color="neutral" variant="outline">查看全部</UButton>
    </div>
    <div v-if="runs.length" class="surface list">
      <RouterLink v-for="run in runs" :key="run.id" :to="{ name: 'run', params: { id: run.id } }" class="flow-row">
        <span class="node-icon"><UIcon name="i-lucide-history" /></span>
        <span class="row-main"><strong>{{ run.name }}</strong><small>{{ dateTime(run.startedAt) }}</small></span>
        <span class="muted">{{ run.steps.length }} 个已执行节点</span>
        <span class="status" :class="{ online: run.status === 'success', danger: run.status === 'failed' }">{{ runLabels[run.status] }}</span>
        <UIcon name="i-lucide-chevron-right" class="muted" />
      </RouterLink>
    </div>
    <div v-else class="surface empty-state">
      <span class="empty-icon"><UIcon name="i-lucide-history" /></span>
      <h2>暂无运行记录</h2>
    </div>
  </main>
</template>
