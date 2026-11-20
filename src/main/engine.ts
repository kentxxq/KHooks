import { randomUUID } from 'node:crypto'
import { setTimeout as wait } from 'node:timers/promises'
import type { IpSample, Run, RunStep } from '../shared/ipc'
import { graphSchema, isTrigger, validateConnections, validateWorkflow, workflowSchema, zodMessage,
  type FlowEdge, type FlowNode, type Graph, type Workflow } from '../shared/workflow'
import { executeAction } from './actions'
import { watchFiles } from './file-watch'
import { HttpError, pollHttp, probe, samePollValue, tally, type AiOptions, type Fetch } from './network'
import { Storage, type QueuedTask, type State } from './storage'
import type { SystemEventSource } from './windows-events'

type Trigger = Extract<FlowNode, { type: 'manual' | 'interval' | 'ip' | 'fileWatch' | 'httpPoll' | 'system' }>
type IpNode = Extract<Trigger, { type: 'ip' }>
type Schedule = { controller: AbortController; config?: string; system: boolean; timer?: ReturnType<typeof setTimeout> }
type Job = QueuedTask & { durable?: boolean }
type Active = { controller: AbortController; done: Promise<void> }
type Sample = (state: State) => { payload: unknown } | undefined

// 持久队列按流程的待处理任务上限,防止高频触发时无限堆积写满磁盘。
const queueLimit = 50

function triggerOf(flow?: Graph): Trigger | undefined {
  return flow?.nodes.find((node): node is Trigger => isTrigger(node))
}

function triggerConfig(flow?: Graph): string | undefined {
  const node = triggerOf(flow)
  if (!node) return
  const { x, y, name, ...config } = node
  return JSON.stringify(config)
}

function sampleIp(state: State, id: string, results: IpSample['results']): IpSample {
  const previousIp = Object.hasOwn(state.baselines, id) ? state.baselines[id] : null
  const sample = tally(results, previousIp, new Date().toISOString())
  state.samples = { ...state.samples, [id]: sample }
  if (sample.winnerIp) state.baselines = { ...state.baselines, [id]: sample.winnerIp }
  return sample
}

function minuteKey(date: Date): string {
  const pad = (number: number) => String(number).padStart(2, '0')
  return [date.getFullYear(), pad(date.getMonth() + 1), pad(date.getDate())].join('-') +
    'T' + pad(date.getHours()) + ':' + pad(date.getMinutes())
}

function historySnapshot(flow: Workflow): Workflow {
  return {
    ...flow,
    nodes: flow.nodes.map((node) => {
      switch (node.type) {
        case 'http': return { ...node, url: '', headers: [], body: '' }
        case 'httpPoll': return { ...node, url: '', headers: [] }
        case 'notification': return { ...node, title: '', body: '' }
        case 'fileWrite': return { ...node, content: '' }
        case 'llm': return { ...node, system: '', prompt: '' }
        default: return node
      }
    })
  }
}

function historyOutput(node: FlowNode, output: unknown): unknown {
  switch (node.type) {
    case 'http': return { status: (output as { status: number }).status }
    case 'httpPoll': {
      const { status, triggeredAt } = output as { status: number; triggeredAt: string }
      return { status, triggeredAt }
    }
    case 'fileRead': {
      const { path } = output as { path: string }
      return { path }
    }
    case 'llm': return { format: node.format }
    default: return output
  }
}

export class Engine {
  private readonly schedules = new Map<string, Schedule>()
  private readonly busy = new Map<string, Active>()
  private readonly ready = new Map<string, Job>()
  private readonly admissions = new Map<string, Promise<unknown>>()
  private readonly sources = new Set<Promise<unknown>>()
  private readonly probes = new Map<string, Promise<unknown>>()
  private readonly abort = new AbortController()
  private suspended = false

