import { mkdir, readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import writeFileAtomic from 'write-file-atomic'
import { z } from 'zod'
import type { IpSample, Run, Theme } from '../shared/ipc'
import { componentSchema, createSiteConfig, workflowSchema, type NodeComponent, type SiteConfig, type Workflow } from '../shared/workflow'

type State = {
  version: 1
  theme: Theme
  workflows: Workflow[]
  components: NodeComponent[]
  baselines: Record<string, string>
  samples: Record<string, IpSample>
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
    ai: { url: '', model: '', encryptedKey: '' }
  }
  private pending: Promise<unknown> = Promise.resolve()

  constructor(private readonly file: string, private readonly changed: () => void = () => {}) {}

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
    if (state.version !== 1 || !Array.isArray(state.runs) || !state.samples || !state.baselines || !state.ai) {
      throw new Error('本地数据格式无效')
    }
    let migrated = false
    for (const flow of state.workflows) {
      for (const node of flow.nodes) {
        if (node.type !== 'ip' || !node.sites.some(isRetiredSite)) continue
        node.sites = migrateSites(node.sites)
        if (node.sites.length === 0) flow.enabled = false
        delete state.baselines[flow.id]
        delete state.samples[flow.id]
        migrated = true
      }
    }
    for (const { config } of state.components ?? []) {
      if (config.type !== 'ip' || !config.sites.some(isRetiredSite)) continue
      config.sites = migrateSites(config.sites)
      migrated = true
    }
    state.workflows = state.workflows.map((flow) => workflowSchema.parse(flow))
    state.components = state.components === undefined ? [] : z.array(componentSchema).parse(state.components)
    state.theme = state.theme === 'dark' ? 'dark' : 'light'
    this.state = state
    if (migrated || state.runs.some((run) => run.status === 'running')) {
      await this.change((draft) => {
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
