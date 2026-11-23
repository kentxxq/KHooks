<script setup lang="ts">
import { computed, ref } from 'vue'
import { useToast } from '@nuxt/ui/composables/useToast'
import {
  conversions, createSiteConfig, fileEvents, isTrigger, methods, nodeLabel, outputFields, parentsOf, siteId, sites, systemEvents,
  type FlowNode, type Graph, type Rule, type SiteConfig, type SiteId
} from '../../../shared/workflow'
import { copy, desktop, errorMessage } from '../model'
import VariableInput from './VariableInput.vue'

const props = defineProps<{ node: FlowNode; graph: Graph; readonly: boolean }>()
const emit = defineEmits<{ change: [node: FlowNode] }>()
const toast = useToast()
const testing = ref<Partial<Record<SiteId, boolean>>>({})
const pathErrors = ref<Partial<Record<SiteId, { path: string; message: string }>>>({})
const variableFields = computed<{ id: string; label: string }[]>((previous) => {
  const parents = parentsOf(props.graph, props.node.id)
  const fields = parents.flatMap((node, index) => {
    const next = parents[index - 1] ?? props.node
    const failure = props.graph.edges.some((edge) => edge.from === node.id && edge.to === next.id && edge.port === 'error')
    const fields = failure ? [
      { key: 'error.message', label: '错误消息' }, { key: 'error.attempts', label: '尝试次数' },
      ...(node.type === 'http' ? [{ key: 'error.status', label: 'HTTP 状态码' }] : [])
    ] : outputFields(node)
    const label = nodeLabel(props.graph, node)
    return fields.map((field) => ({ id: node.id + '.' + field.key, label: (label + '-' + field.label).replace(/\s+/g, '') }))
  })
  // 复用内容相同的候选项，避免编辑时重建变量标签和菜单结果。
  if (previous?.length === fields.length && fields.every((field, index) =>
    field.id === previous[index].id && field.label === previous[index].label)) return previous
  return fields
})
const conditionRules = computed<Rule[]>(() => props.node.type === 'condition'
  ? props.node.group?.rules ?? [asRule(props.node)] : [])
type Action = Extract<FlowNode, { retry?: unknown }>
// 条件节点只有「是/否」出口且运行期不会失败,不提供重试配置(该 computed 仅服务「失败后重试」区块)。
const actionNode = computed(() => isTrigger(props.node) || props.node.type === 'condition' ? undefined : props.node as Action)
const clockMode = computed(() => props.node.type === 'interval' && props.node.clock
  ? props.node.clock.days ? 'weekly' : 'daily' : 'interval')
const weekdays = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
const comparisons = [
  { value: 'eq', label: '等于' }, { value: 'ne', label: '不等于' }, { value: 'gt', label: '大于' },
  { value: 'gte', label: '大于等于' }, { value: 'lt', label: '小于' }, { value: 'lte', label: '小于等于' },
  { value: 'exists', label: '存在' }, { value: 'contains', label: '包含' },
  { value: 'startsWith', label: '开头是' }, { value: 'endsWith', label: '结尾是' }
]
const scheduleModeOptions = [
  { value: 'interval', label: '固定间隔' },
  { value: 'daily', label: '每天' },
  { value: 'weekly', label: '每周' }
]
const dataModeOptions = [
  { value: 'json', label: 'JSON' },
  { value: 'mapping', label: '字段映射' }
]
const conversionOptions = Object.entries(conversions).map(([value, label]) => ({ value, label }))
const watchTargetOptions = [
  { value: 'file', label: '单个文件' },
  { value: 'directory', label: '目录' }
]
const formatOptions = [
  { value: 'text', label: '文本' },
  { value: 'json', label: 'JSON' }
]
const matchModeOptions = [
  { value: 'all', label: '全部满足' },
  { value: 'any', label: '任一满足' }
]
const methodOptions = methods.map((value) => ({ value, label: value }))

