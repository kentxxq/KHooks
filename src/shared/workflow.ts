import { z } from 'zod'

export const sites = {
  ipify: { name: 'ipify', text: 'https://api.ipify.org/', json: 'https://api.ipify.org/?format=json' },
  aws: { name: 'AWS Check IP', text: 'https://checkip.amazonaws.com/' },
  icanhazip: { name: 'icanhazip', text: 'https://ipv4.icanhazip.com/' },
  ipip: { name: 'IPIP.NET', text: 'https://myip.ipip.net/', ipPattern: /^当前 IP[：:]\s*(\S+)/ },
  pconline: { name: '太平洋网络', json: 'https://whois.pconline.com.cn/ipJson.jsp?json=true' },
  oray: { name: '贝锐花生壳', text: 'https://ddns.oray.com/checkip', ipPattern: /^Current IP Address:\s*(\S+)/ },
  kentxxq: { name: 'uni.kentxxq.com', json: 'https://uni.kentxxq.com/ip' },
  tencent: { name: '腾讯视频', text: 'https://vv.video.qq.com/checktime', ipPattern: /<ip>\s*([^<\s]+)\s*<\/ip>/ }
} as const

export const siteId = z.enum(Object.keys(sites) as (keyof typeof sites)[])
export const siteConfig = z.strictObject({
  id: siteId,
  mode: z.enum(['text', 'json']),
  path: z.string().max(200)
})
const id = z.string().regex(/^[\w-]{1,80}$/)
const name = z.string().trim().min(1).max(100)
const nodeBase = {
  id,
  x: z.number(),
  y: z.number(),
  name: z
    .string()
    .trim()
    .max(100)
    .transform((value) => value || undefined)
    .optional()
}
export const methods = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'] as const
export const operators = ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'exists', 'contains', 'startsWith', 'endsWith'] as const
export const busyPolicies = { skip: '忙碌跳过', queue: '持久排队', latest: '中断并运行最新事件' } as const
export const fileEvents = { added: '新增', changed: '修改', removed: '删除' } as const
export const systemEvents = {
  playing: '开始播放',
  stopped: '停止播放',
  offline: '网络断开',
  online: '网络恢复',
  screenOff: '屏幕关闭',
  screenOn: '屏幕点亮'
} as const
export const rule = z.strictObject({
  field: z.string().max(300),
  operator: z.enum(operators),
  value: z.string().max(2000)
})
export type Rule = z.infer<typeof rule>
export const conversions = { keep: '保留类型', text: '文本', number: '数字', boolean: '布尔' } as const
const keys = <T extends object>(labels: T) => Object.keys(labels) as (keyof T & string)[]
export const systemEventSchema = z.enum(keys(systemEvents))
const format = z.enum(['text', 'json'])
const path = z.string().max(4096)
const headers = z.array(z.strictObject({ name: z.string().max(100), value: z.string().max(4000) })).max(30)
const seconds = z.number().int().min(1).max(86400)
const actions = { retry: z.strictObject({ count: z.number().int().min(1).max(3), seconds }).optional() }
const clock = z.strictObject({
  time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  days: z.array(z.number().int().min(0).max(6)).min(1).max(7).optional()
})
const nodeConfigs = [
  z.strictObject({ type: z.literal('manual') }),
  z.strictObject({ type: z.literal('interval'), seconds, clock: clock.optional() }),
  z.strictObject({
    type: z.literal('ip'),
    seconds: z.number().int().min(1).max(86400),
    sites: z.array(siteConfig).max(siteId.options.length)
  }),
  z.strictObject({
    type: z.literal('fileWatch'),
    path,
    target: z.enum(['file', 'directory']),
    events: z.array(z.enum(keys(fileEvents))).max(3)
  }),
  z.strictObject({
    type: z.literal('httpPoll'),
    seconds,
    url: z.string().max(4000),
    headers,
    jsonPath: z.string().max(200)
  }),
  z.strictObject({ type: z.literal('system'), events: z.array(systemEventSchema).max(6) }),
  z.strictObject({
    type: z.literal('condition'),
    ...rule.shape,
    ...actions,
    group: z.strictObject({ match: z.enum(['all', 'any']), rules: z.array(rule).max(20) }).optional()
  }),
  z.strictObject({ type: z.literal('delay'), seconds, ...actions }),
  z.strictObject({
    type: z.literal('data'),
    value: z.string().max(32000),
    ...actions,
    mapping: z
      .array(
        z.strictObject({ key: z.string().max(200), value: z.string().max(32000), convert: z.enum(keys(conversions)) })
      )
      .max(50)
      .optional()
  }),
  z.strictObject({
    type: z.literal('notification'),
    title: z.string().max(100),
    body: z.string().max(1000),
    ...actions
  }),
  z.strictObject({
    type: z.literal('http'),
    method: z.enum(methods),
    url: z.string().max(4000),
    headers,
    body: z.string().max(32000),
    ...actions
  }),
  z.strictObject({ type: z.literal('fileRead'), path, format, ...actions }),
  z.strictObject({ type: z.literal('fileWrite'), path, format, content: z.string(), ...actions }),
  z.strictObject({
    type: z.literal('llm'),
    system: z.string().max(32000),
    prompt: z.string().max(32000),
    format,
    ...actions
  })
] as const
const [
  manual,
  interval,
  ip,
  fileWatch,
  httpPoll,
  system,
  condition,
  delay,
  data,
  notification,
  http,
  fileRead,
  fileWrite,
  llm
] = nodeConfigs
export const nodeSchema = z.discriminatedUnion('type', [
  manual.extend(nodeBase),
  interval.extend(nodeBase),
  ip.extend(nodeBase),
  fileWatch.extend(nodeBase),
  httpPoll.extend(nodeBase),
  system.extend(nodeBase),
  condition.extend(nodeBase),
  delay.extend(nodeBase),
  data.extend(nodeBase),
  notification.extend(nodeBase),
  http.extend(nodeBase),
  fileRead.extend(nodeBase),
  fileWrite.extend(nodeBase),
  llm.extend(nodeBase)
])
const componentInputSchema = z.strictObject({ name, config: z.discriminatedUnion('type', nodeConfigs) })
export const componentSchema = componentInputSchema.extend({ id })

