import { randomUUID } from 'node:crypto'
import type { Engine } from './engine'
import type { Storage } from './storage'
import { graphSchema, validateWorkflow, zodMessage, type Workflow } from '../shared/workflow'

export class InvalidWorkflow extends Error {}

export class WorkflowEnableError extends Error {
  constructor(readonly workflowId: string, cause: unknown) {
    super('流程已保存，但启用失败：' + (cause instanceof Error ? cause.message : String(cause)), { cause })
  }
}

export class Workflows {
  constructor(private readonly store: Storage, private readonly engine: Engine) {}

  get(id: string): Workflow | undefined {
    return this.store.state.workflows.find((flow) => flow.id === id)
  }

  save(flow: Workflow): Promise<void> {
    return this.engine.save(flow)
  }

  async createFromGraph(input: unknown, enable = false): Promise<Workflow> {
    const result = graphSchema.safeParse(input)
    if (!result.success) throw new InvalidWorkflow('流程格式无效：' + zodMessage(result.error))
    const error = validateWorkflow(result.data)
    if (error) throw new InvalidWorkflow('流程未通过校验：' + error)

    const flow: Workflow = { ...result.data, id: randomUUID(), enabled: false }
    await this.save(flow)
    if (enable) {
      try {
        await this.engine.enable(flow.id, true)
      } catch (cause) {
        throw new WorkflowEnableError(flow.id, cause)
      }
    }
    return { ...flow, enabled: enable }
  }
}
