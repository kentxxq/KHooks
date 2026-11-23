import { EventEmitter } from 'node:events'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { watchFiles } from '../src/main/file-watch'
import { Storage } from '../src/main/storage'
import { WindowsEvents, eventSchema } from '../src/main/windows-events'
import type { FlowEdge, FlowNode } from '../src/shared/workflow'
import {
  cleanupResources, createEngine, createStore, fakeSystem, jsonResponse, listen, stubFetch, tempDir, waitForRun, workflow
} from './helpers'

const mocks = vi.hoisted(() => ({ spawn: vi.fn() }))
vi.mock('node:child_process', () => ({ spawn: mocks.spawn }))

afterEach(async () => {
  vi.useRealTimers()
  await cleanupResources()
})

function dataNode(id = 'set'): FlowNode {
  return { id, type: 'data', x: 230, y: 0, value: 'null' }
}

function chain(trigger: FlowNode, next: FlowNode = dataNode()): { nodes: FlowNode[]; edges: FlowEdge[] } {
  return { nodes: [trigger, next], edges: [{ id: 'next', from: trigger.id, to: next.id, port: 'next' }] }
}

const site = { id: 'ipify', mode: 'text', path: '' } as const

describe('manual 触发器', () => {
  it('区分 legacy、saved 与 preview 三种运行方式', async () => {
    const { store } = await createStore()
    const engine = createEngine({ store })
    const nodes: FlowNode[] = [
      { id: 'start', type: 'manual', x: 0, y: 0 },
      { id: 'set', type: 'data', x: 230, y: 0, value: '1' }
    ]
    const graph = { name: '手动', nodes, edges: [{ id: 'next', from: 'start', to: 'set', port: 'next' as const }] }
    await engine.save(workflow('flow', graph.nodes, graph.edges))

    await expect(engine.run('flow')).rejects.toThrow('请先启用流程')
    await engine.run('flow', undefined, 'saved')
    expect(store.state.runs[0]).toMatchObject({
      source: 'manual', status: 'success',
      steps: [{ nodeId: 'start', attempts: 1 }, { nodeId: 'set', output: { value: 1 } }]
    })

    const draft = {
      ...graph,
      nodes: nodes.map((node) => node.type === 'data' ? { ...node, value: '2' } : node)
    }
    await engine.run('flow', draft, 'preview')
    expect(store.state.runs[0]).toMatchObject({ source: 'preview', steps: [{}, { output: { value: 2 } }] })
    // 草稿试跑不写回已保存流程。
    expect(store.state.workflows[0].nodes[1]).toMatchObject({ value: '1' })

    await engine.enable('flow', true)
    await expect(engine.run('flow', draft, 'preview')).rejects.toThrow('请先停用流程')
  })

  it('文件监听的手动运行使用手动事件载荷', async () => {
    const { store } = await createStore()
    const engine = createEngine({ store })
    const dir = await tempDir('watch-')
    const graph = chain({
      id: 'watch', type: 'fileWatch', x: 0, y: 0, path: dir, target: 'directory', events: ['added']
    })
    await engine.save(workflow('flow', graph.nodes, graph.edges))
    await engine.run('flow', undefined, 'saved')
    expect(store.state.runs[0].steps[0]).toMatchObject({
      output: { event: 'manual', path: dir, isDirectory: true }
    })
  })
})

