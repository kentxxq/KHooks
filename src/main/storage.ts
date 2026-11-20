import { mkdir, readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import writeFileAtomic from 'write-file-atomic'
import type { IpSample, Run, RunSource, Theme } from '../shared/ipc'
import { componentSchema, createSiteConfig, workflowSchema, type NodeComponent, type SiteConfig, type Workflow } from '../shared/workflow'

export type QueuedTask = {
  id: string; flow: Workflow; payload: unknown; allowDisabled: boolean; runId?: string; source?: RunSource
}

export type State = {
  version: 1
  theme: Theme
  workflows: Workflow[]
  components: NodeComponent[]
  baselines: Record<string, string>
  samples: Record<string, IpSample>
  pollBaselines: Record<string, unknown>
  clockDates: Record<string, string[]>
  queue: QueuedTask[]
  runs: Run[]
  ai: { url: string; model: string; encryptedKey: string }
}

function isRetiredSite(site: { id: string }): boolean {
  return site.id === 'sohu' || site.id === 'cip'
}

function migrateSites(sites: SiteConfig[]): SiteConfig[] {
  return sites.flatMap((site) => {
    const id: string = site.id
    if (id === 'cip') return []
    return [id === 'sohu' ? createSiteConfig('kentxxq') : site]
  })
}

export class Storage {
  state: State = {
    version: 1, theme: 'light', workflows: [], components: [], baselines: {}, samples: {}, runs: [],
    pollBaselines: {}, clockDates: {}, queue: [],
    ai: { url: '', model: '', encryptedKey: '' }
  }
  private pending: Promise<unknown> = Promise.resolve()

  constructor(
    private readonly file: string,
    private readonly changed: () => void = () => {},
    private readonly report: (message: string) => void = () => {}
  ) {}

  async open(): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true })
    let raw: string
    try {
      raw = await readFile(this.file, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    const state: State = JSON.parse(raw)
    if (state.version !== 1 || !Array.isArray(state.workflows) || !Array.isArray(state.runs) ||
        !state.samples || !state.baselines || !state.ai) {
      throw new Error('本地数据格式无效')
    }
    // 单个流程/组件/队列项损坏时降级剔除并上报,而不是拒绝启动。
    const label = (item: unknown, index: number): string => {
      const name = (item as { name?: unknown } | null)?.name
      return typeof name === 'string' && name.trim() ? `「${name}」` : `第 ${index + 1} 条`
    }
    let migrated = false
    let dropped = 0
    state.workflows = state.workflows.flatMap((flow, index) => {
      try {
        for (const node of flow.nodes) {
          if (node.type !== 'ip' || !node.sites.some(isRetiredSite)) continue
          node.sites = migrateSites(node.sites)
          if (node.sites.length === 0) flow.enabled = false
          delete state.baselines[flow.id]
          delete state.samples[flow.id]
          migrated = true
        }
        return [workflowSchema.parse(flow)]
      } catch (error) {
        dropped++
        this.report(`本地流程${label(flow, index)}解析失败，已跳过：${(error as Error).message}`)
        return []
      }
    })
    state.components = (Array.isArray(state.components) ? state.components : []).flatMap((component, index) => {
      try {
        if (component.config.type === 'ip' && component.config.sites.some(isRetiredSite)) {
          component.config.sites = migrateSites(component.config.sites)
          migrated = true
        }
        return [componentSchema.parse(component)]
      } catch (error) {
        dropped++
        this.report(`本地组件${label(component, index)}解析失败，已跳过：${(error as Error).message}`)
        return []
      }
    })
    state.pollBaselines ??= {}
    state.clockDates ??= {}
    state.queue = (Array.isArray(state.queue) ? state.queue : []).flatMap((task, index) => {
      try {
        return [{ ...task, flow: workflowSchema.parse(task.flow) }]
      } catch (error) {
        dropped++
        this.report(`本地排队任务（流程${label(task?.flow, index)}）解析失败，已丢弃：${(error as Error).message}`)
        return []
      }
    })
    state.theme = state.theme === 'dark' ? 'dark' : 'light'
    this.state = state
    if (migrated || dropped || state.queue.some((task) => task.runId) || state.runs.some((run) => run.status === 'running')) {
      await this.change((draft) => {
        for (const task of draft.queue) delete task.runId
        for (const run of draft.runs.filter((run) => run.status === 'running')) {
          run.status = 'interrupted'
          run.finishedAt = new Date().toISOString()
        }
      })
    }
  }

  change<T>(mutate: (draft: State) => T): Promise<T> {
    const next = this.pending.then(async () => {
      const draft = structuredClone(this.state)
      const result = mutate(draft)
      await writeFileAtomic(this.file, JSON.stringify(draft), { encoding: 'utf8' })
      this.state = draft
      this.changed()
      return result
    })
    this.pending = next.catch(() => {})
    return next
  }

  flush(): Promise<unknown> {
    return this.pending
  }
}
