const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // Download YouTube audio - returns { arrayBuffer, title, duration }
  getYTAudio: (url) => ipcRenderer.invoke('get-yt-audio', url),

  // Listen to download progress events
  onDownloadProgress: (callback) => {
    ipcRenderer.on('download-progress', (event, data) => callback(data));
  },
  removeDownloadListeners: () => {
    ipcRenderer.removeAllListeners('download-progress');
  },

  // Auto updater
  onUpdateStatus: (callback) => {
    ipcRenderer.on('update-status', (event, data) => callback(data));
  },
  installUpdate: () => ipcRenderer.send('install-update'),

  // Window controls
  minimize: () => ipcRenderer.send('minimize-window'),
  maximize: () => ipcRenderer.send('maximize-window'),
  close:    () => ipcRenderer.send('close-window'),
});