function siteModeOptions(config: SiteConfig): { value: SiteConfig['mode']; label: string }[] {
  const options: { value: SiteConfig['mode']; label: string }[] = []
  if ('text' in sites[config.id]) options.push({ value: 'text', label: '纯文本' })
  if ('json' in sites[config.id] || config.mode === 'json') options.push({ value: 'json', label: 'JSON' })
  return options
}

function change<N extends FlowNode>(node: N, patch: Partial<N>): void {
  emit('change', { ...node, ...patch })
}

// 数值输入防呆:空值/NaN/小于下限时回退原值,合法值取整并钳制到范围内(schema 同一约束)。
function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  const input = Number(value)
  if (!Number.isFinite(input) || input < min) return fallback
  return Math.min(Math.max(Math.round(input), min), max)
}

function toggleSite(id: SiteId, selected: boolean): void {
  if (props.node.type !== 'ip') return
  delete pathErrors.value[id]
  const selection = props.node.sites.filter((site) => site.id !== id)
  if (selected) selection.push(createSiteConfig(id))
  change(props.node, { sites: selection })
}

function changeSite(config: SiteConfig, patch: Partial<SiteConfig>): void {
  if (props.node.type !== 'ip') return
  delete pathErrors.value[config.id]
  change(props.node, { sites: props.node.sites.map((site) => site.id === config.id ? { ...site, ...patch } : site) })
}

function pathError(config: SiteConfig): string | undefined {
  const issue = pathErrors.value[config.id]
  if (issue?.path === config.path) return issue.message
}

async function test(config: SiteConfig): Promise<void> {
  const input = copy(config)
  delete pathErrors.value[input.id]
  if (input.mode === 'json' && !input.path.trim().startsWith('$')) {
    pathErrors.value[input.id] = { path: input.path, message: 'JSONPath 必须以 $ 开头' }
    return
  }
  testing.value[input.id] = true
  try {
    const result = await desktop.probe(input)
    if (result.error === 'JSONPath 必须匹配一个值') {
      pathErrors.value[input.id] = { path: input.path, message: result.error }
    } else if (result.error) {
      toast.add({ title: sites[input.id].name + ' · ' + result.error, color: 'error' })
    } else {
      toast.add({ title: sites[input.id].name + ' · ' + result.ip, color: 'success' })
    }
  } catch (cause) {
    toast.add({ title: errorMessage(cause), color: 'error' })
  } finally {
    testing.value[input.id] = false
  }
}

function asRule({ field, operator, value }: Rule): Rule {
  return { field, operator, value }
}

function updateRule(index: number, patch: Partial<Rule>): void {
  if (props.node.type !== 'condition') return
  if (!props.node.group) change(props.node, patch)
  else change(props.node, { group: { ...props.node.group,
    rules: props.node.group.rules.map((rule, i) => i === index ? { ...rule, ...patch } : rule) } })
}

function setRules(rules: Rule[], match = props.node.type === 'condition' ? props.node.group?.match ?? 'all' : 'all'): void {
  if (props.node.type !== 'condition') return
  if (rules.length === 1 && !props.node.group) change(props.node, rules[0])
  else change(props.node, { group: { match, rules } })
}

function setClock(mode: string): void {
  if (props.node.type !== 'interval') return
  change(props.node, { clock: mode === 'interval' ? undefined : {
    time: props.node.clock?.time ?? '09:00', days: mode === 'weekly' ? props.node.clock?.days ?? [1] : undefined
  } })
}

function selectDay(day: number, checked: boolean): void {
  if (props.node.type !== 'interval' || !props.node.clock?.days) return
  const days = props.node.clock.days.filter((value) => value !== day)
  if (checked) days.push(day)
  if (days.length) change(props.node, { clock: { ...props.node.clock, days: days.sort() } })
}

function selectFileEvent(event: keyof typeof fileEvents, checked: boolean): void {
  if (props.node.type !== 'fileWatch') return
  const events = props.node.events.filter((value) => value !== event)
  if (checked) events.push(event)
  change(props.node, { events })
}

function selectSystemEvent(event: keyof typeof systemEvents, checked: boolean): void {
  if (props.node.type !== 'system') return
  const events = props.node.events.filter((value) => value !== event)
  if (checked) events.push(event)
  change(props.node, { events })
}

