const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('weft', {
  layout: bounds => ipcRenderer.invoke('weft:layout', bounds),
  commands: () => ipcRenderer.invoke('weft:commands'),
  pickPath: kind => ipcRenderer.invoke('weft:pickPath', ['folder', 'save', 'import'].includes(kind) ? kind : 'file'),
  onTurnFrame: callback => {
    const listener = (_event, frame) => callback(frame);
    ipcRenderer.on('weft:turn', listener);
    return () => ipcRenderer.off('weft:turn', listener);
  },
  focusPage: () => ipcRenderer.invoke('weft:focusPage'),
  openPrivateWindow: () => ipcRenderer.invoke('weft:openPrivateWindow'),
  onSitePrompt: callback => {
    const listener = () => callback();
    ipcRenderer.on('weft:site-prompt', listener);
    return () => ipcRenderer.off('weft:site-prompt', listener);
  },
  onChrome: callback => {
    const listener = (_event, shortcut) => callback(String(shortcut));
    ipcRenderer.on('weft:chrome', listener);
    return () => ipcRenderer.off('weft:chrome', listener);
  },
  executeOutcome: (name, args = {}) => ipcRenderer.invoke('weft:execute', name, args),
  execute: async (name, args = {}) => {
    const outcome = await ipcRenderer.invoke('weft:execute', name, args);
    if (outcome.error) throw Object.assign(new Error(outcome.error.message), outcome.error, { status: outcome.status });
    return outcome.result;
  },
});
