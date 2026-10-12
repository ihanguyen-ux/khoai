/**
 * Client signaling qua WebSocket thuần (dùng được với cả server Node và Cloudflare Worker).
 *
 * Giao thức:  gửi { e, d, i? } — nhận { e, d } (sự kiện) hoặc { a, d } (trả lời yêu cầu có i)
 * Keepalive:  gửi "ping" mỗi 20 giây, mong "pong"; im lặng quá 8 giây → coi là mất kết nối và tự kết nối lại.
 *
 * API cố ý giống một phần của socket.io-client để các hook chat/gọi dùng lại gần như nguyên vẹn:
 *   on / off / removeAllListeners / emit / timeout(ms).emit(e, d, (err, res) => …) / disconnect / id / connected
 * Sự kiện nội bộ: 'connect' (mỗi lần mở được kết nối, kể cả lần tự nối lại), 'connect_error', 'disconnect'.
 */

const HEARTBEAT_MS = 20_000;
const PONG_TIMEOUT_MS = 8_000;
const CONNECT_TIMEOUT_MS = 6_000;
const BACKOFF_MS = [1000, 2000, 4000, 5000];
export const CLOSE_REPLACED = 4000;

/** "http://host:3001" + "ABC123" → "ws://host:3001/ws?room=ABC123" (https → wss). */
export function buildSignalUrl(serverUrl, room) {
  const u = new URL(serverUrl);
  if (u.protocol === 'http:') u.protocol = 'ws:';
  else if (u.protocol === 'https:') u.protocol = 'wss:';
  u.pathname = '/ws';
  u.search = '';
  u.hash = '';
  u.searchParams.set('room', room);
  return u.toString();
}

export class SignalClient {
  /**
   * @param {string} url  địa chỉ WebSocket đầy đủ (xem buildSignalUrl)
   * @param {string} cid  mã định danh của phiên này (cũng là id của mình trong phòng)
   * @param {{ heartbeatMs?: number, pongTimeoutMs?: number }} [opts]  chỉnh thời gian (dùng cho test)
   */
  constructor(url, cid, opts = {}) {
    this.url = url;
    this.id = cid;
    this.heartbeatMs = opts.heartbeatMs || HEARTBEAT_MS;
    this.pongTimeoutMs = opts.pongTimeoutMs || PONG_TIMEOUT_MS;
    this.connected = false;

    this.listeners = new Map();
    this.pending = new Map();
    this.seq = 0;
    this.ws = null;
    this.stopped = false;
    this.attempt = 0;
    this.timers = { heartbeat: null, pong: null, retry: null, connect: null };

    this.onOnline = () => {
      if (this.stopped || this.connected || !this.timers.retry) return;
      clearTimeout(this.timers.retry);
      this.timers.retry = null;
      this.open();
    };
    if (typeof window !== 'undefined') window.addEventListener('online', this.onOnline);

    this.open();
  }

  // ----- sự kiện ---------------------------------------------------------------

