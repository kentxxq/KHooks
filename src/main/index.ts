import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, nativeTheme, net, Notification, powerMonitor, safeStorage, shell, Tray } from 'electron'
import { autoUpdater } from 'electron-updater'
import { mkdirSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { Engine } from './engine'
import { generateGraph, probe, testAiService, type Fetch } from './network'
import { Storage } from './storage'
import { WindowsEvents } from './windows-events'
import { componentSchema, parseHttpUrl, siteConfig, zodMessage } from '../shared/workflow'
import type { Desktop, Invocation, Settings, Theme, Update } from '../shared/ipc'
import {
  appUserModelId, developmentAppUserModelId, developmentProductName, productName, windowsDevelopmentRuntimePrefix
} from '../shared/app-identity'
import productionIconPath from '../../resources/icon.png?asset'
import developmentIconPath from '../../resources/icon-dev.png?asset'

const development = !app.isPackaged
const iconPath = development ? developmentIconPath : productionIconPath
const appTitle = development ? developmentProductName : productName
const windows = process.platform === 'win32'
const brandedDevelopment = development && windows && basename(dirname(process.execPath)).startsWith(windowsDevelopmentRuntimePrefix)
const developmentToastActivator = '{975DC2E3-03CD-45F9-8722-5F84033FB290}'
const requestedProfile = app.commandLine.getSwitchValue('user-data-dir')
const profile = requestedProfile ? resolve(requestedProfile) : development ? join(app.getPath('appData'), appTitle) : undefined

if (profile) {
  mkdirSync(profile, { recursive: true })
  app.setPath('userData', profile)
  app.setPath('sessionData', profile)
}
if (windows) {
  app.setAppUserModelId(development ? developmentAppUserModelId : appUserModelId)
  if (brandedDevelopment) app.setToastActivatorCLSID(developmentToastActivator)
}

const windowBackground: Record<Theme, string> = { light: '#ffffff', dark: '#0f172a' }

let window: BrowserWindow | undefined
let tray: Tray | undefined
let quitting = false
let draining = false
let update: Update = { state: app.isPackaged ? 'idle' : 'disabled' }
const store = new Storage(join(app.getPath('userData'), 'khooks.json'), notify, console.error)
const fetcher: Fetch = (url, init) => net.fetch(String(url), init)
const engine = new Engine(store, fetcher, console.error, (title, body) => {
  if (windows && development && !brandedDevelopment) {
    throw new Error('请通过项目的开发命令启动 KHooks 后再发送 Windows 通知')
  }
  if (!Notification.isSupported()) throw new Error('系统通知不可用')
  new Notification({ title, body, icon: iconPath }).show()
}, () => {
  const { url, model, encryptedKey } = store.state.ai
  if (!url || !model || !encryptedKey) throw new Error('请先在设置中填写 AI 服务地址、模型和密钥')
  return { url, model, key: decryptAiKey(encryptedKey) }
}, windows ? new WindowsEvents(join(
  development ? join(app.getAppPath(), 'debug', 'tmpfile-AI-windows-events') : join(process.resourcesPath, 'windows-events'),
  'WindowsEvents.exe'
), console.error) : undefined)
const loginArgs = ['--hidden']

function notify(): void {
  if (window && !window.isDestroyed()) window.webContents.send('khooks:changed')
}

function prepareWindowsNotifications(): void {
  if (!windows || (development && !brandedDevelopment)) return
  if (brandedDevelopment) {
    const shortcut = join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', appTitle + '.lnk')
    const options = {
      target: process.execPath,
      cwd: dirname(process.execPath),
      args: '"' + app.getAppPath() + '"',
      icon: process.execPath,
      iconIndex: 0,
      description: appTitle,
      appUserModelId: developmentAppUserModelId,
      toastActivatorClsid: developmentToastActivator
    }
    try {
      let existing: Electron.ShortcutDetails | undefined
      try { existing = shell.readShortcutLink(shortcut) } catch { /* 首次启动时尚未创建快捷方式 */ }
      if (existing?.target !== options.target || existing.cwd !== options.cwd || existing.args !== options.args ||
          existing.icon !== options.icon || existing.appUserModelId !== options.appUserModelId ||
          existing.toastActivatorClsid?.toUpperCase() !== options.toastActivatorClsid) {
        mkdirSync(dirname(shortcut), { recursive: true })
        if (!shell.writeShortcutLink(shortcut, options)) throw new Error('无法注册开发版通知快捷方式')
      }
    } catch (cause) {
      console.error(cause)
    }
  }
  // 提前初始化通知，避免首次发送时才开始注册通知来源。
  Notification.isSupported()
}

function setUpdate(value: Update): void {
  update = value
  notify()
}

function getSettings(): Settings {
  const ai = store.state.ai
  return {
    login: app.isPackaged && app.getLoginItemSettings({ args: loginArgs }).openAtLogin,
    aiUrl: ai.url, aiModel: ai.model, hasAiKey: Boolean(ai.encryptedKey), theme: store.state.theme
  }
}

function decryptAiKey(encryptedKey: string): string {
  if (!safeStorage.isEncryptionAvailable()) throw new Error('系统密钥存储不可用')
  return safeStorage.decryptString(Buffer.from(encryptedKey, 'base64'))
}

function openWindow(): void {
  if (window) {
    window.show()
    window.focus()
    return
  }
  createWindow(true)
}

function createWindow(show: boolean): void {
  const main = new BrowserWindow({
    title: appTitle,
    width: 1440, height: 900, minWidth: 980, minHeight: 660,
    show: false, backgroundColor: windowBackground[store.state.theme], icon: iconPath,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true, sandbox: true, nodeIntegration: false
    }
  })
  window = main
  main.on('page-title-updated', (event) => event.preventDefault())
  if (show) main.once('ready-to-show', () => main.show())
  main.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  main.webContents.on('will-navigate', (event) => event.preventDefault())
  main.on('close', (event) => {
    if (quitting) return
    event.preventDefault()
    main.hide()
  })
  main.on('closed', () => { window = undefined })
  const devUrl = process.env.ELECTRON_RENDERER_URL
  if (!app.isPackaged && devUrl) void main.loadURL(devUrl)
  else void main.loadFile(join(__dirname, '../renderer/index.html'))
}

