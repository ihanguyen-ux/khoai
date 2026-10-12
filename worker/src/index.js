/**
 * WinChat signaling trên Cloudflare Workers.
 *
 *   GET  /health              → JSON trạng thái (không đụng tới Durable Object)
 *   GET  /ws?room=MAPHONG     → nâng cấp WebSocket, chuyển cho Durable Object của phòng đó
 *
 * Mỗi mã phòng ↔ một Durable Object (xem room.js), nên 2 người cùng mã luôn gặp nhau ở cùng một nơi.
 */

import { Room } from './room.js';

export { Room };

const ROOM_PATTERN = /^[A-Z0-9_-]{3,32}$/;

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-store',
    },
  });

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/health') {
      return json({
        ok: true,
        service: 'winchat-signaling',
        runtime: 'cloudflare-worker',
        turn: Boolean(env.TURN_KEY_ID && env.TURN_API_TOKEN),
        protected: Boolean(env.ACCESS_KEY),
      });
    }

    if (url.pathname === '/ws') {
      if (request.headers.get('Upgrade') !== 'websocket') {
        return new Response('Expected a WebSocket upgrade', { status: 426 });
      }
      const room = String(url.searchParams.get('room') ?? '').trim().toUpperCase();
      if (!ROOM_PATTERN.test(room)) {
        return new Response('Invalid room', { status: 400 });
      }
      const stub = env.ROOMS.get(env.ROOMS.idFromName(room));
      return stub.fetch(request);
    }

    return new Response(url.pathname === '/' ? 'WinChat signaling (Cloudflare Worker)\n' : 'Not found\n', {
      status: url.pathname === '/' ? 200 : 404,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
  },
};