const edgeSchema = z.strictObject({ id, from: id, to: id, port: z.enum(['next', 'yes', 'no', 'error']) })
export const graphSchema = z.strictObject({
  name,
  nodes: z.array(nodeSchema),
  edges: z.array(edgeSchema)
})
export const workflowSchema = graphSchema.extend({
  id,
  enabled: z.boolean(),
  busyPolicy: z.enum(keys(busyPolicies)).optional()
})
export type Graph = z.infer<typeof graphSchema>
export type Workflow = z.infer<typeof workflowSchema>
export type FlowNode = z.infer<typeof nodeSchema>
export type ComponentInput = z.infer<typeof componentInputSchema>
export type NodeComponent = z.infer<typeof componentSchema>
export type FlowEdge = z.infer<typeof edgeSchema>
export type SiteConfig = z.infer<typeof siteConfig>
export type SiteId = z.infer<typeof siteId>

export function createSiteConfig(id: SiteId, mode?: SiteConfig['mode']): SiteConfig {
  const site = sites[id]
  const format = mode ?? ('text' in site ? 'text' : 'json')
  return { id, mode: format, path: format === 'json' && 'json' in site ? '$.ip' : '' }
}

export const nodeNames = {
  manual: '手动触发',
  interval: '定时触发',
  ip: '公网 IP 变化',
  fileWatch: '本地文件变化',
  httpPoll: 'HTTP 数据变化',
  system: 'Windows 本机事件',
  condition: '条件分支',
  http: 'HTTP 请求',
  delay: '延时等待',
  data: '设置数据',
  notification: 'Windows 通知',
  fileRead: '读取文件',
  fileWrite: '写入文件',
  llm: '大模型'
} satisfies Record<FlowNode['type'], string>

