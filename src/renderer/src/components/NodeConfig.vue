<script setup lang="ts">
import { computed, nextTick, ref, useTemplateRef, watch } from 'vue'
import { useToast } from '@nuxt/ui/composables/useToast'
import {
  conversions, createSiteConfig, fileEvents, isTrigger, methods, nodeLabel, outputFields, parentsOf, siteId, sites, systemEvents,
  type FlowNode, type Graph, type Rule, type SiteConfig, type SiteId
} from '../../../shared/workflow'
import { copy, desktop, errorMessage } from '../model'
import NotificationBody from './NotificationBody.vue'

const props = defineProps<{ node: FlowNode; graph: Graph; readonly: boolean }>()
const emit = defineEmits<{ change: [node: FlowNode] }>()
const toast = useToast()
const testing = ref<Partial<Record<SiteId, boolean>>>({})
const pathErrors = ref<Partial<Record<SiteId, { path: string; message: string }>>>({})
const refField = ref('')
const notificationTitle = useTemplateRef<{ inputRef?: HTMLInputElement }>('notificationTitle')
const notificationBody = useTemplateRef('notificationBody')

const fieldGroups = computed(() => {
  const parents = parentsOf(props.graph, props.node.id)
  return parents.map((node, index) => {
    const next = parents[index - 1] ?? props.node
    const failure = props.graph.edges.some((edge) => edge.from === node.id && edge.to === next.id && edge.port === 'error')
    const fields = failure ? [
      { key: 'error.message', label: '错误消息' }, { key: 'error.attempts', label: '尝试次数' },
      ...(node.type === 'http' ? [{ key: 'error.status', label: 'HTTP 状态码' }] : [])
    ] : outputFields(node)
    return { id: node.id, label: nodeLabel(props.graph, node),
      fields: fields.map((field) => ({ value: node.id + '.' + field.key, label: field.label })) }
  })
})
const fieldValues = computed(() => new Set(fieldGroups.value.flatMap((group) => group.fields.map((field) => field.value))))
const notificationFields = computed<{ id: string; label: string }[]>((previous) => {
  const fields = fieldGroups.value.flatMap((group) => group.fields.map((field) => ({
    id: field.value, label: (group.label + '-' + field.label).replace(/\s+/g, '')
  })))
  // Mention 菜单按对象身份匹配搜索结果，正文编辑期间复用内容相同的候选项。
  if (previous?.length === fields.length && fields.every((field, index) =>
    field.id === previous[index].id && field.label === previous[index].label)) return previous
  return fields
})
const conditionRules = computed<Rule[]>(() => props.node.type === 'condition'
  ? props.node.group?.rules ?? [asRule(props.node)] : [])
const hasTemplateFields = computed(() => ['http', 'data', 'fileRead', 'fileWrite', 'llm'].includes(props.node.type))
type Action = Extract<FlowNode, { retry?: unknown }>
// 条件节点只有「是/否」出口且运行期不会失败,不提供重试配置(该 computed 仅服务「失败后重试」区块)。
const actionNode = computed(() => isTrigger(props.node) || props.node.type === 'condition' ? undefined : props.node as Action)
const clockMode = computed(() => props.node.type === 'interval' && props.node.clock
  ? props.node.clock.days ? 'weekly' : 'daily' : 'interval')
const weekdays = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
watch(fieldValues, (values) => {
  if (!values.has(refField.value)) refField.value = ''
})
const comparisons = [
  { id: 'eq', label: '等于' }, { id: 'ne', label: '不等于' }, { id: 'gt', label: '大于' },
  { id: 'gte', label: '大于等于' }, { id: 'lt', label: '小于' }, { id: 'lte', label: '小于等于' },
  { id: 'exists', label: '存在' }, { id: 'contains', label: '包含' },
  { id: 'startsWith', label: '开头是' }, { id: 'endsWith', label: '结尾是' }
] as const

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

async function copyReference(): Promise<void> {
  if (!refField.value) return
  try {
    await navigator.clipboard.writeText('{{' + refField.value + '}}')
    toast.add({ title: '已复制', color: 'success' })
  } catch {
    toast.add({ title: '复制失败', color: 'error' })
  }
}

