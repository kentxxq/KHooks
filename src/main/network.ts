import { isIPv4 } from 'node:net'
import { JSONPath } from 'jsonpath-plus'
import { graphSchema, parseHttpUrl, sites, validateWorkflow, type Graph, type SiteConfig } from '../shared/workflow'
import type { IpSample, SiteResult } from '../shared/ipc'

export type Fetch = (url: string | URL, init?: RequestInit) => Promise<Response>

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
interval 需要 seconds（1 到 86400），输出 triggeredAt。
ip 需要 seconds 和 sites 数组。每个站点 {id,mode,path}，id 从 ${Object.keys(sites).join('/')} 选择。pconline 使用 json 和 $.ip，ipify 可用 text 或 json（$.ip），其他站点使用 text（path 为 ""）。输出 results（数组元素含 id 和 ip 或 error）、distinctIpCount、votes、winnerIp、winnerVotes、previousIp、checkedAt。
condition 需要 field（节点ID.字段，例如 trigger.distinctIpCount）、operator（eq/ne/gt/gte/lt/lte/exists）、value（比较值写成字符串），输出 matched。
http 需要 method（GET/POST/PUT/PATCH/DELETE/HEAD）、url、headers（{name,value} 数组）、body（JSON 字符串或空字符串），输出 status。URL、请求头值和 JSON 字符串值可引用 {{节点ID.字段}}。未知目标地址用 https://fake_url，敏感值用 REPLACE_ME。
delay 需要 seconds（1 到 86400），等待后输出 seconds。
data 需要 value（有效的 JSON 字符串，字符串值可引用 {{节点ID.字段}}），输出 value。
notification 需要 title 和 body（字符串，可引用 {{节点ID.字段}}，title 不可为空），输出 sent。
连线 {id,from,to,port}，普通出口使用 next，条件出口使用 yes 或 no。每个出口可以连接多个下游节点，条件节点只执行命中出口的全部连线。每条流程恰好一个触发器，其余节点各有一个入口且从触发器可达。禁止环路，仅引用上游节点。没有其他属性。`

type AiOptions = { url: string; model: string; key: string }

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
