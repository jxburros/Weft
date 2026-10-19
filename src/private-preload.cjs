const { contextBridge, ipcRenderer } = require('electron');

// Private window chrome (#94): navigation for its own page only. No workspace command is reachable from here.
contextBridge.exposeInMainWorld('weftPrivate', {
  ready: () => ipcRenderer.invoke('weft-private:ready'),
  navigate: value => ipcRenderer.invoke('weft-private:navigate', String(value ?? '').slice(0, 16384)),
  control: action => ipcRenderer.invoke('weft-private:control', String(action)),
  onState: callback => { ipcRenderer.on('weft-private:state', (_event, state) => callback(state)); },
  onFocusAddress: callback => { ipcRenderer.on('weft-private:focus-address', () => callback()); },
});
