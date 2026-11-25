<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import type { Run, RunSource } from '../../../shared/ipc'
import { dateTime, runLabels, useDesktop } from '../model'

type StatusFilter = 'all' | 'success' | 'failed' | 'running' | 'aborted'
type SourceFilter = 'all' | RunSource

const route = useRoute()
const router = useRouter()
const store = useDesktop()

const sourceLabels: Record<RunSource, string> = {
  automatic: '自动触发',
  manual: '手动运行',
  preview: '草稿试跑'
}

const search = ref('')
const statusFilter = ref<StatusFilter>('all')
const sourceFilter = ref<SourceFilter>('all')
const flowFilter = ref<string>(typeof route.query.flow === 'string' && route.query.flow ? route.query.flow : 'all')
const page = ref(1)
const pageSize = ref(10)

const pageSizeOptions = [
  { label: '10 条/页', value: 10 },
  { label: '20 条/页', value: 20 },
  { label: '50 条/页', value: 50 }
]

const sourceSelectItems = [
  { label: '全部来源', value: 'all' },
  { label: '自动触发', value: 'automatic' },
  { label: '手动运行', value: 'manual' },
  { label: '草稿试跑', value: 'preview' }
]

watch(
  () => route.query.flow,
  (value) => {
    flowFilter.value = typeof value === 'string' && value ? value : 'all'
  }
)

function setFlowFilter(next: string): void {
  flowFilter.value = next
  if (next === 'all') {
    if (route.query.flow) void router.replace({ name: 'runs' })
  } else if (route.query.flow !== next) {
    void router.replace({ name: 'runs', query: { flow: next } })
  }
}

const allRuns = computed(() => store.data?.runs ?? [])

const flowCategories = computed(() => {
  const counts = new Map<string, { id: string; name: string; count: number }>()
  for (const wf of store.data?.workflows ?? []) {
    counts.set(wf.id, { id: wf.id, name: wf.name, count: 0 })
  }
  for (const run of allRuns.value) {
    const existing = counts.get(run.workflowId)
    if (existing) {
      existing.count++
    } else {
      counts.set(run.workflowId, { id: run.workflowId, name: run.name, count: 1 })
    }
  }
  return Array.from(counts.values()).filter((item) => item.count > 0 || item.id === flowFilter.value)
})

const flowSelectItems = computed(() => [
  { label: `全部流程 (${allRuns.value.length})`, value: 'all' },
  ...flowCategories.value.map((item) => ({ label: `${item.name} (${item.count})`, value: item.id }))
])

const activeFlow = computed(() => flowCategories.value.find((item) => item.id === flowFilter.value))

const runsByFlowAndSearch = computed(() => {
  const q = search.value.trim().toLowerCase()
  return allRuns.value.filter((run) => {
    if (flowFilter.value !== 'all' && run.workflowId !== flowFilter.value) return false
    if (sourceFilter.value !== 'all' && run.source !== sourceFilter.value) return false
    if (!q) return true
    if (run.name.toLowerCase().includes(q) || run.id.toLowerCase().includes(q)) return true
    return run.steps.some(
      (step) =>
        step.type.toLowerCase().includes(q) ||
        step.nodeId.toLowerCase().includes(q) ||
        (step.error && step.error.toLowerCase().includes(q))
    )
  })
})

function matchesStatus(run: Run, filter: StatusFilter): boolean {
  if (filter === 'all') return true
  if (filter === 'aborted') return run.status === 'interrupted' || run.status === 'cancelled'
  return run.status === filter
}

const statusCounts = computed(() => {
  const list = runsByFlowAndSearch.value
  return {
    all: list.length,
    success: list.filter((r) => r.status === 'success').length,
    failed: list.filter((r) => r.status === 'failed').length,
    running: list.filter((r) => r.status === 'running').length,
    aborted: list.filter((r) => r.status === 'interrupted' || r.status === 'cancelled').length
  }
})

const statusTabs = computed<{ id: StatusFilter; label: string; count: number; tone?: string }[]>(() => [
  { id: 'all', label: '全部', count: statusCounts.value.all },
  { id: 'success', label: '成功', count: statusCounts.value.success, tone: 'success' },
  { id: 'failed', label: '失败', count: statusCounts.value.failed, tone: 'danger' },
  { id: 'running', label: '执行中', count: statusCounts.value.running },
  { id: 'aborted', label: '已中断', count: statusCounts.value.aborted }
])

const filteredRuns = computed(() => runsByFlowAndSearch.value.filter((run) => matchesStatus(run, statusFilter.value)))

const totalPages = computed(() => Math.max(1, Math.ceil(filteredRuns.value.length / pageSize.value)))

watch([search, statusFilter, sourceFilter, flowFilter, pageSize], () => {
  page.value = 1
})

watch(totalPages, (max) => {
  if (page.value > max) page.value = max
})

const pagedRuns = computed(() => {
  const start = (page.value - 1) * pageSize.value
  return filteredRuns.value.slice(start, start + pageSize.value)
})

