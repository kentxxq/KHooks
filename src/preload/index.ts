import { contextBridge, ipcRenderer } from 'electron'
import type { Desktop, Invocation } from '../shared/ipc'

function invoke<K extends Invocation>(name: K, ...args: Parameters<Desktop[K]>): ReturnType<Desktop[K]> {
  return ipcRenderer.invoke('khooks:' + name, ...args) as ReturnType<Desktop[K]>
}

const desktop: Desktop = {
  snapshot: () => invoke('snapshot'),
  getWorkflow: (id) => invoke('getWorkflow', id),
  save: (flow) => invoke('save', flow),
  saveComponent: (component) => invoke('saveComponent', component),
  remove: (id) => invoke('remove', id),
  enable: (id, enabled) => invoke('enable', id, enabled),
  run: (id, draft) => invoke('run', id, draft),
  pickPath: (target) => invoke('pickPath', target),
  probe: (site) => invoke('probe', site),
  settings: (settings) => invoke('settings', settings),
  testAi: (settings) => invoke('testAi', settings),
  setTheme: (theme) => invoke('setTheme', theme),
  setAutoCheckUpdate: (enabled) => invoke('setAutoCheckUpdate', enabled),
  generate: (prompt) => invoke('generate', prompt),
  revise: (prompt, draft) => invoke('revise', prompt, draft),
  update: (action) => invoke('update', action),
  openExternal: (target) => invoke('openExternal', target),
  subscribe: (callback) => {
    const listener = () => callback()
    ipcRenderer.on('khooks:changed', listener)
    return () => ipcRenderer.removeListener('khooks:changed', listener)
  },
  onNavigate: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, path: string) => callback(path)
    ipcRenderer.on('khooks:navigate', listener)
    return () => ipcRenderer.removeListener('khooks:navigate', listener)
  }
}
contextBridge.exposeInMainWorld('khooks', desktop)