async function quit(): Promise<void> {
  if (draining) return
  draining = true
  engine.shutdown()
  await engine.drain()
  quitting = true
  tray?.destroy()
  app.quit()
}

function reportUpdateError(cause: Error & { code?: string }): void {
  if (cause.code === 'ERR_UPDATER_NO_PUBLISHED_VERSIONS' ||
      (cause.code === 'ERR_XML_MISSED_ELEMENT' && cause.message === 'No published versions on GitHub')) {
    setUpdate({ state: 'unpublished' })
  } else {
    const messages: Partial<Record<Update['state'], string>> = {
      checking: '无法检查更新，请检查网络后重试',
      downloading: '无法下载更新，请检查网络后重试',
      installing: '无法启动更新安装程序'
    }
    const error = cause.code === 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND'
      ? '正式版本缺少更新文件'
      : messages[update.state] ?? '更新失败'
    setUpdate({ state: 'error', error })
  }
}

function configureUpdater(): void {
  if (!app.isPackaged) return
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = false
  autoUpdater.allowPrerelease = false
  autoUpdater.on('checking-for-update', () => setUpdate({ state: 'checking' }))
  autoUpdater.on('update-available', (info) => setUpdate({ state: 'available', version: info.version }))
  autoUpdater.on('update-not-available', () => setUpdate({ state: 'current' }))
  autoUpdater.on('download-progress', (progress) => setUpdate({ ...update, state: 'downloading', percent: progress.percent }))
  autoUpdater.on('error', reportUpdateError)
  void autoUpdater.checkForUpdates().catch(() => {})
}

