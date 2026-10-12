'use strict';

const { app, BrowserWindow, ipcMain, session, Notification } = require('electron');
const path = require('path');
const os = require('os');
const { startServer } = require('../server/server');

const APP_ID = 'com.winchat.desktop';
const DEV_URL = process.env.VITE_DEV_SERVER_URL || '';

app.setAppUserModelId(APP_ID); // cần để toast notification hiện đúng trên Windows

/** @type {BrowserWindow | null} */
let mainWindow = null;
/** @type {{ port: number, close: () => Promise<void> } | null} */
let embeddedServer = null;

// ---------------------------------------------------------------------------
// Tiện ích bảo mật
// ---------------------------------------------------------------------------

/** Chỉ tin trang do chính app nạp (file:// bản đóng gói, hoặc Vite dev server). */
function isTrustedUrl(url) {
  try {
    const u = new URL(url);
    if (u.protocol === 'file:') return true;
    if (DEV_URL) return u.origin === new URL(DEV_URL).origin;
    return false;
  } catch {
    return false;
  }
}

/** Chỉ chấp nhận IPC đến từ cửa sổ chính, trang tin cậy. */
function isTrustedSender(event) {
  if (!mainWindow || event.sender !== mainWindow.webContents) return false;
  const url = event.senderFrame ? event.senderFrame.url : '';
  return isTrustedUrl(url);
}

function getLanAddresses() {
  const result = [];
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family === 'IPv4' && !a.internal) result.push(a.address);
    }
  }
  return result;
}

function setupPermissions() {
  const ses = session.defaultSession;
  const allowed = new Set(['media']); // chỉ micro/camera

  ses.setPermissionRequestHandler((webContents, permission, callback, details) => {
    const url = (details && details.requestingUrl) || webContents.getURL();
    callback(allowed.has(permission) && isTrustedUrl(url));
  });
  ses.setPermissionCheckHandler((webContents, permission, requestingOrigin) => {
    const url = requestingOrigin || (webContents ? webContents.getURL() : '');
    return allowed.has(permission) && isTrustedUrl(url);
  });
}

// ---------------------------------------------------------------------------
// Cửa sổ chính
// ---------------------------------------------------------------------------

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1120,
    height: 720,
    minWidth: 860,
    minHeight: 560,
    frame: false, // Custom titlebar vẽ bằng React
    backgroundColor: '#09090b',
    show: false,
    title: 'WinChat',
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
      autoplayPolicy: 'no-user-gesture-required', // để chuông/âm thanh cuộc gọi phát được
      backgroundThrottling: false, // khi thu nhỏ cửa sổ vẫn giữ keepalive + cuộc gọi ổn định
    },
  });

  mainWindow.once('ready-to-show', () => mainWindow && mainWindow.show());

  const sendMaximized = () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('window:maximized', mainWindow.isMaximized());
    }
  };
  // backgroundThrottling=false làm document.hidden luôn false → báo riêng trạng thái thu nhỏ/ẩn cho renderer
  const sendVisible = () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('window:visible', mainWindow.isVisible() && !mainWindow.isMinimized());
    }
  };
  for (const ev of ['minimize', 'restore', 'show', 'hide']) mainWindow.on(ev, sendVisible);
  mainWindow.on('maximize', sendMaximized);
  mainWindow.on('unmaximize', sendMaximized);
  mainWindow.on('focus', () => mainWindow && mainWindow.flashFrame(false));
  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // Chặn mở cửa sổ mới và điều hướng ra ngoài trang của app
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!isTrustedUrl(url)) event.preventDefault();
  });

  if (DEV_URL) {
    mainWindow.loadURL(DEV_URL);
  } else {
    mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  }
}

// ---------------------------------------------------------------------------
// IPC: điều khiển cửa sổ
// ---------------------------------------------------------------------------

ipcMain.on('window:minimize', (event) => {
  if (isTrustedSender(event)) mainWindow.minimize();
});

ipcMain.on('window:toggle-maximize', (event) => {
  if (!isTrustedSender(event)) return;
  if (mainWindow.isMaximized()) mainWindow.unmaximize();
  else mainWindow.maximize();
});

ipcMain.on('window:close', (event) => {
  if (isTrustedSender(event)) mainWindow.close();
});

ipcMain.handle('window:is-maximized', (event) => {
  return isTrustedSender(event) ? mainWindow.isMaximized() : false;
});

ipcMain.on('window:flash', (event) => {
  if (isTrustedSender(event) && !mainWindow.isFocused()) mainWindow.flashFrame(true);
});

ipcMain.on('app:notify', (event, payload) => {
  if (!isTrustedSender(event)) return;
  if (!payload || typeof payload.title !== 'string' || typeof payload.body !== 'string') return;
  if (!Notification.isSupported() || (mainWindow && mainWindow.isFocused())) return;

  const n = new Notification({
    title: payload.title.slice(0, 100),
    body: payload.body.slice(0, 200),
    silent: false,
  });
  n.on('click', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });
  n.show();
});

// ---------------------------------------------------------------------------
// IPC: signaling server nhúng (chế độ Host)
// ---------------------------------------------------------------------------

ipcMain.handle('server:start', async (event, port) => {
  if (!isTrustedSender(event)) return { ok: false, error: 'Không được phép.' };

  const p = Number(port);
  if (!Number.isInteger(p) || p < 1024 || p > 65535) {
    return { ok: false, error: 'Cổng phải là số nguyên từ 1024 đến 65535.' };
  }
  if (embeddedServer) {
    return { ok: true, port: embeddedServer.port, ips: getLanAddresses() };
  }
  try {
    embeddedServer = await startServer({ port: p });
    return { ok: true, port: embeddedServer.port, ips: getLanAddresses() };
  } catch (err) {
    embeddedServer = null;
    if (err && err.code === 'EADDRINUSE') {
      return { ok: false, error: `Cổng ${p} đang được dùng bởi chương trình khác. Hãy thử cổng khác.` };
    }
    return { ok: false, error: `Không thể khởi động server: ${err && err.message ? err.message : err}` };
  }
});

ipcMain.handle('server:stop', async (event) => {
  if (!isTrustedSender(event)) return { ok: false };
  await stopEmbeddedServer();
  return { ok: true };
});

ipcMain.handle('server:status', (event) => {
  if (!isTrustedSender(event)) return { running: false };
  return embeddedServer
    ? { running: true, port: embeddedServer.port, ips: getLanAddresses() }
    : { running: false };
});

async function stopEmbeddedServer() {
  if (!embeddedServer) return;
  const s = embeddedServer;
  embeddedServer = null;
  try {
    await s.close();
  } catch {
    /* bỏ qua lỗi khi đóng */
  }
}

// ---------------------------------------------------------------------------
// Vòng đời ứng dụng
// ---------------------------------------------------------------------------

app.on('web-contents-created', (_event, contents) => {
  // Không cho phép <webview> hay gắn nội dung lạ
  contents.on('will-attach-webview', (e) => e.preventDefault());
});

app.whenReady().then(() => {
  setupPermissions();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', async () => {
  await stopEmbeddedServer();
  app.quit();
});

app.on('before-quit', () => {
  // Đóng server nếu còn chạy (không chờ)
  if (embeddedServer) {
    embeddedServer.close().catch(() => {});
    embeddedServer = null;
  }
});
