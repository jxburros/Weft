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
  // Windows (#100): what this window shows, and moving workspaces between windows.
  window: () => ipcRenderer.invoke('weft:window'),
  windows: request => ipcRenderer.invoke('weft:windows', request),
  onWindows: callback => {
    const listener = () => callback();
    ipcRenderer.on('weft:windows', listener);
    return () => ipcRenderer.off('weft:windows', listener);
  },
  // Links and files from other applications (#99), and opt-in default-browser registration.
  external: request => ipcRenderer.invoke('weft:external', request),
  onExternal: callback => {
    const listener = (_event, value) => callback(value);
    ipcRenderer.on('weft:external', listener);
    return () => ipcRenderer.off('weft:external', listener);
  },
  defaultBrowser: action => ipcRenderer.invoke('weft:defaultBrowser', String(action)),
  executeOutcome: (name, args = {}) => ipcRenderer.invoke('weft:execute', name, args),
  execute: async (name, args = {}) => {
    const outcome = await ipcRenderer.invoke('weft:execute', name, args);
    if (outcome.error) throw Object.assign(new Error(outcome.error.message), outcome.error, { status: outcome.status });
    return outcome.result;
  },
});
