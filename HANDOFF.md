# WinChat — ghi chú bàn giao cho Claude Code

Cập nhật: 2026-10-12. Ngôn ngữ làm việc với người dùng (Hải): **tiếng Việt**.

## 1. Mục tiêu
Ứng dụng desktop Windows (Electron + React/Vite + Tailwind + Lucide) cho **2 máy** nhắn tin và gọi thoại/video 1-1 (WebRTC P2P).
Người dùng dùng ~2–3 cuộc gọi/ngày, 10–30 phút, **đã có tài khoản Cloudflare** → chọn phương án đơn giản nhất:
signaling chạy trên **Cloudflare Worker + Durable Object** (gói Free), TURN của **Cloudflare Realtime**.
Yêu cầu gốc: custom titlebar, sidebar trạng thái đối phương, chat (trạng thái tin + "đang gõ"), gọi (nhận/từ chối, mic/cam, kết thúc), build `.exe` bằng electron-builder.

## 2. Trạng thái: code xong, chờ người dùng deploy Cloudflare
- Toàn bộ code + test + README đã xong và gửi người dùng (`winchat-source.zip`). Bản Project doc: `claude/winchat-README.md`.
- **Việc còn lại phía người dùng** (Claude không có connector Cloudflare, không đăng nhập hộ):
  1. Tạo TURN key (Dashboard → Calls/Realtime → TURN; link `https://dash.cloudflare.com/?to=/:account/calls`) → lấy Key ID + API token. *Tên nút & việc có cần thẻ hay không CHƯA xác minh* (docs không nói). Bước này tuỳ chọn.
  2. `cd worker && npm install && npx wrangler login`
  3. Điền `TURN_KEY_ID` trong `worker/wrangler.jsonc`; `npx wrangler secret put ACCESS_KEY` và `TURN_API_TOKEN`
  4. `npx wrangler deploy` → mở `https://winchat-signal.<sub>.workers.dev/health`
  5. Cả 2 máy: tab "Tham gia phòng", cùng mã phòng, địa chỉ workers.dev, Nâng cao → Khoá truy cập.
- Người dùng sẽ dán kết quả/lỗi → xử lý tiếp. Chưa có phản hồi nào sau bản này.

## 3. Kiến trúc & giao thức (quan trọng, đã đổi so với bản Socket.io cũ)
- WebSocket JSON thuần tại `/ws?room=MAPHONG` (room: `^[A-Z0-9_-]{3,32}$`).
  - client→server `{e, d, i?}`; server→client `{e, d}` hoặc ack `{a:i, d}`.
  - keepalive: text `ping` → `pong` (Worker: `setWebSocketAutoResponse`, không đánh thức DO).
  - sự kiện: `join` (ack `{ok,id,peer,iceServers?}`; lỗi `INVALID|ALREADY_JOINED|ROOM_FULL|UNAUTHORIZED`), `leave`,
    `chat:message` (ack `{ok,peerOnline}`), relay: `chat:delivered|seen|typing`, `call:invite|accept|reject|end|busy|media`, `webrtc:offer|answer|ice`;
    server→client: `peer:joined`, `peer:left`.
  - `join` payload `{name, cid, key}`; `cid` = id phiên ngẫu nhiên (24 hex, tạo mỗi lần `connect()`), cũng là id trong phòng.
    Join lại cùng `cid` **thay thế** socket cũ (đóng code 4000, không phát `peer:left`). Client không tự nối lại khi nhận 4000.
  - Worker đóng 4001 (không join sau 20s), 4002 (không ping >90s; quét mỗi 30s bằng alarm).
- Files:
  - `server/server.js` (Node + `ws`; `startServer({port,host,accessKey})`; dùng cho Host trong Electron & VPS; `ACCESS_KEY`/`PORT` env).
  - `worker/src/index.js` (route `/health`, `/ws`), `worker/src/room.js` (Room DO, hibernation, TURN `generate-ice-servers` ttl 86400, cache 6h, lọc URL `:53`, timeout 4s; lỗi TURN → vẫn join, không có iceServers).
  - `worker/wrangler.jsonc`: migration **`new_sqlite_classes: ["Room"]`** (gói Free chỉ hỗ trợ DO SQLite). `vars.TURN_KEY_ID`. Bí mật dùng `wrangler secret`.
  - `src/lib/signal.js` (`SignalClient`: API giống socket.io — on/off/emit/timeout(ms).emit/disconnect; heartbeat 20s/pong 8s; backoff 1,2,4,5s; gửi `leave` trước khi đóng), `src/hooks/useConnection.js`, `useWebRTC.js` (nhận `iceServers`), `src/lib/rtcConfig.js` (`buildIceServers`: server cấp + TURN tự nhập + STUN Google dự phòng), `src/lib/format.js` (`normalizeServerUrl`: IP/localhost/tên trần → `http://…:3001`; tên miền không cổng → `https://`; có scheme thì giữ).
  - `electron/main.js`: `backgroundThrottling:false` + kênh IPC `window:visible` (vì `document.hidden` luôn false) → `useWindowActive` trong `App.jsx` kết hợp focus + visible + poll 1.5s.

