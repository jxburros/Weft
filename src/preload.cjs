const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('weft', {
  layout: bounds => ipcRenderer.invoke('weft:layout', bounds),
  commands: () => ipcRenderer.invoke('weft:commands'),
  pickPath: kind => ipcRenderer.invoke('weft:pickPath', kind === 'folder' ? 'folder' : 'file'),
  onTurnFrame: callback => {
    const listener = (_event, frame) => callback(frame);
    ipcRenderer.on('weft:turn', listener);
    return () => ipcRenderer.off('weft:turn', listener);
  },
  focusPage: () => ipcRenderer.invoke('weft:focusPage'),
  onChrome: callback => {
    const listener = (_event, shortcut) => callback(String(shortcut));
    ipcRenderer.on('weft:chrome', listener);
    return () => ipcRenderer.off('weft:chrome', listener);
  },
  onNotice: callback => {
    const listener = (_event, message) => callback(String(message));
    ipcRenderer.on('weft:notice', listener);
    return () => ipcRenderer.off('weft:notice', listener);
  },
  chrome: async (action, args = {}) => {
    const outcome = await ipcRenderer.invoke('weft:chromeAction', action, args);
    if (outcome?.error) throw Object.assign(new Error(outcome.error.message), { code: outcome.error.code });
    return outcome?.result;
  },
  platform: process.platform,
  executeOutcome: (name, args = {}) => ipcRenderer.invoke('weft:execute', name, args),
  execute: async (name, args = {}) => {
    const outcome = await ipcRenderer.invoke('weft:execute', name, args);
    if (outcome.error) throw Object.assign(new Error(outcome.error.message), outcome.error, { status: outcome.status });
    return outcome.result;
  },
});