describe('interval 触发器', () => {
  it('按固定秒数自动运行', async () => {
    const { store } = await createStore()
    const engine = createEngine({ store })
    const graph = chain({ id: 'timer', type: 'interval', x: 0, y: 0, seconds: 1 })
    await engine.save(workflow('flow', graph.nodes, graph.edges))
    await engine.enable('flow', true)
    const run = await waitForRun(store)
    expect(run).toMatchObject({ source: 'automatic', status: 'success' })
    expect(run.steps[0].output).toMatchObject({ triggeredAt: expect.any(String) })
  })

  it('重启后再次跨入同一目标分钟时沿用持久去重记录', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
    const beforeTarget = new Date(2026, 10, 20, 9, 29, 59)
    vi.setSystemTime(beforeTarget)
    const { store, file } = await createStore()
    const engine = createEngine({ store })
    const graph = chain({ id: 'clock', type: 'interval', x: 0, y: 0, seconds: 60, clock: { time: '09:30' } })
    await engine.save(workflow('flow', graph.nodes, graph.edges))
    await engine.enable('flow', true)
    await vi.advanceTimersByTimeAsync(1000)
    await engine.drain()
    expect(store.state.runs).toMatchObject([{ source: 'automatic', status: 'success' }])
    engine.shutdown()

    vi.setSystemTime(beforeTarget)
    const reopened = new Storage(file)
    await reopened.open()
    expect(reopened.state.clockDates.flow).toEqual(['2026-11-20T09:30'])
    const restarted = createEngine({ store: reopened })
    restarted.start()
    await vi.advanceTimersByTimeAsync(1000)
    await restarted.drain()
    expect(reopened.state.runs).toHaveLength(1)
  })

  it('星期不匹配时不触发', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const start = new Date(2026, 10, 20, 9, 29, 59)
    vi.setSystemTime(start)
    const { store } = await createStore()
    const engine = createEngine({ store })
    const graph = chain({
      id: 'clock', type: 'interval', x: 0, y: 0, seconds: 60,
      clock: { time: '09:30', days: [(start.getDay() + 1) % 7] }
    })
    await engine.save(workflow('flow', graph.nodes, graph.edges))
    await engine.enable('flow', true)
    vi.setSystemTime(new Date(2026, 10, 20, 9, 30, 0, 200))
    await new Promise((done) => setTimeout(done, 1300))
    expect(store.state.runs).toHaveLength(0)
    expect(store.state.clockDates.flow).toBeUndefined()
  })
})

describe('ip 触发器', () => {
  it('多站点平票不产生运行，唯一最高票才更新基线', async () => {
    const { store } = await createStore()
    let ipify = '203.0.113.10'
    let aws = '203.0.113.11'
    const fetcher = stubFetch((url) => new Response(url.hostname === 'api.ipify.org' ? ipify : aws))
    const engine = createEngine({ store, fetcher })
    const graph = chain({
      id: 'ip', type: 'ip', x: 0, y: 0, seconds: 60,
      sites: [site, { id: 'aws', mode: 'text', path: '' }]
    })
    await engine.save(workflow('flow', graph.nodes, graph.edges))

    await engine.run('flow', undefined, 'saved')
    expect(store.state.runs[0].steps[0].output).toMatchObject({ winnerIp: null, distinctIpCount: 2 })
    expect(store.state.baselines).not.toHaveProperty('flow')

    aws = ipify
    await engine.run('flow', undefined, 'saved')
    expect(store.state.runs[0].steps[0].output).toMatchObject({ previousIp: null, winnerIp: ipify })
    expect(store.state.baselines.flow).toBe(ipify)

    ipify = '203.0.113.12'
    aws = ipify
    await engine.run('flow', undefined, 'saved')
    expect(store.state.runs[0].steps[0].output).toMatchObject({ previousIp: '203.0.113.10', winnerIp: ipify })
  })
})

