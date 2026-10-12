import { useState } from 'react';
import { ChevronDown, ChevronRight, Dices, Loader2, MessagesSquare, Server, Wifi } from 'lucide-react';
import {
  DEFAULT_PORT,
  generateRoomCode,
  isValidRoom,
  normalizeRoom,
  normalizeServerUrl,
} from '../lib/format';
import { loadSettings, saveSettings } from '../lib/storage';

const inputCls =
  'w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2.5 text-sm text-zinc-100 outline-none transition-colors placeholder:text-zinc-500 focus:border-blue-500';
const labelCls = 'mb-1.5 block text-xs font-medium text-zinc-400';

/**
 * Màn hình đầu tiên: chọn Host (máy này chạy server) hoặc Tham gia (kết nối tới server của máy kia).
 * onSubmit({ mode, name, room, serverUrl, port }) → Promise<{ ok, error? }>
 */
export default function LoginScreen({ onSubmit, lastError }) {
  const canHost = Boolean(window.winchat && window.winchat.server);
  const saved = loadSettings();

  const [mode, setMode] = useState(canHost && saved.mode === 'host' ? 'host' : 'join');
  const [name, setName] = useState(saved.name);
  const [room, setRoom] = useState(saved.room || '');
  const [serverAddress, setServerAddress] = useState(saved.serverAddress);
  const [port, setPort] = useState(String(saved.port || DEFAULT_PORT));
  const [accessKey, setAccessKey] = useState(saved.accessKey || '');
  const [turnUrl, setTurnUrl] = useState(saved.turnUrl);
  const [turnUser, setTurnUser] = useState(saved.turnUser);
  const [turnPass, setTurnPass] = useState(saved.turnPass);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(lastError || '');

  const isHost = mode === 'host';

  async function handleSubmit(e) {
    e.preventDefault();
    if (busy) return;
    setError('');

    const cleanName = name.trim();
    const cleanRoom = normalizeRoom(room);
    if (!cleanName) return setError('Hãy nhập tên hiển thị.');
    if (!isValidRoom(cleanRoom)) {
      return setError('Mã phòng gồm 3–32 ký tự: chữ cái, số, dấu - hoặc _ (không có khoảng trắng).');
    }

    let serverUrl = '';
    let portNumber = Number.parseInt(port, 10);
    if (isHost) {
      if (!Number.isInteger(portNumber) || portNumber < 1024 || portNumber > 65535) {
        return setError('Cổng phải là số từ 1024 đến 65535.');
      }
    } else {
      serverUrl = normalizeServerUrl(serverAddress);
      if (!serverUrl) return setError('Hãy nhập địa chỉ server (ví dụ 192.168.1.20).');
      portNumber = DEFAULT_PORT;
    }

    saveSettings({
      name: cleanName,
      mode,
      room: cleanRoom,
      serverAddress: isHost ? saved.serverAddress : serverAddress.trim(),
      port: isHost ? portNumber : saved.port,
      accessKey: accessKey.trim(),
      turnUrl: turnUrl.trim(),
      turnUser: turnUser.trim(),
      turnPass,
    });

    setBusy(true);
    const result = await onSubmit({
      mode,
      name: cleanName,
      room: cleanRoom,
      serverUrl,
      port: portNumber,
      accessKey: accessKey.trim(),
    });
    setBusy(false);
    if (!result.ok) setError(result.error || 'Không thể kết nối.');
  }

  const tab = (value, icon, label) => (
    <button
      type="button"
      onClick={() => setMode(value)}
      className={`flex flex-1 items-center justify-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition-colors ${
        mode === value ? 'bg-blue-600 text-white' : 'text-zinc-400 hover:text-zinc-100'
      }`}
    >
      {icon}
      {label}
    </button>
  );

  return (
    <div className="flex flex-1 items-center justify-center overflow-y-auto p-6">
      <form
        onSubmit={handleSubmit}
        className="w-full max-w-md rounded-2xl border border-zinc-800 bg-zinc-900/60 p-7 shadow-2xl"
      >
        <div className="mb-6 flex items-center gap-3">
          <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-blue-600">
            <MessagesSquare size={24} className="text-white" />
          </div>
          <div>
            <h1 className="text-lg font-semibold leading-tight">WinChat</h1>
            <p className="text-xs text-zinc-400">Nhắn tin &amp; gọi video 1-1 giữa 2 máy Windows</p>
          </div>
        </div>

        <div className="mb-5 flex gap-1 rounded-lg bg-zinc-800/80 p-1">
          {canHost && tab('host', <Server size={15} />, 'Tạo phòng (Host)')}
          {tab('join', <Wifi size={15} />, 'Tham gia phòng')}
        </div>

        <div className="space-y-4">
          <div>
            <label className={labelCls} htmlFor="name">
              Tên hiển thị
            </label>
            <input
              id="name"
              className={inputCls}
              value={name}
              maxLength={30}
              placeholder="Ví dụ: Hải"
              onChange={(e) => setName(e.target.value)}
              autoFocus
            />
          </div>

          <div>
            <label className={labelCls} htmlFor="room">
              Mã phòng {isHost ? '(gửi mã này cho người kia)' : '(nhập mã người kia đã gửi)'}
            </label>
            <div className="flex gap-2">
              <input
                id="room"
                className={`${inputCls} font-mono uppercase tracking-widest`}
                value={room}
                maxLength={32}
                placeholder="ABC123"
                onChange={(e) => setRoom(e.target.value.toUpperCase())}
              />
              {isHost && (
                <button
                  type="button"
                  onClick={() => setRoom(generateRoomCode())}
                  title="Tạo mã ngẫu nhiên"
                  className="flex shrink-0 items-center justify-center rounded-lg border border-zinc-700 bg-zinc-900 px-3 text-zinc-300 hover:border-blue-500 hover:text-white"
                >
                  <Dices size={18} />
                </button>
              )}
            </div>
          </div>

          {isHost ? (
            <div>
              <label className={labelCls} htmlFor="port">
                Cổng server
              </label>
              <input
                id="port"
                className={inputCls}
                value={port}
                inputMode="numeric"
                onChange={(e) => setPort(e.target.value.replace(/\D/g, '').slice(0, 5))}
              />
              <p className="mt-1.5 text-xs text-zinc-500">
                App sẽ chạy server ngay trên máy này. Windows có thể hỏi quyền tường lửa — hãy chọn{' '}
                <b className="text-zinc-300">Allow access</b>.
              </p>
            </div>
          ) : (
            <div>
              <label className={labelCls} htmlFor="server">
                Địa chỉ server (IP máy Host, hoặc tên miền Cloudflare)
              </label>
              <input
                id="server"
                className={inputCls}
                value={serverAddress}
                placeholder="192.168.1.20  hoặc  winchat-signal.xxx.workers.dev"
                onChange={(e) => setServerAddress(e.target.value)}
              />
            </div>
          )}

          <button
            type="button"
            onClick={() => setShowAdvanced((v) => !v)}
            className="flex items-center gap-1 text-xs text-zinc-400 hover:text-zinc-200"
          >
            {showAdvanced ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            Nâng cao: khoá truy cập, TURN riêng
          </button>

          {showAdvanced && (
            <div className="space-y-3 rounded-lg border border-zinc-800 bg-zinc-950/50 p-3">
              {!isHost && (
                <div>
                  <label className={labelCls} htmlFor="accessKey">
                    Khoá truy cập (nếu server có đặt)
                  </label>
                  <input
                    id="accessKey"
                    className={inputCls}
                    type="password"
                    autoComplete="off"
                    value={accessKey}
                    placeholder="Để trống nếu server không yêu cầu"
                    onChange={(e) => setAccessKey(e.target.value)}
                  />
                </div>
              )}
              <p className="text-xs leading-relaxed text-zinc-500">
                TURN riêng (tuỳ chọn): với server Cloudflare, TURN đã được cấp tự động — chỉ nhập nếu bạn có TURN
                server của riêng mình.
              </p>
              <input
                className={inputCls}
                value={turnUrl}
                placeholder="turn:turn.example.com:3478"
                onChange={(e) => setTurnUrl(e.target.value)}
              />
              <div className="grid grid-cols-2 gap-2">
                <input
                  className={inputCls}
                  value={turnUser}
                  placeholder="Tên đăng nhập"
                  onChange={(e) => setTurnUser(e.target.value)}
                />
                <input
                  className={inputCls}
                  type="password"
                  value={turnPass}
                  placeholder="Mật khẩu"
                  onChange={(e) => setTurnPass(e.target.value)}
                />
              </div>
            </div>
          )}

          {error && (
            <div role="alert" className="rounded-lg border border-red-900/60 bg-red-950/40 px-3 py-2 text-sm text-red-300">
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={busy}
            className="flex w-full items-center justify-center gap-2 rounded-lg bg-blue-600 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {busy && <Loader2 size={16} className="animate-spin" />}
            {busy ? 'Đang kết nối…' : isHost ? 'Tạo phòng & bắt đầu' : 'Vào phòng'}
          </button>
        </div>
      </form>
    </div>
  );
}