  constructor(
    private readonly store: Storage,
    private readonly fetcher: Fetch = fetch,
    private readonly report: (message: string) => void = console.error,
    private readonly showNotification: (title: string, body: string) => void = () => {
      throw new Error('系统通知不可用')
    },
    private readonly ai: () => AiOptions = () => { throw new Error('请先配置 AI 服务') },
    private readonly system?: SystemEventSource
  ) {}

  start(immediateIp = true): void {
    if (this.abort.signal.aborted) return
    this.suspended = false
    for (const flow of this.store.state.workflows) {
      this.schedule(flow, immediateIp)
      this.pump(flow.id)
    }
  }

  stop(): void {
    this.suspended = true
    for (const [id, schedule] of this.schedules) {
      if (!schedule.system) this.unschedule(id)
    }
  }

  shutdown(): void {
    this.stop()
    for (const id of this.schedules.keys()) this.unschedule(id)
    this.abort.abort('shutdown')
    for (const active of this.busy.values()) active.controller.abort('shutdown')
  }

  async drain(): Promise<void> {
    do {
      await Promise.allSettled([...this.busy.values()].map((active) => active.done)
        .concat([...this.admissions.values(), ...this.sources].map((task) => task.then(() => {}))))
    } while (this.busy.size || this.admissions.size || this.sources.size)
    await this.store.flush()
  }

  private observe(task: Promise<unknown>): void {
    this.sources.add(task)
    void task.catch((error: Error) => {
      if (!this.abort.signal.aborted) this.report(error.message)
    }).finally(() => this.sources.delete(task))
  }

  private unschedule(id: string): void {
    const schedule = this.schedules.get(id)
    if (!schedule) return
    this.schedules.delete(id)
    schedule.controller.abort()
    clearTimeout(schedule.timer)
  }

  private schedule(flow: Workflow, immediateIp: boolean): void {
    const { id } = flow
    if (!flow.enabled || this.suspended || this.schedules.has(id)) return
    const trigger = triggerOf(flow)
    if (!trigger || trigger.type === 'manual') return
    const schedule: Schedule = { controller: new AbortController(), config: triggerConfig(flow), system: trigger.type === 'system' }
    this.schedules.set(id, schedule)
    const { signal } = schedule.controller
    const submit = (sample: Sample) => this.admit(id, sample, { schedule })
    if (trigger.type === 'fileWatch') {
      watchFiles(trigger, signal, (payload) => this.observe(submit(() => ({ payload }))), this.report)
      return
    }
    if (trigger.type === 'system') {
      if (!this.system) this.report('Windows 本机事件不可用')
      this.system?.subscribe(signal, (event) => {
        if (trigger.events.includes(event.event)) this.observe(submit(() => ({ payload: event })))
      })
      return
    }
    let previousTime = new Date()
    let lastError = ''
    // 提交失败待重试的 clock 分钟键;clockDates 的持久去重保证重试不会双触发。
    let pendingClock: string | undefined
    const delay = trigger.type === 'interval' && trigger.clock ? 1000 : trigger.seconds * 1000
    const tick = async () => {
      if (signal.aborted) return
      try {
        if (trigger.type === 'ip') {
          const results = await this.probeIpSites(trigger, signal)
          await submit((state) => {
            const sample = sampleIp(state, id, results)
            if (sample.previousIp && sample.winnerIp && sample.winnerIp !== sample.previousIp) return { payload: sample }
          })
        } else if (trigger.type === 'httpPoll') {
          const reading = await this.readPoll(id, trigger, signal)
          await submit((state) => {
            const known = Object.hasOwn(state.pollBaselines, id)
            const previous = known ? state.pollBaselines[id] : null
            if (known && samePollValue(previous, reading.value)) return
            state.pollBaselines = { ...state.pollBaselines, [id]: reading.value }
            if (known) return { payload: { ...reading, previous } }
          })
        } else {
          const now = new Date()
          const clock = trigger.clock
          const key = minuteKey(now)
          const elapsed = now.getTime() - previousTime.getTime()
          if (pendingClock && pendingClock !== key) pendingClock = undefined
          const due = !clock || pendingClock === key || (elapsed > 0 && elapsed <= 5000 && key !== minuteKey(previousTime) &&
            key.endsWith('T' + clock.time) && (!clock.days || clock.days.includes(now.getDay())))
          previousTime = now
          if (due) {
            try {
              await submit((state) => {
                if (clock) {
                  const dates = Object.hasOwn(state.clockDates, id) ? state.clockDates[id] : []
                  if (dates.includes(key)) return
                  state.clockDates = { ...state.clockDates, [id]: [...dates, key] }
                }
                return { payload: { triggeredAt: now.toISOString() } }
              })
              pendingClock = undefined
            } catch (error) {
              // 提交失败时记住该分钟,下一 tick 同分钟内重试,避免定时事件静默丢失。
              pendingClock = key
              throw error
            }
          }
        }
        lastError = ''
      } catch (error) {
        const message = (error as Error).message
        if (!signal.aborted && lastError !== message) this.report(message)
        lastError = message
      } finally {
        if (!signal.aborted) schedule.timer = setTimeout(() => this.observe(tick()), delay)
      }
    }
    const immediate = trigger.type === 'httpPoll' || (trigger.type === 'ip' && immediateIp)
    schedule.timer = setTimeout(() => this.observe(tick()), immediate ? 0 : delay)
  }