async function pickPath(): Promise<void> {
  const node = props.node
  if (node.type !== 'fileWatch' && node.type !== 'fileRead' && node.type !== 'fileWrite') return
  try {
    const path = await desktop.pickPath(node.type === 'fileWatch' ? node.target : node.type === 'fileRead' ? 'file' : 'write')
    if (path !== undefined && props.node.id === node.id) change(props.node as typeof node, { path })
  } catch (cause) {
    toast.add({ title: errorMessage(cause), color: 'error' })
  }
}

function updateMapping(index: number, patch: Partial<NonNullable<Extract<FlowNode, { type: 'data' }>['mapping']>[number]>): void {
  if (props.node.type === 'data' && props.node.mapping) {
    change(props.node, { mapping: props.node.mapping.map((field, i) => i === index ? { ...field, ...patch } : field) })
  }
}

function setHeader(index: number, field: 'name' | 'value', value: string): void {
  if (props.node.type !== 'http' && props.node.type !== 'httpPoll') return
  change(props.node, { headers: props.node.headers.map((header, i) => i === index ? { ...header, [field]: value } : header) })
}

</script>

<template>
  <div class="fields">
    <template v-if="node.type === 'interval'">
      <label for="schedule-mode">定时模式</label>
      <USelect id="schedule-mode" class="full-width" :model-value="clockMode" :items="scheduleModeOptions" :disabled="readonly"
        @update:model-value="setClock(String($event))" />
      <template v-if="node.clock">
        <label for="clock-time">执行时间</label>
        <UInput id="clock-time" type="time" :model-value="node.clock.time" :disabled="readonly"
          @update:model-value="change(node, { clock: { ...node.clock, time: String($event) || node.clock.time } })" />
        <div v-if="node.clock.days" class="field-group check-list">
          <UCheckbox v-for="(day, index) in weekdays" :key="day" :label="day"
            :model-value="node.clock.days.includes(index)"
            :disabled="readonly || (node.clock.days.length === 1 && node.clock.days.includes(index))"
            @update:model-value="selectDay(index, Boolean($event))" />
        </div>
      </template>
    </template>
    <template v-if="(node.type === 'interval' && !node.clock) || node.type === 'ip' || node.type === 'httpPoll'">
      <label for="interval">轮询间隔（秒）</label>
      <UInput id="interval" type="number" :min="1" :max="86400" :model-value="node.seconds" :disabled="readonly"
        class="full-width" @update:model-value="change(node, { seconds: clampNumber($event, node.seconds, 1, 86400) })" />
    </template>

    <template v-if="node.type === 'delay'">
      <label for="delay-seconds">等待秒数</label>
      <UInput id="delay-seconds" type="number" :min="1" :max="86400" :model-value="node.seconds" :disabled="readonly"
        class="full-width" @update:model-value="change(node, { seconds: clampNumber($event, node.seconds, 1, 86400) })" />
    </template>
    <template v-if="node.type === 'data'">
      <label for="data-mode">数据模式</label>
      <USelect id="data-mode" class="full-width" :model-value="node.mapping ? 'mapping' : 'json'" :items="dataModeOptions"
        :disabled="readonly" @update:model-value="change(node, { mapping: $event === 'mapping' ? [] : undefined })" />
      <template v-if="node.mapping">
        <div v-for="(field, index) in node.mapping" :key="index" class="site-config">
          <UInput :aria-label="'字段名称 ' + (index + 1)" :model-value="field.key" :maxlength="200" :disabled="readonly"
            @update:model-value="updateMapping(index, { key: String($event) })" />
          <VariableInput :id="'mapping-value-' + index" :label="'字段值 ' + (index + 1)" :fields="variableFields"
            :model-value="field.value" :maxlength="32000" :readonly="readonly"
            @update:model-value="updateMapping(index, { value: $event })" />
          <USelect class="full-width" :aria-label="'字段类型 ' + (index + 1)" :model-value="field.convert" :items="conversionOptions"
            :disabled="readonly" @update:model-value="updateMapping(index, { convert: $event as keyof typeof conversions })" />
          <UButton v-if="!readonly" variant="ghost" size="xs" color="neutral" @click="change(node, { mapping: node.mapping?.filter((_, i) => i !== index) })">删除字段</UButton>
        </div>
        <UButton v-if="!readonly" variant="outline" size="xs" color="neutral" :disabled="node.mapping.length >= 50"
          @click="change(node, { mapping: [...(node.mapping ?? []), { key: '', value: '', convert: 'keep' }] })">添加字段</UButton>
      </template>
      <template v-else>
        <label for="data-value">JSON 值</label>
        <VariableInput id="data-value" label="JSON 值" :fields="variableFields" :model-value="node.value" :rows="4"
          :maxlength="32000" class="code-input" :readonly="readonly" @update:model-value="change(node, { value: $event })" />
      </template>
    </template>
    <template v-if="node.type === 'notification'">
      <label for="notification-title">通知标题</label>
      <VariableInput id="notification-title" label="通知标题" :model-value="node.title" :fields="variableFields" :maxlength="100"
        :readonly="readonly" @update:model-value="change(node, { title: $event })" />
      <VariableInput id="notification-body" label="通知正文" :model-value="node.body" :fields="variableFields" :rows="4"
        :maxlength="1000" :readonly="readonly" expandable @update:model-value="change(node, { body: $event })" />
    </template>

    <template v-if="node.type === 'ip'">
      <div class="field-group check-list">
        <h3>查询站点</h3>
        <UCheckbox v-for="id in siteId.options" :key="id" :label="sites[id].name"
          :model-value="node.sites.some(site => site.id === id)" :disabled="readonly"
          @update:model-value="toggleSite(id, Boolean($event))" />
      </div>
      <div v-for="config in node.sites" :key="config.id" class="site-config">
        <div class="site-title"><strong>{{ sites[config.id].name }}</strong>
          <UButton color="neutral" variant="outline" size="xs" :loading="testing[config.id]"
            :aria-label="'测试 ' + sites[config.id].name" @click="test(config)">测试</UButton>
        </div>
        <label :for="'mode-' + config.id">响应格式</label>
        <USelect :id="'mode-' + config.id" class="full-width" :model-value="config.mode" :items="siteModeOptions(config)"
          :disabled="readonly || !('text' in sites[config.id]) || (config.mode === 'text' && !('json' in sites[config.id]))"
          @update:model-value="changeSite(config, {
            mode: $event as SiteConfig['mode'],
            path: config.path || createSiteConfig(config.id, 'json').path
          })" />
        <template v-if="config.mode === 'json'">
          <label :for="'path-' + config.id">JSONPath</label>
          <UInput :id="'path-' + config.id" :model-value="config.path" :maxlength="200" :disabled="readonly"
            :aria-invalid="Boolean(pathError(config))" :aria-describedby="pathError(config) ? 'path-error-' + config.id : undefined"
            class="full-width" @update:model-value="changeSite(config, { path: String($event) })" />
          <p v-if="pathError(config)" :id="'path-error-' + config.id" class="field-error" role="alert">{{ pathError(config) }}</p>
        </template>
      </div>
    </template>

    <template v-if="node.type === 'fileWatch'">
      <label for="watch-target">监听类型</label>
      <USelect id="watch-target" class="full-width" :model-value="node.target" :items="watchTargetOptions" :disabled="readonly"
        @update:model-value="change(node, { target: $event as typeof node.target, path: '' })" />
    </template>
    <template v-if="node.type === 'fileWatch' || node.type === 'fileRead' || node.type === 'fileWrite'">
      <label for="local-path">路径</label>
      <div class="actions">
        <UInput v-if="node.type === 'fileWatch'" id="local-path" class="full-width" :model-value="node.path" :maxlength="4096" :disabled="readonly"
          @update:model-value="change(node, { path: String($event) })" />
        <VariableInput v-else id="local-path" label="路径" class="full-width" :model-value="node.path" :maxlength="4096"
          :fields="variableFields" :readonly="readonly" @update:model-value="change(node, { path: $event })" />
        <UButton v-if="!readonly" variant="outline" color="neutral" @click="pickPath">选择</UButton>
      </div>
    </template>
    <template v-if="node.type === 'fileWatch'">
      <div class="check-list">
        <UCheckbox v-for="(label, event) in fileEvents" :key="event" :label="label"
          :model-value="node.events.includes(event)" :disabled="readonly"
          @update:model-value="selectFileEvent(event, Boolean($event))" />
      </div>
    </template>
    <template v-if="node.type === 'system'">
      <div class="check-list">
        <UCheckbox v-for="(label, event) in systemEvents" :key="event" :label="label"
          :model-value="node.events.includes(event)" :disabled="readonly"
          @update:model-value="selectSystemEvent(event, Boolean($event))" />
      </div>
    </template>
    <template v-if="node.type === 'fileRead' || node.type === 'fileWrite' || node.type === 'llm'">
      <label for="content-format">{{ node.type === 'llm' ? '输出格式' : '文件格式' }}</label>
      <USelect id="content-format" class="full-width" :model-value="node.format" :items="formatOptions" :disabled="readonly"
        @update:model-value="change(node, { format: $event as typeof node.format })" />
    </template>
    <template v-if="node.type === 'fileWrite'">
      <label for="file-content">写入内容</label>
      <VariableInput id="file-content" label="写入内容" :rows="4" :model-value="node.content" :fields="variableFields"
        class="code-input" :readonly="readonly" @update:model-value="change(node, { content: $event })" />
    </template>
    <template v-if="node.type === 'llm'">
      <label for="llm-system">系统提示</label>
      <VariableInput id="llm-system" label="系统提示" :rows="3" :model-value="node.system" :maxlength="32000" :fields="variableFields"
        :readonly="readonly" @update:model-value="change(node, { system: $event })" />
      <label for="llm-prompt">用户提示</label>
      <VariableInput id="llm-prompt" label="用户提示" :rows="4" :model-value="node.prompt" :maxlength="32000" :fields="variableFields"
        :readonly="readonly" @update:model-value="change(node, { prompt: $event })" />
    </template>
    <template v-if="node.type === 'condition'">
      <template v-if="node.group">
        <label for="condition-match">匹配方式</label>
        <USelect id="condition-match" class="full-width" :model-value="node.group.match" :items="matchModeOptions" :disabled="readonly"
          @update:model-value="setRules(conditionRules, $event as 'all' | 'any')" />
      </template>
      <div v-for="(rule, index) in conditionRules" :key="index" class="site-config">
      <label :for="'condition-field-' + index">上游字段</label>
      <VariableInput :id="'condition-field-' + index" label="上游字段" :model-value="rule.field" :maxlength="300"
        :fields="variableFields" :readonly="readonly" field-path @update:model-value="updateRule(index, { field: $event })" />
      <label :for="'operator-' + index">运算符</label>
      <USelect :id="'operator-' + index" class="full-width" :model-value="rule.operator" :items="comparisons" :disabled="readonly"
        @update:model-value="updateRule(index, { operator: $event as Rule['operator'] })" />
      <template v-if="rule.operator !== 'exists'">
        <label :for="'compare-value-' + index">比较值</label>
        <UInput :id="'compare-value-' + index" :model-value="rule.value" :maxlength="2000" class="full-width" :disabled="readonly"
          @update:model-value="updateRule(index, { value: String($event) })" />
      </template>
      <UButton v-if="!readonly && conditionRules.length > 1" variant="ghost" size="xs" color="neutral"
        @click="setRules(conditionRules.filter((_, i) => i !== index))">删除条件</UButton>
      </div>
      <UButton v-if="!readonly" variant="outline" size="xs" color="neutral" :disabled="conditionRules.length >= 20"
        @click="setRules([...conditionRules, { field: '', operator: 'eq', value: '' }])">添加条件</UButton>
    </template>

    <template v-if="node.type === 'http' || node.type === 'httpPoll'">
      <template v-if="node.type === 'http'">
      <label for="http-method">请求方法</label>
      <USelect id="http-method" class="full-width" :model-value="node.method" :items="methodOptions" :disabled="readonly"
        @update:model-value="change(node, { method: $event as typeof node.method })" />
      </template>
      <label for="http-url">请求地址</label>
      <UInput v-if="node.type === 'httpPoll'" id="http-url" :model-value="node.url" :maxlength="4000" class="full-width" :disabled="readonly"
        @update:model-value="change(node, { url: String($event) })" />
      <VariableInput v-else id="http-url" label="请求地址" :model-value="node.url" :maxlength="4000" :fields="variableFields"
        :readonly="readonly" @update:model-value="change(node, { url: $event })" />
      <template v-if="node.type === 'http' && node.method !== 'GET' && node.method !== 'HEAD'">
        <label for="http-body">JSON 请求体</label>
        <VariableInput id="http-body" label="JSON 请求体" :model-value="node.body" :rows="4" :maxlength="32000"
          :fields="variableFields" class="code-input" :readonly="readonly" @update:model-value="change(node, { body: $event })" />
      </template>
      <template v-if="node.type === 'httpPoll'">
        <label for="poll-path">JSONPath</label>
        <UInput id="poll-path" :model-value="node.jsonPath" :maxlength="200" class="full-width" :disabled="readonly"
          @update:model-value="change(node, { jsonPath: String($event) })" />
      </template>
      <div class="section-row field-group">
        <h3>请求头</h3>
        <UButton v-if="!readonly" variant="ghost" color="neutral" size="xs" icon="i-lucide-plus" :disabled="node.headers.length >= 30"
          @click="change(node, { headers: [...node.headers, { name: '', value: '' }] })">添加</UButton>
      </div>
      <div v-for="(header, index) in node.headers" :key="index" class="header-fields">
        <UInput :aria-label="'请求头名称 ' + (index + 1)" :model-value="header.name" :maxlength="100" :disabled="readonly"
          @update:model-value="setHeader(index, 'name', String($event))" />
        <UInput v-if="node.type === 'httpPoll'" :aria-label="'请求头值 ' + (index + 1)" :model-value="header.value" :maxlength="4000" :disabled="readonly"
          @update:model-value="setHeader(index, 'value', String($event))" />
        <VariableInput v-else :id="'http-header-value-' + index" :label="'请求头值 ' + (index + 1)" :model-value="header.value"
          :maxlength="4000" :fields="variableFields" :readonly="readonly" @update:model-value="setHeader(index, 'value', $event)" />
        <UButton v-if="!readonly" variant="ghost" color="neutral" icon="i-lucide-x" aria-label="删除请求头"
          @click="change(node, { headers: node.headers.filter((_, i) => i !== index) })" />
      </div>
    </template>
    <template v-if="actionNode">
      <div class="section-row field-group">
        <label for="retry-toggle">失败后重试</label>
        <USwitch id="retry-toggle" :model-value="Boolean(actionNode.retry)" :disabled="readonly"
          @update:model-value="change(actionNode, { retry: $event ? { count: 1, seconds: 1 } : undefined })" />
      </div>
      <template v-if="actionNode.retry">
        <label for="retry-count">重试次数</label>
        <UInput id="retry-count" type="number" :min="1" :max="3" :model-value="actionNode.retry.count" :disabled="readonly"
          @update:model-value="change(actionNode, { retry: { count: clampNumber($event, actionNode.retry!.count, 1, 3), seconds: actionNode.retry!.seconds } })" />
        <label for="retry-seconds">重试间隔（秒）</label>
        <UInput id="retry-seconds" type="number" :min="1" :max="86400" :model-value="actionNode.retry.seconds" :disabled="readonly"
          @update:model-value="change(actionNode, { retry: { count: actionNode.retry!.count, seconds: clampNumber($event, actionNode.retry!.seconds, 1, 86400) } })" />
      </template>
    </template>
  </div>
</template>