describe('httpPoll 触发器', () => {
  it('首次只建基线，值变化才自动运行', async () => {
    let payload: unknown = { value: 1 }
    const base = await listen((_, response) => {
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify(payload))
    })
    const { store } = await createStore()
    const engine = createEngine({ store })
    const graph = chain(
      { id: 'poll', type: 'httpPoll', x: 0, y: 0, seconds: 1, url: base + '/value', headers: [], jsonPath: '$.value' },
      { id: 'set', type: 'data', x: 230, y: 0, value: '{"v":"{{poll.value}}","old":"{{poll.previous}}"}' }
    )
    await engine.save(workflow('flow', graph.nodes, graph.edges))
    await engine.enable('flow', true)
    await vi.waitFor(() => expect(store.state.pollBaselines.flow).toBe(1))
    expect(store.state.runs).toHaveLength(0)

    payload = { value: 2 }
    const run = await waitForRun(store)
    expect(run).toMatchObject({ source: 'automatic', steps: [{}, { output: { value: { v: 2, old: 1 } } }] })
    expect(store.state.pollBaselines.flow).toBe(2)

    await new Promise((done) => setTimeout(done, 1300))
    expect(store.state.runs).toHaveLength(1)
  })

  it('修改轮询地址后清空基线', async () => {
    const { store } = await createStore()
    const fetcher = stubFetch(() => jsonResponse({ v: 1 }))
    const engine = createEngine({ store, fetcher })
    const graph = chain({
      id: 'poll', type: 'httpPoll', x: 0, y: 0, seconds: 60,
      url: 'https://fake_url/v1', headers: [], jsonPath: '$.v'
    })
    const flow = workflow('flow', graph.nodes, graph.edges)
    await engine.save(flow)
    await engine.enable('flow', true)
    await vi.waitFor(() => expect(store.state.pollBaselines.flow).toBe(1))
    await engine.enable('flow', false)
    const changed = {
      ...flow,
      nodes: flow.nodes.map((node) => node.type === 'httpPoll' ? { ...node, url: 'https://fake_url/v2' } : node)
    }
    await engine.save(changed)
    expect(store.state.pollBaselines).not.toHaveProperty('flow')
  })
})

describe('fileWatch 触发器', () => {
  it('首次扫描不触发，之后区分新增、修改与删除', async () => {
    const dir = await tempDir('watch-')
    const file = join(dir, 'a.txt')
    await writeFile(file, 'one')
    const changes: { event: string; path: string; isDirectory: boolean }[] = []
    const controller = new AbortController()
    watchFiles({
      id: 'watch', type: 'fileWatch', x: 0, y: 0, path: dir, target: 'directory',
      events: ['added', 'changed', 'removed']
    }, controller.signal, (change) => changes.push(change), () => {})
    try {
      await new Promise((done) => setTimeout(done, 500))
      expect(changes).toEqual([])

      await writeFile(file, 'one changed')
      await vi.waitFor(() => expect(changes.map((item) => item.event)).toContain('changed'), { timeout: 3000 })
      expect(changes.find((item) => item.event === 'changed')).toMatchObject({ path: file, isDirectory: false })

      await new Promise((done) => setTimeout(done, 500))
      const added = join(dir, 'b.txt')
      await writeFile(added, 'two')
      await vi.waitFor(() => expect(changes.some((item) => item.event === 'added' && item.path === added)).toBe(true), { timeout: 3000 })

      await new Promise((done) => setTimeout(done, 500))
      await rm(file)
      await vi.waitFor(() => expect(changes.some((item) => item.event === 'removed' && item.path === file)).toBe(true), { timeout: 3000 })
    } finally {
      controller.abort()
    }
  })

  it('只上报配置的事件类型，并忽略子目录内部文件', async () => {
    const dir = await tempDir('watch-')
    const changes: { event: string; path: string; isDirectory: boolean }[] = []
    const controller = new AbortController()
    watchFiles({ id: 'watch', type: 'fileWatch', x: 0, y: 0, path: dir, target: 'directory', events: ['added'] },
      controller.signal, (change) => changes.push(change), () => {})
    try {
      await new Promise((done) => setTimeout(done, 500))
      const child = join(dir, 'child')
      await mkdir(child)
      await writeFile(join(child, 'inner.txt'), 'inner')
      await vi.waitFor(() => expect(changes.some((item) => item.event === 'added' && item.path === child)).toBe(true), { timeout: 3000 })
      expect(changes.every((item) => item.event === 'added')).toBe(true)
      await new Promise((done) => setTimeout(done, 800))
      // 目录模式只观察一层，子目录内部的变化不上报。
      expect(changes.some((item) => item.path === join(child, 'inner.txt'))).toBe(false)
    } finally {
      controller.abort()
    }
  })

  it('自动触发运行并标记为自动事件', async () => {
    const dir = await tempDir('watch-')
    const file = join(dir, 'a.txt')
    await writeFile(file, 'one')
    const { store } = await createStore()
    const engine = createEngine({ store })
    const graph = chain(
      { id: 'watch', type: 'fileWatch', x: 0, y: 0, path: dir, target: 'directory', events: ['changed'] },
      { id: 'set', type: 'data', x: 230, y: 0, value: '{"event":"{{watch.event}}"}' }
    )
    await engine.save(workflow('flow', graph.nodes, graph.edges))
    await engine.enable('flow', true)
    await new Promise((done) => setTimeout(done, 500))
    await writeFile(file, 'two')
    const run = await waitForRun(store)
    expect(run).toMatchObject({
      source: 'automatic', status: 'success',
      steps: [{ nodeId: 'watch', output: { event: 'changed', path: file } }, { nodeId: 'set', output: { value: { event: 'changed' } } }]
    })
  })
})

