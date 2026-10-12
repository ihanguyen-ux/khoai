/**
 * Durable Object "Room": một phòng chat 1-1.
 *
 * Giao thức giống hệt server Node (server/server.js):
 *   client → server : { e, d, i? }     server → client : { e, d }  hoặc  { a: i, d }
 *   "ping" → "pong" được runtime tự trả lời (setWebSocketAutoResponse) nên KHÔNG đánh thức DO.
 *
 * Dùng WebSocket Hibernation API: khi phòng im lặng, DO bị gỡ khỏi bộ nhớ và không tính tiền thời gian chờ,
 * kết nối WebSocket vẫn giữ nguyên. Trạng thái từng kết nối ({cid, name, t}) lưu trong "attachment".
 */

import { DurableObject } from 'cloudflare:workers';

const MAX_PER_ROOM = 2;
const MAX_TEXT_LENGTH = 4000;
const CID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;
const CLOSE_REPLACED = 4000; // bị kết nối mới cùng cid thay thế
const CLOSE_JOIN_TIMEOUT = 4001; // mở kết nối nhưng không vào phòng
const CLOSE_IDLE = 4002; // mất tín hiệu keepalive

const DEFAULT_SWEEP_MS = 30_000;
const DEFAULT_IDLE_MS = 90_000; // client ping mỗi ~20 giây
const DEFAULT_JOIN_TIMEOUT_MS = 20_000;
const ICE_CACHE_MS = 6 * 60 * 60 * 1000; // thông tin TURN sống 24 giờ, cache 6 giờ
const TURN_TTL_SECONDS = 86_400;

const RELAY_EVENTS = new Set([
  'chat:delivered',
  'chat:seen',
  'chat:typing',
  'call:invite',
  'call:accept',
  'call:reject',
  'call:end',
  'call:busy',
  'call:media',
  'webrtc:offer',
  'webrtc:answer',
  'webrtc:ice',
]);

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function sanitizeName(value) {
  // eslint-disable-next-line no-control-regex
  const name = String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 30);
  return name.length > 0 ? name : null;
}

async function safeEqual(a, b) {
  const enc = new TextEncoder();
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(String(a ?? ''))),
    crypto.subtle.digest('SHA-256', enc.encode(String(b ?? ''))),
  ]);
  const x = new Uint8Array(ha);
  const y = new Uint8Array(hb);
  let diff = 0;
  for (let i = 0; i < x.length; i += 1) diff |= x[i] ^ y[i];
  return diff === 0;
}

function send(ws, message) {
  try {
    ws.send(typeof message === 'string' ? message : JSON.stringify(message));
  } catch {
    /* kết nối đã đóng */
  }
}

/** Bỏ các URL cổng 53 (hay bị trình duyệt báo timeout) khỏi danh sách ICE server. */
function cleanIceServers(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const entry of list) {
    if (!isPlainObject(entry)) continue;
    const urls = (Array.isArray(entry.urls) ? entry.urls : [entry.urls]).filter(
      (u) => typeof u === 'string' && !/:53(\?|$)/.test(u)
    );
    if (urls.length > 0) out.push({ ...entry, urls });
  }
  return out;
}

