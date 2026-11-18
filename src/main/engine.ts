import { randomUUID } from 'node:crypto'
import { setTimeout as wait } from 'node:timers/promises'
import type { IpSample, Run, RunStep } from '../shared/ipc'
import {
  evaluate, graphSchema, isTrigger, parseHttpUrl, readField, renderJson, renderTemplate, validateConnections, validateWorkflow,
  workflowSchema, type FlowEdge, type FlowNode, type Graph, type Workflow
} from '../shared/workflow'
import { probe, tally, type Fetch } from './network'
import { Storage } from './storage'

type Schedule = { timer?: ReturnType<typeof setTimeout> }
type HttpNode = Extract<FlowNode, { type: 'http' }>
type IpNode = Extract<FlowNode, { type: 'ip' }>

function ipSiteKey(graph?: Graph): string | undefined {
  const node = graph?.nodes.find((item) => item.type === 'ip')
  return node && JSON.stringify(node.sites)
}

function recordIpSample(state: Storage['state'], id: string, results: IpSample['results']): IpSample {
  const previousIp = Object.hasOwn(state.baselines, id) ? state.baselines[id] : null
  const sample = tally(results, previousIp, new Date().toISOString())
  state.samples[id] = sample
  if (sample.winnerIp) state.baselines[id] = sample.winnerIp
  return sample
}

export class Engine {
  private readonly schedules = new Map<string, Schedule>()
  private readonly busy = new Map<string, Promise<void>>()
  private suspended = false
  private readonly abort = new AbortController()

  constructor(
    private readonly store: Storage,
    private readonly fetcher: Fetch = fetch,
    private readonly report: (message: string) => void = console.error,
    private readonly showNotification: (title: string, body: string) => void = () => {
      throw new Error('系统通知不可用')
    }
  ) {}

  start(immediateIp = true): void {
    this.suspended = false
    for (const flow of this.store.state.workflows) this.schedule(flow, immediateIp)
  }

  stop(): void {
    this.suspended = true
    for (const id of this.schedules.keys()) this.unschedule(id)
  }

  private unschedule(id: string): void {
    clearTimeout(this.schedules.get(id)?.timer)
    this.schedules.delete(id)
  }

  private schedule(flow: Workflow, immediateIp: boolean): void {
    if (!flow.enabled || this.suspended || this.schedules.has(flow.id)) return
    const trigger = flow.nodes.find(isTrigger)
    if (trigger?.type !== 'ip' && trigger?.type !== 'interval') return
    const schedule: Schedule = {}
    this.schedules.set(flow.id, schedule)
    const tick = async () => {
      if (this.schedules.get(flow.id) !== schedule) return
      try {
        await this.exclusive(flow.id, async () => {
          if (trigger.type === 'interval') {
            await this.execute(flow, trigger, { triggeredAt: new Date().toISOString() })
          } else {
            await this.poll(flow, trigger, schedule)
          }
        }, true)
      } catch (error) {
        this.report((error as Error).message)
      } finally {
        if (this.schedules.get(flow.id) === schedule) schedule.timer = setTimeout(tick, trigger.seconds * 1000)
      }
    }
    schedule.timer = setTimeout(tick, trigger.type === 'ip' && immediateIp ? 0 : trigger.seconds * 1000)
  }

  shutdown(): void {
    this.stop()
    this.abort.abort()
  }

  async drain(): Promise<void> {
    await Promise.allSettled(this.busy.values())
    await this.store.flush()
  }

  async save(input: Workflow): Promise<void> {
    const flow = workflowSchema.parse({ ...input, enabled: false })
    const error = validateConnections(flow)
    if (error) throw new Error(error)
    await this.store.change((draft) => {
      const previous = draft.workflows.find((item) => item.id === flow.id)
      if (previous?.enabled) throw new Error('请先停用流程')
      if (ipSiteKey(previous) !== ipSiteKey(flow)) {
        delete draft.baselines[flow.id]
        delete draft.samples[flow.id]
      }
      if (previous) draft.workflows[draft.workflows.indexOf(previous)] = flow
      else draft.workflows.push(flow)
    })
  }