  async save(input: Workflow): Promise<void> {
    // schema 拒绝时转译为中文摘要,避免渲染层 toast 弹出 zod 英文 dump。
    let flow: Workflow
    try {
      flow = workflowSchema.parse({ ...input, enabled: false })
    } catch (error) {
      throw new Error('流程配置无效：' + zodMessage(error))
    }
    const reschedule = await this.store.change((draft) => {
      const previous = draft.workflows.find((item) => item.id === flow.id)
      flow.enabled = previous?.enabled ?? false
      const error = flow.enabled ? validateWorkflow(flow) : validateConnections(flow)
      if (error) throw new Error(error)
      const before = triggerOf(previous)
      const after = triggerOf(flow)
      if (JSON.stringify(before?.type === 'ip' ? before.sites : undefined) !==
          JSON.stringify(after?.type === 'ip' ? after.sites : undefined)) {
        delete draft.baselines[flow.id]
        delete draft.samples[flow.id]
      }
      const pollConfig = (trigger?: Trigger) => trigger?.type === 'httpPoll'
        ? JSON.stringify([trigger.url, trigger.headers, trigger.jsonPath]) : undefined
      if (pollConfig(before) !== pollConfig(after)) delete draft.pollBaselines[flow.id]
      if (previous) draft.workflows[draft.workflows.indexOf(previous)] = flow
      else draft.workflows.push(flow)
      return flow.enabled && triggerConfig(previous) !== triggerConfig(flow)
    })
    if (reschedule) {
      this.unschedule(flow.id)
      this.schedule(flow, true)
    }
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
    if (enabled) {
      this.schedule(flow, true)
      this.pump(id)
    } else {
      this.unschedule(id)
      if (!this.ready.get(id)?.allowDisabled) this.ready.delete(id)
    }
  }

  async remove(id: string): Promise<void> {
    await this.store.change((draft) => {
      if (draft.workflows.find((item) => item.id === id)?.enabled || this.busy.has(id) || this.ready.has(id)) {
        throw new Error('请停用流程并等待当前执行结束')
      }
      draft.workflows = draft.workflows.filter((item) => item.id !== id)
      draft.queue = draft.queue.filter((item) => item.flow.id !== id)
      delete draft.baselines[id]
      delete draft.samples[id]
      delete draft.pollBaselines[id]
      delete draft.clockDates[id]
    })
  }