describe('system 触发器', () => {
  it('事件 schema 归一化 appId 并拒绝非法事件', () => {
    const base = { event: 'playing' as const, state: true, triggeredAt: '2026-11-20T00:00:00.000Z' }
    expect(eventSchema.parse(base)).toMatchObject({ appId: null })
    expect(eventSchema.parse({ ...base, appId: 'fake_info' })).toMatchObject({ appId: 'fake_info' })
    expect(() => eventSchema.parse({ ...base, event: 'offline', state: 'yes' })).toThrow()
  })

  it('按事件白名单过滤后自动运行', async () => {
    const system = fakeSystem()
    const { store } = await createStore()
    const engine = createEngine({ store, system })
    const graph = chain(
      { id: 'sys', type: 'system', x: 0, y: 0, events: ['playing'] },
      { id: 'set', type: 'data', x: 230, y: 0, value: '{"event":"{{sys.event}}","state":"{{sys.state}}"}' }
    )
    await engine.save(workflow('flow', graph.nodes, graph.edges))
    await engine.enable('flow', true)
    system.emit({ event: 'stopped', state: false, appId: null, triggeredAt: new Date().toISOString() })
    await new Promise((done) => setTimeout(done, 100))
    expect(store.state.runs).toHaveLength(0)

    system.emit({ event: 'playing', state: true, appId: null, triggeredAt: new Date().toISOString() })
    const run = await waitForRun(store)
    expect(run).toMatchObject({
      source: 'automatic', status: 'success',
      steps: [{ nodeId: 'sys', output: { event: 'playing', state: true, appId: null } },
        { nodeId: 'set', output: { value: { event: 'playing', state: true } } }]
    })
  })

  it('辅助程序分发有效行、上报无效行并在取消订阅后退出', async () => {
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), kill: vi.fn()
    })
    mocks.spawn.mockReturnValue(child)
    const report = vi.fn()
    const received: unknown[] = []
    const controller = new AbortController()
    const source = new WindowsEvents('fake_events.exe', report)
    source.subscribe(controller.signal, (event) => received.push(event))
    expect(mocks.spawn).toHaveBeenCalledWith('fake_events.exe', expect.objectContaining({ windowsHide: true }))

    const event = { event: 'playing', state: true, triggeredAt: '2026-11-20T00:00:00.000Z' }
    child.stdout.write(JSON.stringify(event) + '\n')
    await vi.waitFor(() => expect(received).toEqual([{ ...event, appId: null }]))

    child.stdout.write('not json\n')
    await vi.waitFor(() => expect(report).toHaveBeenCalledWith('Windows 事件数据无效'))
    child.stderr.write('辅助程序提示\n')
    await vi.waitFor(() => expect(report).toHaveBeenCalledWith('Windows 事件监听：辅助程序提示'))

    controller.abort()
    expect(child.kill).toHaveBeenCalled()
  })
})
