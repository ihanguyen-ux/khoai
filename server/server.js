'use strict';

/**
 * WinChat signaling server (WebSocket thuần, thư viện `ws`).
 *
 * - Mỗi "phòng" tối đa 2 người (2 máy tính).
 * - Server KHÔNG lưu tin nhắn, chỉ chuyển tiếp (relay) tin nhắn chat và các gói
 *   signaling WebRTC (offer / answer / ICE) giữa 2 người trong cùng phòng.
 * - Audio/video đi trực tiếp P2P giữa 2 máy, không đi qua server này.
 * - Cùng giao thức với bản Cloudflare Worker (thư mục worker/), nên app dùng được với cả hai.
 *
 * Giao thức (JSON qua WebSocket tại  ws://host:port/ws?room=MAPHONG):
 *   client → server : { e: 'sự-kiện', d: dữ-liệu, i?: 'id-yêu-cầu' }
 *   server → client : { e: 'sự-kiện', d: dữ-liệu }            (sự kiện)
 *                     { a: 'id-yêu-cầu', d: dữ-liệu }          (trả lời cho yêu cầu có i)
 *   keepalive       : client gửi chuỗi "ping" → server trả "pong"
 *
 * Chạy độc lập:   node server/server.js            (PORT mặc định 3001, ACCESS_KEY tuỳ chọn)
 * Hoặc nhúng:     const { startServer } = require('./server/server');
 */

const http = require('http');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const MAX_PER_ROOM = 2;
const MAX_TEXT_LENGTH = 4000;
const MAX_PAYLOAD_BYTES = 64 * 1024;
const ROOM_PATTERN = /^[A-Z0-9_-]{3,32}$/;
const CID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;
const IDLE_TIMEOUT_MS = 60_000; // client gửi "ping" mỗi ~20 giây; im lặng quá lâu → coi như đã mất
const SWEEP_INTERVAL_MS = 15_000;
const CLOSE_REPLACED = 4000; // kết nối cũ bị thay thế bởi kết nối mới cùng cid

/** Các sự kiện chỉ cần chuyển thẳng cho người còn lại trong phòng. */
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

function sanitizeRoom(value) {
  const room = String(value ?? '').trim().toUpperCase();
  return ROOM_PATTERN.test(room) ? room : null;
}

function sanitizeName(value) {
  // eslint-disable-next-line no-control-regex
  const name = String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 30);
  return name.length > 0 ? name : null;
}

function sanitizeCid(value) {
  return typeof value === 'string' && CID_PATTERN.test(value) ? value : null;
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a ?? '')).digest();
  const hb = crypto.createHash('sha256').update(String(b ?? '')).digest();
  return crypto.timingSafeEqual(ha, hb);
}

/**
 * @param {{ accessKey?: string }} [options]  accessKey: nếu có, client phải gửi đúng khoá khi vào phòng.
 */
