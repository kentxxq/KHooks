import type { ComponentInput, Graph, NodeComponent, SiteConfig, SiteId, Workflow } from './workflow'

export type SiteResult = { id: SiteId; ip: string; error?: never } | { id: SiteId; ip?: never; error: string }
export type IpSample = {
  results: SiteResult[]
  distinctIpCount: number
  votes: Record<string, number>
  winnerIp: string | null
  winnerVotes: number
  previousIp: string | null
  checkedAt: string
}

export type RunSource = 'automatic' | 'manual' | 'preview'
export type RunStep = {
  nodeId: string
  type: string
  startedAt?: string
  finishedAt?: string
  attempts?: number
  details?: Record<string, string | number>
  notification?: { title: string; body: string }
  output?: unknown
  error?: string
}
export type Run = {
  id: string
  workflowId: string
  name: string
  startedAt: string
  finishedAt: string | null
  status: 'running' | 'success' | 'failed' | 'interrupted' | 'cancelled'
  taskId?: string
  source?: RunSource
  steps: RunStep[]
  edges: string[]
  workflow: Workflow
}

export type Theme = 'light' | 'dark'
export type ExternalLink = 'releases' | 'changelog'
export type Settings = { login: boolean; autoCheckUpdate: boolean; aiUrl: string; aiModel: string; hasAiKey: boolean; theme: Theme }
export type Update = { state: 'disabled' | 'idle' | 'checking' | 'available' | 'downloading' | 'downloaded' | 'current' | 'unpublished' | 'installing' | 'error'; version?: string; percent?: number; error?: string }
export type Snapshot = {
  workflows: Workflow[]
  components: NodeComponent[]
  samples: Record<string, IpSample>
  runs: Run[]
  settings: Settings
  update: Update
  version: string
}

export interface Desktop {
  snapshot(): Promise<Snapshot>
  getWorkflow(id: string): Promise<Workflow | undefined>
  save(workflow: Workflow): Promise<void>
  saveComponent(component: ComponentInput): Promise<void>
  remove(id: string): Promise<void>
  enable(id: string, enabled: boolean): Promise<void>
  run(id: string, draft?: Graph): Promise<void>
  pickPath(target: 'file' | 'directory' | 'write'): Promise<string | undefined>
  probe(site: SiteConfig): Promise<SiteResult>
  settings(settings: Omit<Settings, 'hasAiKey' | 'theme' | 'autoCheckUpdate'> & { aiKey?: string }): Promise<void>
  testAi(settings: { aiUrl: string; aiModel: string; aiKey?: string }): Promise<void>
  setTheme(theme: Theme): Promise<void>
  setAutoCheckUpdate(enabled: boolean): Promise<void>
  generate(prompt: string): Promise<Workflow>
  revise(prompt: string, draft: Graph): Promise<Graph>
  update(action: 'check' | 'apply'): Promise<Update>
  openExternal(target: ExternalLink): Promise<void>
  subscribe(callback: () => void): () => void
  onNavigate(callback: (path: string) => void): () => void
}
export type Invocation = Exclude<keyof Desktop, 'subscribe' | 'onNavigate'>
