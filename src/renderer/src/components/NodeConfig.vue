<script setup lang="ts">
import { computed, nextTick, ref, useTemplateRef, watch } from 'vue'
import { useToast } from '@nuxt/ui/composables/useToast'
import {
  createSiteConfig, methods, nodeLabel, outputFields, parentsOf, siteId, sites,
  type FlowNode, type Graph, type SiteConfig, type SiteId
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

const fieldGroups = computed(() => parentsOf(props.graph, props.node.id).map((node) => ({
  id: node.id,
  label: nodeLabel(props.graph, node),
  fields: outputFields(node).map((field) => ({ value: node.id + '.' + field.key, label: field.label }))
})))
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
const conditionField = computed({
  get: () => props.node.type === 'condition' ? props.node.field : '',
  set: (field: string) => {
    if (props.node.type === 'condition') change(props.node, { field })
  }
})
const hasTemplateFields = computed(() => props.node.type === 'http' || props.node.type === 'data')
watch(fieldValues, (values) => {
  if (!values.has(refField.value)) refField.value = ''
})
const comparisons = [
  { id: 'eq', label: '等于' }, { id: 'ne', label: '不等于' }, { id: 'gt', label: '大于' },
  { id: 'gte', label: '大于等于' }, { id: 'lt', label: '小于' }, { id: 'lte', label: '小于等于' },
  { id: 'exists', label: '存在' }
] as const

function change<N extends FlowNode>(node: N, patch: Partial<N>): void {
  emit('change', { ...node, ...patch })
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

function comparison(event: Event): void {
  if (props.node.type !== 'condition') return
  const value = (event.target as HTMLSelectElement).value as typeof props.node.operator
  change(props.node, { operator: value })
}

function setHeader(index: number, field: 'name' | 'value', value: string): void {
  if (props.node.type !== 'http') return
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
    <template v-if="node.type === 'interval' || node.type === 'ip'">
      <label for="interval">轮询间隔（秒）</label>
      <UInput id="interval" type="number" :min="1" :max="86400" :model-value="node.seconds" :disabled="readonly"
        class="full-width" @update:model-value="change(node, { seconds: Number($event) })" />
    </template>

    <template v-if="node.type === 'delay'">
      <label for="delay-seconds">等待秒数</label>
      <UInput id="delay-seconds" type="number" :min="1" :max="86400" :model-value="node.seconds" :disabled="readonly"
        class="full-width" @update:model-value="change(node, { seconds: Number($event) })" />
    </template>
    <template v-if="node.type === 'data'">
      <label for="data-value">JSON 值</label>
      <UTextarea id="data-value" :model-value="node.value" :rows="4" :maxlength="32000" class="full-width code-input" :disabled="readonly"
        @update:model-value="change(node, { value: String($event) })" />
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
          <UInput :id="'path-' + config.id" :model-value="config.path" :disabled="readonly"
            :aria-invalid="Boolean(pathError(config))" :aria-describedby="pathError(config) ? 'path-error-' + config.id : undefined"
            class="full-width" @update:model-value="changeSite(config, { path: String($event) })" />
          <p v-if="pathError(config)" :id="'path-error-' + config.id" class="field-error" role="alert">{{ pathError(config) }}</p>
        </template>
      </div>
    </template>

    <template v-if="node.type === 'condition'">
      <label for="condition-field">上游字段</label>
      <select id="condition-field" v-model="conditionField" class="input-native" :disabled="readonly">
        <option value="">选择字段</option>
        <option v-if="node.field && !fieldValues.has(node.field)" :value="node.field">已保存的字段不在列表中</option>
        <template v-for="group in fieldGroups" :key="group.id">
          <option v-for="field in group.fields" :key="field.value" :value="field.value">{{ group.label }} · {{ field.label }}</option>
        </template>
      </select>
      <label for="operator">运算符</label>
      <select id="operator" class="input-native" :value="node.operator" :disabled="readonly" @change="comparison">
        <option v-for="item in comparisons" :key="item.id" :value="item.id">{{ item.label }}</option>
      </select>
      <template v-if="node.operator !== 'exists'">
        <label for="compare-value">比较值</label>
        <UInput id="compare-value" :model-value="node.value" class="full-width" :disabled="readonly"
          @update:model-value="change(node, { value: String($event) })" />
      </template>
    </template>

    <template v-if="node.type === 'http'">
      <label for="http-method">请求方法</label>
      <select id="http-method" class="input-native" :value="node.method" :disabled="readonly"
        @change="change(node, { method: ($event.target as HTMLSelectElement).value as typeof node.method })">
        <option v-for="method in methods" :key="method" :value="method">{{ method }}</option>
      </select>
      <label for="http-url">请求地址</label>
      <UInput id="http-url" :model-value="node.url" class="full-width" :disabled="readonly"
        @update:model-value="change(node, { url: String($event) })" />
      <template v-if="node.method !== 'GET' && node.method !== 'HEAD'">
        <label for="http-body">JSON 请求体</label>
        <UTextarea id="http-body" :model-value="node.body" :rows="4" class="full-width code-input" :disabled="readonly"
          @update:model-value="change(node, { body: String($event) })" />
      </template>
      <div class="section-row field-group">
        <h3>请求头</h3>
        <UButton v-if="!readonly" variant="ghost" color="neutral" size="xs" icon="i-lucide-plus"
          @click="change(node, { headers: [...node.headers, { name: '', value: '' }] })">添加</UButton>
      </div>
      <div v-for="(header, index) in node.headers" :key="index" class="header-fields">
        <UInput :aria-label="'请求头名称 ' + (index + 1)" :model-value="header.name" :disabled="readonly"
          @update:model-value="setHeader(index, 'name', String($event))" />
        <UInput :aria-label="'请求头值 ' + (index + 1)" :model-value="header.value" :disabled="readonly"
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
  </div>
</template>