export function nodeLabel(graph: Graph, node: FlowNode): string {
  const name = node.name?.trim()
  if (name) return name + ' · ' + nodeNames[node.type]
  const siblings = graph.nodes.filter((item) => item.type === node.type)
  const index = siblings.findIndex((item) => item.id === node.id)
  return nodeNames[node.type] + (siblings.length > 1 ? ' ' + (index + 1) : '')
}

export function createNode(type: FlowNode['type'], id: string, x: number, y: number): FlowNode {
  const base = { id, x, y }
  switch (type) {
    case 'manual':
      return { ...base, type }
    case 'interval':
      return { ...base, type, seconds: 60 }
    case 'ip':
      return { ...base, type, seconds: 60, sites: [] }
    case 'fileWatch':
      return { ...base, type, path: '', target: 'directory', events: ['added', 'changed', 'removed'] }
    case 'httpPoll':
      return { ...base, type, seconds: 60, url: '', headers: [], jsonPath: '' }
    case 'system':
      return { ...base, type, events: [] }
    case 'condition':
      return { ...base, type, field: '', operator: 'eq', value: '' }
    case 'http':
      return { ...base, type, method: 'GET', url: '', headers: [], body: '' }
    case 'delay':
      return { ...base, type, seconds: 5 }
    case 'data':
      return { ...base, type, value: 'null' }
    case 'notification':
      return { ...base, type, title: '', body: '' }
    case 'fileRead':
      return { ...base, type, path: '', format: 'text' }
    case 'fileWrite':
      return { ...base, type, path: '', format: 'text', content: '' }
    case 'llm':
      return { ...base, type, system: '', prompt: '', format: 'text' }
  }
}

export function isTrigger(node: Pick<FlowNode, 'type'>): boolean {
  return ['manual', 'interval', 'ip', 'fileWatch', 'httpPoll', 'system'].includes(node.type)
}

export function isAbsoluteFilePath(value: string): boolean {
  return /^(?:[a-z]:[\\/]|\\\\[^\\]+\\[^\\]+|\/)/i.test(value)
}

export function parseHttpUrl(value: string): URL {
  const url = new URL(value)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('请输入 HTTP(S) 地址，凭据请填在请求头中')
  }
  return url
}

const fieldSyntax = /^[\w-]+(?:\.[\w-]+)+$/
const templateField = /@\{([\w.-]+)\}/g
const exactTemplateField = new RegExp('^' + templateField.source + '$')

export function formatFieldRef(path: string): string {
  return '@{' + path + '}'
}

export function exactFieldRef(template: string): string | undefined {
  const match = exactTemplateField.exec(template)
  return match?.[0] === template ? match[1] : undefined
}

export function fieldRefs(template: string): string[] {
  return Array.from(template.matchAll(templateField), (match) => match[1])
}

export function replaceFieldRefs(
  template: string,
  replace: (path: string, expression: string, offset: number) => string
): string {
  return template.replace(templateField, (expression, path: string, offset: number) =>
    replace(path, expression, offset)
  )
}

export function mapNodeTemplates(node: NodeComponent['config'], map: (value: string) => string): void {
  switch (node.type) {
    case 'data':
      node.value = map(node.value)
      for (const field of node.mapping ?? []) field.value = map(field.value)
      break
    case 'fileWrite':
      node.content = map(node.content)
      node.path = map(node.path)
      break
    case 'fileRead':
      node.path = map(node.path)
      break
    case 'llm':
      node.system = map(node.system)
      node.prompt = map(node.prompt)
      break
    case 'notification':
      node.title = map(node.title)
      node.body = map(node.body)
      break
    case 'http':
      node.url = map(node.url)
      for (const header of node.headers) header.value = map(header.value)
      node.body = map(node.body)
      break
  }
}

export function instantiateComponent(component: NodeComponent, id: string, x: number, y: number): FlowNode {
  const node = { ...structuredClone(component.config), id, x, y, name: component.name }
  if (node.type === 'condition') {
    node.field = ''
    for (const rule of node.group?.rules ?? []) rule.field = ''
  }
  mapNodeTemplates(node, (value) => replaceFieldRefs(value, () => ''))
  return node
}