  async run(id: string, draft?: Graph, intent: 'saved' | 'preview' | 'legacy' = 'legacy'): Promise<void> {
    const saved = this.store.state.workflows.find((item) => item.id === id)
    if (!saved) throw new Error('流程不存在')
    const preview = draft !== undefined
    // 试跑草稿 schema 拒绝时同样转译,避免渲染层 toast 弹出 zod 英文 dump。
    let flow: Workflow = saved
    if (preview) {
      try {
        flow = { ...graphSchema.parse(draft), id, enabled: false }
      } catch (error) {
        throw new Error('流程配置无效：' + zodMessage(error))
      }
    }
    const error = validateWorkflow(flow)
    if (error) throw new Error(error)
    const trigger = triggerOf(flow)
    if (!trigger) throw new Error('请添加触发器')
    if (intent === 'legacy' && !preview && !saved.enabled) throw new Error('请先启用流程')
    if (preview && saved.enabled) throw new Error('请先停用流程')
    if ((preview || (saved.busyPolicy ?? 'skip') === 'skip') && (this.busy.has(id) || this.ready.has(id))) {
      throw new Error('流程正在执行')
    }
    let sample: Sample = () => ({ payload: { triggeredAt: new Date().toISOString() } })
    if (trigger.type === 'ip') {
      const results = await this.probeIpSites(trigger, this.abort.signal)
      sample = (state) => {
        const current = triggerOf(state.workflows.find((item) => item.id === id))
        const sameSites = current?.type === 'ip' && JSON.stringify(current.sites) === JSON.stringify(trigger.sites)
        if (sameSites && intent !== 'preview') return { payload: sampleIp(state, id, results) }
        const previous = sameSites && Object.hasOwn(state.baselines, id) ? state.baselines[id] : null
        return { payload: tally(results, previous, new Date().toISOString()) }
      }
    } else if (trigger.type === 'httpPoll') {
      const reading = await this.readPoll(id, trigger, this.abort.signal)
      sample = (state) => {
        const current = triggerOf(state.workflows.find((item) => item.id === id))
        const same = current?.type === 'httpPoll' && current.url === trigger.url && current.jsonPath === trigger.jsonPath &&
          JSON.stringify(current.headers) === JSON.stringify(trigger.headers)
        const previous = same && Object.hasOwn(state.pollBaselines, id) ? state.pollBaselines[id] : null
        return { payload: { ...reading, previous } }
      }
    } else if (trigger.type === 'fileWatch' || trigger.type === 'system') {
      sample = () => ({ payload: {
        event: 'manual', triggeredAt: new Date().toISOString(),
        ...(trigger.type === 'fileWatch' ? { path: trigger.path, isDirectory: trigger.target === 'directory' }
          : { state: null, appId: null })
      } })
    }
    const result = await this.admit(id, sample, { flow, manual: true, preview })
    if (intent !== 'saved' || (saved.busyPolicy ?? 'skip') === 'skip') await result?.done
  }

  private async probeIpSites(trigger: IpNode, signal: AbortSignal): Promise<IpSample['results']> {
    const fetcher: Fetch = (url, init) => this.fetcher(url, {
      ...init, signal: init?.signal ? AbortSignal.any([init.signal, signal]) : signal
    })
    return Promise.all(trigger.sites.map((site) => probe(site, fetcher)))
  }

  private async readPoll(id: string, trigger: Extract<Trigger, { type: 'httpPoll' }>, signal: AbortSignal) {
    const before = this.probes.get(id)
    const request = Promise.resolve(before).catch(() => {}).then(() => {
      signal.throwIfAborted()
      return pollHttp(trigger, this.fetcher, signal)
    })
    this.probes.set(id, request)
    try { return await request } finally {
      if (this.probes.get(id) === request) this.probes.delete(id)
    }
  }