function registerIpc(): void {
  const idSchema = z.string().regex(/^[\w-]{1,80}$/)
  const aiInput = z.strictObject({
    aiUrl: z.string().max(1000), aiModel: z.string().trim().max(200), aiKey: z.string().max(4000).optional()
  })
  const settingsInput = aiInput.extend({ login: z.boolean() })
  function bind<K extends Invocation>(channel: K, handler: Desktop[K]): void {
    ipcMain.handle('khooks:' + channel, (event, ...args: Parameters<Desktop[K]>) => {
      if (event.sender !== window?.webContents || event.senderFrame !== window?.webContents.mainFrame || draining) {
        throw new Error('应用当前无法处理此请求')
      }
      return (handler as (...params: Parameters<Desktop[K]>) => ReturnType<Desktop[K]>)(...args)
    })
  }
  bind('snapshot', async () => ({
    workflows: store.state.workflows, samples: store.state.samples, runs: store.state.runs,
    components: store.state.components,
    settings: getSettings(), update, version: app.getVersion()
  }))
  // 不做预解析:engine.save 内部已做 schema parse 并转译中文,预解析会抢先抛出 zod 英文 dump。
  bind('save', (flow) => engine.save(flow))
  bind('saveComponent', async (input) => {
    const component = componentSchema.parse({ ...input, id: randomUUID() })
    await store.change((state) => { state.components.push(component) })
  })
  bind('remove', (id) => engine.remove(idSchema.parse(id)))
  bind('enable', (id, enabled) => engine.enable(idSchema.parse(id), z.boolean().parse(enabled)))
  bind('run', (id, draft) => engine.run(idSchema.parse(id), draft, draft === undefined ? 'saved' : 'preview'))
  bind('pickPath', async (input) => {
    const target = z.enum(['file', 'directory', 'write']).parse(input)
    if (!window) return
    if (target === 'write') {
      const result = await dialog.showSaveDialog(window, { title: '选择写入路径' })
      return result.filePath
    }
    const result = await dialog.showOpenDialog(window, { properties: [target === 'file' ? 'openFile' : 'openDirectory'] })
    return result.filePaths[0]
  })
  bind('probe', (config) => probe(siteConfig.parse(config), fetcher))
  bind('settings', async (input) => {
    // 设置 schema 拒绝时转译为中文,避免渲染层 toast 弹出 zod 英文 dump。
    const parsed = settingsInput.safeParse(input)
    if (!parsed.success) throw new Error('设置无效：' + zodMessage(parsed.error))
    const { login, aiUrl, aiModel, aiKey } = parsed.data
    let url = ''
    if (aiUrl.trim()) url = parseHttpUrl(aiUrl.trim()).toString()
    let encrypted: string | undefined
    if (aiKey !== undefined) {
      if (!aiKey) encrypted = ''
      else {
        if (!safeStorage.isEncryptionAvailable()) throw new Error('系统密钥存储不可用')
        encrypted = safeStorage.encryptString(aiKey).toString('base64')
      }
    }
    await store.change((state) => {
      const sameService = state.ai.url === url
      state.ai = { url, model: aiModel, encryptedKey: encrypted ?? (sameService ? state.ai.encryptedKey : '') }
    })
    if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: login, args: loginArgs })
    notify()
  })
  bind('setTheme', async (value) => {
    const theme = z.enum(['light', 'dark']).parse(value)
    await store.change((state) => { state.theme = theme })
    nativeTheme.themeSource = store.state.theme
    window?.setBackgroundColor(windowBackground[store.state.theme])
  })
  bind('testAi', async (input) => {
    const { aiUrl, aiModel, aiKey } = aiInput.parse(input)
    if (!aiUrl.trim() || !aiModel) throw new Error('请填写 AI 服务地址和模型')
    const url = parseHttpUrl(aiUrl.trim()).toString()
    const saved = store.state.ai
    let key = aiKey
    if (!key && saved.url === url && saved.encryptedKey) key = decryptAiKey(saved.encryptedKey)
    if (!key) throw new Error('请填写 API 密钥')
    await testAiService({ url, model: aiModel, key }, fetcher)
  })
  bind('generate', async (value) => {
    const prompt = z.string().trim().min(1).max(8000).parse(value)
    const { url, model, encryptedKey } = store.state.ai
    if (!url || !model || !encryptedKey) throw new Error('请先在设置中填写 AI 服务地址、模型和密钥')
    const key = decryptAiKey(encryptedKey)
    const graph = await generateGraph({ url, model, key }, prompt, fetcher)
    const workflow = { ...graph, id: randomUUID(), enabled: false }
    await engine.save(workflow)
    return workflow
  })
  bind('update', async (action) => {
    if (!app.isPackaged || update.state === 'downloading' || update.state === 'installing') return update
    switch (action) {
      case 'check':
        await autoUpdater.checkForUpdates().catch(() => {})
        break
      case 'apply': {
        if (update.state !== 'available') return update
        const version = update.version
        setUpdate({ ...update, state: 'downloading', percent: 0 })
        const files = await autoUpdater.downloadUpdate().catch(() => undefined)
        if (!files?.length || draining) return update
        setUpdate({ state: 'installing', version })
        autoUpdater.quitAndInstall(true, true)
        break
      }
    }
    return update
  })
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => { if (tray && !draining) openWindow() })
  app.on('activate', () => { if (tray && !draining) openWindow() })
  app.on('before-quit', (event) => {
    if (quitting || !tray) return
    event.preventDefault()
    void quit()
  })
  void app.whenReady().then(async () => {
    Menu.setApplicationMenu(null)
    await store.open()
    prepareWindowsNotifications()
    nativeTheme.themeSource = store.state.theme
    registerIpc()
    tray = new Tray(nativeImage.createFromPath(iconPath))
    tray.setToolTip(appTitle)
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: '打开', click: openWindow },
      { type: 'separator' },
      { label: '退出', click: () => { void quit() } }
    ]))
    tray.on('double-click', openWindow)
    if (!process.argv.includes('--hidden')) openWindow()
    powerMonitor.on('suspend', () => engine.stop())
    powerMonitor.on('resume', () => { if (!draining) engine.start(false) })
    engine.start()
    configureUpdater()
  }).catch(() => {
    dialog.showErrorBox(appTitle, '无法打开本地数据或启动应用。')
    app.exit(1)
  })
}
