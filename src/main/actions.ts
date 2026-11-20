import { open, stat } from 'node:fs/promises'
import { isAbsolute, normalize } from 'node:path'
import { setTimeout as wait } from 'node:timers/promises'
import writeFileAtomic from 'write-file-atomic'
import type { RunStep } from '../shared/ipc'
import { evaluate, parseHttpUrl, readField, renderJson, renderTemplate, type FlowNode } from '../shared/workflow'
import { contentLimit, fetchData, runLlm, type AiOptions, type Fetch } from './network'

type Action = Exclude<FlowNode, { type: 'manual' | 'interval' | 'ip' | 'fileWatch' | 'httpPoll' | 'system' }>
type Outputs = Record<string, unknown>

function convert(value: unknown, mode: 'keep' | 'text' | 'number' | 'boolean'): unknown {
  switch (mode) {
    case 'keep': return value
    case 'text': return typeof value === 'string' ? value : JSON.stringify(value)
    case 'number': {
      if (typeof value === 'number' && Number.isFinite(value)) return value
      if (typeof value === 'boolean') return Number(value)
      if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value)
      throw new Error('无法转换为数字')
    }
    case 'boolean':
      if (typeof value === 'boolean') return value
      if (value === 1 || value === '1' || value === 'true') return true
      if (value === 0 || value === '0' || value === 'false') return false
      throw new Error('无法转换为布尔值')
  }
}

async function readLocalFile(path: string, signal: AbortSignal): Promise<string> {
  if (!(await stat(path)).isFile()) throw new Error('请选择普通文件')
  const file = await open(path, 'r')
  try {
    if (!(await file.stat()).isFile()) throw new Error('请选择普通文件')
    const buffer = Buffer.alloc(contentLimit + 1)
    let size = 0
    while (size < buffer.length) {
      signal.throwIfAborted()
      const { bytesRead } = await file.read(buffer, size, buffer.length - size, size)
      if (bytesRead === 0) break
      size += bytesRead
    }
    if (size > contentLimit) throw new Error('文件内容超过 256 KB')
    return buffer.toString('utf8', 0, size)
  } finally {
    await file.close()
  }
}

export async function executeAction(
  node: Action, outputs: Outputs, signal: AbortSignal,
  services: { fetcher: Fetch; ai: () => AiOptions; notify: (title: string, body: string) => void },
  trace: Pick<RunStep, 'details' | 'notification'>
): Promise<unknown> {
  switch (node.type) {
    case 'condition': {
      const matches = (rule: Parameters<typeof evaluate>[0]) => evaluate(rule, readField(outputs, rule.field))
      const rules = node.group?.rules ?? [node]
      return { matched: node.group?.match === 'any' ? rules.some(matches) : rules.every(matches) }
    }
    case 'http': {
      const details: NonNullable<RunStep['details']> = { method: node.method }
      trace.details = details
      let url: URL
      try { url = parseHttpUrl(renderTemplate(node.url, outputs)) } catch { throw new Error('HTTP 请求地址无效') }
      details.host = url.host
      let headers: Headers
      try {
        headers = new Headers(node.headers.map(({ name, value }) => [name, renderTemplate(value, outputs)]))
      } catch { throw new Error('HTTP 请求头无效') }
      let body: string | undefined
      if (node.body && node.method !== 'GET' && node.method !== 'HEAD') {
        body = JSON.stringify(renderJson(JSON.parse(node.body), outputs))
        if (!headers.has('Content-Type')) headers.set('Content-Type', 'application/json')
      }
      return fetchData(services.fetcher, url, { method: node.method, headers, body }, signal, {
        onStatus: (status) => { details.status = status }
      })
    }
    case 'data':
      return { value: node.mapping ? Object.fromEntries(node.mapping.map((field) => [
        field.key.trim(), convert(renderJson(field.value, outputs), field.convert)
      ])) : renderJson(JSON.parse(node.value), outputs) }
    case 'notification': {
      delete trace.notification
      const title = renderTemplate(node.title, outputs)
      if (!title.trim()) throw new Error('通知标题为空')
      const body = renderTemplate(node.body, outputs)
      trace.notification = { title, body }
      services.notify(title, body)
      return { sent: true }
    }
    case 'fileRead':
    case 'fileWrite': {
      const details: NonNullable<RunStep['details']> = { format: node.format }
      trace.details = details
      const rawPath = renderTemplate(node.path.trim(), outputs)
      if (!isAbsolute(rawPath) || /^\\\\[?.]\\/.test(rawPath)) throw new Error('文件路径无效')
      const path = normalize(rawPath)
      details.path = path
      if (node.type === 'fileRead') {
        const content = await readLocalFile(path, signal)
        return { path, content: node.format === 'json' ? parseFileJson(content.replace(/^\uFEFF/, '')) : content }
      }
      const value = node.format === 'json'
        ? JSON.stringify(renderJson(parseFileJson(node.content), outputs))
        : renderTemplate(node.content, outputs)
      const bytes = Buffer.byteLength(value)
      if (bytes > contentLimit) throw new Error('文件内容超过 256 KB')
      signal.throwIfAborted()
      try { await writeFileAtomic(path, value, { encoding: 'utf8' }) } catch { throw new Error('无法写入文件') }
      return { path, bytes }
    }
    case 'llm': {
      const details: NonNullable<RunStep['details']> = { format: node.format }
      trace.details = details
      const prompt = renderTemplate(node.prompt, outputs)
      if (!prompt.trim()) throw new Error('用户提示为空')
      const ai = services.ai()
      details.model = ai.model
      return { value: await runLlm(ai, renderTemplate(node.system, outputs), prompt, node.format, services.fetcher, signal) }
    }
    case 'delay': {
      await wait(node.seconds * 1000, undefined, { signal })
      return { seconds: node.seconds }
    }
  }
}

function parseFileJson(value: string): unknown {
  try { return JSON.parse(value) } catch { throw new Error('文件内容不是有效的 JSON') }
}