const hasActiveFilters = computed(
  () =>
    Boolean(search.value.trim()) ||
    statusFilter.value !== 'all' ||
    sourceFilter.value !== 'all' ||
    flowFilter.value !== 'all'
)

function resetFilters(): void {
  search.value = ''
  statusFilter.value = 'all'
  sourceFilter.value = 'all'
  setFlowFilter('all')
  page.value = 1
}

function formatDuration(run: Run): string {
  if (!run.finishedAt) return run.status === 'running' ? '进行中' : '—'
  const ms = Math.max(0, new Date(run.finishedAt).getTime() - new Date(run.startedAt).getTime())
  if (ms < 1000) return `${ms}ms`
  const sec = ms / 1000
  if (sec < 60) return `${sec.toFixed(sec < 10 ? 2 : 1)}s`
  return `${Math.floor(sec / 60)}m ${Math.round(sec % 60)}s`
}

function failedStepError(run: Run): string | undefined {
  return run.steps.find((step) => step.error)?.error
}

function statusClass(status: Run['status']): Record<string, boolean> {
  return {
    online: status === 'success',
    danger: status === 'failed',
    running: status === 'running'
  }
}

const timelineGroups = computed(() => {
  const now = new Date()
  const todayKey = now.toDateString()
  const yesterday = new Date(now)
  yesterday.setDate(now.getDate() - 1)
  const yesterdayKey = yesterday.toDateString()

  const groups: { key: string; label: string; items: Run[] }[] = []
  const map = new Map<string, { key: string; label: string; items: Run[] }>()

  for (const run of pagedRuns.value) {
    const date = new Date(run.startedAt)
    const dayKey = date.toDateString()
    const label =
      dayKey === todayKey
        ? '今天'
        : dayKey === yesterdayKey
          ? '昨天'
          : date.toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' })
    let group = map.get(dayKey)
    if (!group) {
      group = { key: dayKey, label, items: [] }
      map.set(dayKey, group)
      groups.push(group)
    }
    group.items.push(run)
  }
  return groups
})

function timeOnly(value: string): string {
  return new Date(value).toLocaleTimeString('zh-CN', { hour12: false })
}
</script>

<template>
  <div class="runs-scroll">
    <main class="page runs-page">
      <div class="page-heading">
        <div>
          <h1>运行记录</h1>
          <p class="muted">
            <template v-if="activeFlow">{{ activeFlow.name }} · </template>
            共 {{ filteredRuns.length }} 条<template v-if="filteredRuns.length !== allRuns.length"
              >（总计 {{ allRuns.length }} 条）</template
            >
          </p>
        </div>
        <UButton v-if="route.query.flow" to="/runs" color="neutral" variant="outline" size="sm">查看全部</UButton>
      </div>

      <section class="surface runs-toolbar">
        <div class="runs-toolbar-row">
          <UInput
            v-model="search"
            size="sm"
            icon="i-lucide-search"
            placeholder="搜索流程名、ID、节点或报错..."
            class="runs-search"
          />
          <USelect
            :model-value="flowFilter"
            :items="flowSelectItems"
            size="sm"
            class="runs-select-flow"
            @update:model-value="setFlowFilter(String($event))"
          />
          <USelect v-model="sourceFilter" :items="sourceSelectItems" size="sm" class="runs-select-source" />
          <UButton
            size="sm"
            color="neutral"
            variant="ghost"
            icon="i-lucide-rotate-ccw"
            :disabled="!hasActiveFilters"
            class="runs-reset-btn"
            @click="resetFilters"
          >
            重置
          </UButton>
        </div>
        <div class="status-pills">
          <button
            v-for="tab in statusTabs"
            :key="tab.id"
            type="button"
            class="pill-btn"
            :class="{ active: statusFilter === tab.id, [tab.tone ?? '']: Boolean(tab.tone) }"
            @click="statusFilter = tab.id"
          >
            <span>{{ tab.label }}</span>
            <span class="pill-count">{{ tab.count }}</span>
          </button>
        </div>
      </section>

      <div v-if="timelineGroups.length" class="timeline-groups">
        <section v-for="group in timelineGroups" :key="group.key" class="timeline-group">
          <div class="timeline-date">
            <span>{{ group.label }}</span>
            <span class="muted text-xs tabular">{{ group.items.length }} 条</span>
          </div>
          <div class="surface timeline-list">
            <RouterLink
              v-for="run in group.items"
              :key="run.id"
              :to="{ name: 'run', params: { id: run.id } }"
              class="timeline-row"
            >
              <span class="timeline-time tabular muted" :title="dateTime(run.startedAt)">{{
                timeOnly(run.startedAt)
              }}</span>
              <span class="timeline-axis">
                <span class="timeline-node" :class="statusClass(run.status)" />
              </span>
              <div class="timeline-body">
                <div class="timeline-head">
                  <strong class="truncate">{{ run.name }}</strong>
                  <span v-if="run.source" class="source-tag">{{ sourceLabels[run.source] }}</span>
                  <span class="status" :class="statusClass(run.status)">{{ runLabels[run.status] }}</span>
                </div>
                <div class="timeline-sub muted">
                  <span class="tabular">耗时 {{ formatDuration(run) }}</span>
                  <span>·</span>
                  <span class="tabular">{{ run.steps.length }} 个已执行节点</span>
                  <template v-if="failedStepError(run)">
                    <span>·</span>
                    <span class="error-text truncate">{{ failedStepError(run) }}</span>
                  </template>
                </div>
              </div>
              <UIcon name="i-lucide-chevron-right" class="muted shrink-0" />
            </RouterLink>
          </div>
        </section>
      </div>
      <div v-else class="surface empty-state">
        <span class="empty-icon"><UIcon name="i-lucide-history" /></span>
        <h2>{{ allRuns.length ? '没有匹配的运行记录' : '暂无运行记录' }}</h2>
        <UButton v-if="hasActiveFilters" color="neutral" variant="soft" size="sm" @click="resetFilters"
          >清空筛选</UButton
        >
      </div>

      <footer v-if="filteredRuns.length" class="runs-pagination">
        <span class="muted text-xs tabular">
          第 {{ (page - 1) * pageSize + 1 }}–{{ Math.min(page * pageSize, filteredRuns.length) }} 条，共
          {{ filteredRuns.length }} 条
        </span>
        <div class="runs-pagination-controls">
          <USelect v-model="pageSize" :items="pageSizeOptions" size="xs" class="runs-page-size" />
          <UPagination
            v-model:page="page"
            :total="filteredRuns.length"
            :items-per-page="pageSize"
            :sibling-count="1"
            size="xs"
          />
        </div>
      </footer>
    </main>
  </div>
