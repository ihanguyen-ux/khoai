'use strict';

const { contextBridge, ipcRenderer } = require('electron');

/**
 * Chỉ lộ ra đúng những hàm cần thiết cho renderer (contextIsolation = true).
 * Renderer KHÔNG có quyền truy cập trực tiếp ipcRenderer, Node hay fs.
 */
contextBridge.exposeInMainWorld('winchat', {
  platform: process.platform,

  window: {
    minimize: () => ipcRenderer.send('window:minimize'),
    toggleMaximize: () => ipcRenderer.send('window:toggle-maximize'),
    close: () => ipcRenderer.send('window:close'),
    isMaximized: () => ipcRenderer.invoke('window:is-maximized'),
    onVisibilityChange: (callback) => {
      const handler = (_event, visible) => callback(Boolean(visible));
      ipcRenderer.on('window:visible', handler);
      return () => ipcRenderer.removeListener('window:visible', handler);
    },
    onMaximizeChange: (callback) => {
      const handler = (_event, isMaximized) => callback(Boolean(isMaximized));
      ipcRenderer.on('window:maximized', handler);
      return () => ipcRenderer.removeListener('window:maximized', handler);
    },
  },

  // Chạy signaling server ngay trong app này (chế độ "Host")
  server: {
    start: (port) => ipcRenderer.invoke('server:start', port),
    stop: () => ipcRenderer.invoke('server:stop'),
    status: () => ipcRenderer.invoke('server:status'),
  },

  // Thông báo Windows (toast) + nhấp nháy taskbar khi có tin/cuộc gọi mới
  notify: (title, body) => ipcRenderer.send('app:notify', { title, body }),
  flash: () => ipcRenderer.send('window:flash'),
});