export class Room extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ice = null; // { at, servers }
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }

  // ----- tiện ích -----------------------------------------------------------

  get sweepMs() {
    return Number(this.env.SWEEP_MS) || DEFAULT_SWEEP_MS;
  }

  /** Các kết nối đã vào phòng: [{ ws, att }] */
  members() {
    const out = [];
    for (const ws of this.ctx.getWebSockets()) {
      const att = ws.deserializeAttachment();
      if (att && att.cid) out.push({ ws, att });
    }
    return out;
  }

  peerOf(cid) {
    return this.members().find((m) => m.att.cid !== cid) || null;
  }

  async scheduleSweep() {
    const current = await this.ctx.storage.getAlarm();
    if (current === null) await this.ctx.storage.setAlarm(Date.now() + this.sweepMs);
  }

  // ----- kết nối ------------------------------------------------------------

  async fetch(request) {
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('Expected a WebSocket upgrade', { status: 426 });
    }
    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ cid: null, name: null, t: Date.now() });
    await this.scheduleSweep();
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, message) {
    if (typeof message !== 'string') {
      ws.close(1003, 'binary not supported');
      return;
    }
    if (message.length > 64 * 1024) {
      ws.close(1009, 'message too big');
      return;
    }
    let msg;
    try {
      msg = JSON.parse(message);
    } catch {
      return;
    }
    if (!isPlainObject(msg) || typeof msg.e !== 'string') return;

    const hasId = typeof msg.i === 'string' || typeof msg.i === 'number';
    const reply = (d) => {
      if (hasId) send(ws, { a: msg.i, d });
    };

    if (msg.e === 'join') {
      await this.handleJoin(ws, msg.d, reply);
    } else if (msg.e === 'leave') {
      this.leave(ws);
    } else if (msg.e === 'chat:message') {
      this.handleChat(ws, msg.d, reply);
    } else if (RELAY_EVENTS.has(msg.e)) {
      const att = ws.deserializeAttachment();
      if (!att || !att.cid) return;
      const peer = this.peerOf(att.cid);
      if (peer) send(peer.ws, { e: msg.e, d: isPlainObject(msg.d) ? msg.d : {} });
    }
  }

  async webSocketClose(ws) {
    this.leave(ws);
  }

  async webSocketError(ws) {
    this.leave(ws);
  }

  /** Gỡ một kết nối khỏi phòng và báo cho người còn lại (an toàn khi gọi nhiều lần). */
  leave(ws) {
    const att = ws.deserializeAttachment();
    if (!att || !att.cid) return; // chưa vào phòng, hoặc đã bị thay thế/gỡ trước đó
    ws.serializeAttachment({ ...att, cid: null });
    for (const m of this.members()) {
      if (m.att.cid !== att.cid) send(m.ws, { e: 'peer:left', d: { id: att.cid } });
    }
  }

  // ----- xử lý sự kiện ------------------------------------------------------

  async handleJoin(ws, d, reply) {
    const key = this.env.ACCESS_KEY;
    if (key && !(await safeEqual(isPlainObject(d) ? d.key : '', key))) {
      reply({ ok: false, error: 'UNAUTHORIZED' });
      return;
    }
    if (!isPlainObject(d)) {
      reply({ ok: false, error: 'INVALID' });
      return;
    }
    const att = ws.deserializeAttachment() || {};
    if (att.cid) {
      reply({ ok: false, error: 'ALREADY_JOINED' });
      return;
    }
    const name = sanitizeName(d.name);
    const cid = typeof d.cid === 'string' && CID_PATTERN.test(d.cid) ? d.cid : null;
    if (!name || !cid) {
      reply({ ok: false, error: 'INVALID' });
      return;
    }

    const members = this.members();
    const stale = members.find((m) => m.att.cid === cid);
    if (stale) {
      // Cùng máy kết nối lại → thay thế kết nối cũ. Gỡ cid trước để sự kiện đóng không báo "rời phòng".
      stale.ws.serializeAttachment({ ...stale.att, cid: null });
      try {
        stale.ws.close(CLOSE_REPLACED, 'replaced');
      } catch {
        /* đã đóng */
      }
    } else if (members.length >= MAX_PER_ROOM) {
      reply({ ok: false, error: 'ROOM_FULL' });
      return;
    }

    // Đăng ký ngay (trước mọi await) để hai lần join đồng thời không cùng lọt qua kiểm tra "phòng đầy"
    ws.serializeAttachment({ cid, name, t: Date.now() });
    const peer = this.peerOf(cid);
    if (peer) send(peer.ws, { e: 'peer:joined', d: { id: cid, name } });

    const iceServers = await this.getIceServers();
    const ack = {
      ok: true,
      id: cid,
      peer: peer ? { id: peer.att.cid, name: peer.att.name } : null,
    };
    if (iceServers) ack.iceServers = iceServers;
    reply(ack);
  }

  handleChat(ws, d, reply) {
    const att = ws.deserializeAttachment();
    if (!att || !att.cid) {
      reply({ ok: false, error: 'NOT_IN_ROOM' });
      return;
    }
    if (
      !isPlainObject(d) ||
      typeof d.id !== 'string' ||
      d.id.length === 0 ||
      d.id.length > 64 ||
      typeof d.text !== 'string' ||
      d.text.length === 0 ||
      d.text.length > MAX_TEXT_LENGTH
    ) {
      reply({ ok: false, error: 'INVALID' });
      return;
    }
    const peer = this.peerOf(att.cid);
    if (!peer) {
      reply({ ok: true, peerOnline: false });
      return;
    }
    send(peer.ws, {
      e: 'chat:message',
      d: { id: d.id, text: d.text, ts: Number.isFinite(d.ts) ? d.ts : Date.now() },
    });
    reply({ ok: true, peerOnline: true });
  }

  // ----- TURN (Cloudflare Realtime) -----------------------------------------

  /** @returns {Promise<object[] | undefined>} danh sách iceServers, hoặc undefined nếu chưa cấu hình/lỗi */
  async getIceServers() {
    const { TURN_KEY_ID, TURN_API_TOKEN } = this.env;
    if (!TURN_KEY_ID || !TURN_API_TOKEN) return undefined;
    if (this.ice && Date.now() - this.ice.at < ICE_CACHE_MS) return this.ice.servers;

    const base = this.env.TURN_API_BASE || 'https://rtc.live.cloudflare.com';
    try {
      const res = await fetch(
        `${base}/v1/turn/keys/${encodeURIComponent(TURN_KEY_ID)}/credentials/generate-ice-servers`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${TURN_API_TOKEN}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ ttl: TURN_TTL_SECONDS }),
          signal: AbortSignal.timeout(4000),
        }
      );
      if (!res.ok) {
        console.warn(`TURN API trả về ${res.status}`);
        return undefined;
      }
      const data = await res.json();
      const servers = cleanIceServers(data.iceServers);
      if (servers.length === 0) return undefined;
      this.ice = { at: Date.now(), servers };
      return servers;
    } catch (err) {
      console.warn('Không lấy được thông tin TURN:', err && err.message);
      return undefined;
    }
  }

  // ----- dọn dẹp định kỳ ----------------------------------------------------

  /** Đóng kết nối "chết" (mất mạng đột ngột) và kết nối mở ra nhưng không vào phòng. */
  async alarm() {
    const now = Date.now();
    const idleMs = Number(this.env.IDLE_MS) || DEFAULT_IDLE_MS;
    const joinMs = Number(this.env.JOIN_TIMEOUT_MS) || DEFAULT_JOIN_TIMEOUT_MS;
    let alive = 0;

    for (const ws of this.ctx.getWebSockets()) {
      const att = ws.deserializeAttachment() || {};
      const auto = this.ctx.getWebSocketAutoResponseTimestamp(ws);
      const lastSeen = Math.max(att.t || 0, auto ? auto.getTime() : 0);

      if (!att.cid && now - (att.t || 0) > joinMs) {
        try {
          ws.close(CLOSE_JOIN_TIMEOUT, 'join timeout');
        } catch {
          /* đã đóng */
        }
      } else if (att.cid && now - lastSeen > idleMs) {
        this.leave(ws);
        try {
          ws.close(CLOSE_IDLE, 'idle');
        } catch {
          /* đã đóng */
        }
      } else {
        alive += 1;
      }
    }

    if (alive > 0) await this.ctx.storage.setAlarm(Date.now() + this.sweepMs);
  }
}