  on(event, fn) {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event).add(fn);
    return this;
  }

  off(event, fn) {
    const set = this.listeners.get(event);
    if (set) set.delete(fn);
    return this;
  }

  removeAllListeners() {
    this.listeners.clear();
    return this;
  }

  dispatch(event, data) {
    const set = this.listeners.get(event);
    if (!set) return;
    for (const fn of [...set]) {
      try {
        fn(data);
      } catch (err) {
        console.error(`[signal] lỗi trong trình xử lý "${event}":`, err);
      }
    }
  }

  // ----- gửi -------------------------------------------------------------------

  /** Gửi sự kiện, không chờ trả lời. @returns {boolean} false nếu chưa kết nối (gói tin bị bỏ) */
  emit(event, data) {
    return this.write({ e: event, d: data });
  }

  /** Gửi yêu cầu và chờ trả lời. */
  request(event, data, timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
      const i = String(++this.seq);
      const timer = setTimeout(() => {
        this.pending.delete(i);
        reject(new Error('timeout'));
      }, timeoutMs);
      this.pending.set(i, { resolve, reject, timer });
      if (!this.write({ e: event, d: data, i })) {
        clearTimeout(timer);
        this.pending.delete(i);
        reject(new Error('not connected'));
      }
    });
  }

  /** Giống socket.io: socket.timeout(ms).emit(event, data, (err, res) => …) */
  timeout(ms) {
    return {
      emit: (event, data, cb) => {
        this.request(event, data, ms).then(
          (res) => cb(null, res),
          (err) => cb(err)
        );
      },
    };
  }

  write(obj) {
    if (!this.ws || this.ws.readyState !== 1) return false;
    try {
      this.ws.send(JSON.stringify(obj));
      return true;
    } catch {
      return false;
    }
  }

  // ----- vòng đời kết nối ------------------------------------------------------

  open() {
    if (this.stopped) return;
    let ws;
    try {
      ws = new WebSocket(this.url);
    } catch {
      this.afterClose(ws, 0, false);
      return;
    }
    this.ws = ws;
    let opened = false;

    this.timers.connect = setTimeout(() => {
      if (!opened) this.drop(ws, 0, false);
    }, CONNECT_TIMEOUT_MS);

    ws.onopen = () => {
      if (this.ws !== ws) return;
      opened = true;
      clearTimeout(this.timers.connect);
      this.connected = true;
      this.attempt = 0;
      this.startHeartbeat(ws);
      this.dispatch('connect');
    };

    ws.onmessage = (ev) => {
      if (this.ws !== ws) return;
      clearTimeout(this.timers.pong); // có dữ liệu về = còn sống
      this.timers.pong = null;
      if (typeof ev.data !== 'string' || ev.data === 'pong') return;
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (msg === null || typeof msg !== 'object') return;
      if (msg.a !== undefined) {
        const p = this.pending.get(String(msg.a));
        if (p) {
          clearTimeout(p.timer);
          this.pending.delete(String(msg.a));
          p.resolve(msg.d);
        }
      } else if (typeof msg.e === 'string') {
        this.dispatch(msg.e, msg.d);
      }
    };

    ws.onclose = (ev) => {
      if (this.ws !== ws) return;
      this.afterClose(ws, ev.code, opened);
    };
    ws.onerror = () => {
      // Lỗi khi đang kết nối = thất bại. Trình duyệt sẽ bắn onclose ngay sau, nhưng Node thì không → tự xử lý
      // (drop() bỏ các trình xử lý cũ nên không bị tính hai lần).
      if (!opened) setTimeout(() => this.drop(ws, 1006, false), 0);
    };
  }

  startHeartbeat(ws) {
    clearInterval(this.timers.heartbeat);
    this.timers.heartbeat = setInterval(() => {
      if (this.ws !== ws || ws.readyState !== 1) return;
      if (this.timers.pong) return; // vẫn đang chờ trả lời của lần ping trước
      try {
        ws.send('ping');
      } catch {
        return;
      }
      this.timers.pong = setTimeout(() => this.drop(ws, 1006, true), this.pongTimeoutMs);
    }, this.heartbeatMs);
  }

  /** Bỏ một kết nối không phản hồi mà không chờ trình duyệt hoàn tất bắt tay đóng. */
  drop(ws, code, wasOpen) {
    if (this.ws !== ws) return;
    ws.onopen = null;
    ws.onmessage = null;
    ws.onclose = null;
    try {
      ws.close();
    } catch {
      /* đã đóng */
    }
    this.afterClose(ws, code, wasOpen);
  }

  afterClose(ws, code, wasOpen) {
    if (ws && this.ws !== ws) return;
    clearInterval(this.timers.heartbeat);
    clearTimeout(this.timers.pong);
    this.timers.pong = null;
    clearTimeout(this.timers.connect);
    this.ws = null;

    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error('disconnected'));
    }
    this.pending.clear();

    if (this.stopped) return;

    if (wasOpen || this.connected) {
      this.connected = false;
      this.dispatch('disconnect', { code });
    } else {
      this.dispatch('connect_error', { code });
    }

    // Bị thay thế bởi một kết nối khác cùng id → không tranh giành nữa
    if (code === CLOSE_REPLACED) return;

    const delay = BACKOFF_MS[Math.min(this.attempt, BACKOFF_MS.length - 1)];
    this.attempt += 1;
    this.timers.retry = setTimeout(() => {
      this.timers.retry = null;
      this.open();
    }, delay);
  }

  disconnect() {
    this.stopped = true;
    this.connected = false;
    if (typeof window !== 'undefined') window.removeEventListener('online', this.onOnline);
    clearInterval(this.timers.heartbeat);
    clearTimeout(this.timers.pong);
    clearTimeout(this.timers.retry);
    clearTimeout(this.timers.connect);
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error('disconnected'));
    }
    this.pending.clear();
    const ws = this.ws;
    // Báo rời phòng trước khi đóng để người kia nhận peer:left ngay (kể cả khi server tắt theo ngay sau đó)
    if (ws && ws.readyState === 1) {
      try {
        ws.send(JSON.stringify({ e: 'leave' }));
      } catch {
        /* bỏ qua */
      }
    }
    this.ws = null;
    if (ws) {
      ws.onopen = null;
      ws.onmessage = null;
      ws.onclose = null;
      try {
        ws.close(1000);
      } catch {
        /* đã đóng */
      }
    }
  }
}
