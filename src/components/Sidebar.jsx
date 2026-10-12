import { useState } from 'react';
import { Check, Copy, LogOut, Server, WifiOff } from 'lucide-react';
import Avatar from './Avatar';

/**
 * Sidebar trái: thông tin phòng, trạng thái kết nối của đối phương, thông tin server (nếu là Host).
 */
export default function Sidebar({ me, peer, status, unread, hosting, serverUrl, onLeave }) {
  const [copied, setCopied] = useState('');

  async function copy(text, key) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(key);
      setTimeout(() => setCopied(''), 1500);
    } catch {
      /* clipboard bị chặn: bỏ qua */
    }
  }

  const connected = status === 'connected';
  const peerOnline = connected && Boolean(peer);

  return (
    <aside className="flex w-72 shrink-0 flex-col border-r border-zinc-800 bg-zinc-900/50">
      {/* Phòng */}
      <div className="border-b border-zinc-800 p-4">
        <p className="text-[11px] font-medium uppercase tracking-wider text-zinc-500">Mã phòng</p>
        <div className="mt-1 flex items-center justify-between gap-2">
          <span className="selectable font-mono text-xl font-semibold tracking-widest">{me.room}</span>
          <button
            type="button"
            onClick={() => copy(me.room, 'room')}
            title="Sao chép mã phòng"
            className="rounded-md p-1.5 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
          >
            {copied === 'room' ? <Check size={16} className="text-emerald-400" /> : <Copy size={16} />}
          </button>
        </div>
      </div>

      {/* Đối phương */}
      <div className="flex-1 overflow-y-auto p-3">
        <p className="px-1 pb-2 text-[11px] font-medium uppercase tracking-wider text-zinc-500">Cuộc trò chuyện</p>

        {peer ? (
          <div className="flex items-center gap-3 rounded-xl bg-zinc-800/70 p-3">
            <Avatar name={peer.name} size={44} online={peerOnline} />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-semibold">{peer.name}</p>
              <p className={`text-xs ${peerOnline ? 'text-emerald-400' : 'text-zinc-500'}`}>
                {peerOnline ? 'Đang trực tuyến' : 'Không rõ (mất kết nối server)'}
              </p>
            </div>
            {unread > 0 && (
              <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-blue-600 px-1.5 text-[11px] font-semibold">
                {unread}
              </span>
            )}
          </div>
        ) : (
          <div className="rounded-xl border border-dashed border-zinc-700 p-4 text-center">
            <p className="text-sm font-medium text-zinc-300">Đang chờ đối phương…</p>
            <p className="mt-1 text-xs leading-relaxed text-zinc-500">
              Gửi mã phòng <span className="font-mono text-zinc-300">{me.room}</span>
              {hosting ? ' và địa chỉ server bên dưới' : ''} cho người kia để họ vào phòng.
            </p>
          </div>
        )}
      </div>

      {/* Server / Host */}
      <div className="space-y-2 border-t border-zinc-800 p-3 text-xs">
        {status === 'reconnecting' && (
          <div className="flex items-center gap-2 rounded-lg bg-amber-950/40 px-3 py-2 text-amber-300">
            <WifiOff size={14} />
            Mất kết nối server, đang thử lại…
          </div>
        )}

        {hosting ? (
          <div className="rounded-lg bg-zinc-800/60 p-3">
            <div className="mb-1.5 flex items-center gap-1.5 font-medium text-zinc-300">
              <Server size={13} /> Máy này đang làm server
            </div>
            {hosting.ips.length > 0 ? (
              hosting.ips.map((ip) => {
                const addr = `${ip}:${hosting.port}`;
                return (
                  <div key={ip} className="flex items-center justify-between gap-2">
                    <span className="selectable font-mono text-zinc-200">{addr}</span>
                    <button
                      type="button"
                      onClick={() => copy(addr, ip)}
                      title="Sao chép địa chỉ"
                      className="rounded p-1 text-zinc-400 hover:bg-zinc-700 hover:text-zinc-100"
                    >
                      {copied === ip ? <Check size={14} className="text-emerald-400" /> : <Copy size={14} />}
                    </button>
                  </div>
                );
              })
            ) : (
              <p className="text-zinc-400">Không tìm thấy địa chỉ mạng LAN. Kiểm tra kết nối mạng.</p>
            )}
            <p className="mt-1.5 text-zinc-500">Người kia nhập địa chỉ này khi chọn “Tham gia phòng”.</p>
          </div>
        ) : (
          <p className="truncate px-1 text-zinc-500" title={serverUrl}>
            Server: <span className="font-mono text-zinc-400">{serverUrl}</span>
          </p>
        )}

        <div className="flex items-center justify-between px-1">
          <span className="truncate text-zinc-400">
            Bạn: <b className="text-zinc-200">{me.name}</b>
          </span>
          <button
            type="button"
            onClick={onLeave}
            className="flex items-center gap-1.5 rounded-md px-2 py-1.5 text-zinc-400 hover:bg-red-950/50 hover:text-red-300"
          >
            <LogOut size={14} /> Rời phòng
          </button>
        </div>
      </div>
    </aside>
  );
}
