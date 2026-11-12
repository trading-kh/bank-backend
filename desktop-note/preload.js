const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('noteApi', {
  init: () => ipcRenderer.invoke('app:init'),
  login: (payload) => ipcRenderer.invoke('auth:login', payload),
  logout: () => ipcRenderer.invoke('auth:logout'),
  save: (note) => ipcRenderer.invoke('note:save', note),
  pull: () => ipcRenderer.invoke('note:pull'),
  setTop: (on) => ipcRenderer.invoke('win:top', on),
  hide: () => ipcRenderer.invoke('win:hide'),
  quit: () => ipcRenderer.invoke('app:quit'),
  openAdmin: () => ipcRenderer.invoke('app:openAdmin'),
  status: () => ipcRenderer.invoke('app:status'),
  autostart: (on) => ipcRenderer.invoke('app:autostart', on),
  resize: (width, height) => ipcRenderer.invoke('win:resize', { width, height }),
  onRemote: (cb) => ipcRenderer.on('note:remote', (_e, note) => cb(note)),
  onTop: (cb) => ipcRenderer.on('win:top', (_e, on) => cb(on)),
});
