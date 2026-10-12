// Test SignalClient (src/lib/signal.js) với WebSocket có sẵn của Node 22 — không cần trình duyệt.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createRequire } from 'node:module';
import { SignalClient, buildSignalUrl } from '../../src/lib/signal.js';

const require = createRequire(import.meta.url);
const { startServer } = require('../server.js');
const { WebSocketServer } = require('ws');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (cond, ms = 6000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return;
    await sleep(25);
  }
  throw new Error('hết thời gian chờ điều kiện');
};

test('buildSignalUrl: http→ws, https→wss, giữ cổng, thêm /ws?room=', () => {
  assert.equal(buildSignalUrl('http://192.168.1.2:3001', 'ABC123'), 'ws://192.168.1.2:3001/ws?room=ABC123');
  assert.equal(buildSignalUrl('https://x.workers.dev', 'ABC123'), 'wss://x.workers.dev/ws?room=ABC123');
  assert.equal(buildSignalUrl('wss://x.workers.dev/', 'A-B_C'), 'wss://x.workers.dev/ws?room=A-B_C');
});

test('kết nối, request/ack, timeout(ms).emit, emit khi chưa kết nối trả false', async () => {
  const srv = await startServer({ port: 0, host: '127.0.0.1' });
  const c = new SignalClient(`ws://127.0.0.1:${srv.port}/ws?room=ROOMT1`, 'client-id-0001');
  assert.equal(c.emit('chat:typing', {}), false); // chưa mở
  let connects = 0;
  c.on('connect', () => (connects += 1));
  await until(() => c.connected);
  const res = await c.request('join', { name: 'A', cid: 'client-id-0001' });
  assert.equal(res.ok, true);
  const viaTimeout = await new Promise((resolve) =>
    c.timeout(2000).emit('chat:message', { id: 'm1', text: 'hi' }, (err, r) => resolve({ err, r }))
  );
  assert.equal(viaTimeout.err, null);
  assert.deepEqual(viaTimeout.r, { ok: true, peerOnline: false });
  assert.equal(connects, 1);
  c.disconnect();
  await srv.close();
});

test('mất server → disconnect; server trở lại cùng cổng → tự kết nối lại', async () => {
  let srv = await startServer({ port: 0, host: '127.0.0.1' });
  const port = srv.port;
  const c = new SignalClient(`ws://127.0.0.1:${port}/ws?room=ROOMT2`, 'client-id-0002');
  const log = [];
  c.on('connect', () => log.push('connect'));
  c.on('disconnect', () => log.push('disconnect'));
  c.on('connect_error', () => log.push('connect_error'));
  await until(() => c.connected);

  const pendingReq = c.request('join', { name: 'A', cid: 'client-id-0002' }, 5000);
  await pendingReq;
  await srv.close();
  await until(() => log.includes('disconnect'));
  assert.equal(c.connected, false);

  srv = await startServer({ port, host: '127.0.0.1' });
  await until(() => log.filter((x) => x === 'connect').length === 2, 10000);
  assert.equal(c.connected, true);
  assert.ok(log.includes('connect_error') || log.includes('disconnect'));
  c.disconnect();
  await srv.close();
});

test('request đang chờ bị reject khi mất kết nối', async () => {
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' }); // server không bao giờ trả lời
  await new Promise((r) => wss.on('listening', r));
  const c = new SignalClient(`ws://127.0.0.1:${wss.address().port}/ws?room=X`, 'client-id-0003', {});
  await until(() => c.connected);
  const p = c.request('join', {}, 5000);
  setTimeout(() => wss.clients.forEach((w) => w.terminate()), 100);
  await assert.rejects(p, /disconnected/);
  c.disconnect();
  wss.close();
});

test('server im lặng (không pong) → client tự bỏ kết nối chết và nối lại', async () => {
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise((r) => wss.on('listening', r));
  let accepted = 0;
  wss.on('connection', () => (accepted += 1)); // nhận kết nối nhưng không trả "pong"
  const c = new SignalClient(`ws://127.0.0.1:${wss.address().port}/ws?room=X`, 'client-id-0004', {
    heartbeatMs: 200,
    pongTimeoutMs: 300,
  });
  const events = [];
  c.on('disconnect', () => events.push('disconnect'));
  await until(() => c.connected);
  await until(() => events.length >= 1, 4000);
  await until(() => accepted >= 2, 6000); // đã tự nối lại
  c.disconnect();
  wss.close();
});

test('bị thay thế (close 4000) → không tự nối lại', async () => {
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise((r) => wss.on('listening', r));
  let accepted = 0;
  wss.on('connection', (ws) => {
    accepted += 1;
    setTimeout(() => ws.close(4000, 'replaced'), 50);
  });
  const c = new SignalClient(`ws://127.0.0.1:${wss.address().port}/ws?room=X`, 'client-id-0005');
  let info = null;
  c.on('disconnect', (i) => (info = i));
  await until(() => info !== null);
  assert.equal(info.code, 4000);
  await sleep(2500);
  assert.equal(accepted, 1, 'không được nối lại');
  c.disconnect();
  wss.close();
});

test('connect_error khi không có ai lắng nghe, rồi disconnect() dừng hẳn việc thử lại', async () => {
  const probe = http.createServer().listen(0, '127.0.0.1');
  await new Promise((r) => probe.on('listening', r));
  const port = probe.address().port;
  await new Promise((r) => probe.close(r)); // cổng giờ trống
  const c = new SignalClient(`ws://127.0.0.1:${port}/ws?room=X`, 'client-id-0006');
  let errors = 0;
  c.on('connect_error', () => (errors += 1));
  await until(() => errors >= 2, 8000);
  c.disconnect();
  const n = errors;
  await sleep(1500);
  assert.equal(errors, n);
});
