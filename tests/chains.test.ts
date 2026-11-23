import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Run } from '../src/shared/ipc'
import type { FlowEdge, FlowNode } from '../src/shared/workflow'
import {
  cleanupResources, createEngine, createStore, fakeSystem, listen, tempDir, waitForRun, workflow
} from './helpers'

afterEach(async () => {
  vi.useRealTimers()
  await cleanupResources()
})

function step(run: Run, id: string) {
  return run.steps.find((item) => item.nodeId === id)
}

describe('触发器与节点的组合链路', () => {
  it('文件变化后读取内容并上传', async () => {
    let uploaded = ''
    const base = await listen(async (request, response) => {
      const parts: Buffer[] = []
      for await (const chunk of request) parts.push(chunk as Buffer)
      uploaded = Buffer.concat(parts).toString()
      response.writeHead(204).end()
    })
    const dir = await tempDir('chain-')
    const file = join(dir, 'note.txt')
    await writeFile(file, 'first')
    const { store } = await createStore()
    const engine = createEngine({ store })
    const nodes: FlowNode[] = [
      { id: 'watch', type: 'fileWatch', x: 0, y: 0, path: dir, target: 'directory', events: ['changed'] },
      { id: 'read', type: 'fileRead', x: 230, y: 0, path: '@{watch.path}', format: 'text' },
      { id: 'send', type: 'http', x: 460, y: 0, method: 'POST', url: base + '/upload', headers: [], body: '{"text":"@{read.content}"}' }
    ]
    const edges: FlowEdge[] = [
      { id: 'a', from: 'watch', to: 'read', port: 'next' },
      { id: 'b', from: 'read', to: 'send', port: 'next' }
    ]
    await engine.save(workflow('flow', nodes, edges))
    await engine.enable('flow', true)
    await new Promise((done) => setTimeout(done, 500))
    await writeFile(file, 'second')
    const run = await waitForRun(store)
    expect(run).toMatchObject({
      source: 'automatic', status: 'success', edges: ['a', 'b'],
      steps: [
        { nodeId: 'watch', output: { event: 'changed', path: file, isDirectory: false } },
        { nodeId: 'read', output: { path: file } },
        { nodeId: 'send', output: { status: 204 } }
      ]
    })
    expect(JSON.parse(uploaded)).toEqual({ text: 'second' })
    // 运行快照保留结构但清空请求地址与正文。
    expect(run.workflow.nodes[2]).toMatchObject({ type: 'http', url: '', body: '' })
    expect(JSON.stringify(run)).not.toContain('second')
  })

  it('轮询值变化经映射和条件后通知并写文件', async () => {
    let payload: unknown = { state: 'idle' }
    const base = await listen((_, response) => {
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify(payload))
    })
    const dir = await tempDir('chain-')
    const notify = vi.fn()
    const { store } = await createStore()
    const engine = createEngine({ store, notify })
    const nodes: FlowNode[] = [
      { id: 'poll', type: 'httpPoll', x: 0, y: 0, seconds: 1, url: base + '/state', headers: [], jsonPath: '$.state' },
      {
        id: 'map', type: 'data', x: 230, y: 0, value: 'null',
        mapping: [{ key: 'flag', value: '@{poll.value}', convert: 'keep' }]
      },
      { id: 'gate', type: 'condition', x: 460, y: 0, field: 'map.value.flag', operator: 'eq', value: '"ready"' },
      { id: 'notify', type: 'notification', x: 690, y: 0, title: '状态 @{map.value.flag}', body: '已就绪' },
      {
        id: 'save', type: 'fileWrite', x: 690, y: 150, path: join(dir, 'state.json'), format: 'json',
        content: '{"flag":"@{map.value.flag}"}'
      }
    ]
    const edges: FlowEdge[] = [
      { id: 'a', from: 'poll', to: 'map', port: 'next' },
      { id: 'b', from: 'map', to: 'gate', port: 'next' },
      { id: 'yes-notify', from: 'gate', to: 'notify', port: 'yes' },
      { id: 'yes-save', from: 'gate', to: 'save', port: 'yes' }
    ]
    await engine.save(workflow('flow', nodes, edges))
    await engine.enable('flow', true)
    await vi.waitFor(() => expect(store.state.pollBaselines.flow).toBe('idle'))
    payload = { state: 'ready' }
    const run = await waitForRun(store)
    expect(run).toMatchObject({ source: 'automatic', status: 'success' })
    expect(run.edges).toEqual(expect.arrayContaining(['a', 'b', 'yes-notify', 'yes-save']))
    expect(step(run, 'poll')?.output).toMatchObject({ status: 200 })
    expect(step(run, 'map')?.output).toEqual({ value: { flag: 'ready' } })
    expect(step(run, 'gate')?.output).toEqual({ matched: true })
    expect(step(run, 'notify')?.output).toEqual({ sent: true })
    expect(step(run, 'notify')?.notification).toEqual({ title: '状态 ready', body: '已就绪' })
    expect(notify).toHaveBeenCalledWith('状态 ready', '已就绪')
    expect(JSON.parse(await readFile(join(dir, 'state.json'), 'utf8'))).toEqual({ flag: 'ready' })
  })

  it('定时触发后写入文件、再读回文件内容并提交', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(2026, 10, 20, 9, 29, 59))
    let uploaded = ''
    const base = await listen(async (request, response) => {
      const parts: Buffer[] = []
      for await (const chunk of request) parts.push(chunk as Buffer)
      uploaded = Buffer.concat(parts).toString()
      response.writeHead(204).end()
    })
    const dir = await tempDir('chain-')
    const file = join(dir, 'run.txt')
    const { store } = await createStore()
    const engine = createEngine({ store })
    const nodes: FlowNode[] = [
      { id: 'clock', type: 'interval', x: 0, y: 0, seconds: 60, clock: { time: '09:30' } },
      { id: 'gate', type: 'condition', x: 230, y: 0, field: 'clock.triggeredAt', operator: 'exists', value: '' },
      { id: 'save', type: 'fileWrite', x: 460, y: 0, path: file, format: 'text', content: '触发时间 @{clock.triggeredAt}' },
      { id: 'load', type: 'fileRead', x: 690, y: 0, path: '@{save.path}', format: 'text' },
      { id: 'send', type: 'http', x: 920, y: 0, method: 'POST', url: base + '/done', headers: [], body: '{"text":"@{load.content}"}' }
    ]
    const edges: FlowEdge[] = [
      { id: 'a', from: 'clock', to: 'gate', port: 'next' },
      { id: 'b', from: 'gate', to: 'save', port: 'yes' },
      { id: 'c', from: 'save', to: 'load', port: 'next' },
      { id: 'd', from: 'load', to: 'send', port: 'next' }
    ]
    await engine.save(workflow('flow', nodes, edges))
    await engine.enable('flow', true)
    vi.setSystemTime(new Date(2026, 10, 20, 9, 30, 0, 200))
    const run = await waitForRun(store)
    expect(run).toMatchObject({
      source: 'automatic', status: 'success', edges: ['a', 'b', 'c', 'd'],
      steps: [{ nodeId: 'clock' }, { nodeId: 'gate', output: { matched: true } },
        { nodeId: 'save' }, { nodeId: 'load' }, { nodeId: 'send', output: { status: 204 } }]
    })
    const triggeredAt = (step(run, 'clock')?.output as { triggeredAt: string }).triggeredAt
    expect(await readFile(file, 'utf8')).toBe('触发时间 ' + triggeredAt)
    expect(JSON.parse(uploaded)).toEqual({ text: '触发时间 ' + triggeredAt })
    expect(store.state.clockDates.flow).toEqual(['2026-11-20T09:30'])
  })

  it('系统事件经条件判断后提交 HTTP 请求', async () => {
    let uploaded = ''
    const base = await listen(async (request, response) => {
      const parts: Buffer[] = []
      for await (const chunk of request) parts.push(chunk as Buffer)
      uploaded = Buffer.concat(parts).toString()
      response.writeHead(204).end()
    })
    const system = fakeSystem()
    const { store } = await createStore()
    const engine = createEngine({ store, system })
    const nodes: FlowNode[] = [
      { id: 'sys', type: 'system', x: 0, y: 0, events: ['playing'] },
      { id: 'gate', type: 'condition', x: 230, y: 0, field: 'sys.state', operator: 'eq', value: 'true' },
      { id: 'send', type: 'http', x: 460, y: 0, method: 'POST', url: base + '/play', headers: [], body: '{"event":"@{sys.event}"}' }
    ]
    const edges: FlowEdge[] = [
      { id: 'a', from: 'sys', to: 'gate', port: 'next' },
      { id: 'b', from: 'gate', to: 'send', port: 'yes' }
    ]
    await engine.save(workflow('flow', nodes, edges))
    await engine.enable('flow', true)
    system.emit({ event: 'playing', state: true, appId: null, triggeredAt: new Date().toISOString() })
    const run = await waitForRun(store)
    expect(run).toMatchObject({
      source: 'automatic', status: 'success', edges: ['a', 'b'],
      steps: [{ nodeId: 'sys', output: { event: 'playing', state: true } },
        { nodeId: 'gate', output: { matched: true } }, { nodeId: 'send', output: { status: 204 } }]
    })
    expect(JSON.parse(uploaded)).toEqual({ event: 'playing' })
  })
})
