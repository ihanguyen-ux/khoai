import { useEffect, useRef, useState } from 'react';
import { AlertCircle, Phone, Send, Video } from 'lucide-react';
import Avatar from './Avatar';
import { formatTime } from '../lib/format';

const STATUS_LABEL = {
  sending: 'Đang gửi…',
  sent: 'Đã gửi',
  delivered: 'Đã nhận',
  seen: 'Đã xem',
};

function MessageBubble({ msg, showStatus, onResend }) {
  if (msg.from === 'system') {
    return (
      <div className="my-2 text-center text-xs text-zinc-500">
        {msg.text} · {formatTime(msg.ts)}
      </div>
    );
  }
  const mine = msg.from === 'me';
  const failed = msg.status === 'failed';
  return (
    <div className={`flex flex-col ${mine ? 'items-end' : 'items-start'}`}>
      <div
        className={`selectable max-w-[75%] whitespace-pre-wrap break-words rounded-2xl px-3.5 py-2 text-sm leading-relaxed ${
          mine
            ? `rounded-br-md ${failed ? 'bg-red-900/60 text-red-100' : 'bg-blue-600 text-white'}`
            : 'rounded-bl-md bg-zinc-800 text-zinc-100'
        }`}
        title={formatTime(msg.ts)}
      >
        {msg.text}
      </div>
      <div className="mt-0.5 px-1 text-[11px] text-zinc-500">
        {formatTime(msg.ts)}
        {mine && failed && (
          <>
            {' · '}
            <span className="inline-flex items-center gap-1 text-red-400">
              <AlertCircle size={11} /> Chưa gửi được
            </span>{' '}
            <button type="button" onClick={() => onResend(msg.id)} className="text-blue-400 hover:underline">
              Gửi lại
            </button>
          </>
        )}
        {mine && !failed && showStatus && <> · {STATUS_LABEL[msg.status]}</>}
      </div>
    </div>
  );
}

export default function ChatPanel({
  peer,
  peerOnline,
  connectionStatus,
  chat,
  inCall,
  onStartCall,
}) {
  const [text, setText] = useState('');
  const endRef = useRef(null);
  const inputRef = useRef(null);
  const { messages, peerTyping, send, resend, notifyTyping } = chat;

  useEffect(() => {
    if (endRef.current) endRef.current.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages.length, peerTyping]);

  function submit() {
    if (!text.trim()) return;
    send(text);
    setText('');
    if (inputRef.current) inputRef.current.style.height = 'auto';
  }

  function onKeyDown(e) {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    }
  }

  function onChange(e) {
    setText(e.target.value);
    notifyTyping();
    const el = e.target;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 140)}px`;
  }

  // Chỉ hiện trạng thái ở tin cuối cùng của mình (giống Messenger)
  let lastMine = -1;
  messages.forEach((m, i) => {
    if (m.from === 'me') lastMine = i;
  });

  const canCall = peerOnline && connectionStatus === 'connected' && !inCall;
  const callBtn =
    'flex h-9 w-9 items-center justify-center rounded-full text-blue-400 transition-colors hover:bg-zinc-800 disabled:cursor-not-allowed disabled:text-zinc-600 disabled:hover:bg-transparent';

  return (
    <section className="flex min-w-0 flex-1 flex-col bg-zinc-950">
      {/* Header */}
      <header className="flex h-16 shrink-0 items-center justify-between border-b border-zinc-800 px-5">
        {peer ? (
          <div className="flex items-center gap-3">
            <Avatar name={peer.name} size={38} online={peerOnline} />
            <div>
              <p className="text-sm font-semibold leading-tight">{peer.name}</p>
              <p className="text-xs text-zinc-500">
                {peerTyping ? 'Đang gõ…' : peerOnline ? 'Đang trực tuyến' : 'Ngoại tuyến'}
              </p>
            </div>
          </div>
        ) : (
          <p className="text-sm text-zinc-400">Chưa có ai trong phòng</p>
        )}

        <div className="flex items-center gap-1">
          <button
            type="button"
            className={callBtn}
            disabled={!canCall}
            onClick={() => onStartCall('audio')}
            title="Gọi thoại"
            aria-label="Gọi thoại"
          >
            <Phone size={19} />
          </button>
          <button
            type="button"
            className={callBtn}
            disabled={!canCall}
            onClick={() => onStartCall('video')}
            title="Gọi video"
            aria-label="Gọi video"
          >
            <Video size={20} />
          </button>
        </div>
      </header>

      {/* Danh sách tin nhắn */}
      <div className="flex-1 space-y-2.5 overflow-y-auto px-5 py-4">
        {messages.length === 0 && (
          <div className="flex h-full items-center justify-center text-sm text-zinc-600">
            {peer ? 'Hãy gửi lời chào đầu tiên 👋' : 'Đang chờ đối phương vào phòng…'}
          </div>
        )}
        {messages.map((m, i) => (
          <MessageBubble key={m.id} msg={m} showStatus={i === lastMine} onResend={resend} />
        ))}
        {peerTyping && peer && (
          <div className="flex items-center gap-2 text-xs text-zinc-500">
            <span className="flex items-center gap-1 rounded-2xl rounded-bl-md bg-zinc-800 px-3 py-2">
              {[0, 1, 2].map((i) => (
                <span
                  key={i}
                  className="typing-dot block h-1.5 w-1.5 rounded-full bg-zinc-400"
                  style={{ animationDelay: `${i * 0.15}s` }}
                />
              ))}
            </span>
            {peer.name} đang gõ…
          </div>
        )}
        <div ref={endRef} />
      </div>

      {/* Ô nhập */}
      <div className="shrink-0 border-t border-zinc-800 p-3">
        <div className="flex items-end gap-2 rounded-2xl border border-zinc-800 bg-zinc-900 px-3 py-2 focus-within:border-blue-600">
          <textarea
            ref={inputRef}
            rows={1}
            value={text}
            onChange={onChange}
            onKeyDown={onKeyDown}
            placeholder={peerOnline ? 'Nhập tin nhắn… (Enter để gửi, Shift+Enter xuống dòng)' : 'Đối phương chưa trực tuyến'}
            maxLength={4000}
            className="max-h-36 min-h-[28px] flex-1 resize-none bg-transparent py-1 text-sm leading-relaxed text-zinc-100 outline-none placeholder:text-zinc-600"
          />
          <button
            type="button"
            onClick={submit}
            disabled={!text.trim()}
            title="Gửi"
            aria-label="Gửi"
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-blue-600 text-white transition-colors hover:bg-blue-500 disabled:cursor-not-allowed disabled:bg-zinc-800 disabled:text-zinc-600"
          >
            <Send size={16} />
          </button>
        </div>
      </div>
    </section>
  );
}
