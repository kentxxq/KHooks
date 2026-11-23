import { createServer, type RequestListener, type Server } from 'node:http'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { expect, vi } from 'vitest'
import { Engine } from '../src/main/engine'
import type { AiOptions, Fetch } from '../src/main/network'
import { Storage } from '../src/main/storage'
import type { SystemEventSource } from '../src/main/windows-events'
import type { Run } from '../src/shared/ipc'
import type { FlowEdge, FlowNode, Workflow } from '../src/shared/workflow'

const servers: Server[] = []
const engines: Engine[] = []
const dirs: string[] = []

// 统一登记本地 HTTP 服务，afterEach 时一并关闭。
export async function listen(handler: RequestListener): Promise<string> {
  const server = createServer(handler)
  servers.push(server)
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('测试服务未启动')
  return 'http://127.0.0.1:' + address.port
}

// 临时目录统一放在被 gitignore 的 debug/ 下，并带可辨识前缀。
export async function tempDir(prefix: string): Promise<string> {
  await mkdir('debug', { recursive: true })
  const path = await mkdtemp(resolve('debug/tmpfile-AI-' + prefix))
  dirs.push(path)
  return path
}

export async function storageFile(prefix = 'storage-'): Promise<string> {
  return join(await tempDir(prefix), 'state.json')
}

export async function createStore(
  report: (message: string) => void = () => {}
): Promise<{ store: Storage; file: string }> {
  const file = await storageFile()
  const store = new Storage(file, undefined, report)
  await store.open()
  return { store, file }
}

export function workflow(
  id: string,
  nodes: FlowNode[],
  edges: FlowEdge[],
  extra: { name?: string; busyPolicy?: Workflow['busyPolicy'] } = {}
): Workflow {
  return { id, name: extra.name ?? '测试流程', enabled: false, nodes, edges, busyPolicy: extra.busyPolicy }
}

export function createEngine(options: {
  store: Storage
  fetcher?: Fetch
  report?: (message: string) => void
  notify?: (title: string, body: string) => void
  ai?: () => AiOptions
  system?: SystemEventSource
}): Engine {
  const engine = new Engine(options.store, options.fetcher, options.report, options.notify, options.ai, options.system)
  engines.push(engine)
  return engine
}

// 按 URL 返回预置响应，同时记录调用参数，供断言请求方法与正文。
export function stubFetch(
  route: (url: URL, init: RequestInit) => Response | Promise<Response>
): Fetch & { calls: { url: URL; init: RequestInit }[] } {
  const calls: { url: URL; init: RequestInit }[] = []
  const fetcher: Fetch = async (input, init = {}) => {
    const url = new URL(String(input))
    calls.push({ url, init })
    return route(url, init)
  }
  return Object.assign(fetcher, { calls })
}

export function jsonResponse(value: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(value), {
    ...init,
    headers: { 'content-type': 'application/json', ...(init.headers as Record<string, string> | undefined) }
  })
}

// OpenAI 兼容补全响应，只保留 runLlm 会读取的字段。
export function llmResponse(content: string): Response {
  return jsonResponse({ choices: [{ message: { content } }] })
}

type SystemEvent = Parameters<Parameters<SystemEventSource['subscribe']>[1]>[0]

// 可手动推送事件的 Windows 事件替身，替代真实子进程。
export function fakeSystem(): SystemEventSource & { emit(event: SystemEvent): void } {
  const listeners = new Set<Parameters<SystemEventSource['subscribe']>[1]>()
  return {
    subscribe(signal, listener) {
      listeners.add(listener)
      signal.addEventListener('abort', () => listeners.delete(listener), { once: true })
    },
    emit(event) {
      for (const listener of listeners) listener(event)
    }
  }
}

export async function waitForRun(store: Storage, index = 0, timeout = 8000): Promise<Run> {
  await vi.waitFor(() => expect(store.state.runs[index]).toBeDefined(), { timeout })
  await vi.waitFor(() => expect(store.state.runs[index].status).not.toBe('running'), { timeout })
  return store.state.runs[index]
}

export async function cleanupResources(): Promise<void> {
  const active = engines.splice(0)
  for (const engine of active) engine.shutdown()
  await Promise.allSettled(active.map((engine) => engine.drain()))
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((done) => {
    server.close(() => done())
    server.closeAllConnections()
  })))
  await Promise.all(dirs.splice(0).map((path) => rm(path, { recursive: true, force: true })))
}
