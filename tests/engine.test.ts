import { readFile, writeFile } from 'node:fs/promises'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Storage } from '../src/main/storage'
import type { Run } from '../src/shared/ipc'
import type { FlowEdge, FlowNode } from '../src/shared/workflow'
import {
  cleanupResources, createEngine, createStore, jsonResponse, llmResponse, storageFile, stubFetch, tempDir,
  waitForRun, workflow
} from './helpers'

afterEach(cleanupResources)

function manualChain(seconds = 1, extra: { retry?: { count: number; seconds: number } } = {}) {
  const nodes: FlowNode[] = [
    { id: 'start', type: 'manual', x: 0, y: 0 },
    { id: 'wait', type: 'delay', x: 230, y: 0, seconds, ...extra }
  ]
  const edges: FlowEdge[] = [{ id: 'next', from: 'start', to: 'wait', port: 'next' }]
  return { nodes, edges }
}

describe('忙碌策略', () => {
  it('skip：执行中拒绝手动运行', async () => {
    const { store } = await createStore()
    const engine = createEngine({ store })
    const { nodes, edges } = manualChain()
    await engine.save(workflow('flow', nodes, edges, { busyPolicy: 'skip' }))
    const first = engine.run('flow', undefined, 'saved')
    await expect(engine.run('flow', undefined, 'saved')).rejects.toThrow('流程正在执行')
    await first
    expect(store.state.runs[0].status).toBe('success')
  })

  it('queue：任务持久入队并串行执行', async () => {
    const { store } = await createStore()
    const engine = createEngine({ store })
    const { nodes, edges } = manualChain()
    await engine.save(workflow('flow', nodes, edges, { busyPolicy: 'queue' }))
    await engine.run('flow', undefined, 'saved')
    await engine.run('flow', undefined, 'saved')
    await engine.drain()
    expect(store.state.runs).toHaveLength(2)
    expect(store.state.runs.every((run) => run.status === 'success')).toBe(true)
    expect(store.state.queue).toEqual([])
  })

  it('queue：同一流程最多保留 50 条待处理任务', async () => {
    const { store } = await createStore()
    const engine = createEngine({ store })
    const { nodes, edges } = manualChain(86400)
    await engine.save(workflow('flow', nodes, edges, { busyPolicy: 'queue' }))
    for (let index = 0; index < 50; index++) await engine.run('flow', undefined, 'saved')
    expect(store.state.queue).toHaveLength(50)
    await expect(engine.run('flow', undefined, 'saved')).rejects.toThrow('排队任务已达上限')
  })

  it('latest：中断当前运行并标记为取消', async () => {
    const { store } = await createStore()
    const engine = createEngine({ store })
    const { nodes, edges } = manualChain(86400)
    await engine.save(workflow('flow', nodes, edges, { busyPolicy: 'latest' }))
    await engine.run('flow', undefined, 'saved')
    await vi.waitFor(() => expect(store.state.runs[0]?.status).toBe('running'))
    await engine.run('flow', undefined, 'saved')
    await vi.waitFor(() => expect(store.state.runs.some((run) => run.status === 'cancelled')).toBe(true))
    const cancelled = store.state.runs.find((run) => run.status === 'cancelled')!
    expect(cancelled.steps.at(-1)).toMatchObject({ error: '已被新事件中断' })
  })
})

