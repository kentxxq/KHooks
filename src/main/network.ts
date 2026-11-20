import { isIPv4 } from 'node:net'
import { isDeepStrictEqual } from 'node:util'
import { JSONPath } from 'jsonpath-plus'
import { graphSchema, parseHttpUrl, sites, validateWorkflow, type FlowNode, type Graph, type SiteConfig } from '../shared/workflow'
import type { IpSample, SiteResult } from '../shared/ipc'

export type Fetch = (url: string | URL, init?: RequestInit) => Promise<Response>
export const contentLimit = 256 * 1024

export class HttpError extends Error {
  constructor(readonly status: number) {
    super('HTTP ' + status)
  }
}

export async function fetchData(
  fetcher: Fetch, url: URL, init: RequestInit, signal: AbortSignal,
  options?: { detectJson?: boolean; onStatus?: (status: number) => void }
) {
  const timeout = AbortSignal.timeout(15000)
  let response: Response
  try {
    response = await fetcher(url, { ...init, signal: AbortSignal.any([timeout, signal]), redirect: 'manual' })
  } catch {
    signal.throwIfAborted()
    throw new Error(timeout.aborted ? 'HTTP 请求超时' : 'HTTP 请求失败')
  }
  options?.onStatus?.(response.status)
  if (!response.ok) {
    void response.body?.cancel().catch(() => {})
    throw new HttpError(response.status)
  }
  const headers = Object.fromEntries(Array.from(response.headers).filter(([name]) =>
    !/auth|cookie|token|secret|api[-_]?key/i.test(name)
  ))
  let raw: string
  try {
    raw = await readText(response, contentLimit)
  } catch (error) {
    signal.throwIfAborted()
    if (timeout.aborted) throw new Error('HTTP 请求超时')
    throw error
  }
  const media = response.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase()
  const json = media === 'application/json' || media?.endsWith('+json')
  let body: unknown = raw
  if (!raw && (init.method === 'HEAD' || response.status === 204 || response.status === 205)) body = null
  else if (json || options?.detectJson) {
    try { body = JSON.parse(raw) } catch {
      if (json) throw new Error('HTTP 响应不是有效的 JSON')
    }
  }
  return { status: response.status, headers, body }
}

type PollNode = Extract<FlowNode, { type: 'httpPoll' }>

export async function pollHttp(node: PollNode, fetcher: Fetch, signal: AbortSignal) {
  const { status, body } = await fetchData(fetcher, parseHttpUrl(node.url), {
    method: 'GET', cache: 'no-store', headers: new Headers(node.headers.map(({ name, value }) => [name, value]))
  }, signal, { detectJson: true })
  let value: unknown = body
  const path = node.jsonPath.trim()
  if (path && path !== '$') {
    const result = JSONPath<unknown[]>({ path, json: body as string | number | boolean | object | null, eval: false, wrap: true })
    if (result.length !== 1 || result[0] === undefined) throw new Error('JSONPath 必须匹配一个值')
    value = result[0]
  }
  return { status, value: JSON.parse(JSON.stringify(value)) as unknown, triggeredAt: new Date().toISOString() }
}

export function samePollValue(previous: unknown, value: unknown): boolean {
  return isDeepStrictEqual(previous, value)
}

export async function readText(response: Response, limit: number): Promise<string> {
  const reader = response.body?.getReader()
  if (!reader) return ''
  const decoder = new TextDecoder()
  let size = 0
  let text = ''
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) return text + decoder.decode()
      size += value.byteLength
      if (size > limit) throw new Error('响应内容过大')
      text += decoder.decode(value, { stream: true })
    }
  } finally {
    void reader.cancel().catch(() => {})
  }
}

export function parseIp(source: string, config: SiteConfig): string {
  const site = sites[config.id]
  let value: unknown = source.trim()
  if (config.mode === 'json') {
    let matches: unknown[]
    try {
      if (!config.path.trim().startsWith('$')) throw new Error()
      matches = JSONPath<unknown[]>({ path: config.path.trim(), json: JSON.parse(source), eval: false, wrap: true })
    } catch {
      throw new Error('响应不是有效 JSON，或 JSONPath 无法解析')
    }
    if (matches.length !== 1) throw new Error('JSONPath 必须匹配一个值')
    value = matches[0]
  } else if ('ipPattern' in site) {
    value = site.ipPattern.exec(source.trim())?.[1]
  }
  if (typeof value !== 'string' || !isIPv4(value.trim())) throw new Error('站点未返回有效 IPv4')
  return value.trim()
}