  private admit(id: string, sample: Sample, options: {
    schedule?: Schedule; flow?: Workflow; manual?: boolean; preview?: boolean
  }): Promise<{ done: Promise<void> } | undefined> {
    const occupiedOnArrival = this.busy.has(id) || this.ready.has(id)
    const before = this.admissions.get(id)
    const admission = Promise.resolve(before).catch(() => {}).then(async () => {
      let job: Job | undefined
      let replace = false
      await this.store.change((state) => {
        if (this.abort.signal.aborted ||
            (options.schedule && this.schedules.get(id) !== options.schedule)) return
        const current = state.workflows.find((flow) => flow.id === id)
        if (!current || (!options.manual && !current.enabled)) return
        if (options.schedule && triggerConfig(current) !== options.schedule.config) return
        const flow = options.flow ?? current
        const policy = options.preview ? 'skip' : current.busyPolicy ?? 'skip'
        const busy = this.busy.has(id) || this.ready.has(id) || (policy === 'skip' && occupiedOnArrival) ||
          state.queue.some((item) => item.flow.id === id && (current.enabled || item.allowDisabled))
        if (options.manual && busy && policy === 'skip') throw new Error('流程正在执行')
        const event = sample(state)
        if (!event || (busy && policy === 'skip')) return
        if (policy === 'queue' && state.queue.filter((item) => item.flow.id === id).length >= queueLimit) {
          // 自动事件按 skip 语义丢弃,手动运行明确报错,避免队列无限增长。
          if (options.manual) throw new Error('排队任务已达上限')
          return
        }
        job = {
          id: randomUUID(), flow: structuredClone(flow), payload: event.payload,
          source: options.preview ? 'preview' : options.manual ? 'manual' : 'automatic',
          allowDisabled: Boolean(options.manual && !current.enabled)
        }
        if (policy === 'queue') {
          state.queue.push(job)
          job = { ...job, durable: true }
        } else {
          replace = policy === 'latest' && busy
        }
      })
      if (!job || this.abort.signal.aborted) return
      const current = this.store.state.workflows.find((flow) => flow.id === id)
      if (!current) return
      if (!job.durable) {
        if (!job.allowDisabled && !current.enabled) return
        this.ready.set(id, job)
      }
      if (replace) this.busy.get(id)?.controller.abort('latest')
      const active = this.pump(id)
      if (active?.id === job.id) return { done: active.done }
    }).finally(() => {
      if (this.admissions.get(id) === admission) this.admissions.delete(id)
    })
    this.admissions.set(id, admission)
    return admission
  }

  private pump(id: string): { id: string; done: Promise<void> } | undefined {
    if (this.abort.signal.aborted || this.busy.has(id)) return
    const flow = this.store.state.workflows.find((item) => item.id === id)
    if (!flow) return
    const eligible = (item: Job) => item.allowDisabled || (flow.enabled && !this.suspended)
    const ready = this.ready.get(id)
    const job = ready && eligible(ready) ? ready : this.store.state.queue.find((item) =>
      item.flow.id === id && !item.runId && eligible(item))
    if (!job) return
    if (job === ready) this.ready.delete(id)
    const controller = new AbortController()
    const done = Promise.resolve().then(() => this.execute(job, controller.signal, job !== ready)).finally(() => {
      this.busy.delete(id)
    })
    this.busy.set(id, { controller, done })
    // 执行异常(如步骤记录写盘失败)后也要继续泵送,否则持久队列停摆。
    void done.then(() => this.pump(id), (error: Error) => {
      this.report(error.message)
      this.pump(id)
    })
    return { id: job.id, done }
  }