export function parentsOf(graph: Graph, nodeId: string): FlowNode[] {
  const parents: FlowNode[] = []
  const seen = new Set([nodeId])
  let upstream = graph.edges.find((edge) => edge.to === nodeId)
  while (upstream && !seen.has(upstream.from)) {
    const parent = graph.nodes.find((node) => node.id === upstream?.from)
    if (!parent) break
    seen.add(parent.id)
    parents.push(parent)
    upstream = graph.edges.find((edge) => edge.to === parent.id)
  }
  return parents
}

// zod 拒绝输入时把首个 issue 转成中文摘要,避免英文 dump 直接进入渲染层 toast。
export function zodMessage(error: unknown): string {
  const issue = error instanceof z.ZodError ? error.issues[0] : undefined
  if (!issue) return '格式不正确'
  // 路径以 nodes[2].seconds 形式拼接,数字段用方括号。
  const field = issue.path
    .map((part) => (typeof part === 'number' ? `[${part}]` : '.' + String(part)))
    .join('')
    .replace(/^\./, '')
  const name = field ? field + ' ' : ''
  if (issue.code === 'too_small') return `${name}不能小于 ${issue.minimum}`
  if (issue.code === 'too_big') return `${name}不能大于 ${issue.maximum}`
  if (issue.code === 'invalid_type') return name + '类型无效'
  if (issue.code === 'invalid_format') return name + '格式无效'
  if (issue.code === 'unrecognized_keys') return name + '包含不支持的字段'
  return name + issue.message
}

export function validateConnections(graph: Graph): string | undefined {
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]))
  if (nodes.size !== graph.nodes.length) return '节点标识重复'
  const triggers = graph.nodes.filter(isTrigger)
  if (triggers.length > 1) return '每条流程只允许一个触发器'
  const edgeIds = new Set<string>()
  const incoming = new Map<string, string>()
  for (const edge of graph.edges) {
    const source = nodes.get(edge.from)
    const target = nodes.get(edge.to)
    if (edgeIds.has(edge.id) || !source || !target || isTrigger(target)) return '连线端点无效'
    edgeIds.add(edge.id)
    // 条件节点运行期只按「是/否」出口调度,没有失败出口,直接拦截死分支。
    if (edge.port === 'error' && source.type === 'condition') return '条件节点没有失败出口'
    const validPort =
      edge.port === 'error'
        ? !isTrigger(source)
        : source.type === 'condition'
          ? edge.port !== 'next'
          : edge.port === 'next'
    if (!validPort) return '连线出口无效'
    if (incoming.has(edge.to)) return '节点只能有一个入口'
    incoming.set(edge.to, edge.from)
  }
  const checked = new Set<string>()
  for (const node of graph.nodes) {
    const seen = new Set<string>()
    let current: string | undefined = node.id
    while (current && !checked.has(current)) {
      if (seen.has(current)) return '流程不能包含环路'
      seen.add(current)
      current = incoming.get(current)
    }
    for (const id of seen) checked.add(id)
  }
}

