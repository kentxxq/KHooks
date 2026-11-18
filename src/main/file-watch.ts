import { watch, type FSWatcher } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { dirname, join, normalize } from 'node:path'
import { type fileEvents, type FlowNode } from '../shared/workflow'

type Node = Extract<FlowNode, { type: 'fileWatch' }>
type Entry = { directory: boolean; stamp: string }
type Change = { event: keyof typeof fileEvents; path: string; isDirectory: boolean; triggeredAt: string }

async function entry(path: string): Promise<Entry | undefined> {
  try {
    const info = await stat(path, { bigint: true })
    return { directory: info.isDirectory(), stamp: [info.ino, info.size, info.mtimeNs, info.ctimeNs].join(':') }
  } catch (error) {
    if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) return
    throw error
  }
}

export function watchFiles(node: Node, signal: AbortSignal, submit: (change: Change) => void, report: (message: string) => void): void {
  const path = normalize(node.path)
  let previous: Map<string, Entry> | undefined
  let directory: string | undefined
  let watcher: FSWatcher | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let reading = false
  let pending = false
  let lastError = ''
  const quietAt = new Map<string, number>()
  const pathKey = (value: string) => process.platform === 'win32' ? value.toLowerCase() : value

  function refresh(delay = 300): void {
    if (signal.aborted || timer) return
    timer = setTimeout(() => {
      timer = undefined
      void scan()
    }, delay)
  }

  function follow(target: string): void {
    if (directory === target && watcher) return
    watcher?.close()
    watcher = undefined
    directory = target
    try {
      const current = watch(target, (_, name) => {
        if (name) {
          const candidate = pathKey(join(target, name))
          if (target === path || candidate === pathKey(path)) quietAt.set(candidate, Date.now() + 300)
        }
        refresh()
      })
      watcher = current
      current.on('error', () => {
        current.close()
        if (watcher === current) watcher = undefined
        refresh()
      })
    } catch { /* 目录重新可访问时由定期扫描重新绑定。 */ }
  }

  async function scan(): Promise<void> {
    if (signal.aborted) return
    if (reading) {
      pending = true
      return
    }
    reading = true
    try {
      const entries = new Map<string, Entry>()
      const root = await entry(path)
      if (signal.aborted) return
      follow(node.target === 'directory' && root?.directory ? path : dirname(path))
      if (node.target === 'file' && root && !root.directory) entries.set(path, root)
      if (node.target === 'directory' && root?.directory) {
        for (const name of await readdir(path)) {
          if (signal.aborted) return
          const child = join(path, name)
          const info = await entry(child)
          if (info) entries.set(child, info)
        }
      }
      if (signal.aborted) return
      const old = previous
      const now = Date.now()
      let next = Infinity
      for (const [key, time] of quietAt) {
        if (time <= now) quietAt.delete(key)
        else next = Math.min(next, time)
      }
      if (Number.isFinite(next)) refresh(next - now)
      lastError = ''
      if (!old) {
        previous = entries
        return
      }
      const triggeredAt = new Date().toISOString()
      function emit(event: Change['event'], path: string, info: Entry): void {
        if (node.events.includes(event)) submit({ event, path, isDirectory: info.directory, triggeredAt })
      }
      for (const [path, info] of old) {
        if (entries.has(path)) continue
        if (quietAt.has(pathKey(path))) entries.set(path, info)
        else emit('removed', path, info)
      }
      for (const [path, info] of entries) {
        const before = old.get(path)
        if (quietAt.has(pathKey(path))) {
          if (before) entries.set(path, before)
          else entries.delete(path)
        } else if (!before) emit('added', path, info)
        else if (before.stamp !== info.stamp || before.directory !== info.directory) emit('changed', path, info)
      }
      previous = entries
    } catch (error) {
      const message = (error as Error).message
      if (!signal.aborted && message !== lastError) report('文件监听失败：' + message)
      lastError = message
    } finally {
      reading = false
      if (pending) {
        pending = false
        refresh()
      }
    }
  }

  const fallback = setInterval(() => {
    if (!timer) void scan()
  }, 2000)
  signal.addEventListener('abort', () => {
    watcher?.close()
    clearTimeout(timer)
    clearInterval(fallback)
  }, { once: true })
  void scan()
}
