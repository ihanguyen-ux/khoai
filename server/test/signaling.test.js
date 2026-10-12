'use strict';

/**
 * Bộ test giao thức signaling. Chạy được với CẢ HAI bản server:
 *   npm test                                  → khởi động server Node (ws) cục bộ
 *   TEST_WS_URL=ws://127.0.0.1:8787 \
 *   TEST_ACCESS_KEY=khoa-bi-mat npm test      → test trực tiếp Cloudflare Worker (wrangler dev / đã deploy)
 *   (thêm TEST_EXPECT_ICE=1 nếu Worker có cấu hình TURN → kiểm tra ack có iceServers)
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const WebSocket = require('ws');
const { startServer } = require('../server');

const REMOTE = process.env.TEST_WS_URL ? process.env.TEST_WS_URL.replace(/\/+$/, '') : '';
const REMOTE_KEY = process.env.TEST_ACCESS_KEY || '';
const EXPECT_ICE = process.env.TEST_EXPECT_ICE === '1';

let base; // ws://host:port
let httpBase; // http://host:port
let accessKey = '';
let local = null;

test.before(async () => {
  if (REMOTE) {
    base = REMOTE;
    httpBase = REMOTE.replace(/^ws/, 'http');
    accessKey = REMOTE_KEY;
  } else {
    local = await startServer({ port: 0, host: '127.0.0.1' });
    base = `ws://127.0.0.1:${local.port}`;
    httpBase = `http://127.0.0.1:${local.port}`;
  }
});

test.after(async () => {
  if (local) await local.close();
});

const randRoom = () => `T${crypto.randomBytes(5).toString('hex').toUpperCase()}`;
const randCid = () => crypto.randomBytes(8).toString('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Client thử nghiệm: gom mọi sự kiện vào hàng đợi để không bị lỡ. */
function open(room, url = base) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${url}/ws?room=${encodeURIComponent(room)}`);
    const queue = [];
    const waiters = [];
    const pending = new Map();
    let seq = 0;
    const c = {
      ws,
      cid: randCid(),
      raw: [],
      closed: null,
      emit: (e, d) => ws.send(JSON.stringify({ e, d })),
      request(e, d, timeout = 4000) {
        const i = String(++seq);
        return new Promise((res, rej) => {
          const t = setTimeout(() => rej(new Error(`ack timeout: ${e}`)), timeout);
          pending.set(i, (v) => {
            clearTimeout(t);
            res(v);
          });
          ws.send(JSON.stringify({ e, d, i }));
        });
      },
      join(name = 'User', extra = {}) {
        return c.request('join', { name, cid: c.cid, key: accessKey, ...extra });
      },
      next(e, timeout = 3000) {
        const idx = queue.findIndex((m) => m.e === e);
        if (idx >= 0) return Promise.resolve(queue.splice(idx, 1)[0].d);
        return new Promise((res, rej) => {
          const t = setTimeout(() => {
            waiters.splice(waiters.indexOf(w), 1);
            rej(new Error(`timeout chờ sự kiện ${e}`));
          }, timeout);
          const w = { e, res: (d) => { clearTimeout(t); res(d); } };
          waiters.push(w);
        });
      },
      async none(e, ms = 400) {
        await sleep(ms);
        assert.equal(queue.some((m) => m.e === e), false, `không được nhận ${e}`);
      },
      close: () => ws.close(),
      waitClose: () =>
        c.closed
          ? Promise.resolve(c.closed)
          : new Promise((res) => ws.once('close', (code) => res({ code }))),
    };
    ws.on('message', (data) => {
      const text = data.toString();
      c.raw.push(text);
      if (text === 'pong') return;
      const m = JSON.parse(text);
      if (m.a !== undefined) {
        const cb = pending.get(String(m.a));
        if (cb) { pending.delete(String(m.a)); cb(m.d); }
        return;
      }
      const wi = waiters.findIndex((w) => w.e === m.e);
      if (wi >= 0) waiters.splice(wi, 1)[0].res(m.d);
      else queue.push(m);
    });
    ws.on('close', (code) => { c.closed = { code }; });
    ws.once('open', () => resolve(c));
    ws.once('error', reject);
  });
}

async function pair(room = randRoom()) {
  const a = await open(room);
  const b = await open(room);
  const ra = await a.join('Hải');
  const rb = await b.join('Lan');
  assert.equal(ra.ok, true, JSON.stringify(ra));
  assert.equal(rb.ok, true, JSON.stringify(rb));
  await a.next('peer:joined');
  return { a, b, ra, rb, room };
}

test('/health trả về ok', async () => {
  const res = await fetch(`${httpBase}/health`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
});

test('vào phòng: thấy nhau, phòng đầy với người thứ 3', async () => {
  const room = randRoom();
  const a = await open(room);
  const ra = await a.join('Hải');
  assert.equal(ra.ok, true);
  assert.equal(ra.id, a.cid);
  assert.equal(ra.peer, null);
  if (EXPECT_ICE) {
    assert.ok(Array.isArray(ra.iceServers) && ra.iceServers.length > 0, 'ack phải có iceServers');
  }

  const b = await open(room);
  const rb = await b.join('Lan');
  assert.equal(rb.ok, true);
  assert.deepEqual(rb.peer, { id: a.cid, name: 'Hải' });
  assert.deepEqual(await a.next('peer:joined'), { id: b.cid, name: 'Lan' });

  const c = await open(room);
  const rc = await c.join('Mai');
  assert.deepEqual(rc, { ok: false, error: 'ROOM_FULL' });
  [a, b, c].forEach((x) => x.close());
});

test('vào phòng với dữ liệu sai bị từ chối; vào hai lần bị từ chối', async () => {
  const a = await open(randRoom());
  assert.equal((await a.join('   ')).error, 'INVALID');
  assert.equal((await a.join('Tên', { cid: 'ngắn' })).error, 'INVALID');
  assert.equal((await a.request('join', 'không-phải-object')).ok, false);
  const ok = await a.join('Hợp lệ');
  assert.equal(ok.ok, true);
  assert.equal((await a.join('Lần hai')).error, 'ALREADY_JOINED');
  a.close();
});

test('mã phòng sai trên URL bị từ chối ngay khi bắt tay', async () => {
  await assert.rejects(open('ab'), /400|Unexpected server response|socket hang up|ECONNRESET/);
  await assert.rejects(open('co khoang trang'), /400|Unexpected server response|socket hang up|ECONNRESET/);
});

test('chưa vào phòng thì không gửi chat được và không rò rỉ relay', async () => {
  const room = randRoom();
  const a = await open(room);
  const b = await open(room);
  await b.join('Lan');
  assert.equal((await a.request('chat:message', { id: 'm1', text: 'x' })).error, 'NOT_IN_ROOM');
  a.emit('chat:typing', { typing: true });
  await b.none('chat:typing');
  [a, b].forEach((x) => x.close());
});

test('chat: chuyển tiếp, delivered / seen / typing', async () => {
  const { a, b } = await pair();
  const ack = await a.request('chat:message', { id: 'm1', text: 'Xin chào', ts: 123 });
  assert.deepEqual(ack, { ok: true, peerOnline: true });
  assert.deepEqual(await b.next('chat:message'), { id: 'm1', text: 'Xin chào', ts: 123 });

  b.emit('chat:delivered', { id: 'm1' });
  assert.deepEqual(await a.next('chat:delivered'), { id: 'm1' });
  b.emit('chat:seen', { ids: ['m1'] });
  assert.deepEqual(await a.next('chat:seen'), { ids: ['m1'] });
  b.emit('chat:typing', { typing: true });
  assert.deepEqual(await a.next('chat:typing'), { typing: true });
  [a, b].forEach((x) => x.close());
});

test('chat khi đối phương vắng mặt: peerOnline=false', async () => {
  const a = await open(randRoom());
  await a.join('Hải');
  assert.deepEqual(await a.request('chat:message', { id: 'm1', text: 'hi' }), { ok: true, peerOnline: false });
  a.close();
});

test('chat: dữ liệu sai bị từ chối', async () => {
  const { a, b } = await pair();
  const bad = [
    null,
    {},
    { id: '', text: 'x' },
    { id: 'm', text: '' },
    { id: 'm', text: 'a'.repeat(4001) },
    { id: 'x'.repeat(65), text: 'x' },
    { id: 5, text: 'x' },
  ];
  for (const payload of bad) {
    assert.equal((await a.request('chat:message', payload)).error, 'INVALID', JSON.stringify(payload));
  }
  await b.none('chat:message');
  [a, b].forEach((x) => x.close());
});

test('call + webrtc: chuyển tiếp nguyên vẹn hai chiều', async () => {
  const { a, b } = await pair();
  const events = [
    ['call:invite', { type: 'video', callId: 'c1' }],
    ['call:accept', { callId: 'c1' }],
    ['webrtc:offer', { callId: 'c1', sdp: { type: 'offer', sdp: 'v=0...' } }],
    ['webrtc:answer', { callId: 'c1', sdp: { type: 'answer', sdp: 'v=0...' } }],
    ['webrtc:ice', { callId: 'c1', candidate: { candidate: 'candidate:1 1 udp 1 1.2.3.4 5 typ host' } }],
    ['call:media', { callId: 'c1', mic: false, cam: true }],
    ['call:busy', { callId: 'c2' }],
    ['call:reject', { callId: 'c3' }],
    ['call:end', { callId: 'c1' }],
  ];
  for (const [e, d] of events) {
    a.emit(e, d);
    assert.deepEqual(await b.next(e), d, e);
    b.emit(e, d);
    assert.deepEqual(await a.next(e), d, e);
  }
  [a, b].forEach((x) => x.close());
});

test('sự kiện lạ không được chuyển tiếp', async () => {
  const { a, b } = await pair();
  a.emit('hack:anything', { x: 1 });
  a.emit('join', null);
  await b.none('hack:anything');
  [a, b].forEach((x) => x.close());
});

test('các phòng cô lập với nhau', async () => {
  const p1 = await pair();
  const p2 = await pair();
  p1.a.emit('chat:typing', { typing: true });
  assert.deepEqual(await p1.b.next('chat:typing'), { typing: true });
  await p2.a.none('chat:typing');
  await p2.b.none('chat:typing');
  [p1.a, p1.b, p2.a, p2.b].forEach((x) => x.close());
});

test('rời phòng → peer:left; vào lại → peer:joined', async () => {
  const { a, b, room } = await pair();
  b.close();
  assert.deepEqual(await a.next('peer:left'), { id: b.cid });

  const b2 = await open(room);
  const r = await b2.join('Lan');
  assert.equal(r.ok, true);
  assert.deepEqual(r.peer, { id: a.cid, name: 'Hải' });
  assert.deepEqual(await a.next('peer:joined'), { id: b2.cid, name: 'Lan' });
  [a, b2].forEach((x) => x.close());
});

test('"leave": báo peer:left ngay, rồi vào lại được', async () => {
  const { a, b, room } = await pair();
  b.emit('leave');
  assert.deepEqual(await a.next('peer:left'), { id: b.cid });
  b.emit('chat:typing', { typing: true }); // đã rời phòng → không được chuyển tiếp
  await a.none('chat:typing');
  const b2 = await open(room);
  assert.equal((await b2.join('Lan')).ok, true);
  [a, b, b2].forEach((x) => x.close());
});

test('kết nối lại cùng cid thay thế kết nối cũ (không báo rời phòng, không bị ROOM_FULL)', async () => {
  const { a, b, room } = await pair();
  const b2 = await open(room);
  b2.cid = b.cid; // cùng một máy kết nối lại
  const r = await b2.join('Lan');
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(r.peer, { id: a.cid, name: 'Hải' });
  assert.equal((await b.waitClose()).code, 4000);
  await a.none('peer:left');
  // kết nối mới vẫn dùng được
  b2.emit('chat:typing', { typing: true });
  assert.deepEqual(await a.next('chat:typing'), { typing: true });
  [a, b2].forEach((x) => x.close());
});

test('keepalive: "ping" → "pong"', async () => {
  const a = await open(randRoom());
  a.ws.send('ping');
  await sleep(300);
  assert.ok(a.raw.includes('pong'), 'phải nhận được pong');
  a.close();
});

test('JSON rác không làm sập server', async () => {
  const a = await open(randRoom());
  a.ws.send('{không phải json');
  a.ws.send('123');
  a.ws.send(JSON.stringify({ e: 5 }));
  const r = await a.join('Vẫn sống');
  assert.equal(r.ok, true);
  a.close();
});

test('khoá truy cập: sai khoá bị từ chối, đúng khoá vào được', async () => {
  let srv = null;
  let url = base;
  let goodKey = accessKey;
  if (!REMOTE) {
    srv = await startServer({ port: 0, host: '127.0.0.1', accessKey: 'khoa-dung' });
    url = `ws://127.0.0.1:${srv.port}`;
    goodKey = 'khoa-dung';
  } else if (!accessKey) {
    return; // Worker không bật khoá → bỏ qua
  }
  try {
    const room = randRoom();
    const bad = await open(room, url);
    assert.equal((await bad.join('X', { key: 'sai-khoa' })).error, 'UNAUTHORIZED');
    assert.equal((await bad.join('X', { key: undefined })).error, 'UNAUTHORIZED');
    bad.close();

    const good = await open(room, url);
    assert.equal((await good.join('Y', { key: goodKey })).ok, true);
    good.close();
  } finally {
    if (srv) await srv.close();
  }
});
