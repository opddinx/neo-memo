const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('neo', {
  call: (method, payload = {}) => ipcRenderer.invoke('neo', method, payload),
  onChanged: callback => { const handler = () => callback(); ipcRenderer.on('neo:changed', handler); return () => ipcRenderer.removeListener('neo:changed', handler); }
});
