import { execFile } from 'node:child_process'
import { mkdir, mkdtemp } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test'

const executablePath = process.env.KHOOKS_INSTALLED_EXECUTABLE
const runDuplicate = promisify(execFile)

test('安装版关窗后与开发版并行运行，各自保持单实例和独立配置', async () => {
  test.skip(!executablePath, '需要用 NSIS 安装当前构建后指定已安装程序路径')
  await mkdir('debug', { recursive: true })
  const profile = await mkdtemp(resolve('debug/tmpfile-AI-installed-profile-'))
  const application = await electron.launch({ executablePath, args: ['--user-data-dir=' + profile] })
  const page = await application.firstWindow()
  let restoreLogin: boolean | undefined
  let dev: ElectronApplication | undefined
  try {
    await expect(page.getByRole('heading', { name: '流程', exact: true })).toBeVisible()
    expect(await application.evaluate(({ app }) => app.isPackaged)).toBe(true)
    await expect(page.locator('html')).toHaveClass('light')
    await application.evaluate(({ session }, ip) => {
      const state = globalThis as typeof globalThis & { fixtureIp: string }
      state.fixtureIp = ip
      session.defaultSession.protocol.handle('https', (request) => {
        if (new URL(request.url).hostname !== 'api.ipify.org') return new Response(null, { status: 404 })
        return new Response(state.fixtureIp)
      })
    }, '203.0.113.10')

    await page.getByRole('link', { name: '设置' }).click()
    const login = page.getByLabel('登录 Windows 后自动启动')
    restoreLogin = await login.isChecked()
    await login.setChecked(!restoreLogin)
    await page.getByRole('button', { name: '保存设置' }).click()
    await expect(page.getByRole('status')).toHaveText('已保存')
    expect(await application.evaluate(({ app }) => app.getLoginItemSettings({ args: ['--hidden'] }).openAtLogin)).toBe(
      !restoreLogin
    )
    await page.screenshot({ path: 'debug/tmpfile-AI-installed-settings.png' })

    await page.evaluate(async () => {
      await window.khooks.save({
        id: 'installed-ip',
        name: '安装版轮询',
        enabled: false,
        nodes: [
          { id: 'ip', type: 'ip', seconds: 1, sites: [{ id: 'ipify', mode: 'text', path: '' }], x: 0, y: 0 },
          {
            id: 'condition',
            type: 'condition',
            field: 'ip.distinctIpCount',
            operator: 'exists',
            value: '',
            x: 240,
            y: 0
          }
        ],
        edges: [{ id: 'edge', from: 'ip', to: 'condition', port: 'next' }]
      })
      await window.khooks.enable('installed-ip', true)
    })
    await page.getByRole('link', { name: '流程', exact: true }).click()
    await page.getByRole('link', { name: /安装版轮询/ }).click()
    await expect(page.getByTestId('latest-ip')).toContainText('203.0.113.10')

    const main = await application.browserWindow(page)
    await main.evaluate((window) => window.close())
    await expect.poll(() => main.evaluate((window) => window.isVisible())).toBe(false)
    const devProfile = await mkdtemp(resolve('debug/tmpfile-AI-parallel-dev-'))
    const devExecutable = join(process.cwd(), 'node_modules', 'electron', 'dist', 'electron.exe')
    const devArgs = [process.cwd(), '--user-data-dir=' + devProfile]
    dev = await electron.launch({ executablePath: devExecutable, args: devArgs })
    const devPage = await dev.firstWindow()
    const devWindow = await dev.browserWindow(devPage)
    await expect(devPage.getByRole('heading', { name: '流程', exact: true })).toBeVisible()
    expect(await devWindow.evaluate((window) => window.getTitle())).toBe('KHooks Dev')
    expect(
      await dev.evaluate(({ app }) => ({
        userData: app.getPath('userData'),
        sessionData: app.getPath('sessionData')
      }))
    ).toEqual({ userData: devProfile, sessionData: devProfile })
    await expect(devPage.getByText('暂无流程', { exact: true })).toBeVisible()
    await devPage.getByRole('button', { name: '新建流程' }).first().click()
    await expect(devPage.getByLabel('流程名称')).toHaveValue('未命名流程')
    await devPage.getByRole('link', { name: '设置', exact: true }).click()
    await devPage.getByLabel('主题', { exact: true }).selectOption('dark')
    await expect(devPage.locator('html')).toHaveClass('dark')
    await expect(page.locator('html')).toHaveClass('light')
    expect(await page.evaluate(async () => (await window.khooks.snapshot()).workflows.length)).toBe(1)

    await devWindow.evaluate((window) => window.close())
    await expect.poll(() => devWindow.evaluate((window) => window.isVisible())).toBe(false)
    await runDuplicate(devExecutable, devArgs, { windowsHide: true, timeout: 5000 })
    await expect.poll(() => devWindow.evaluate((window) => window.isVisible())).toBe(true)
    expect(await main.evaluate((window) => window.isVisible())).toBe(false)
    await application.evaluate((_, ip) => {
      const state = globalThis as typeof globalThis & { fixtureIp: string }
      state.fixtureIp = ip
    }, '203.0.113.11')
    await expect.poll(() => page.getByTestId('latest-ip').textContent()).toContain('203.0.113.11')
    await dev.close()
    dev = undefined
    await application.evaluate((_, ip) => {
      const state = globalThis as typeof globalThis & { fixtureIp: string }
      state.fixtureIp = ip
    }, '203.0.113.12')
    await expect.poll(() => page.getByTestId('latest-ip').textContent()).toContain('203.0.113.12')

    await runDuplicate(executablePath!, ['--user-data-dir=' + profile], { windowsHide: true, timeout: 5000 })
    await expect.poll(() => main.evaluate((window) => window.isVisible())).toBe(true)
    await page.locator('main').getByRole('link', { name: '运行记录' }).click()
    await expect(page.getByText('成功', { exact: true })).toHaveCount(2)
  } finally {
    try {
      if (restoreLogin !== undefined)
        await application.evaluate(({ app }, value) => {
          app.setLoginItemSettings({ openAtLogin: value, args: ['--hidden'] })
        }, restoreLogin)
    } finally {
      await Promise.all([dev?.close(), application.close()])
    }
  }
})