export function validateWorkflow(graph: Graph): string | undefined {
  const connections = validateConnections(graph)
  if (connections) return connections
  const trigger = graph.nodes.find(isTrigger)
  if (!trigger) return '请添加触发器'
  if (graph.nodes.length === 1) return '请连接至少一个处理节点'
  for (const node of graph.nodes) {
    const parents = parentsOf(graph, node.id)
    if (node !== trigger && !parents.includes(trigger)) return '请将所有节点连接到触发器'
    const validRef = (field: string) =>
      fieldSyntax.test(field) && parents.some((parent) => parent.id === field.split('.')[0])
    if (node.type === 'ip') {
      if (!node.sites.length || new Set(node.sites.map((site) => site.id)).size !== node.sites.length)
        return '请选择至少一个站点，每个站点只能选择一次'
      if (node.sites.some((site) => site.mode === 'json' && !site.path.trim().startsWith('$')))
        return 'JSONPath 必须以 $ 开头'
    }
    if (node.type === 'interval' && node.clock?.days && new Set(node.clock.days).size !== node.clock.days.length)
      return '星期不能重复'
    if (node.type === 'fileWatch' && (!isAbsoluteFilePath(node.path) || !node.events.length))
      return '请选择绝对路径和文件事件'
    if (node.type === 'system' && !node.events.length) return '请选择本机事件'
    if (node.type === 'condition') {
      const rules = node.group?.rules ?? [node]
      if (!rules.length || rules.some((rule) => !validRef(rule.field))) return '条件节点需要引用上游字段'
    }
    if (node.type === 'data') {
      const values = node.mapping?.map((field) => field.value) ?? [node.value]
      if (values.flatMap(fieldRefs).some((field) => !validRef(field))) return '设置数据只能引用上游字段'
      if (node.mapping) {
        const keys = node.mapping.map((field) => field.key.trim())
        // 字段引用按点号分路径(readField),含点号的映射键在下游不可达,直接拦截。
        if (keys.some((key) => !key || key.includes('.')) || new Set(keys).size !== keys.length)
          return '映射字段名称不能为空、重复或包含点号'
      } else {
        try {
          JSON.parse(node.value)
        } catch {
          return '设置数据需要有效的 JSON'
        }
      }
    }
    if (node.type === 'fileRead' || node.type === 'fileWrite') {
      if (!isAbsoluteFilePath(node.path) && !exactFieldRef(node.path.trim()))
        return '文件节点需要绝对路径或上游路径引用'
      const values = node.type === 'fileWrite' ? [node.path, node.content] : [node.path]
      if (values.flatMap(fieldRefs).some((field) => !validRef(field))) return '文件节点只能引用上游字段'
      if (node.type === 'fileWrite' && node.format === 'json') {
        try {
          JSON.parse(node.content)
        } catch {
          return '写入文件需要有效的 JSON'
        }
      }
    }
    if (node.type === 'llm') {
      if (!node.prompt.trim()) return '请输入用户提示'
      if ([node.system, node.prompt].flatMap(fieldRefs).some((field) => !validRef(field)))
        return '大模型节点只能引用上游字段'
    }
    if (node.type === 'notification') {
      if (!node.title.trim()) return '请输入通知标题'
      if ([node.title, node.body].flatMap(fieldRefs).some((field) => !validRef(field)))
        return 'Windows 通知只能引用上游字段'
    }
    if (node.type === 'http') {
      const placeholders = [node.url, node.body, ...node.headers.map((header) => header.value)]
      if (placeholders.flatMap(fieldRefs).some((field) => !validRef(field))) return 'HTTP 节点只能引用上游字段'
      try {
        parseHttpUrl(node.url.replace(templateField, 'placeholder'))
        new Headers(node.headers.map(({ name, value }) => [name, value]))
        if (node.body && node.method !== 'GET' && node.method !== 'HEAD') JSON.parse(node.body)
      } catch {
        return '请检查 HTTP 请求的地址、请求头和 JSON 请求体'
      }
    }
    if (node.type === 'httpPoll') {
      try {
        parseHttpUrl(node.url)
        new Headers(node.headers.map(({ name, value }) => [name, value]))
      } catch {
        return '请检查 HTTP 轮询地址和请求头'
      }
      if (node.jsonPath.trim() && !node.jsonPath.trim().startsWith('$')) return 'JSONPath 必须以 $ 开头'
    }
  }
}