  private async execute(job: Job, signal: AbortSignal, durable: boolean): Promise<void> {
    const { flow, payload } = job
    const trigger = triggerOf(flow)
    if (!trigger) throw new Error('请添加触发器')
    const run: Run = {
      id: randomUUID(), workflowId: flow.id, name: flow.name, workflow: historySnapshot(flow),
      taskId: job.id, source: job.source, startedAt: new Date().toISOString(), finishedAt: null,
      status: 'running', steps: [], edges: []
    }
    const started = await this.store.change((draft) => {
      if (durable) {
        const queued = draft.queue.find((item) => item.id === job.id)
        if (!queued || queued.runId || (!job.allowDisabled && !draft.workflows.find((item) => item.id === flow.id)?.enabled)) return false
        queued.runId = run.id
      }
      draft.runs.unshift(run)
      return true
    })
    if (!started) return

    const nodes = new Map(flow.nodes.map((node) => [node.id, node]))
    const outgoing = new Map<string, FlowEdge[]>()
    for (const edge of flow.edges) {
      const edges = outgoing.get(edge.from)
      if (edges) edges.push(edge)
      else outgoing.set(edge.from, [edge])
    }
    const outputs: Record<string, unknown> = Object.create(null)
    const services = { fetcher: this.fetcher, ai: this.ai, notify: this.showNotification }
    let failed = false
    const executeNode = async (node: FlowNode, incoming?: FlowEdge): Promise<void> => {
      if (signal.aborted || failed) return
      const step: RunStep & { attempts: number } = {
        nodeId: node.id, type: node.type, startedAt: new Date().toISOString(), attempts: 0
      }
      let port: FlowEdge['port'] = 'next'
      const edges = outgoing.get(node.id) ?? []
      let output: unknown
      try {
        if (node.type === 'manual' || node.type === 'interval' || node.type === 'ip' ||
            node.type === 'fileWatch' || node.type === 'httpPoll' || node.type === 'system') {
          output = payload
          step.attempts = 1
          if (node.type === 'httpPoll') {
            const host = URL.parse(node.url)?.host
            if (host) step.details = { host }
          }
        } else {
          while (true) {
            signal.throwIfAborted()
            step.attempts++
            try {
              output = await executeAction(node, outputs, signal, services, step)
              signal.throwIfAborted()
              break
            } catch (error) {
              signal.throwIfAborted()
              if (!node.retry || step.attempts > node.retry.count) throw error
              await wait(node.retry.seconds * 1000, undefined, { signal })
            }
          }
        }
        if (node.type === 'condition') port = (output as { matched: boolean }).matched ? 'yes' : 'no'
        step.output = historyOutput(node, output)
      } catch (error) {
        step.error = signal.aborted ? (signal.reason === 'latest' ? '已被新事件中断' : '应用正在退出')
          : (error as Error).message
        if (!signal.aborted) {
          port = 'error'
          failed ||= !edges.some((edge) => edge.port === 'error')
          output = { error: {
            message: step.error, attempts: step.attempts, ...(error instanceof HttpError ? { status: error.status } : {})
          } }
        }
      }
      step.finishedAt = new Date().toISOString()
      outputs[node.id] = output
      await this.store.change((draft) => {
        const record = draft.runs.find((item) => item.id === run.id)
        if (!record) return
        record.steps.push(step)
        if (incoming) record.edges.push(incoming.id)
      })
      if (signal.aborted || failed) return
      const branches = await Promise.allSettled(edges.filter((edge) => edge.port === port)
        .map((edge) => executeNode(nodes.get(edge.to)!, edge)))
      const rejected = branches.find((result) => result.status === 'rejected')
      if (rejected) throw rejected.reason
    }

    try {
      await executeNode(trigger)
    } catch (error) {
      failed = true
      throw error
    } finally {
      await this.store.change((draft) => {
        const record = draft.runs.find((item) => item.id === run.id)
        if (!record) return
        record.status = signal.aborted ? (signal.reason === 'latest' ? 'cancelled' : 'interrupted')
          : failed ? 'failed' : 'success'
        record.finishedAt = new Date().toISOString()
        const queued = draft.queue.find((item) => item.id === job.id)
        if (queued && record.status === 'interrupted') delete queued.runId
        else if (queued) draft.queue = draft.queue.filter((item) => item.id !== job.id)
        draft.runs = draft.runs.filter((item, index) => index < 100 || item.status === 'running')
      })
    }
  }
}
