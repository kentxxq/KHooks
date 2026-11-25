import { randomBytes, timingSafeEqual } from 'node:crypto'
import { once } from 'node:events'
import { rm } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { join } from 'node:path'
import writeFileAtomic from 'write-file-atomic'
import { InvalidWorkflow, WorkflowEnableError, type Workflows } from './workflows'

const host = '127.0.0.1'
const maxBodyBytes = 4 * 1024 * 1024

class RequestError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message)
  }
}

function json(response: ServerResponse, status: number, value: unknown): void {
  response
    .writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'close'
    })
    .end(JSON.stringify(value))
}

async function readGraph(request: IncomingMessage): Promise<unknown> {
  if (Number(request.headers['content-length']) > maxBodyBytes) throw new RequestError(413, '流程 JSON 超过 4 MiB')
  let bytes = 0
  const chunks: Buffer[] = []
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    bytes += chunk.length
    if (bytes > maxBodyBytes) throw new RequestError(413, '流程 JSON 超过 4 MiB')
    chunks.push(chunk)
  }
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)))
  } catch {
    throw new RequestError(400, '需要有效的 UTF-8 流程 JSON')
  }
}

export async function startWorkflowCli(
  profile: string,
  workflows: Workflows,
  report: (cause: unknown) => void
): Promise<() => Promise<void>> {
  const token = randomBytes(32).toString('hex')
  const expected = Buffer.from('Bearer ' + token)
  const descriptor = join(profile, 'workflow-cli.json')

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const supplied = Buffer.from(request.headers.authorization ?? '')
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      throw new RequestError(401, 'CLI 令牌无效，请重新读取运行中的配置')
    }
    if (request.method === 'POST' && (request.url === '/workflows' || request.url === '/workflows?enable=1')) {
      const graph = await readGraph(request)
      json(response, 201, await workflows.createFromGraph(graph, request.url.endsWith('?enable=1')))
      return
    }
    const match = request.method === 'GET' && request.url?.match(/^\/workflows\/([\w-]{1,80})$/)
    if (match) {
      const flow = workflows.get(match[1])
      if (!flow) throw new RequestError(404, '流程不存在')
      json(response, 200, flow)
      return
    }
    throw new RequestError(404, 'CLI 操作不存在')
  }

  const server = createServer(
    { requestTimeout: 5000, headersTimeout: 5000, connectionsCheckingInterval: 1000 },
    (request, response) => {
      void handle(request, response).catch((cause: unknown) => {
        if (response.destroyed) return
        if (cause instanceof RequestError) json(response, cause.status, { error: cause.message })
        else if (cause instanceof InvalidWorkflow) json(response, 400, { error: cause.message })
        else if (cause instanceof WorkflowEnableError)
          json(response, 409, { error: cause.message, workflowId: cause.workflowId })
        else {
          report(cause)
          json(response, 500, { error: '无法处理工作流请求' })
        }
      })
    }
  )
  const listening = once(server, 'listening')
  server.listen(0, host)
  try {
    await listening
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('无法获取工作流 CLI 端口')
    await writeFileAtomic(descriptor, JSON.stringify({ port: address.port, token, pid: process.pid }), { mode: 0o600 })
  } catch (cause) {
    server.close()
    throw cause
  }
  server.on('error', report)
  return async () => {
    await new Promise<void>((done) => server.close(() => done()))
    await rm(descriptor, { force: true })
  }
}