async function insertNotificationTitleReference(): Promise<void> {
  const node = props.node
  if (node.type !== 'notification' || props.readonly || !fieldValues.value.has(refField.value)) return
  const input = notificationTitle.value?.inputRef
  if (!input) return
  const value = node.title
  const start = input.selectionStart ?? value.length
  const end = input.selectionEnd ?? start
  const token = '{{' + refField.value + '}}'
  const updated = value.slice(0, start) + token + value.slice(end)
  if (updated.length > input.maxLength) {
    toast.add({ title: '插入后通知标题超过长度上限', color: 'error' })
    return
  }
  change(node, { title: updated })
  await nextTick()
  input.focus()
  input.setSelectionRange(start + token.length, start + token.length)
}
</script>

<template>
  <div class="fields">
    <template v-if="node.type === 'interval'">
      <label for="schedule-mode">定时模式</label>
      <select id="schedule-mode" class="input-native" :value="clockMode" :disabled="readonly"
        @change="setClock(($event.target as HTMLSelectElement).value)">
        <option value="interval">固定间隔</option>
        <option value="daily">每天</option>
        <option value="weekly">每周</option>
      </select>
      <template v-if="node.clock">
        <label for="clock-time">执行时间</label>
        <UInput id="clock-time" type="time" :model-value="node.clock.time" :disabled="readonly"
          @update:model-value="change(node, { clock: { ...node.clock, time: String($event) || node.clock.time } })" />
        <div v-if="node.clock.days" class="field-group">
          <label v-for="(day, index) in weekdays" :key="day" class="check-row">
            <input type="checkbox" :checked="node.clock.days.includes(index)"
              :disabled="readonly || (node.clock.days.length === 1 && node.clock.days.includes(index))"
              @change="selectDay(index, ($event.target as HTMLInputElement).checked)" />{{ day }}
          </label>
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
      <select id="data-mode" class="input-native" :value="node.mapping ? 'mapping' : 'json'" :disabled="readonly"
        @change="change(node, { mapping: ($event.target as HTMLSelectElement).value === 'mapping' ? [] : undefined })">
        <option value="json">JSON</option>
        <option value="mapping">字段映射</option>
      </select>
      <template v-if="node.mapping">
        <div v-for="(field, index) in node.mapping" :key="index" class="site-config">
          <UInput :aria-label="'字段名称 ' + (index + 1)" :model-value="field.key" :maxlength="200" :disabled="readonly"
            @update:model-value="updateMapping(index, { key: String($event) })" />
          <UInput :aria-label="'字段值 ' + (index + 1)" :model-value="field.value" :maxlength="32000" :disabled="readonly"
            @update:model-value="updateMapping(index, { value: String($event) })" />
          <select class="input-native" :aria-label="'字段类型 ' + (index + 1)" :value="field.convert" :disabled="readonly"
            @change="updateMapping(index, { convert: ($event.target as HTMLSelectElement).value as keyof typeof conversions })">
            <option v-for="(label, key) in conversions" :key="key" :value="key">{{ label }}</option>
          </select>
          <UButton v-if="!readonly" variant="ghost" size="xs" color="neutral" @click="change(node, { mapping: node.mapping?.filter((_, i) => i !== index) })">删除字段</UButton>
        </div>
        <UButton v-if="!readonly" variant="outline" size="xs" color="neutral" :disabled="node.mapping.length >= 50"
          @click="change(node, { mapping: [...(node.mapping ?? []), { key: '', value: '', convert: 'keep' }] })">添加字段</UButton>
      </template>
      <template v-else>
        <label for="data-value">JSON 值</label>
        <UTextarea id="data-value" :model-value="node.value" :rows="4" :maxlength="32000" class="full-width code-input" :disabled="readonly"
          @update:model-value="change(node, { value: String($event) })" />
      </template>
    </template>
    <template v-if="node.type === 'notification'">
      <label for="notification-title">通知标题</label>
      <UInput id="notification-title" ref="notificationTitle" :model-value="node.title" :maxlength="100" class="full-width" :disabled="readonly"
        @update:model-value="change(node, { title: String($event) })" />
      <NotificationBody ref="notificationBody" :model-value="node.body" :fields="notificationFields" :readonly="readonly"
        @update:model-value="change(node, { body: $event })" />
      <template v-if="!readonly">
        <label for="notification-field">上游字段</label>
        <select id="notification-field" v-model="refField" class="input-native" :disabled="!fieldGroups.length">
          <option value="">{{ fieldGroups.length ? '选择字段' : '无可用的上游字段' }}</option>
          <template v-for="group in fieldGroups" :key="group.id">
            <option v-for="field in group.fields" :key="field.value" :value="field.value">{{ group.label }} · {{ field.label }}</option>
          </template>
        </select>
        <div class="actions">
          <UButton color="neutral" variant="outline" size="xs" :disabled="!refField"
            @click="insertNotificationTitleReference">插入标题</UButton>
          <UButton color="neutral" variant="outline" size="xs" :disabled="!refField"
            @click="notificationBody?.insertReference(refField)">插入正文</UButton>
        </div>
      </template>
    </template>

    <template v-if="node.type === 'ip'">
      <div class="field-group">
        <h3>查询站点</h3>
        <label v-for="id in siteId.options" :key="id" class="check-row">
          <input type="checkbox" :checked="node.sites.some(site => site.id === id)" :disabled="readonly"
            @change="toggleSite(id, ($event.target as HTMLInputElement).checked)" />
          {{ sites[id].name }}
        </label>
      </div>
      <div v-for="config in node.sites" :key="config.id" class="site-config">
        <div class="site-title"><strong>{{ sites[config.id].name }}</strong>
          <UButton color="neutral" variant="outline" size="xs" :loading="testing[config.id]"
            :aria-label="'测试 ' + sites[config.id].name" @click="test(config)">测试</UButton>
        </div>
        <label :for="'mode-' + config.id">响应格式</label>
        <select :id="'mode-' + config.id" class="input-native" :value="config.mode"
          :disabled="readonly || !('text' in sites[config.id]) || (config.mode === 'text' && !('json' in sites[config.id]))"
          @change="changeSite(config, {
            mode: ($event.target as HTMLSelectElement).value as SiteConfig['mode'],
            path: config.path || createSiteConfig(config.id, 'json').path
          })">
          <option v-if="'text' in sites[config.id]" value="text">纯文本</option>
          <option v-if="'json' in sites[config.id] || config.mode === 'json'" value="json">JSON</option>
        </select>
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
      <select id="watch-target" class="input-native" :value="node.target" :disabled="readonly"
        @change="change(node, { target: ($event.target as HTMLSelectElement).value as typeof node.target, path: '' })">
        <option value="file">单个文件</option>
        <option value="directory">目录</option>
      </select>
    </template>
    <template v-if="node.type === 'fileWatch' || node.type === 'fileRead' || node.type === 'fileWrite'">
      <label for="local-path">路径</label>
      <div class="actions">
        <UInput id="local-path" class="full-width" :model-value="node.path" :maxlength="4096" :disabled="readonly"
          @update:model-value="change(node, { path: String($event) })" />
        <UButton v-if="!readonly" variant="outline" color="neutral" @click="pickPath">选择</UButton>
      </div>
    </template>
    <template v-if="node.type === 'fileWatch'">
      <label v-for="(label, event) in fileEvents" :key="event" class="check-row">
        <input type="checkbox" :checked="node.events.includes(event)" :disabled="readonly"
          @change="selectFileEvent(event, ($event.target as HTMLInputElement).checked)" />{{ label }}
      </label>
    </template>
    <template v-if="node.type === 'system'">
      <label v-for="(label, event) in systemEvents" :key="event" class="check-row">
        <input type="checkbox" :checked="node.events.includes(event)" :disabled="readonly"
          @change="selectSystemEvent(event, ($event.target as HTMLInputElement).checked)" />{{ label }}
      </label>
    </template>
    <template v-if="node.type === 'fileRead' || node.type === 'fileWrite' || node.type === 'llm'">
      <label for="content-format">{{ node.type === 'llm' ? '输出格式' : '文件格式' }}</label>
      <select id="content-format" class="input-native" :value="node.format" :disabled="readonly"
        @change="change(node, { format: ($event.target as HTMLSelectElement).value as typeof node.format })">
        <option value="text">文本</option>
        <option value="json">JSON</option>
      </select>
    </template>
    <template v-if="node.type === 'fileWrite'">
      <label for="file-content">写入内容</label>
      <UTextarea id="file-content" :rows="4" :model-value="node.content" :maxlength="262144" class="full-width code-input" :disabled="readonly"
        @update:model-value="change(node, { content: String($event) })" />
    </template>
    <template v-if="node.type === 'llm'">
      <label for="llm-system">系统提示</label>
      <UTextarea id="llm-system" :rows="3" :model-value="node.system" :maxlength="32000" class="full-width" :disabled="readonly"
        @update:model-value="change(node, { system: String($event) })" />
      <label for="llm-prompt">用户提示</label>
      <UTextarea id="llm-prompt" :rows="4" :model-value="node.prompt" :maxlength="32000" class="full-width" :disabled="readonly"
        @update:model-value="change(node, { prompt: String($event) })" />
    </template>
    <template v-if="node.type === 'condition'">
      <template v-if="node.group">
        <label for="condition-match">匹配方式</label>
        <select id="condition-match" class="input-native" :value="node.group.match" :disabled="readonly"
          @change="setRules(conditionRules, ($event.target as HTMLSelectElement).value as 'all' | 'any')">
          <option value="all">全部满足</option>
          <option value="any">任一满足</option>
        </select>
      </template>
      <div v-for="(rule, index) in conditionRules" :key="index" class="site-config">
      <label :for="'condition-field-' + index">上游字段</label>
      <select :id="'condition-field-' + index" :value="rule.field" class="input-native" :disabled="readonly"
        @change="updateRule(index, { field: ($event.target as HTMLSelectElement).value })">
        <option value="">选择字段</option>
        <option v-if="rule.field && !fieldValues.has(rule.field)" :value="rule.field">{{ rule.field }}</option>
        <template v-for="group in fieldGroups" :key="group.id">
          <option v-for="field in group.fields" :key="field.value" :value="field.value">{{ group.label }} · {{ field.label }}</option>
        </template>
      </select>
      <label :for="'condition-path-' + index">字段路径</label>
      <UInput :id="'condition-path-' + index" :model-value="rule.field" :maxlength="300" class="full-width" :disabled="readonly"
        @update:model-value="updateRule(index, { field: String($event) })" />
      <label :for="'operator-' + index">运算符</label>
      <select :id="'operator-' + index" class="input-native" :value="rule.operator" :disabled="readonly"
        @change="updateRule(index, { operator: ($event.target as HTMLSelectElement).value as Rule['operator'] })">
        <option v-for="item in comparisons" :key="item.id" :value="item.id">{{ item.label }}</option>
      </select>
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
      <select id="http-method" class="input-native" :value="node.method" :disabled="readonly"
        @change="change(node, { method: ($event.target as HTMLSelectElement).value as typeof node.method })">
        <option v-for="method in methods" :key="method" :value="method">{{ method }}</option>
      </select>
      </template>
      <label for="http-url">请求地址</label>
      <UInput id="http-url" :model-value="node.url" :maxlength="4000" class="full-width" :disabled="readonly"
        @update:model-value="change(node, { url: String($event) })" />
      <template v-if="node.type === 'http' && node.method !== 'GET' && node.method !== 'HEAD'">
        <label for="http-body">JSON 请求体</label>
        <UTextarea id="http-body" :model-value="node.body" :rows="4" :maxlength="32000" class="full-width code-input" :disabled="readonly"
          @update:model-value="change(node, { body: String($event) })" />
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
        <UInput :aria-label="'请求头值 ' + (index + 1)" :model-value="header.value" :maxlength="4000" :disabled="readonly"
          @update:model-value="setHeader(index, 'value', String($event))" />
        <UButton v-if="!readonly" variant="ghost" color="neutral" icon="i-lucide-x" aria-label="删除请求头"
          @click="change(node, { headers: node.headers.filter((_, i) => i !== index) })" />
      </div>
    </template>
    <template v-if="hasTemplateFields && fieldGroups.length && !readonly">
      <label for="template-field">上游字段</label>
      <select id="template-field" v-model="refField" class="input-native">
        <option value="">选择字段</option>
        <optgroup v-for="group in fieldGroups" :key="group.id" :label="group.label">
          <option v-for="field in group.fields" :key="field.value" :value="field.value">{{ field.label }}</option>
        </optgroup>
      </select>
      <div class="actions">
        <UButton color="neutral" variant="outline" size="xs" :disabled="!refField" @click="copyReference">复制引用</UButton>
      </div>
    </template>
    <template v-if="actionNode">
      <label class="check-row">
        <input type="checkbox" :checked="Boolean(actionNode.retry)" :disabled="readonly"
          @change="change(actionNode, { retry: ($event.target as HTMLInputElement).checked ? { count: 1, seconds: 1 } : undefined })" />
        失败后重试
      </label>
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