export async function probe(config: SiteConfig, fetcher: Fetch = fetch, timeout = 5000): Promise<SiteResult> {
  const site = sites[config.id]
  const url = 'json' in site && (config.mode === 'json' || !('text' in site)) ? site.json : site.text
  const signal = AbortSignal.timeout(timeout)
  try {
    const response = await fetcher(url, { signal, redirect: 'error', cache: 'no-store' })
    if (!response.ok) {
      void response.body?.cancel().catch(() => {})
      return { id: config.id, error: 'HTTP ' + response.status }
    }
    const content = await readText(response, 8192)
    try {
      return { id: config.id, ip: parseIp(content, config) }
    } catch (error) {
      return { id: config.id, error: (error as Error).message }
    }
  } catch {
    return { id: config.id, error: signal.aborted ? '站点请求超时' : '无法读取站点响应' }
  }
}

export function tally(results: SiteResult[], previousIp: string | null, checkedAt: string): IpSample {
  const votes: Record<string, number> = {}
  for (const result of results) {
    if (result.ip) votes[result.ip] = (votes[result.ip] ?? 0) + 1
  }
  const count = Object.keys(votes).length
  const winnerVotes = Math.max(0, ...Object.values(votes))
  const winners = Object.keys(votes).filter((ip) => votes[ip] === winnerVotes)
  return {
    results, distinctIpCount: count, votes, winnerIp: winners.length === 1 ? winners[0] : null,
    winnerVotes, previousIp, checkedAt
  }
}

const aiInstruction = `把用户请求转成一个 JSON 对象，格式为 {name,nodes,edges}。只返回 JSON。节点通用字段 {id,type,x,y}，id 用英文数字或连字符，x、y 为画布坐标且节点间隔至少 240 像素。节点类型：
manual 无其他参数，输出 triggeredAt。
interval 需要 seconds（1 到 86400）；可选 clock {time:"HH:mm",days?}，不填 days 表示每天，days 由 0（周日）到 6（周六）的数字组成。输出 triggeredAt。
ip 需要 seconds 和 sites 数组。每个站点 {id,mode,path}，id 从 ${Object.keys(sites).join('/')} 选择。pconline 和 kentxxq 使用 json 和 $.ip，ipify 可用 text 或 json（$.ip），其他站点使用 text（path 为 ""）。输出 results（数组元素含 id 和 ip 或 error）、distinctIpCount、votes、winnerIp、winnerVotes、previousIp、checkedAt。
fileWatch 需要 path（绝对路径，如 C:/fake_info）、target（file/directory）、events（added/changed/removed 数组），输出 event、path、isDirectory、triggeredAt。
httpPoll 需要 url、headers（{name,value} 数组）、seconds、jsonPath（可为空），输出 previous、value、status、triggeredAt。
system 需要 events（playing/stopped/offline/online/screenOff/screenOn 数组），输出 event、state、appId（媒体事件）、triggeredAt。
condition 需要 field（节点ID.字段，例如 trigger.distinctIpCount）、operator（eq/ne/gt/gte/lt/lte/exists/contains/startsWith/endsWith）、value（比较值写成字符串）。组合条件另加 group {match:"all" 或 "any",rules:[{field,operator,value}]}。输出 matched。
http 需要 method（GET/POST/PUT/PATCH/DELETE/HEAD）、url、headers（{name,value} 数组）、body（JSON 字符串或空字符串），输出 status、body、headers。URL、请求头值和 JSON 字符串值可引用 {{节点ID.字段}}。未知目标地址用 https://fake_url，敏感值用 REPLACE_ME。
delay 需要 seconds（1 到 86400），等待后输出 seconds。
data 需要 value（有效的 JSON 字符串，字符串值可引用 {{节点ID.字段}}）；可选 mapping（{key,value,convert} 数组，value 为字符串模板，convert 为 keep/text/number/boolean），输出 value。
notification 需要 title 和 body（字符串，可引用 {{节点ID.字段}}，title 不可为空），输出 sent。
fileRead、fileWrite 需要 path（绝对路径或 {{节点ID.字段}}）、format（text/json）；fileWrite 另需 content（文本模板或含模板的 JSON 字符串）。fileRead 输出 path、content，fileWrite 输出 path、bytes。
llm 需要 system（可为空）、prompt、format（text/json）；提示支持字段引用，输出 value。
处理节点可选 retry {count,seconds}（额外重试 1 到 3 次，固定间隔秒数）。
连线 {id,from,to,port}，普通出口用 next，条件出口用 yes 或 no，处理节点失败出口用 error，下游可引用 节点ID.error.message、节点ID.error.attempts，HTTP 状态失败还会输出 节点ID.error.status。每个出口可以连接多个下游节点。每条流程恰好一个触发器，其余节点各有一个入口且从触发器可达。禁止环路，仅引用上游节点。没有其他属性。`