  async enable(id: string, enabled: boolean): Promise<void> {
    const flow = await this.store.change((draft) => {
      const flow = draft.workflows.find((item) => item.id === id)
      if (!flow) throw new Error('流程不存在')
      if (enabled) {
        const error = validateWorkflow(flow)
        if (error) throw new Error(error)
      }
      flow.enabled = enabled
      return flow
    })
    if (enabled) this.schedule(flow, true)
    else this.unschedule(id)
  }

  async remove(id: string): Promise<void> {
    await this.store.change((draft) => {
      if (draft.workflows.find((item) => item.id === id)?.enabled || this.busy.has(id)) {
        throw new Error('请停用流程并等待当前执行结束')
      }
      draft.workflows = draft.workflows.filter((item) => item.id !== id)
      delete draft.baselines[id]
      delete draft.samples[id]
    })
  }

  async run(id: string, draft?: Graph): Promise<void> {
    const saved = this.store.state.workflows.find((item) => item.id === id)
    if (!saved) throw new Error('流程不存在')
    const flow = draft === undefined ? saved : { ...graphSchema.parse(draft), id, enabled: false }
    const error = validateWorkflow(flow)
    if (error) throw new Error(error)
    const trigger = flow.nodes.find(isTrigger)
    if (!trigger) throw new Error('请添加触发器')
    if (draft === undefined && !saved.enabled) throw new Error('请先启用流程')
    if (draft !== undefined && saved.enabled) throw new Error('请先停用流程')
    await this.exclusive(id, async () => {
      if (trigger.type === 'ip') {
        const results = await this.probeIpSites(trigger)
        const sample = await this.store.change((state) => {
          const current = state.workflows.find((item) => item.id === id)
          if (ipSiteKey(current) !== ipSiteKey(flow)) return tally(results, null, new Date().toISOString())
          return recordIpSample(state, id, results)
        })
        await this.execute(flow, trigger, sample)
      } else {
        await this.execute(flow, trigger, { triggeredAt: new Date().toISOString() })
      }
    })
  }

  private async exclusive(id: string, action: () => Promise<void>, skipBusy = false): Promise<void> {
    if (this.busy.has(id)) {
      if (skipBusy) return
      throw new Error('流程正在执行')
    }
    const task = action()
    this.busy.set(id, task)
    try { await task } finally { this.busy.delete(id) }
  }

  private async probeIpSites(trigger: IpNode): Promise<IpSample['results']> {
    const fetcher: Fetch = (url, init) => this.fetcher(url, {
      ...init, signal: init?.signal ? AbortSignal.any([init.signal, this.abort.signal]) : this.abort.signal
    })
    return Promise.all(trigger.sites.map((site) => probe(site, fetcher)))
  }

  private async poll(flow: Workflow, trigger: IpNode, schedule: Schedule): Promise<void> {
    const results = await this.probeIpSites(trigger)
    if (this.schedules.get(flow.id) !== schedule) return
    const sample = await this.store.change((draft): IpSample | undefined => {
      if (this.schedules.get(flow.id) !== schedule || !draft.workflows.find((item) => item.id === flow.id)?.enabled) return
      return recordIpSample(draft, flow.id, results)
    })
    if (sample?.previousIp && sample.winnerIp && sample.winnerIp !== sample.previousIp &&
        this.schedules.get(flow.id) === schedule && this.store.state.workflows.find((item) => item.id === flow.id)?.enabled) {
      await this.execute(flow, trigger, sample)
    }
  }