describe('重试与失败出口', () => {
  it('按 retry 次数重试并记录 attempts', async () => {
    let calls = 0
    const fetcher = stubFetch(() => (++calls < 3 ? new Response(null, { status: 503 }) : new Response(null, { status: 204 })))
    const { store } = await createStore()
    const engine = createEngine({ store, fetcher })
    const nodes: FlowNode[] = [
      { id: 'start', type: 'manual', x: 0, y: 0 },
      { id: 'send', type: 'http', x: 230, y: 0, method: 'GET', url: 'https://fake_url/x', headers: [], body: '', retry: { count: 2, seconds: 1 } }
    ]
    await engine.save(workflow('flow', nodes, [{ id: 'next', from: 'start', to: 'send', port: 'next' }]))
    await engine.run('flow', undefined, 'saved')
    expect(store.state.runs[0]).toMatchObject({
      status: 'success',
      steps: [{ nodeId: 'start' }, { nodeId: 'send', attempts: 3, output: { status: 204 } }]
    })
  })

  it('未连接失败出口时整次运行失败', async () => {
    const fetcher = stubFetch(() => new Response(null, { status: 503 }))
    const { store } = await createStore()
    const engine = createEngine({ store, fetcher })
    const nodes: FlowNode[] = [
      { id: 'start', type: 'manual', x: 0, y: 0 },
      { id: 'send', type: 'http', x: 230, y: 0, method: 'GET', url: 'https://fake_url/x', headers: [], body: '' }
    ]
    await engine.save(workflow('flow', nodes, [{ id: 'next', from: 'start', to: 'send', port: 'next' }]))
    await engine.run('flow', undefined, 'saved')
    expect(store.state.runs[0]).toMatchObject({
      status: 'failed',
      steps: [{}, { nodeId: 'send', error: 'HTTP 503', attempts: 1 }]
    })
    // 失败的节点不写 output，错误对象只提供给下游分支引用。
    expect(store.state.runs[0].steps[1].output).toBeUndefined()
  })

  it('连接失败出口后继续执行并暴露错误字段', async () => {
    const fetcher = stubFetch(() => new Response(null, { status: 503 }))
    const { store } = await createStore()
    const engine = createEngine({ store, fetcher })
    const nodes: FlowNode[] = [
      { id: 'start', type: 'manual', x: 0, y: 0 },
      { id: 'send', type: 'http', x: 230, y: 0, method: 'GET', url: 'https://fake_url/x', headers: [], body: '' },
      {
        id: 'fallback', type: 'data', x: 460, y: 0,
        value: '{"message":"{{send.error.message}}","status":"{{send.error.status}}"}'
      }
    ]
    const edges: FlowEdge[] = [
      { id: 'next', from: 'start', to: 'send', port: 'next' },
      { id: 'fail', from: 'send', to: 'fallback', port: 'error' }
    ]
    await engine.save(workflow('flow', nodes, edges))
    await engine.run('flow', undefined, 'saved')
    expect(store.state.runs[0]).toMatchObject({
      status: 'success', edges: ['next', 'fail'],
      steps: [{}, { nodeId: 'send', error: 'HTTP 503' },
        { nodeId: 'fallback', output: { value: { message: 'HTTP 503', status: 503 } } }]
    })
  })
})

describe('运行记录', () => {
  it('快照脱敏 HTTP 请求，步骤只保留状态且下游仍可引用完整响应', async () => {
    const fetcher = stubFetch(() => jsonResponse({ secret: 'fake_secret' }))
    const { store } = await createStore()
    const engine = createEngine({ store, fetcher })
    const nodes: FlowNode[] = [
      { id: 'start', type: 'manual', x: 0, y: 0 },
      {
        id: 'send', type: 'http', x: 230, y: 0, method: 'POST', url: 'https://fake_url/secret',
        headers: [{ name: 'Authorization', value: 'Bearer fake_key' }], body: '{"token":"fake_secret"}'
      },
      { id: 'set', type: 'data', x: 460, y: 0, value: '{"body":"{{send.body}}","type":"{{send.headers.content-type}}"}' }
    ]
    const edges: FlowEdge[] = [
      { id: 'next', from: 'start', to: 'send', port: 'next' },
      { id: 'done', from: 'send', to: 'set', port: 'next' }
    ]
    await engine.save(workflow('flow', nodes, edges))
    await engine.run('flow', undefined, 'saved')
    const run = store.state.runs[0]
    expect(run.workflow.nodes[1]).toMatchObject({ type: 'http', url: '', headers: [], body: '' })
    expect(run.steps[1]).toMatchObject({ output: { status: 200 } })
    expect(run.steps[1].startedAt).toEqual(expect.any(String))
    expect(run.steps[1].finishedAt).toEqual(expect.any(String))
    expect(run.steps[1].details).toEqual({ method: 'POST', host: 'fake_url', status: 200 })
    expect(run.steps[2].output).toEqual({ value: { body: { secret: 'fake_secret' }, type: 'application/json' } })
    expect(JSON.stringify(run.workflow)).not.toContain('fake_secret')
    expect(JSON.stringify(run.workflow)).not.toContain('fake_key')
  })

  it('快照清空通知、模型提示与文件写入内容', async () => {
    const fetcher = stubFetch(() => llmResponse('hello'))
    const { store } = await createStore()
    const notify = vi.fn()
    const dir = await tempDir('node-')
    const engine = createEngine({
      store, fetcher,
      notify,
      ai: () => ({ url: 'https://fake_url/v1', model: 'fake_info', key: 'fake_key' })
    })
    const nodes: FlowNode[] = [
      { id: 'start', type: 'manual', x: 0, y: 0 },
      { id: 'notify', type: 'notification', x: 230, y: 0, title: '标题 {{start.triggeredAt}}', body: '正文 fake_info' },
      { id: 'llm', type: 'llm', x: 460, y: 0, system: '系统 fake_info', prompt: '提示 fake_info', format: 'text' },
      { id: 'save', type: 'fileWrite', x: 690, y: 0, path: dir + '/out.txt', format: 'text', content: 'fake_info {{llm.value}}' }
    ]
    const edges: FlowEdge[] = [
      { id: 'a', from: 'start', to: 'notify', port: 'next' },
      { id: 'b', from: 'notify', to: 'llm', port: 'next' },
      { id: 'c', from: 'llm', to: 'save', port: 'next' }
    ]
    await engine.save(workflow('flow', nodes, edges))
    await engine.run('flow', undefined, 'saved')
    const run = store.state.runs[0]
    expect(run.workflow.nodes[1]).toMatchObject({ type: 'notification', title: '', body: '' })
    expect(run.workflow.nodes[2]).toMatchObject({ type: 'llm', system: '', prompt: '' })
    expect(run.workflow.nodes[3]).toMatchObject({ type: 'fileWrite', content: '' })
    expect(run.steps[1].notification).toMatchObject({ body: '正文 fake_info' })
    expect(run.steps[2].output).toEqual({ format: 'text' })
    expect(notify).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(run.workflow)).not.toContain('fake_info')
  })

  it('运行记录最多保留 100 条', async () => {
    const { store } = await createStore()
    const engine = createEngine({ store })
    const { nodes, edges } = manualChain(1)
    const flow = workflow('flow', nodes, edges)
    await engine.save(flow)
    const old = (index: number): Run => ({
      id: 'old-' + index, workflowId: 'flow', name: '旧记录', startedAt: '', finishedAt: '',
      status: 'success', steps: [], edges: [], workflow: flow
    })
    store.state.runs = Array.from({ length: 100 }, (_, index) => old(index))
    await engine.run('flow', undefined, 'saved')
    expect(store.state.runs).toHaveLength(100)
    expect(store.state.runs[0].taskId).toEqual(expect.any(String))
    expect(store.state.runs.some((run) => run.id === 'old-99')).toBe(false)
  })
})