## 4. Test (đều đang PASS)
- `npm test` → 24 test (giao thức 17 trên Node server + 7 test `SignalClient` bằng WebSocket của Node).
- Test giao thức trên Worker: chạy `cd worker && npx wrangler dev`, rồi
  `TEST_WS_URL=ws://127.0.0.1:8787 TEST_ACCESS_KEY=<key> [TEST_EXPECT_ICE=1] npm run test:worker`
  (`worker-extra.test.js` cần thêm `TEST_FAST_SWEEP=1` và `.dev.vars` có `SWEEP_MS=1000 IDLE_MS=4000 JOIN_TIMEOUT_MS=2000`, TURN giả `TURN_API_BASE=http://127.0.0.1:9911` bằng `dev-tools/e2e/mock-turn.mjs`).
  Mẫu vars: `dev-tools/e2e/dev.vars.fast.example`. **Đừng để vars "fast" khi chạy e2e thật** (sẽ đá người dùng ra sau 4s).
- E2E trên Electron thật (Linux giả lập): `dev-tools/e2e/` — `launch.sh` (Xvfb :99 + openbox + 2 Electron, cổng debug 9222/9223, webcam/micro giả), `e2e.py` (24), `e2e2.py` (10, biên), `e2e3.py` (6, nút cửa sổ), `e2e4.py` (13, qua Worker cục bộ + khoá + TURN giả). Cần `playwright` (Python), `xdotool`, `wmctrl`, `x11-utils`, `openbox`, `xvfb`. Relaunch Electron giữa các bài. Đường dẫn trong script đã đổi sang `/tmp/winchat-e2e` — kiểm tra lại khi chạy.
- Kết quả gần nhất: e2e 24/24 (cả bản dev và `app.asar`), e2e2 10/10, e2e3 6/6, e2e4 13/13, `wrangler deploy --dry-run` OK, cài sạch từ zip OK.

## 5. Bẫy môi trường đã gặp
- `pkill -f`/`pgrep -f` chứa chuỗi có trong chính câu lệnh sẽ **giết luôn shell** (exit 143/144). Dùng `pkill -x electron` ở lệnh riêng, hoặc đưa vào script file.
- Playwright `wait_for_function` bị CSP chặn (không `unsafe-eval`) → dùng polling `evaluate`.
- Node `WebSocket` (undici) không bắn `close` khi kết nối lỗi → `SignalClient.onerror` tự `drop()` nếu chưa mở.
- Electron chạy root cần `--no-sandbox`; Xvfb cần window manager (openbox) để test maximize/minimize.
- `electron-builder --win` trên Linux không tạo được `.exe` (thiếu wine) → **`.exe` phải build trên Windows** (`npm run dist`); `dist:dir` + chạy thử `release/win-unpacked/resources/app.asar` bằng Electron Linux thì được.
- Thư mục Cloudflare docs: trang TURN không nêu cách tạo key; nguồn API: `POST https://rtc.live.cloudflare.com/v1/turn/keys/$KEY_ID/credentials/generate-ice-servers` (Bearer token, body `{"ttl":86400}`, trả 201 + `iceServers`).

## 6. Chưa kiểm thử / rủi ro
- Chưa chạy trên Windows thật, webcam/micro thật, 2 máy khác mạng/NAT thật, Worker thật trên Cloudflare, TURN thật, và `.exe` thật.
- Hạn mức Free: 100k request/ngày; alarm quét ~2.9k/ngày nếu để app mở 24/24; TURN 1.000 GB miễn phí rồi $0.05/GB (docs không nói reset theo tháng không). Ước tính tối đa ~80 GB/tháng nếu mọi cuộc gọi đều qua TURN.
- Worker URL công khai: bắt buộc nên đặt `ACCESS_KEY`; kết nối bị từ chối vẫn tính request (gợi ý WAF rate limit).
- Tắt app đột ngột → seat cũ giữ tới ~90s (người dùng có thể gặp ROOM_FULL ngắn) vì `cid` đổi mỗi phiên.
- Chưa có: gửi file, chia sẻ màn hình, nâng cấp thoại→video giữa cuộc gọi, khôi phục cuộc gọi khi signaling rớt (P2P vẫn sống nếu đường truyền còn).
- Ý tưởng tiếp theo (chưa làm, chưa hỏi người dùng): ký số `.exe`, auto-update, lưu lịch sử chat cục bộ.

## 7. Lệnh nhanh
```
npm install && npm test
npm run dev          # + npm run electron:start (hoặc npm run start:all)
npm run dist         # build .exe (trên Windows)
cd worker && npm install && npx wrangler dev    # chạy Worker cục bộ :8787
cd worker && npx wrangler deploy                # deploy thật
```
