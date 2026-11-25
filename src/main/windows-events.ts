import { spawn, type ChildProcess } from 'node:child_process'
import { createInterface } from 'node:readline'
import { z } from 'zod'
import { systemEventSchema } from '../shared/workflow'

// 非媒体事件不带 appId,归一化为 null,与手动运行载荷及 UI 输出字段形状一致。
export const eventSchema = z.strictObject({
  event: systemEventSchema,
  state: z.boolean(),
  appId: z
    .string()
    .nullish()
    .transform((value) => value ?? null),
  triggeredAt: z.iso.datetime()
})
type Event = z.infer<typeof eventSchema>
type Listener = (event: Event) => void

export interface SystemEventSource {
  subscribe(signal: AbortSignal, listener: Listener): void
}

export class WindowsEvents implements SystemEventSource {
  private readonly listeners = new Set<Listener>()
  private child?: ChildProcess
  private retry?: ReturnType<typeof setTimeout>
  private delay = 1000

  constructor(
    private readonly executable: string,
    private readonly report: (message: string) => void
  ) {}

  subscribe(signal: AbortSignal, listener: Listener): void {
    if (signal.aborted) return
    this.listeners.add(listener)
    signal.addEventListener(
      'abort',
      () => {
        this.listeners.delete(listener)
        if (this.listeners.size) return
        clearTimeout(this.retry)
        this.retry = undefined
        this.delay = 1000
        const child = this.child
        this.child = undefined
        child?.kill()
      },
      { once: true }
    )
    if (!this.child && !this.retry) this.start()
  }

  private start(): void {
    if (!this.listeners.size) return
    const child = spawn(this.executable, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    this.child = child
    const started = Date.now()
    const stdout = createInterface({ input: child.stdout })
    stdout.on('line', (line) => {
      if (this.child !== child) return
      try {
        const event = eventSchema.parse(JSON.parse(line))
        for (const listener of this.listeners) listener(event)
      } catch {
        this.report('Windows 事件数据无效')
      }
    })
    const stderr = createInterface({ input: child.stderr })
    stderr.on('line', (line) => {
      if (this.child === child) this.report('Windows 事件监听：' + line)
    })
    child.stdin.on('error', () => {})
    const reconnect = (message: string) => {
      stdout.close()
      stderr.close()
      if (this.child !== child) return
      this.child = undefined
      this.report(message)
      if (!this.listeners.size) return
      if (Date.now() - started > 30000) this.delay = 1000
      this.retry = setTimeout(() => {
        this.retry = undefined
        this.start()
      }, this.delay)
      this.delay = Math.min(this.delay * 2, 30000)
    }
    child.once('error', () => reconnect('无法启动 Windows 事件监听程序'))
    child.once('close', () => reconnect('Windows 事件监听程序已退出'))
  }
}