  private async execute(flow: Workflow, trigger: FlowNode, initial: unknown): Promise<void> {
    const start = new Date().toISOString()
    const workflow = {
      ...flow,
      nodes: flow.nodes.map((node) => {
        if (node.type === 'http') return { ...node, url: '', headers: [], body: '' }
        if (node.type === 'notification') return { ...node, title: '', body: '' }
        return node
      })
    }
    const run: Run = {
      id: randomUUID(), workflowId: flow.id, name: flow.name, workflow, startedAt: start,
      finishedAt: null, status: 'running', steps: [], edges: []
    }
    await this.store.change((draft) => {
      draft.runs.unshift(run)
      draft.runs = draft.runs.filter((item, index) => index < 100 || item.status === 'running')
    })

    const nodes = new Map(flow.nodes.map((node) => [node.id, node]))
    const outgoing = new Map<string, FlowEdge[]>()
    for (const edge of flow.edges) {
      const edges = outgoing.get(edge.from)
      if (edges) edges.push(edge)
      else outgoing.set(edge.from, [edge])
    }
    const outputs: Record<string, unknown> = Object.create(null)
    let failed = false
    const executeNode = async (node: FlowNode, incoming?: FlowEdge): Promise<void> => {
      const step: RunStep = { nodeId: node.id, type: node.type }
      let port: FlowEdge['port'] = 'next'
      try {
        if (this.abort.signal.aborted) throw new Error('应用正在退出')
        if (node.type === 'condition') {
          const matched = evaluate(node, readField(outputs, node.field))
          port = matched ? 'yes' : 'no'
          step.output = { matched }
        } else if (node.type === 'http') {
          step.output = await this.request(node, outputs)
        } else if (node.type === 'delay') {
          await wait(node.seconds * 1000, undefined, { signal: this.abort.signal })
          step.output = { seconds: node.seconds }
        } else if (node.type === 'data') {
          step.output = { value: renderJson(JSON.parse(node.value), outputs) }
        } else if (node.type === 'notification') {
          const title = renderTemplate(node.title, outputs)
          if (!title.trim()) throw new Error('通知标题为空')
          this.showNotification(title, renderTemplate(node.body, outputs))
          step.output = { sent: true }
        } else {
          step.output = initial
        }
        outputs[node.id] = step.output
      } catch (error) {
        step.error = this.abort.signal.aborted ? '应用正在退出' : (error as Error).message
        failed = true
      }
      try {
        await this.store.change((draft) => {
          const runRecord = draft.runs.find((item) => item.id === run.id)
          if (!runRecord) return
          runRecord.steps.push(step)
          if (incoming) runRecord.edges.push(incoming.id)
        })
      } catch (error) {
        failed = true
        throw error
      }
      if (failed) return

      const branches = (outgoing.get(node.id) ?? []).filter((edge) => edge.port === port)
      const results = await Promise.allSettled(branches.map((edge) => executeNode(nodes.get(edge.to)!, edge)))
      const rejected = results.find((result) => result.status === 'rejected')
      if (rejected) throw rejected.reason
    }

    try {
      await executeNode(trigger)
    } finally {
      await this.store.change((draft) => {
        const runRecord = draft.runs.find((item) => item.id === run.id)
        if (!runRecord) return
        runRecord.status = failed ? 'failed' : 'success'
        runRecord.finishedAt = new Date().toISOString()
        draft.runs = draft.runs.filter((item, index) => index < 100 || item.status === 'running')
      })
    }
  }

  private async request(node: HttpNode, outputs: Record<string, unknown>): Promise<{ status: number }> {
    let url: URL
    const address = renderTemplate(node.url, outputs)
    try { url = parseHttpUrl(address) } catch { throw new Error('HTTP 请求地址无效') }
    const pairs = node.headers.map(({ name, value }): [string, string] => [name, renderTemplate(value, outputs)])
    let headers: Headers
    try { headers = new Headers(pairs) } catch { throw new Error('HTTP 请求头无效') }
    let body: string | undefined
    if (node.body && node.method !== 'GET' && node.method !== 'HEAD') {
      body = JSON.stringify(renderJson(JSON.parse(node.body), outputs))
      if (!headers.has('Content-Type')) headers.set('Content-Type', 'application/json')
    }
    const timeout = AbortSignal.timeout(15000)
    const signal = AbortSignal.any([timeout, this.abort.signal])
    let response: Response
    try {
      response = await this.fetcher(url, { method: node.method, headers, body, signal, redirect: 'manual' })
    } catch {
      throw new Error(timeout.aborted ? 'HTTP 请求超时' : this.abort.signal.aborted ? '应用正在退出' : 'HTTP 请求失败')
    }
    void response.body?.cancel().catch(() => {})
    if (!response.ok) throw new Error('HTTP ' + response.status)
    return { status: response.status }
  }
}
