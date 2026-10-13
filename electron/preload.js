/**
 * Preload bridge: exposes a minimal, explicit API to the renderer as window.api.
 * The renderer has no Node access; everything goes through these IPC calls.
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  suggestions: () => ipcRenderer.invoke('suggestions'),
  search: (city, opts) => ipcRenderer.invoke('search', city, opts),
  onProgress: (cb) => {
    const listener = (_e, msg) => cb(msg);
    ipcRenderer.on('progress', listener);
    return () => ipcRenderer.removeListener('progress', listener);
  },
  saveCsv: (text, name) => ipcRenderer.invoke('save-csv', text, name),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  copy: (text) => ipcRenderer.invoke('copy', text),

  // "Email them" section
  mail: {
    getSettings: () => ipcRenderer.invoke('mail:get-settings'),
    saveSettings: (s) => ipcRenderer.invoke('mail:save-settings', s),
    verify: () => ipcRenderer.invoke('mail:verify'),
    openCsv: () => ipcRenderer.invoke('mail:open-csv'),
    parseList: (text) => ipcRenderer.invoke('mail:parse-list', text),
    pickAttachments: () => ipcRenderer.invoke('mail:pick-attachments'),
    preview: (args) => ipcRenderer.invoke('mail:preview', args),
    sentLog: () => ipcRenderer.invoke('mail:sent-log'),
    sendTest: (job) => ipcRenderer.invoke('mail:send-test', job),
    send: (job) => ipcRenderer.invoke('mail:send', job),
    stop: () => ipcRenderer.invoke('mail:stop'),
    onProgress: (cb) => {
      const listener = (_e, p) => cb(p);
      ipcRenderer.on('mail:progress', listener);
      return () => ipcRenderer.removeListener('mail:progress', listener);
    },
  },
});
