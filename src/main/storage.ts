import { mkdir, readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import writeFileAtomic from 'write-file-atomic'
import { z } from 'zod'
import type { IpSample, Run, Theme } from '../shared/ipc'
import { componentSchema, workflowSchema, type NodeComponent, type Workflow } from '../shared/workflow'

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
    state.workflows = state.workflows.map((flow) => workflowSchema.parse(flow))
    state.components = state.components === undefined ? [] : z.array(componentSchema).parse(state.components)
    state.theme = state.theme === 'dark' ? 'dark' : 'light'
    this.state = state
    if (state.runs.some((run) => run.status === 'running')) {
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
