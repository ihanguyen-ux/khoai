# WinChat — nhắn tin & gọi video 1-1 giữa 2 máy Windows

Ứng dụng desktop (Electron + React + Tailwind) cho **2 máy tính** nhắn tin và gọi thoại/video trực tiếp.
Tin nhắn và tín hiệu kết nối đi qua một **signaling server** nhỏ (WebSocket); âm thanh/hình ảnh đi
**trực tiếp P2P** bằng WebRTC (mã hoá DTLS-SRTP), chỉ đi vòng qua **TURN** khi hai máy không nối thẳng được.

Có 3 cách chạy server — chọn 1:

| Cách | Khi nào dùng | Chi phí |
|---|---|---|
| **A. Cloudflare Worker** (khuyên dùng) | 2 máy ở **khác mạng** / qua Internet. Không cần mở cổng, không cần máy bật sẵn | Miễn phí với mức dùng 2–3 cuộc gọi/ngày |
| **B. Host trong app** | Cùng mạng LAN, hoặc qua VPN (Tailscale/ZeroTier) | Miễn phí |
| **C. VPS riêng** | Muốn tự quản lý | Tiền thuê VPS |

## 1. Kiến trúc

```
        Máy A                                         Máy B
 ┌──────────────────┐        WebSocket (wss)       ┌──────────────────┐
 │ Electron + React │ ───► Signaling server ◄───── │ Electron + React │
 └────────┬─────────┘      (chat, offer/answer/ICE) └────────┬─────────┘
          │                                                  │
          └────────── WebRTC P2P (audio/video) ──────────────┘
                 (qua TURN của Cloudflare nếu không nối thẳng được)
```

- **Signaling** (giao thức giống nhau ở cả 3 cách):
  - `worker/` — Cloudflare Worker + Durable Object (mỗi mã phòng = 1 Durable Object, WebSocket Hibernation).
    Khi vào phòng, server cấp luôn thông tin **TURN ngắn hạn** của Cloudflare cho 2 máy.
  - `server/server.js` — bản Node.js (`ws`), dùng cho chế độ Host trong app hoặc VPS.
  - Phòng tối đa 2 người, server **không lưu** tin nhắn.
- **Electron main** (`electron/main.js`): cửa sổ không viền, IPC có kiểm tra nguồn gửi, chỉ cấp quyền micro/camera,
  chặn điều hướng/mở cửa sổ lạ, toast Windows khi có tin/cuộc gọi lúc cửa sổ không focus.
- **Renderer** (`src/`): React + Tailwind; hook `useConnection` (WebSocket + vào phòng), `useChat`, `useWebRTC`.

### Cấu trúc thư mục

```
winchat/
├─ package.json            # scripts + cấu hình electron-builder
├─ vite.config.mjs         # Vite + React + Tailwind (+ CSP khi build)
├─ index.html
├─ build/icon.png          # icon app (electron-builder tự đổi sang .ico)
├─ electron/
│  ├─ main.js              # cửa sổ, IPC, server nhúng, quyền thiết bị
│  └─ preload.js           # cầu nối an toàn window.winchat
├─ server/
│  ├─ server.js            # signaling bản Node (ws) — chế độ Host / VPS
│  └─ test/                # test giao thức (chạy được cả với Worker) + test client
├─ worker/                 # signaling bản Cloudflare
│  ├─ wrangler.jsonc       # cấu hình Worker + Durable Object
│  └─ src/index.js  room.js
└─ src/
   ├─ main.jsx  App.jsx  index.css
   ├─ hooks/       useConnection.js  useChat.js  useWebRTC.js
   ├─ components/  TitleBar  LoginScreen  Sidebar  ChatPanel  CallLayer  Avatar
   └─ lib/         signal.js  format.js  storage.js  rtcConfig.js  ringtone.js
```

## 2. Cài đặt & chạy thử (Windows 10/11)

Cần **Node.js 22 LTS** — tải tại https://nodejs.org

```bat
cd winchat
npm install
```

**Chạy chế độ phát triển** (2 cửa sổ terminal):

```bat
:: Terminal 1 — giao diện (Vite, có hot reload)
npm run dev

:: Terminal 2 — mở cửa sổ Electron
npm run electron:start
```

Hoặc gộp một lệnh: `npm run start:all`. Chạy bản production chưa đóng gói: `npm run electron:prod`.

