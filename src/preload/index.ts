import { contextBridge, ipcRenderer } from 'electron'
import type { Desktop, Invocation } from '../shared/ipc'

function invoke<K extends Invocation>(name: K, ...args: Parameters<Desktop[K]>): ReturnType<Desktop[K]> {
  return ipcRenderer.invoke('khooks:' + name, ...args) as ReturnType<Desktop[K]>
}

const desktop: Desktop = {
  snapshot: () => invoke('snapshot'),
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
  generate: (prompt) => invoke('generate', prompt),
  update: (action) => invoke('update', action),
  subscribe: (callback) => {
    const listener = () => callback()
    ipcRenderer.on('khooks:changed', listener)
    return () => ipcRenderer.removeListener('khooks:changed', listener)
  }
}
contextBridge.exposeInMainWorld('khooks', desktop)
