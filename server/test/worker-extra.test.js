'use strict';

/**
 * Test riêng cho Cloudflare Worker (cần `wrangler dev` với .dev.vars: SWEEP_MS=1000, IDLE_MS=4000,
 * JOIN_TIMEOUT_MS=2000 và TURN giả). Chạy:
 *   TEST_WS_URL=ws://127.0.0.1:8787 TEST_ACCESS_KEY=khoa-test TEST_FAST_SWEEP=1 \
 *     node --test server/test/worker-extra.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const WebSocket = require('ws');

const BASE = process.env.TEST_WS_URL;
const KEY = process.env.TEST_ACCESS_KEY || '';
const skip = !BASE || process.env.TEST_FAST_SWEEP !== '1';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const room = () => `X${crypto.randomBytes(5).toString('hex').toUpperCase()}`;

function conn(r) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${BASE}/ws?room=${r}`);
    const c = { ws, cid: crypto.randomBytes(8).toString('hex'), events: [], closeCode: null, pending: new Map(), n: 0 };
    ws.on('message', (data) => {
      const t = data.toString();
      if (t === 'pong') return;
      const m = JSON.parse(t);
      if (m.a !== undefined) c.pending.get(String(m.a))?.(m.d);
      else c.events.push(m);
    });
    ws.on('close', (code) => { c.closeCode = code; });
    ws.once('open', () => resolve(c));
    ws.once('error', reject);
    c.join = (name) =>
      new Promise((res) => {
        const i = String(++c.n);
        c.pending.set(i, res);
        ws.send(JSON.stringify({ e: 'join', i, d: { name, cid: c.cid, key: KEY } }));
      });
  });
}

test('iceServers từ TURN: có TURN, đã lọc cổng 53', { skip }, async () => {
  const a = await conn(room());
  const r = await a.join('A');
  assert.equal(r.ok, true);
  const all = r.iceServers.flatMap((s) => s.urls);
  assert.ok(all.some((u) => u.startsWith('stun:')));
  assert.ok(all.some((u) => u.startsWith('turn:turn.cloudflare.com:3478')));
  assert.ok(all.some((u) => u.startsWith('turns:')));
  assert.ok(!all.some((u) => /:53(\?|$)/.test(u)), 'phải lọc URL cổng 53: ' + all.join(','));
  const turn = r.iceServers.find((s) => s.username);
  assert.equal(turn.username, 'u');
  assert.equal(turn.credential, 'c');
  a.ws.close();
});

test('kết nối mở nhưng không vào phòng bị đóng (4001)', { skip }, async () => {
  const a = await conn(room());
  await sleep(4500);
  // wrangler dev đôi khi không đóng hẳn TCP sau khi gửi khung close → chấp nhận CLOSING (2) hoặc CLOSED (3)
  assert.ok(a.closeCode === 4001 || a.ws.readyState >= 2, `socket phải bị đóng, readyState=${a.ws.readyState}`);
});

test('mất keepalive → server đóng (4002) và báo peer:left cho người còn lại', { skip }, async () => {
  const r = room();
  const a = await conn(r);
  const b = await conn(r);
  await a.join('A');
  await b.join('B');
  // A gửi ping đều đặn, B im lặng
  const timer = setInterval(() => a.ws.readyState === 1 && a.ws.send('ping'), 1000);
  try {
    await sleep(8000);
    assert.equal(b.closeCode, 4002, 'B phải bị đóng vì idle');
    assert.equal(a.closeCode, null, 'A vẫn còn kết nối');
    assert.ok(a.events.some((e) => e.e === 'peer:left' && e.d.id === b.cid), 'A phải nhận peer:left');
  } finally {
    clearInterval(timer);
    a.ws.close();
  }
});