**Test:** `npm test` (24 test: giao thức signaling + client WebSocket tự kết nối lại / phát hiện kết nối chết).

## 3. Build file `.exe` cho Windows

Chạy **trên máy Windows**:

```bat
npm run dist
```

Kết quả trong thư mục `release/`:

| File | Dùng để |
|---|---|
| `WinChat Setup 1.0.0.exe` | Bộ cài (NSIS) — chọn thư mục cài, tạo shortcut |
| `WinChat-1.0.0-portable.exe` | Bản chạy thẳng, không cần cài — tiện copy sang máy kia |

`npm run dist:dir` chỉ tạo thư mục `release/win-unpacked/` (nhanh hơn, để thử).

> **Lỗi `Cannot create symbolic link` khi build trên Windows:** bật *Settings → Privacy & security →
> For developers → Developer Mode* (hoặc mở terminal bằng *Run as administrator*), xoá thư mục
> `%LOCALAPPDATA%\electron-builder\Cache` rồi chạy lại.
>
> **SmartScreen cảnh báo khi chạy `.exe`:** vì app chưa được ký số. Chọn *More info → Run anyway*.

## 4. Cách A — Cloudflare Worker (2 máy khác mạng)

Làm **một lần**, trên một máy bất kỳ có Node.js. Cần tài khoản Cloudflare (gói Free).

### Bước 1 — Tạo TURN key (để gọi được khi một bên nằm sau NAT/tường lửa khó)

1. Mở https://dash.cloudflare.com/?to=/:account/calls (mục **Calls / Realtime** trong Dashboard, phần **TURN**).
2. Tạo một **TURN key** (đặt tên bất kỳ, ví dụ `winchat`).
3. Lưu lại 2 giá trị Cloudflare hiện ra: **Key ID** (còn gọi *TURN Token ID*) và **API token** của key đó.
   API token thường **chỉ hiện một lần** — hãy chép ngay.

> Tên nút/menu trong Dashboard có thể khác đôi chút theo thời điểm. Bước TURN là **tuỳ chọn**: bỏ qua thì
> app vẫn chạy, chỉ dùng STUN của Google/Cloudflare (đủ cho phần lớn mạng gia đình, nhưng có thể không gọi
> được khi một bên ở mạng công ty/4G đối xứng).

### Bước 2 — Điền cấu hình và triển khai Worker

```bat
cd worker
npm install
npx wrangler login
```

`wrangler login` mở trình duyệt để bạn đăng nhập Cloudflare và bấm **Allow**. Sau đó:

1. Mở `worker/wrangler.jsonc`, dán **Key ID** vào `"TURN_KEY_ID": "..."` (bỏ qua nếu không dùng TURN).
2. Đặt các bí mật (lệnh sẽ hỏi giá trị, bạn gõ/dán vào — không lưu trong file):

   ```bat
   npx wrangler secret put ACCESS_KEY
   npx wrangler secret put TURN_API_TOKEN
   ```

   - `ACCESS_KEY`: một chuỗi dài ngẫu nhiên do bạn đặt (ví dụ 20+ ký tự). **Rất nên đặt** — không có thì ai biết
     địa chỉ Worker + mã phòng đều vào được và có thể tiêu hao hạn mức miễn phí của bạn.
   - `TURN_API_TOKEN`: API token ở Bước 1 (bỏ qua nếu không dùng TURN).
3. Triển khai:

   ```bat
   npx wrangler deploy
   ```

   Lần đầu Wrangler có thể hỏi đăng ký một tên miền con `*.workers.dev` cho tài khoản — chọn tên bạn thích.
   Cuối lệnh in ra địa chỉ, dạng `https://winchat-signal.<tên-bạn>.workers.dev`.

4. Kiểm tra: mở `https://winchat-signal.<tên-bạn>.workers.dev/health` trong trình duyệt, phải thấy
   `{"ok":true,"service":"winchat-signaling","runtime":"cloudflare-worker","turn":true,"protected":true}`
   (`turn` / `protected` là `true` khi đã cấu hình TURN / khoá truy cập).

### Bước 3 — Dùng trong app (cả 2 máy)

Tab **Tham gia phòng**, trên **cả hai** máy nhập:

