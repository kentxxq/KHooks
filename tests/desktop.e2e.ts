import { createServer as createHttpServer, type Server } from 'node:http'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { _electron as electron, expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test'
import type { ViteDevServer } from 'vite'

let application: ElectronApplication | undefined
let vite: ViteDevServer | undefined
let receiver: Server | undefined

async function wire(page: Page, from: Locator, to: Locator): Promise<void> {
  await to.hover()
  await from.hover()
  const source = await from.boundingBox()
  const target = await to.boundingBox()
  if (!source || !target) throw new Error('找不到画布连线端口')
  await page.mouse.move(source.x + source.width / 2, source.y + source.height / 2)
  await page.mouse.down()
  await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2, { steps: 16 })
  await page.mouse.up()
}

test.afterEach(async ({}, info) => {
  try {
    if (info.status !== info.expectedStatus && application) {
      await (await application.firstWindow()).screenshot({ path: 'debug/tmpfile-AI-e2e-failure.png' })
    }
  } finally {
    const activeReceiver = receiver
    await Promise.allSettled([
      application?.close(), vite?.close(), activeReceiver ? new Promise<void>((done) => {
        activeReceiver.close(() => done())
        activeReceiver.closeAllConnections()
      }) : undefined
    ])
  }
})

test('在开发版画布编排公网 IP 变化流程并从运行记录查看执行路径', async () => {
  await mkdir('debug', { recursive: true })
  const profile = await mkdtemp(resolve('debug/tmpfile-AI-electron-profile-'))
  await writeFile(join(profile, 'khooks.json'), JSON.stringify({
    version: 1, workflows: [], baselines: {}, samples: {}, runs: [],
    ai: { url: '', model: '', encryptedKey: '' }
  }))
  const { resolveConfig } = await import('electron-vite')
  const { createServer } = await import('vite')
  const config = (await resolveConfig({ root: process.cwd() }, 'serve', 'development')).config?.renderer
  if (!config) throw new Error('缺少 Electron 渲染进程配置')
  vite = await createServer({
    ...config, configFile: false, server: { ...config.server, host: '127.0.0.1', port: 0 }
  })
  await vite.listen()
  const url = vite.resolvedUrls?.local[0]
  if (!url) throw new Error('开发服务器地址不可用')

  const captures: unknown[] = []
  const aiCalls: unknown[] = []
  let callbackStatus = 204
  const server = createHttpServer(async (request, response) => {
    const parts: Buffer[] = []
    for await (const part of request) parts.push(part)
    const body = JSON.parse(Buffer.concat(parts).toString())
    if (request.url === '/v1/chat/completions') {
      aiCalls.push({ body, authorization: request.headers.authorization })
      const draft = {
        name: 'AI 手动流程',
        nodes: [
          { id: 'start', type: 'manual', x: 0, y: 0 },
          { id: 'send', type: 'http', x: 240, y: 0, method: 'POST', url: 'https://fake_url', headers: [], body: '' }
        ],
        edges: [{ id: 'edge', from: 'start', to: 'send', port: 'next' }]
      }
      response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(draft) } }] }))
      return
    }
    captures.push({ path: request.url, body })
    response.writeHead(callbackStatus).end()
  })
  receiver = server
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  const address = receiver.address()
  if (!address || typeof address === 'string') throw new Error('回调测试服务地址不可用')

  const launchOptions = {
    args: [process.cwd(), '--user-data-dir=' + profile],
    executablePath: join(process.cwd(), 'node_modules', 'electron', 'dist', 'electron.exe'),
    env: { ...process.env, ELECTRON_RENDERER_URL: url }
  }
  application = await electron.launch(launchOptions)
  const page = await application.firstWindow()
  await expect(page.getByRole('heading', { name: '流程', exact: true })).toBeVisible()
  await expect(page.locator('html')).toHaveClass('light')
  await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(255, 255, 255)')
  expect(await application.evaluate(({ nativeTheme }) => nativeTheme.themeSource)).toBe('light')
  const rendererErrors: string[] = []
  page.on('pageerror', (error) => rendererErrors.push(error.message))
  const fixture = { ip: '203.0.113.10' }
  await application.evaluate(({ session }, initialIp) => {
    const state = globalThis as typeof globalThis & { fixtureIp: string }
    state.fixtureIp = initialIp
    session.defaultSession.protocol.handle('https', (request) => {
      const url = new URL(request.url)
      if (!['api.ipify.org', 'checkip.amazonaws.com'].includes(url.hostname)) return new Response(null, { status: 404 })
      return url.searchParams.has('format') ? Response.json({ ip: state.fixtureIp }) : new Response(state.fixtureIp)
    })
  }, fixture.ip)

  await page.getByRole('button', { name: '新建流程' }).first().click()
  await page.getByLabel('流程名称').fill('公网地址事件')
  await page.getByRole('button', { name: '公网 IP 变化', exact: true }).click()
  await page.getByRole('spinbutton', { name: '轮询间隔（秒）' }).fill('1')
  await page.getByRole('checkbox', { name: 'ipify' }).check()
  await page.getByRole('checkbox', { name: 'AWS Check IP' }).check()
  await page.getByRole('button', { name: '测试 AWS Check IP' }).click()
  await expect(page.locator('output')).toHaveText(fixture.ip)
  await page.locator('#mode-ipify').selectOption('json')
  await page.getByLabel('JSONPath').fill('$.missing')
  await page.getByRole('button', { name: '测试 ipify' }).click()
  await expect(page.locator('output').first()).toHaveText('JSONPath 必须匹配一个值')
  await page.getByLabel('JSONPath').fill('$.ip')
  await page.getByRole('button', { name: '测试 ipify' }).click()
  await expect(page.locator('output').first()).toHaveText(fixture.ip)

  await page.getByRole('button', { name: '条件分支', exact: true }).click()
  await page.getByRole('button', { name: 'HTTP 请求', exact: true }).click()
  const trigger = page.getByTestId('node-ip')
  const condition = page.getByTestId('node-condition')
  const http = page.getByTestId('node-http')
  await wire(page, trigger.locator('[data-handleid="next"]'), condition.locator('[data-handleid="in"]'))
  await expect(page.getByText('3 个节点 · 1 条连线')).toBeVisible()
  const triggerId = await trigger.locator('xpath=ancestor::*[@data-id][1]').getAttribute('data-id')
  expect(triggerId).toBeTruthy()
  await page.getByLabel('上游字段').fill(triggerId + '.distinctIpCount')
  await page.getByLabel('比较值').fill('1')
  await wire(page, condition.locator('[data-handleid="yes"]'), http.locator('[data-handleid="in"]'))
  await expect(page.getByText('3 个节点 · 2 条连线')).toBeVisible()
  await page.getByLabel('请求方法').selectOption('POST')
  await page.getByLabel('请求地址').fill('http://127.0.0.1:' + address.port + '/changed')
  await page.getByLabel('JSON 请求体').fill(JSON.stringify({
    ip: '@{' + triggerId + '.winnerIp}', count: '@{' + triggerId + '.distinctIpCount}'
  }))

  const nodePosition = await http.boundingBox()
  if (!nodePosition) throw new Error('找不到可拖动的 HTTP 节点')
  await page.mouse.move(nodePosition.x + 65, nodePosition.y + 24)
  await page.mouse.down()
  await page.mouse.move(nodePosition.x + 75, nodePosition.y + 79, { steps: 10 })
  await page.mouse.up()

  await page.getByRole('button', { name: '启用', exact: true }).click()
  await expect(page.getByTestId('latest-ip')).toContainText(fixture.ip)
  const stored = await page.evaluate(async () => (await window.khooks.snapshot()).workflows[0])
  expect(stored.nodes.find((node) => node.type === 'http')?.y).toBeGreaterThan(25)
  expect(captures).toHaveLength(0)
  await page.screenshot({ path: 'debug/tmpfile-AI-editor.png' })

  await application.evaluate((_, value) => {
    const state = globalThis as typeof globalThis & { fixtureIp: string }
    state.fixtureIp = value
  }, '203.0.113.11')
  await expect.poll(() => captures).toEqual([{ path: '/changed', body: { ip: '203.0.113.11', count: 1 } }])
  await page.locator('main').getByRole('link', { name: '运行记录' }).click()
  await page.locator('main').getByRole('link', { name: /公网地址事件/ }).click()
  await expect(page.getByText('成功', { exact: true })).toBeVisible()
  await expect(page.locator('.flow-card.executed')).toHaveCount(3)
  await expect(page.locator('.execution-edge')).toHaveCount(2)
  await expect(page.locator('.vue-flow')).toHaveCSS('color-scheme', 'light')
  await page.getByRole('button', { name: '公网 IP 变化', exact: true }).click()
  await expect(page.locator('pre')).toContainText('"winnerIp": "203.0.113.11"')
  await page.screenshot({ path: 'debug/tmpfile-AI-run.png' })
  await page.getByRole('link', { name: '设置', exact: true }).click()
  await page.getByLabel('OpenAI 兼容服务地址').fill('http://127.0.0.1:' + address.port + '/v1')
  await page.getByLabel('模型', { exact: true }).fill('fake_info')
  await page.getByLabel('API 密钥').fill('fake_key')
  await page.getByRole('button', { name: '保存设置' }).click()
  await expect(page.getByRole('status')).toHaveText('已保存')
  expect(await readFile(join(profile, 'khooks.json'), 'utf8')).not.toContain('fake_key')

  await page.getByRole('link', { name: '流程', exact: true }).click()
  await page.getByRole('button', { name: 'AI 生成', exact: true }).click()
  await page.getByLabel('流程需求').fill('创建手动发送 HTTP 请求的流程')
  await page.getByRole('button', { name: '生成草稿' }).click()
  await expect(page.getByLabel('流程名称')).toHaveValue('AI 手动流程')
  await expect(page.getByText('已停用', { exact: true })).toBeVisible()
  expect(aiCalls).toMatchObject([{ authorization: 'Bearer fake_key', body: { model: 'fake_info' } }])
  expect(captures).toHaveLength(1)
  await page.getByRole('link', { name: '设置', exact: true }).click()
  await page.getByLabel('主题', { exact: true }).selectOption('dark')
  await expect(page.locator('html')).toHaveClass('dark')
  expect(await application.evaluate(({ nativeTheme }) => nativeTheme.themeSource)).toBe('dark')
  await page.getByRole('link', { name: '流程', exact: true }).click()
  await page.getByRole('link', { name: /公网地址事件/ }).click()
  await expect(page.locator('.vue-flow')).toHaveCSS('color-scheme', 'dark')
  await expect(page.getByTestId('node-condition').locator('[data-handleid="no"]')).toBeVisible()
  await page.screenshot({ path: 'debug/tmpfile-AI-editor-dark.png' })

  callbackStatus = 503
  await application.evaluate((_, value) => {
    const state = globalThis as typeof globalThis & { fixtureIp: string }
    state.fixtureIp = value
  }, '203.0.113.12')
  await page.locator('main').getByRole('link', { name: '运行记录' }).click()
  await page.getByRole('link', { name: /公网地址事件.*失败/ }).click()
  await expect(page.locator('.vue-flow')).toHaveCSS('color-scheme', 'dark')
  await expect(page.locator('.execution-edge')).toHaveCount(2)
  await expect(page.locator('.flow-card.failed')).toHaveCount(1)
  await page.getByRole('button', { name: 'HTTP 请求', exact: true }).click()
  await expect(page.getByRole('alert')).toHaveText('HTTP 503')
  await page.screenshot({ path: 'debug/tmpfile-AI-run-dark.png' })
  expect(rendererErrors).toEqual([])

  await page.evaluate((id) => window.khooks.enable(id, false), stored.id)
  await application.close()
  application = await electron.launch(launchOptions)
  const reopened = await application.firstWindow()
  await reopened.getByRole('link', { name: '设置', exact: true }).click()
  await expect(reopened.getByLabel('主题', { exact: true })).toHaveValue('dark')
  await expect(reopened.locator('html')).toHaveClass('dark')
  expect(await application.evaluate(({ nativeTheme }) => nativeTheme.themeSource)).toBe('dark')
  await reopened.getByLabel('主题', { exact: true }).selectOption('light')
  await expect(reopened.locator('body')).toHaveCSS('background-color', 'rgb(255, 255, 255)')
})
