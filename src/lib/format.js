/** ID duy nhất cho tin nhắn (có dự phòng nếu crypto.randomUUID không khả dụng). */
export function uid() {
  try {
    if (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') {
      return globalThis.crypto.randomUUID();
    }
  } catch {
    /* dùng dự phòng bên dưới */
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function formatTime(ts) {
  const d = new Date(ts);
  return d.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit', hour12: false });
}

export function formatDuration(totalSeconds) {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(sec).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

const ROOM_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // bỏ ký tự dễ nhầm: I, O, 0, 1

export function generateRoomCode(length = 6) {
  let out = '';
  const bytes = new Uint8Array(length);
  (globalThis.crypto || window.crypto).getRandomValues(bytes);
  for (let i = 0; i < length; i += 1) out += ROOM_CHARS[bytes[i] % ROOM_CHARS.length];
  return out;
}

export function normalizeRoom(value) {
  return String(value || '').trim().toUpperCase();
}

export function isValidRoom(value) {
  return /^[A-Z0-9_-]{3,32}$/.test(normalizeRoom(value));
}

export const DEFAULT_PORT = 3001;

/** Mã định danh ngẫu nhiên cho một phiên kết nối (24 ký tự hex). */
export function newClientId() {
  const bytes = new Uint8Array(12);
  (globalThis.crypto || window.crypto).getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Chuẩn hoá địa chỉ server người dùng nhập.
 *  "192.168.1.20"                  -> http://192.168.1.20:3001      (IP / localhost / tên máy → LAN)
 *  "192.168.1.20:4000"             -> http://192.168.1.20:4000
 *  "winchat.abc.workers.dev"       -> https://winchat.abc.workers.dev (tên miền không cổng → HTTPS)
 *  "https://chat.example.com"      -> giữ nguyên scheme (http/https/ws/wss)
 */
export function normalizeServerUrl(input) {
  const raw = String(input || '').trim();
  if (!raw) return '';
  if (/^(https?|wss?):\/\//i.test(raw)) return raw.replace(/\/+$/, '');

  const hostPort = raw.replace(/\/.*$/, '');
  const host = hostPort.replace(/:\d+$/, '');
  const hasPort = host !== hostPort;
  if (hasPort) return `http://${hostPort}`;

  const isLan = /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host === 'localhost' || !host.includes('.');
  return isLan ? `http://${host}:${DEFAULT_PORT}` : `https://${host}`;
}

export function initials(name) {
  const parts = String(name || '?').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  const first = parts[0][0] || '';
  const last = parts.length > 1 ? parts[parts.length - 1][0] : '';
  return (first + last).toUpperCase();
}
