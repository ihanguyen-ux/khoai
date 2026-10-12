import { loadSettings } from './storage';

/**
 * STUN giúp 2 máy tìm địa chỉ công cộng của nhau (đủ cho mạng LAN và nhiều mạng Internet).
 * Khi dùng server Cloudflare, server cấp thêm STUN + TURN của Cloudflare (thông tin đăng nhập TURN
 * ngắn hạn, tự sinh) để gọi được cả khi một bên nằm sau NAT đối xứng / mạng chặn UDP.
 * Có thể nhập thêm TURN riêng ở mục "Nâng cao" trên màn hình đăng nhập.
 */
const FALLBACK_STUN = [{ urls: 'stun:stun.l.google.com:19302' }];

/** @param {RTCIceServer[]} [serverProvided] iceServers lấy từ ack khi vào phòng */
export function buildIceServers(serverProvided = []) {
  const servers = Array.isArray(serverProvided) ? [...serverProvided] : [];

  const { turnUrl, turnUser, turnPass } = loadSettings();
  const url = String(turnUrl || '').trim();
  if (/^turns?:/i.test(url)) {
    servers.push({ urls: url, username: turnUser || undefined, credential: turnPass || undefined });
  }

  servers.push(...FALLBACK_STUN);
  return servers;
}