export function outputFields(node: FlowNode): { key: string; label: string }[] {
  switch (node.type) {
    case 'ip':
      return [
        { key: 'winnerIp', label: '现在的 IP' },
        { key: 'previousIp', label: '之前的 IP' },
        { key: 'distinctIpCount', label: '不同 IP 数量' },
        { key: 'winnerVotes', label: '最高得票数' },
        { key: 'checkedAt', label: '检测时间' },
        { key: 'votes', label: 'IP 票数统计' },
        { key: 'results', label: '全部站点结果' },
        ...node.sites.flatMap((site, index) => [
          { key: `results.${index}.id`, label: sites[site.id].name + ' · 站点标识' },
          { key: `results.${index}.ip`, label: sites[site.id].name + ' · 返回 IP' },
          { key: `results.${index}.error`, label: sites[site.id].name + ' · 错误信息' }
        ])
      ]
    case 'condition':
      return [{ key: 'matched', label: '条件是否满足' }]
    case 'http':
      return [
        { key: 'status', label: 'HTTP 状态码' },
        { key: 'body', label: '响应内容' },
        { key: 'headers', label: '响应头' }
      ]
    case 'httpPoll':
      return [
        { key: 'previous', label: '旧值' },
        { key: 'value', label: '新值' },
        { key: 'status', label: 'HTTP 状态码' },
        { key: 'triggeredAt', label: '检测时间' }
      ]
    case 'fileWatch':
      return [
        { key: 'event', label: '文件事件' },
        { key: 'path', label: '路径' },
        { key: 'isDirectory', label: '是否目录' },
        { key: 'triggeredAt', label: '触发时间' }
      ]
    case 'system':
      return [
        { key: 'event', label: '系统事件' },
        { key: 'state', label: '状态' },
        { key: 'appId', label: '应用标识' },
        { key: 'triggeredAt', label: '触发时间' }
      ]
    case 'fileRead':
      return [
        { key: 'path', label: '文件路径' },
        { key: 'content', label: '文件内容' }
      ]
    case 'fileWrite':
      return [
        { key: 'path', label: '文件路径' },
        { key: 'bytes', label: '写入字节数' }
      ]
    case 'llm':
      return [{ key: 'value', label: '模型输出' }]
    case 'delay':
      return [{ key: 'seconds', label: '等待秒数' }]
    case 'data':
      return [{ key: 'value', label: '数据值' }]
    case 'notification':
      return [{ key: 'sent', label: '通知是否已发送' }]
    default:
      return [{ key: 'triggeredAt', label: '触发时间' }]
  }
}

export function readField(outputs: Record<string, unknown>, path: string): unknown {
  let result: unknown = outputs
  for (const part of path.split('.')) {
    if (result === null || typeof result !== 'object' || !Object.hasOwn(result, part)) return undefined
    result = (result as Record<string, unknown>)[part]
  }
  return result
}

function requiredField(outputs: Record<string, unknown>, path: string): unknown {
  const value = readField(outputs, path)
  if (value === undefined) throw new Error('上游字段不存在：' + path)
  return value
}

export function renderTemplate(template: string, outputs: Record<string, unknown>): string {
  return replaceFieldRefs(template, (path) => {
    const value = requiredField(outputs, path)
    return typeof value === 'string' ? value : JSON.stringify(value)
  })
}

export function renderJson(value: unknown, outputs: Record<string, unknown>): unknown {
  if (typeof value === 'string') {
    const field = exactFieldRef(value)
    return field ? requiredField(outputs, field) : renderTemplate(value, outputs)
  }
  if (Array.isArray(value)) return value.map((item) => renderJson(item, outputs))
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, renderJson(item, outputs)]))
  }
  return value
}

export function evaluate(node: Rule, value: unknown): boolean {
  if (node.operator === 'exists') return value !== undefined && value !== null
  let expected: unknown = node.value
  try {
    expected = JSON.parse(node.value)
  } catch {
    /* 未加引号的文本按字符串比较 */
  }
  if (node.operator === 'eq') return value === expected
  if (node.operator === 'ne') return value !== expected
  if (node.operator === 'contains' || node.operator === 'startsWith' || node.operator === 'endsWith') {
    return (
      typeof value === 'string' &&
      value[node.operator === 'contains' ? 'includes' : node.operator](
        typeof expected === 'string' ? expected : node.value
      )
    )
  }
  if (typeof value !== 'number' || typeof expected !== 'number') return false
  switch (node.operator) {
    case 'gt':
      return value > expected
    case 'gte':
      return value >= expected
    case 'lt':
      return value < expected
    case 'lte':
      return value <= expected
  }
}