- **Tên hiển thị** (mỗi người một tên)
- **Mã phòng**: cùng một mã (ví dụ `ABC123`; bấm 🎲 ở tab Host để tạo mã ngẫu nhiên rồi gửi cho người kia)
- **Địa chỉ server**: `winchat-signal.<tên-bạn>.workers.dev` (không cần gõ `https://`)
- **Nâng cao → Khoá truy cập**: đúng giá trị `ACCESS_KEY` đã đặt

Bấm **Vào phòng**. Hai bên thấy nhau trực tuyến → nhắn tin, bấm 📞 / 🎥 để gọi.

### Hạn mức & chi phí (gói Free) — ước tính cho 2–3 cuộc gọi/ngày

- Mỗi lần vào phòng ≈ vài request; tin nhắn/tín hiệu tính tỉ lệ 20 : 1; gói "ping" giữ kết nối do Cloudflare tự
  trả lời nên **không tính**. Server còn dọn kết nối chết mỗi 30 giây khi có người trong phòng (~2.900 request/ngày
  nếu để app mở 24/24) — vẫn rất xa mức 100.000 request/ngày của gói Free.
- Âm thanh/hình ảnh đi P2P thì **không** tốn gì. Chỉ khi phải đi vòng qua TURN mới tính dung lượng: Cloudflare
  ghi 1.000 GB miễn phí rồi $0,05/GB. Một cuộc gọi video 30 phút qua TURN ước khoảng 1 GB (cả hai chiều, ở ~2 Mbps mỗi chiều), nên
  ngay cả khi 3 cuộc/ngày đều phải qua TURN cũng chỉ khoảng 80 GB/tháng (ước tính, không phải số đo thực).
- Mức miễn phí và giá do Cloudflare quyết định và có thể đổi — kiểm tra trang giá của Cloudflare.

### Chạy thử Worker trên máy bạn (không cần deploy)

```bat
cd worker
copy .dev.vars.example .dev.vars
npx wrangler dev
```

Worker chạy ở `http://127.0.0.1:8787`; trong app nhập địa chỉ `127.0.0.1:8787` và khoá truy cập `khoa-thu-nghiem`.
Test giao thức trực tiếp trên Worker: `set TEST_WS_URL=ws://127.0.0.1:8787` và `set TEST_ACCESS_KEY=khoa-thu-nghiem`
rồi `npm run test:worker` (trên PowerShell: `$env:TEST_WS_URL="ws://127.0.0.1:8787"`).

## 5. Cách B — Cùng mạng LAN (Host trong app)

1. **Máy A:** mở WinChat → tab **Tạo phòng (Host)** → nhập tên, bấm 🎲 tạo mã phòng → **Tạo phòng & bắt đầu**.
   Windows hỏi tường lửa → chọn **Allow access**. Sidebar hiện địa chỉ dạng `192.168.1.20:3001`.
2. **Máy B:** tab **Tham gia phòng** → nhập tên, **cùng mã phòng**, địa chỉ của máy A (ví dụ `192.168.1.20`) → **Vào phòng**.

Qua Internet mà không dùng Cloudflare: cài **Tailscale/ZeroTier** trên cả 2 máy và dùng IP ảo của máy Host
như mạng LAN, hoặc chuyển tiếp cổng TCP `3001` trên router về máy Host.

## 6. Cách C — VPS riêng

```bash
npm install --omit=dev      # chỉ cài thư viện chạy server (ws)
ACCESS_KEY=chuoi-bi-mat PORT=3001 node server/server.js
```

Đặt sau HTTPS (nginx/Caddy) để dùng `wss://`. Cả 2 máy nhập `https://ten-mien-cua-ban` và khoá truy cập.
Bản Node không tự cấp TURN — nhập TURN riêng ở **Nâng cao** nếu cần.

## 7. Xử lý sự cố

