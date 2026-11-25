import { readFile, stat } from 'node:fs/promises'
import { request } from 'node:http'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { parseArgs } from 'node:util'

const usage = [
  '用法：khooks workflow create <文件> [--enable] [--profile-path <目录>]',
  '      khooks workflow get <ID> [--profile-path <目录>]'
].join('\n')
const maxGraphBytes = 4 * 1024 * 1024

function defaultProfile() {
  const home = homedir()
  if (process.platform === 'win32') return join(process.env.APPDATA || join(home, 'AppData', 'Roaming'), 'KHooks')
  if (process.platform === 'darwin') return join(home, 'Library', 'Application Support', 'KHooks')
  return join(process.env.XDG_CONFIG_HOME || join(home, '.config'), 'KHooks')
}

async function readEndpoint(profile) {
  try {
    const endpoint = JSON.parse(await readFile(join(profile, 'workflow-cli.json'), 'utf8'))
    const { port, token, pid } = endpoint
    if (
      !Number.isInteger(port) ||
      port < 1 ||
      port > 65535 ||
      typeof token !== 'string' ||
      !/^[0-9a-f]{64}$/.test(token) ||
      !Number.isInteger(pid) ||
      pid <= 0
    )
      throw new Error()
    process.kill(pid, 0)
    return { port, token }
  } catch {
    throw new Error('找不到正在运行的 KHooks CLI，请检查应用版本和数据目录。')
  }
}

async function call(endpoint, path, body) {
  let statusCode
  let text = ''
  try {
    const headers = { Authorization: `Bearer ${endpoint.token}` }
    if (body) {
      headers['Content-Type'] = 'application/json'
      headers['Content-Length'] = body.length
    }
    const connection = request({
      hostname: '127.0.0.1',
      port: endpoint.port,
      path,
      method: body ? 'POST' : 'GET',
      headers,
      agent: false,
      signal: AbortSignal.timeout(15000)
    })
    const received = new Promise((resolve, reject) => {
      connection.once('response', resolve)
      connection.once('error', reject)
    })
    connection.end(body)
    const response = await received
    statusCode = response.statusCode
    response.setEncoding('utf8')
    for await (const chunk of response) text += chunk
  } catch {
    throw new Error('无法连接指定数据目录的 KHooks CLI，或请求已超时。')
  }
  let result
  try {
    result = JSON.parse(text)
  } catch {
    throw new Error('KHooks CLI 返回了无效响应。')
  }
  if (statusCode >= 200 && statusCode < 300) return result
  const message = result?.error || `KHooks CLI 请求失败（HTTP ${statusCode}）。`
  throw new Error(result?.workflowId ? `${message}（草稿 ID：${result.workflowId}）` : message)
}

async function main() {
  let args
  try {
    args = parseArgs({
      allowPositionals: true,
      options: {
        enable: { type: 'boolean' },
        'profile-path': { type: 'string' },
        help: { type: 'boolean', short: 'h' }
      }
    })
  } catch {
    throw new Error(usage)
  }
  if (args.values.help) {
    process.stdout.write(usage + '\n')
    return
  }
  const [resource, action, value] = args.positionals
  if (
    args.positionals.length !== 3 ||
    resource !== 'workflow' ||
    !value ||
    (action !== 'create' && (action !== 'get' || args.values.enable)) ||
    args.values['profile-path'] === ''
  ) {
    throw new Error(usage)
  }
  if (action === 'get' && !/^[A-Za-z0-9_-]{1,80}$/.test(value)) throw new Error('流程 ID 无效。')
  const endpoint = await readEndpoint(args.values['profile-path'] ?? defaultProfile())
  let path = `/workflows/${value}`
  let body
  if (action === 'create') {
    const file = await stat(value).catch(() => undefined)
    if (!file?.isFile()) throw new Error('请选择流程 JSON 文件。')
    if (file.size > maxGraphBytes) throw new Error('流程 JSON 超过 4 MiB。')
    body = await readFile(value)
    path = args.values.enable ? '/workflows?enable=1' : '/workflows'
  }
  const result = await call(endpoint, path, body)
  process.stdout.write(JSON.stringify(result) + '\n')
}

main().catch((error) => {
  process.stderr.write((error instanceof Error ? error.message : String(error)) + '\n')
  process.exitCode = 1
})
