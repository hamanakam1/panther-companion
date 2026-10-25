const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('pantherAPI', {
  action: (action, data = {}) => ipcRenderer.invoke('panther:action', action, data),
});