export type AiOptions = { url: string; model: string; key: string }

async function requestCompletion(
  options: AiOptions,
  messages: { role: 'system' | 'user'; content: string }[],
  fetcher: Fetch,
  signal: AbortSignal
): Promise<Response> {
  const url = parseHttpUrl(options.url)
  url.pathname = url.pathname.replace(/\/+$/, '') + '/chat/completions'
  let response: Response
  try {
    response = await fetcher(url, {
      method: 'POST', redirect: 'error', signal,
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + options.key },
      body: JSON.stringify({ model: options.model, messages })
    })
  } catch {
    throw new Error(signal.aborted ? 'AI 请求超时' : '无法连接 AI 服务')
  }
  if (!response.ok) {
    void response.body?.cancel().catch(() => {})
    throw new Error('AI 服务返回 HTTP ' + response.status)
  }
  return response
}

export async function testAiService(options: AiOptions, fetcher: Fetch): Promise<void> {
  const signal = AbortSignal.timeout(45000)
  const response = await requestCompletion(options, [{ role: 'user', content: '请只回复 OK。' }], fetcher, signal)
  try {
    const payload = JSON.parse(await readText(response, 256_000))
    const content = payload?.choices?.[0]?.message?.content
    if (typeof content !== 'string' || !content.trim()) throw new Error()
  } catch {
    throw new Error(signal.aborted ? 'AI 请求超时' : 'AI 服务返回的对话响应格式无效')
  }
}

export async function runLlm(options: AiOptions, system: string, prompt: string, format: 'text' | 'json', fetcher: Fetch, signal: AbortSignal) {
  const messages: Parameters<typeof requestCompletion>[1] = []
  if (system.trim()) messages.push({ role: 'system', content: system })
  if (format === 'json') messages.push({ role: 'system', content: '只返回一个有效的 JSON 值。' })
  messages.push({ role: 'user', content: prompt })
  const timeout = AbortSignal.timeout(45000)
  const response = await requestCompletion(options, messages, fetcher, AbortSignal.any([signal, timeout]))
  let content: unknown
  try { content = JSON.parse(await readText(response, contentLimit))?.choices?.[0]?.message?.content } catch {
    signal.throwIfAborted()
    throw new Error(timeout.aborted ? 'AI 请求超时' : '无法读取 AI 服务响应')
  }
  if (typeof content !== 'string') throw new Error('AI 服务返回的对话响应格式无效')
  if (format === 'text') return content
  try { return JSON.parse(content) as unknown } catch { throw new Error('模型输出不是有效的 JSON') }
}

export async function generateGraph(options: AiOptions, prompt: string, fetcher: Fetch = fetch): Promise<Graph> {
  const response = await requestCompletion(options, [
    { role: 'system', content: aiInstruction }, { role: 'user', content: prompt }
  ], fetcher, AbortSignal.timeout(45000))
  let graph: Graph
  try {
    const payload = JSON.parse(await readText(response, 256_000))
    const content = payload.choices[0].message.content as string
    const raw = content.trim().replace(/^\x60\x60\x60(?:json)?\s*([\s\S]*?)\s*\x60\x60\x60$/i, '$1')
    graph = graphSchema.parse(JSON.parse(raw))
  } catch {
    throw new Error('AI 返回的流程格式无效')
  }
  const error = validateWorkflow(graph)
  if (error) throw new Error('AI 流程未通过校验：' + error)
  return graph
}