function createSignalingServer({ accessKey = '' } = {}) {
  /** @type {Map<string, Map<string, import('ws').WebSocket>>} room → (cid → socket) */
  const rooms = new Map();

  const httpServer = http.createServer((req, res) => {
    const { pathname } = new URL(req.url || '/', 'http://localhost');
    if (pathname === '/health') {
      const body = JSON.stringify({ ok: true, service: 'winchat-signaling', rooms: rooms.size });
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-store',
      });
      res.end(body);
      return;
    }
    res.writeHead(pathname === '/' ? 200 : 404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(pathname === '/' ? 'WinChat signaling server\n' : 'Not found\n');
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD_BYTES });

  httpServer.on('upgrade', (req, socket, head) => {
    let url;
    try {
      url = new URL(req.url || '/', 'http://localhost');
    } catch {
      socket.destroy();
      return;
    }
    const room = sanitizeRoom(url.searchParams.get('room'));
    if (url.pathname !== '/ws' || !room) {
      socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.room = room;
      wss.emit('connection', ws, req);
    });
  });

  function send(ws, message) {
    if (ws.readyState === ws.OPEN) ws.send(typeof message === 'string' ? message : JSON.stringify(message));
  }

  function findPeer(room, selfCid) {
    const members = rooms.get(room);
    if (!members) return null;
    for (const [cid, sock] of members) {
      if (cid !== selfCid) return { id: cid, name: sock.userName };
    }
    return null;
  }

  function peerSocket(ws) {
    const members = rooms.get(ws.room);
    if (!members) return null;
    for (const [cid, sock] of members) {
      if (cid !== ws.cid) return sock;
    }
    return null;
  }

  /** Gỡ khỏi phòng và báo người còn lại. An toàn khi gọi nhiều lần (leave rồi close). */
  function removeFromRoom(ws) {
    if (!ws.cid) return undefined;
    const cid = ws.cid;
    ws.cid = null;
    const members = rooms.get(ws.room);
    if (!members || members.get(cid) !== ws) return undefined; // đã bị thay thế → không báo "rời phòng"
    members.delete(cid);
    if (members.size === 0) rooms.delete(ws.room);
    else for (const sock of members.values()) send(sock, { e: 'peer:left', d: { id: cid } });
    return undefined;
  }

  wss.on('connection', (ws) => {
    ws.cid = null;
    ws.userName = null;
    ws.lastSeen = Date.now();

    ws.on('message', (data, isBinary) => {
      ws.lastSeen = Date.now();
      if (isBinary) return ws.close(1003, 'binary not supported');
      const text = data.toString();
      if (text === 'ping') return send(ws, 'pong');

      let msg;
      try {
        msg = JSON.parse(text);
      } catch {
        return undefined;
      }
      if (!isPlainObject(msg) || typeof msg.e !== 'string') return undefined;

      const hasId = typeof msg.i === 'string' || typeof msg.i === 'number';
      const reply = (d) => {
        if (hasId) send(ws, { a: msg.i, d });
      };

      if (msg.e === 'join') return handleJoin(ws, msg.d, reply);
      if (msg.e === 'leave') return removeFromRoom(ws);
      if (msg.e === 'chat:message') return handleChat(ws, msg.d, reply);
      if (RELAY_EVENTS.has(msg.e)) {
        if (!ws.cid) return undefined;
        const peer = peerSocket(ws);
        if (peer) send(peer, { e: msg.e, d: isPlainObject(msg.d) ? msg.d : {} });
      }
      return undefined;
    });

    ws.on('close', () => removeFromRoom(ws));

    ws.on('error', () => {
      /* lỗi socket sẽ kéo theo sự kiện 'close' */
    });
  });

  function handleJoin(ws, d, reply) {
    if (accessKey && !safeEqual(isPlainObject(d) ? d.key : '', accessKey)) {
      return reply({ ok: false, error: 'UNAUTHORIZED' });
    }
    if (!isPlainObject(d)) return reply({ ok: false, error: 'INVALID' });
    if (ws.cid) return reply({ ok: false, error: 'ALREADY_JOINED' });
    const name = sanitizeName(d.name);
    const cid = sanitizeCid(d.cid);
    if (!name || !cid) return reply({ ok: false, error: 'INVALID' });

    let members = rooms.get(ws.room);
    if (!members) {
      members = new Map();
      rooms.set(ws.room, members);
    }

    const stale = members.get(cid);
    if (stale) {
      // Cùng một máy kết nối lại (kết nối cũ có thể chưa bị phát hiện là đã chết) → thay thế
      members.delete(cid);
      stale.close(CLOSE_REPLACED, 'replaced');
    } else if (members.size >= MAX_PER_ROOM) {
      return reply({ ok: false, error: 'ROOM_FULL' });
    }

    ws.cid = cid;
    ws.userName = name;
    members.set(cid, ws);

    for (const [otherCid, sock] of members) {
      if (otherCid !== cid) send(sock, { e: 'peer:joined', d: { id: cid, name } });
    }
    return reply({ ok: true, id: cid, peer: findPeer(ws.room, cid) });
  }

  function handleChat(ws, d, reply) {
    if (!ws.cid) return reply({ ok: false, error: 'NOT_IN_ROOM' });
    if (
      !isPlainObject(d) ||
      typeof d.id !== 'string' ||
      d.id.length === 0 ||
      d.id.length > 64 ||
      typeof d.text !== 'string' ||
      d.text.length === 0 ||
      d.text.length > MAX_TEXT_LENGTH
    ) {
      return reply({ ok: false, error: 'INVALID' });
    }
    const peer = peerSocket(ws);
    if (!peer) return reply({ ok: true, peerOnline: false });
    send(peer, {
      e: 'chat:message',
      d: { id: d.id, text: d.text, ts: Number.isFinite(d.ts) ? d.ts : Date.now() },
    });
    return reply({ ok: true, peerOnline: true });
  }

  // Dọn các kết nối "chết" (mất mạng đột ngột, không kịp đóng)
  const sweeper = setInterval(() => {
    const now = Date.now();
    for (const ws of wss.clients) {
      if (now - ws.lastSeen > IDLE_TIMEOUT_MS) ws.terminate();
    }
  }, SWEEP_INTERVAL_MS);
  sweeper.unref();

  return { httpServer, wss, rooms, sweeper };
}

/**
 * Khởi động server. port = 0 để hệ điều hành tự chọn cổng trống (dùng cho test).
 * @returns {Promise<{ port: number, close: () => Promise<void> }>}
 */
function startServer({ port = 3001, host = '0.0.0.0', accessKey = '' } = {}) {
  const { httpServer, wss, sweeper } = createSignalingServer({ accessKey });

  return new Promise((resolve, reject) => {
    const onError = (err) => reject(err);
    httpServer.once('error', onError);
    httpServer.listen(port, host, () => {
      httpServer.removeListener('error', onError);
      const actualPort = httpServer.address().port;
      resolve({
        port: actualPort,
        close: () =>
          new Promise((done) => {
            clearInterval(sweeper);
            // Đóng êm: khung close nằm sau các gói đã xếp hàng (vd. peer:left) nên người kia vẫn nhận đủ
            for (const ws of wss.clients) ws.close(1001, 'server shutdown');
            const force = setTimeout(() => {
              for (const ws of wss.clients) ws.terminate();
              httpServer.closeAllConnections?.();
            }, 500);
            const finish = () => {
              clearTimeout(force);
              clearTimeout(guard);
              done();
            };
            const guard = setTimeout(finish, 2000);
            wss.close(() => {
              httpServer.close(finish);
              httpServer.closeAllConnections?.();
            });
          }),
      });
    });
  });
}

module.exports = {
  startServer,
  createSignalingServer,
  sanitizeRoom,
  sanitizeName,
  sanitizeCid,
  MAX_PER_ROOM,
  MAX_TEXT_LENGTH,
};

if (require.main === module) {
  const port = Number.parseInt(process.env.PORT || '3001', 10);
  const accessKey = process.env.ACCESS_KEY || '';
  startServer({ port, accessKey })
    .then(({ port: p }) => {
      console.log(`[WinChat] Signaling server đang chạy tại cổng ${p}${accessKey ? ' (có khoá truy cập)' : ''}`);
      console.log(`[WinChat] Kiểm tra: http://localhost:${p}/health`);
    })
    .catch((err) => {
      if (err.code === 'EADDRINUSE') {
        console.error(`[WinChat] Cổng ${port} đã được dùng. Đổi cổng: set PORT=3002 && node server/server.js`);
      } else {
        console.error('[WinChat] Không thể khởi động server:', err);
      }
      process.exit(1);
    });
}
