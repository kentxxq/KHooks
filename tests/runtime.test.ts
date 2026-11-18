import { createServer, type Server, type RequestListener } from 'node:http'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { Engine } from '../src/main/engine'
import { generateGraph, probe, type Fetch } from '../src/main/network'
import { Storage } from '../src/main/storage'
import type { Workflow } from '../src/shared/workflow'

const servers: Server[] = []
const engines: Engine[] = []
const dirs: string[] = []

async function listen(handler: RequestListener): Promise<string> {
  const server = createServer(handler)
  servers.push(server)
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('测试服务未启动')
  return 'http://127.0.0.1:' + address.port
}

async function storageFile(): Promise<string> {
  await mkdir('debug', { recursive: true })
  const path = await mkdtemp(resolve('debug/tmpfile-AI-storage-'))
  dirs.push(path)
  return join(path, 'state.json')
}

afterEach(async () => {
  engines.forEach((engine) => engine.shutdown())
  await Promise.all(engines.splice(0).map((engine) => engine.drain()))
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((done) => {
    server.close(() => done())
    server.closeAllConnections()
  })))
  await Promise.all(dirs.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

const site = { id: 'ipify', mode: 'text', path: '' } as const

function workflow(base: string): Workflow {
  return {
    id: 'flow', name: 'IP 回调', enabled: false,
    nodes: [
      { id: 'ip', type: 'ip', x: 0, y: 0, sites: [site], seconds: 1 },
      { id: 'if', type: 'condition', x: 230, y: 0, field: 'ip.distinctIpCount', operator: 'eq', value: '1' },
      { id: 'send', type: 'http', x: 460, y: 0, url: base + '/call', method: 'POST', headers: [],
        body: '{"ip":"{{ip.winnerIp}}","count":"{{ip.distinctIpCount}}"}' },
      { id: 'other', type: 'http', x: 460, y: 150, url: base + '/other', method: 'GET', headers: [], body: '' }
    ],
    edges: [
      { id: 'start', from: 'ip', to: 'if', port: 'next' },
      { id: 'true', from: 'if', to: 'send', port: 'yes' },
      { id: 'false', from: 'if', to: 'other', port: 'no' }
    ]
  }
}

it('加载旧数据时替换搜狐、移除 CIP.CC 并停用无可用站点的流程', async () => {
  const file = await storageFile()
  const store = new Storage(file)
  const cip = { id: 'cip', mode: 'text', path: '' }
  const oldConfig = { type: 'ip', seconds: 1, sites: [site, { id: 'sohu', mode: 'text', path: '' }, cip] }
  const flow = workflow('https://fake_url')
  const previousIp = '203.0.113.10'
  await writeFile(file, JSON.stringify({
    ...store.state,
    workflows: [
      { ...flow, enabled: true, nodes: [{ ...flow.nodes[0], ...oldConfig }, ...flow.nodes.slice(1)] },
      { ...flow, id: 'cip-only', enabled: true, nodes: [{ ...flow.nodes[0], ...oldConfig, sites: [cip] }, ...flow.nodes.slice(1)] }
    ],
    components: [{ id: 'legacy', name: '旧触发器', config: oldConfig }],
    baselines: { [flow.id]: previousIp },
    samples: { [flow.id]: { winnerIp: previousIp } }
  }))

  await store.open()

  const expectedSites = [site, { id: 'kentxxq', mode: 'json', path: '$.ip' }]
  expect(store.state.workflows[0].nodes[0]).toMatchObject({ sites: expectedSites })
  expect(store.state.workflows[0].enabled).toBe(true)
  expect(store.state.workflows[1]).toMatchObject({ enabled: false })
  expect(store.state.workflows[1].nodes[0]).toMatchObject({ sites: [] })
  expect(store.state.components[0].config).toMatchObject({ sites: expectedSites })
  expect(store.state.baselines).not.toHaveProperty(flow.id)
  expect(store.state.samples).not.toHaveProperty(flow.id)
  expect(JSON.parse(await readFile(file, 'utf8'))).toEqual(store.state)
})

it('跨重启保留基线，首次不执行，同一变化只请求一次并记录命中的分支', async () => {
  let current = '203.0.113.10'
  let probes = 0
  const captures: { path?: string; body: unknown }[] = []
  const base = await listen(async (request, response) => {
    if (request.url === '/ip') {
      probes++
      response.end(current)
      return
    }
    const data: Buffer[] = []
    for await (const chunk of request) data.push(chunk)
    const body = Buffer.concat(data).toString()
    captures.push({ path: request.url, body: body ? JSON.parse(body) : null })
    response.statusCode = 204
    response.end()
  })
  const fetcher: Fetch = (url, init) => fetch(String(url).startsWith('https://api.ipify.org') ? base + '/ip' : url, init)
  const file = await storageFile()
  const first = new Storage(file)
  await first.open()
  const engine = new Engine(first, fetcher)
  engines.push(engine)
  await engine.save(workflow(base))
  await engine.enable('flow', true)
  await vi.waitFor(() => expect(first.state.baselines.flow).toBe(current))
  expect(first.state.runs).toHaveLength(0)
  expect(captures).toHaveLength(0)
  engine.shutdown()
  await engine.drain()

  current = '203.0.113.11'
  const reopened = new Storage(file)
  await reopened.open()
  const restarted = new Engine(reopened, fetcher)
  engines.push(restarted)
  restarted.start()
  await vi.waitFor(() => expect(reopened.state.runs[0]?.status).toBe('success'))
  expect(reopened.state.runs[0]).toMatchObject({ edges: ['start', 'true'], steps: [
    { nodeId: 'ip', output: { previousIp: '203.0.113.10', winnerIp: '203.0.113.11' } },
    { nodeId: 'if', output: { matched: true } }, { nodeId: 'send', output: { status: 204 } }
  ] })
  await vi.waitFor(() => expect(probes).toBeGreaterThanOrEqual(3), { timeout: 2500 })
  expect(captures).toEqual([{ path: '/call', body: { ip: current, count: 1 } }])
  expect(reopened.state.runs).toHaveLength(1)
  expect(JSON.parse(await readFile(file, 'utf8')).version).toBe(1)
})

it('站点超时独立失败，HTTP 非 2xx 的节点记录错误', async () => {
  const base = await listen((request, response) => {
    if (request.url === '/hold') return
    response.statusCode = 503
    response.end()
  })
  await expect(probe(site, (_, init) => fetch(base + '/hold', init), 35)).resolves.toEqual({ id: 'ipify', error: '站点请求超时' })
  const store = new Storage(await storageFile())
  await store.open()
  const engine = new Engine(store)
  engines.push(engine)
  await engine.save({
    id: 'manual', name: '手动请求', enabled: false,
    nodes: [
      { id: 'start', x: 0, y: 0, type: 'manual' },
      { id: 'send', x: 230, y: 0, type: 'http', method: 'GET', url: base, headers: [], body: '' }
    ],
    edges: [{ id: 'next', from: 'start', to: 'send', port: 'next' }]
  })
  await expect(engine.run('manual')).rejects.toThrow('请先启用流程')
  await engine.enable('manual', true)
  await engine.run('manual')
  expect(store.state.runs[0]).toMatchObject({ status: 'failed', steps: [{ nodeId: 'start' }, { nodeId: 'send', error: 'HTTP 503' }] })
})

it('OpenAI 兼容请求只提交模型、提示和节点约定，拒绝模型返回的非法图', async () => {
  const { name, nodes, edges } = workflow('https://fake_url')
  const valid = { name, nodes, edges }
  const captures: { path?: string; body: Record<string, unknown> }[] = []
  let value: unknown = valid
  const base = await listen(async (request, response) => {
    const parts: Buffer[] = []
    for await (const chunk of request) parts.push(chunk)
    captures.push({ path: request.url, body: JSON.parse(Buffer.concat(parts).toString()) })
    response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(value) } }] }))
  })
  const options = { url: base + '/v1', key: 'fake_key', model: 'fake_info' }
  await expect(generateGraph(options, '编排公网 IP 查询')).resolves.toEqual(valid)
  expect(captures[0].path).toBe('/v1/chat/completions')
  expect(captures[0].body).toMatchObject({
    model: 'fake_info', messages: [{ role: 'system' }, { role: 'user', content: '编排公网 IP 查询' }]
  })
  expect(Object.keys(captures[0].body).sort()).toEqual(['messages', 'model'])
  value = { ...valid, edges: [] }
  await expect(generateGraph(options, '编排公网 IP 查询')).rejects.toThrow('未通过校验')
})

it('定时流程命中否分支，停用后不再调度', async () => {
  const received: string[] = []
  const base = await listen((request, response) => {
    received.push(request.url ?? '')
    response.writeHead(204).end()
  })
  const store = new Storage(await storageFile())
  await store.open()
  const engine = new Engine(store)
  engines.push(engine)
  const flow = workflow(base)
  flow.nodes.splice(0, 2,
    { id: 'ip', type: 'interval', x: 0, y: 0, seconds: 1 },
    { id: 'if', type: 'condition', x: 230, y: 0, field: 'ip.triggeredAt', operator: 'eq', value: 'fake_info' })
  await engine.save(flow)
  await engine.enable(flow.id, true)
  expect(received).toEqual([])
  await vi.waitFor(() => expect(store.state.runs[0]?.status).toBe('success'), { timeout: 2500 })
  await engine.enable(flow.id, false)
  await engine.drain()
  expect(store.state.runs[0]).toMatchObject({ edges: ['start', 'false'], steps: [
    { nodeId: 'ip' }, { nodeId: 'if', output: { matched: false } }, { nodeId: 'other', output: { status: 204 } }
  ] })
  await new Promise((done) => setTimeout(done, 1100))
  expect(received).toEqual(['/other'])
})
