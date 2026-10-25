import electron from 'electron'
const { contextBridge, ipcRenderer } = electron

contextBridge.exposeInMainWorld('pantherAPI', {
  explain: () => ipcRenderer.invoke('panther:explain'),
  follow: () => ipcRenderer.invoke('panther:follow'),
  prepare: () => ipcRenderer.invoke('panther:prepare'),
  setGoal: (hypothesis: string | null) => ipcRenderer.invoke('panther:goal:set', hypothesis),
  showGoal: () => ipcRenderer.invoke('panther:goal:show'),
  feedback: (kind: string, insightId: string | null, topic: string | null) =>
    ipcRenderer.invoke('panther:feedback', kind, insightId, topic),
  status: () => ipcRenderer.invoke('panther:status'),
  sources: () => ipcRenderer.invoke('panther:sources'),
  onCardUpdate: (callback: (data: unknown) => void) => {
    const handler = (_event: unknown, data: unknown) => callback(data)
    ipcRenderer.on('panther:card-update', handler)
    return () => ipcRenderer.removeListener('panther:card-update', handler)
  },
  hide: () => ipcRenderer.send('panther:hide'),
})