describe('本地数据', () => {
  it('跳过损坏的流程、组件和排队任务并继续启动', async () => {
    const file = await storageFile()
    const initial = new Storage(file)
    await initial.open()
    const { nodes, edges } = manualChain(1)
    const good = workflow('good', nodes, edges, { name: '好流程' })
    const brokenNodes = [{ id: 'start', type: 'unknown' }]
    await writeFile(file, JSON.stringify({
      ...initial.state,
      workflows: [good, { ...good, id: 'bad', name: '坏流程', nodes: brokenNodes }],
      components: [{ id: 'c1', name: '坏组件', config: { type: 'unknown' } }],
      queue: [{ id: 'q1', flow: { ...good, id: 'bad2', nodes: brokenNodes }, payload: {} }]
    }))
    const messages: string[] = []
    const store = new Storage(file, undefined, (message) => messages.push(message))
    await store.open()
    expect(store.state.workflows.map((flow) => flow.id)).toEqual(['good'])
    expect(store.state.components).toEqual([])
    expect(store.state.queue).toEqual([])
    expect(messages).toHaveLength(3)
    expect(messages[0]).toContain('「坏流程」')
    expect(messages[2]).toContain('已丢弃')
  })

  it('启动时把进行中的运行标记为中断并清理排队任务的运行关联', async () => {
    const file = await storageFile()
    const initial = new Storage(file)
    await initial.open()
    const { nodes, edges } = manualChain(1)
    const flow = workflow('flow', nodes, edges)
    const running: Run = {
      id: 'run-1', workflowId: 'flow', name: '运行中', startedAt: '', finishedAt: null,
      status: 'running', steps: [], edges: [], workflow: flow
    }
    await writeFile(file, JSON.stringify({
      ...initial.state,
      workflows: [flow],
      queue: [{ id: 'task', flow, payload: {}, allowDisabled: false, runId: 'run-1' }],
      runs: [running]
    }))
    const store = new Storage(file)
    await store.open()
    expect(store.state.runs[0]).toMatchObject({ status: 'interrupted', finishedAt: expect.any(String) })
    expect(store.state.queue[0].runId).toBeUndefined()
    const raw = JSON.parse(await readFile(file, 'utf8')) as { runs: Run[]; queue: { runId?: string }[] }
    expect(raw.runs[0].status).toBe('interrupted')
    expect(raw.queue[0].runId).toBeUndefined()
  })

  it('重启后恢复持久排队任务并沿用原触发来源', async () => {
    const file = await storageFile()
    const { nodes, edges } = manualChain(1)
    const flow = workflow('flow', nodes, edges)
    const initial = new Storage(file)
    await initial.open()
    await writeFile(file, JSON.stringify({
      ...initial.state,
      workflows: [{ ...flow, enabled: true }],
      queue: [{ id: 'task', flow, payload: { triggeredAt: '2026-11-20T00:00:00.000Z' }, allowDisabled: false, source: 'automatic' }]
    }))
    const store = new Storage(file)
    await store.open()
    const engine = createEngine({ store })
    engine.start()
    const run = await waitForRun(store)
    expect(run).toMatchObject({ source: 'automatic', status: 'success', taskId: 'task' })
    expect(store.state.queue).toEqual([])
  })
})
