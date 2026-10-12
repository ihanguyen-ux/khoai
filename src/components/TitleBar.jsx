import { useEffect, useState } from 'react';
import { Copy, MessagesSquare, Minus, Square, X } from 'lucide-react';

/** Thanh tiêu đề tuỳ chỉnh (cửa sổ Electron không viền). */
export default function TitleBar({ subtitle = '', unread = 0 }) {
  const api = window.winchat ? window.winchat.window : null;
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    if (!api) return undefined;
    api.isMaximized().then(setMaximized).catch(() => {});
    return api.onMaximizeChange(setMaximized);
  }, [api]);

  const btn =
    'app-no-drag flex h-full w-12 items-center justify-center text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-zinc-100';

  return (
    <div
      className="app-drag flex h-9 shrink-0 select-none items-center justify-between border-b border-zinc-800 bg-zinc-950"
      onDoubleClick={() => api && api.toggleMaximize()}
    >
      <div className="flex items-center gap-2 pl-3 text-xs text-zinc-300">
        <MessagesSquare size={15} className="text-blue-500" />
        <span className="font-semibold tracking-wide">WinChat</span>
        {subtitle && <span className="text-zinc-500">· {subtitle}</span>}
        {unread > 0 && (
          <span className="rounded-full bg-blue-600 px-1.5 text-[10px] font-semibold text-white">{unread}</span>
        )}
      </div>

      {api && (
        <div className="flex h-full" onDoubleClick={(e) => e.stopPropagation()}>
          <button type="button" className={btn} onClick={() => api.minimize()} title="Thu nhỏ" aria-label="Thu nhỏ">
            <Minus size={16} />
          </button>
          <button
            type="button"
            className={btn}
            onClick={() => api.toggleMaximize()}
            title={maximized ? 'Khôi phục' : 'Phóng to'}
            aria-label={maximized ? 'Khôi phục' : 'Phóng to'}
          >
            {maximized ? <Copy size={13} /> : <Square size={13} />}
          </button>
          <button
            type="button"
            className={`${btn} hover:!bg-red-600 hover:!text-white`}
            onClick={() => api.close()}
            title="Đóng"
            aria-label="Đóng"
          >
            <X size={17} />
          </button>
        </div>
      )}
    </div>
  );
}