| Triệu chứng | Cách xử lý |
|---|---|
| "Không kết nối được tới server" | Đúng địa chỉ chưa? Với Cloudflare, mở thử `https://…workers.dev/health`. Với LAN: đúng IP `192.168.x.x`, cùng mạng, tường lửa máy Host đã *Allow* |
| "Khoá truy cập không đúng" | Nhập lại đúng `ACCESS_KEY` ở **Nâng cao → Khoá truy cập** (đổi key: chạy lại `wrangler secret put ACCESS_KEY`) |
| "Phòng đã đủ 2 người" | Mỗi mã phòng tối đa 2 máy; đổi mã khác. Nếu vừa tắt app đột ngột, đợi ~1 phút để server dọn kết nối cũ |
| Gọi mãi "Đang kết nối…" rồi báo không nối trực tiếp được | Một bên nằm sau NAT/mạng chặn UDP → cần TURN: làm Bước 1–2 mục 4 (kiểm tra `/health` có `"turn":true`) |
| "Không có quyền dùng micro/camera" | *Settings → Privacy & security → Microphone / Camera* → bật **Let desktop apps access** |
| "Micro/camera đang được ứng dụng khác dùng" | Đóng Zoom/Teams/trình duyệt đang giữ webcam |
| Cổng 3001 đang bị chiếm (Host) | Đổi số cổng ở tab Host (vd. 3002); máy kia nhập `IP:3002` |
| Muốn thử trên 1 máy | Mở app 2 lần, dùng cuộc gọi **thoại**; webcam một số máy không chia sẻ được cho 2 cửa sổ |
| `wrangler deploy` báo lỗi Durable Object / migration | Đảm bảo giữ nguyên khối `migrations` (`new_sqlite_classes`) trong `wrangler.jsonc` — gói Free chỉ hỗ trợ Durable Object dùng SQLite |

## 8. Bảo mật & giới hạn (cần biết)

- Audio/video mã hoá end-to-end bởi WebRTC (DTLS-SRTP), kể cả khi đi qua TURN. Chat và tín hiệu đi qua server
  signaling (qua `wss://` với Cloudflare; trên LAN là `ws://` không mã hoá).
- **Khoá truy cập (`ACCESS_KEY`) là lớp bảo vệ chính.** Địa chỉ `workers.dev` là công khai về mặt kỹ thuật;
  hãy đặt khoá, dùng mã phòng ngẫu nhiên dài, và không chia sẻ công khai. Thông tin đăng nhập TURN chỉ được cấp cho
  người đã vào phòng đúng khoá và hết hạn sau 24 giờ.
- Kẻ biết địa chỉ Worker vẫn có thể mở kết nối rồi bị từ chối — mỗi lần như vậy vẫn tính vào hạn mức request.
  Nếu bị lạm dụng, thêm quy tắc **Rate limiting** trong Cloudflare Dashboard (Security → WAF) hoặc đổi tên Worker.
- Tin nhắn chỉ nằm trong bộ nhớ khi app mở — **không lưu lịch sử**, đóng app là mất.
- Chưa có: gửi file, chia sẻ màn hình, nâng cấp thoại → video giữa cuộc gọi, tự khôi phục cuộc gọi đang diễn ra
  khi mất kết nối rồi tự nối lại signaling (cuộc gọi P2P vẫn tiếp tục nếu đường P2P còn sống).
- Địa chỉ server, tên, mã phòng, khoá truy cập và (nếu nhập) thông tin TURN được lưu cục bộ trong `localStorage`
  của app, không được mã hoá.

## 9. Phạm vi đã kiểm thử

Đã chạy tự động trên **Electron thật** (bản dev và bản đóng gói `app.asar`, môi trường Linux giả lập, webcam/micro giả
của Chromium): đăng nhập Host/Join, chat + "đã xem" + "đang gõ", gọi video và thoại (P2P có khung hình/âm thanh thật),
tắt mic/camera, từ chối, hai bên gọi cùng lúc, đối phương rời giữa cuộc gọi, server tắt đột ngột, nút Thu nhỏ/Phóng to/
Đóng, thu nhỏ cửa sổ thì tin nhắn chưa bị tính là "đã xem".
Test giao thức chạy giống hệt trên server Node và trên Worker chạy cục bộ bằng `wrangler dev` (có khoá truy cập,
TURN giả, dọn kết nối chết, thay thế kết nối cùng id).

**Chưa kiểm thử:** chạy trên Windows thật, webcam/micro thật, hai máy khác mạng/qua NAT thật, **Worker đã deploy trên
Cloudflare thật** và TURN thật của Cloudflare (chỉ thử với TURN giả), và bước tạo `.exe` cuối cùng (cần Windows).
Nếu gặp lỗi ở các phần này, hãy gửi lại thông báo lỗi để chỉnh.
