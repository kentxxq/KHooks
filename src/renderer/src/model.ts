import { defineStore } from 'pinia'
import { ref } from 'vue'
import { useToast } from '@nuxt/ui/composables/useToast'
import type { Desktop, Run, Snapshot } from '../../shared/ipc'

declare global {
  interface Window { khooks: Desktop }
}

export const desktop = window.khooks

export const useDesktop = defineStore('desktop', () => {
  const data = ref<Snapshot>()
  const toast = useToast()
  let request = 0

  async function refresh(): Promise<void> {
    const version = ++request
    try {
      const next = await desktop.snapshot()
      if (version === request) data.value = next
    } catch (cause) {
      if (version === request) toast.add({ id: 'snapshot-error', title: errorMessage(cause), color: 'error' })
    }
  }
  return { data, refresh }
})

export const runLabels: Record<Run['status'], string> = {
  running: '执行中', success: '成功', failed: '失败', interrupted: '已中断'
}

export { nodeIcons } from './node-icons'
export const nodeDragType = 'application/x-khooks-node'

export function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message.replace(/^Error invoking remote method '[^']+': Error: /, '') : String(cause)
}

export function dateTime(value?: string | null): string {
  return value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '—'
}

export function copy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value))
}