</template>

<style scoped>
/* 独立滚动容器并预留固定滚动条沟槽，避免竖向滚动条出现/消失时导致居中页面横向抖动 */
.runs-scroll {
  height: 100%;
  overflow-y: auto;
  scrollbar-gutter: stable;
}
.runs-page {
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.runs-page .page-heading {
  margin-bottom: 2px;
  flex-wrap: wrap;
}
.tabular {
  font-variant-numeric: tabular-nums;
}
.truncate {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.source-tag {
  display: inline-flex;
  align-items: center;
  width: fit-content;
  padding: 2px 7px;
  border-radius: 6px;
  font-size: 11px;
  color: var(--ui-text-toned);
  background: var(--ui-bg-muted);
  border: 1px solid var(--line);
  white-space: nowrap;
}

/* 筛选工具栏与状态分类胶囊 */
.runs-toolbar {
  padding: 12px 14px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.runs-toolbar-row {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.runs-search {
  width: 260px;
  flex: 1 1 200px;
  max-width: 360px;
}
.runs-select-flow {
  width: 190px;
}
.runs-select-source {
  width: 120px;
}
.runs-reset-btn {
  margin-left: auto;
}
.status-pills {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}
.pill-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  border-radius: 999px;
  font-size: 12px;
  color: var(--dim);
  background: var(--ui-bg-muted);
  border: 1px solid var(--line);
  transition:
    background 0.12s,
    border-color 0.12s,
    color 0.12s;
}
.pill-btn:hover {
  color: var(--ui-text-highlighted);
  border-color: var(--ui-border-accented);
}
.pill-btn.active {
  background: var(--surface);
  color: var(--ui-text-highlighted);
  border-color: var(--accent);
  font-weight: 600;
}
.pill-btn.active.success {
  color: var(--success);
  border-color: var(--success-border);
  background: var(--success-bg);
}
.pill-btn.active.danger {
  color: var(--danger);
  border-color: var(--danger-border);
  background: var(--danger-bg);
}
.pill-count {
  font-size: 11px;
  opacity: 0.8;
  font-variant-numeric: tabular-nums;
}

/* 时间轴日期分组 */
.timeline-groups {
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.timeline-group {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.timeline-date {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 0 4px;
  font-weight: 650;
  font-size: 13px;
}
.timeline-list {
  overflow: hidden;
}
.timeline-row {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 12px 16px;
  transition: background 0.12s;
}
.timeline-row + .timeline-row {
  border-top: 1px solid var(--line);
}
.timeline-row:hover {
  background: var(--ui-bg-muted);
}
.timeline-time {
  width: 64px;
  font-size: 12px;
  flex: none;
}
.timeline-axis {
  display: grid;
  place-items: center;
  width: 14px;
  flex: none;
}
.timeline-node {
  width: 9px;
  height: 9px;
  border-radius: 999px;
  background: var(--dim);
}
.timeline-node.online {
  background: var(--success);
}
.timeline-node.danger {
  background: var(--danger);
}
.timeline-body {
  flex: 1;
  min-width: 0;
  display: grid;
  gap: 4px;
}
.timeline-head {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  min-width: 0;
}
.timeline-sub {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  min-width: 0;
}

/* 底部分页 */
.runs-pagination {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
  padding: 4px 2px;
}
.runs-pagination-controls {
  display: flex;
  align-items: center;
  gap: 10px;
}
.runs-page-size {
  width: 104px;
}
</style>
