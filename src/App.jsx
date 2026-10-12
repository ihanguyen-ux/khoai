import { useCallback, useEffect, useState } from 'react';
import { X } from 'lucide-react';
import TitleBar from './components/TitleBar';
import LoginScreen from './components/LoginScreen';
import Sidebar from './components/Sidebar';
import ChatPanel from './components/ChatPanel';
import CallLayer from './components/CallLayer';
import { useConnection } from './hooks/useConnection';
import { useChat } from './hooks/useChat';
import { useWebRTC } from './hooks/useWebRTC';

/** true khi cửa sổ đang được focus, hiển thị và không bị thu nhỏ (người dùng đang nhìn thấy tin nhắn). */
function useWindowActive() {
  const [state, setState] = useState(() => ({
    focused: document.hasFocus() && !document.hidden,
    visible: true,
  }));
  useEffect(() => {
    const update = () =>
      setState((s) => {
        const focused = document.hasFocus() && !document.hidden;
        return s.focused === focused ? s : { ...s, focused };
      });
    window.addEventListener('focus', update);
    window.addEventListener('blur', update);
    document.addEventListener('visibilitychange', update);
    // Dự phòng: một số trường hợp đổi focus không bắn sự kiện (vd. chuyển giữa các cửa sổ cùng tiến trình)
    const poll = setInterval(update, 1500);
    const bridge = window.winchat;
    const offVisible =
      bridge && bridge.window && bridge.window.onVisibilityChange
        ? bridge.window.onVisibilityChange((visible) => setState((s) => ({ ...s, visible })))
        : null;
    return () => {
      window.removeEventListener('focus', update);
      window.removeEventListener('blur', update);
      document.removeEventListener('visibilitychange', update);
      clearInterval(poll);
      if (offVisible) offVisible();
    };
  }, []);
  return state.focused && state.visible;
}

export default function App() {
  const conn = useConnection();
  const active = useWindowActive();
  const [session, setSession] = useState(null); // { serverUrl, hosting: { port, ips } | null }

  const peerName = conn.peer ? conn.peer.name : 'Đối phương';
  const bridge = window.winchat;

  const chat = useChat({
    socket: conn.socket,
    peer: conn.peer,
    active,
    onIncoming: (m) => {
      if (bridge) {
        bridge.notify(peerName, m.text);
        bridge.flash();
      }
    },
  });

  const call = useWebRTC({
    socket: conn.socket,
    peer: conn.peer,
    iceServers: conn.iceServers,
    onLog: chat.addSystem,
  });

  // Có cuộc gọi đến khi cửa sổ đang thu nhỏ/ở nền → báo cho người dùng
  useEffect(() => {
    if (call.callState === 'incoming' && bridge) {
      bridge.notify(
        `${peerName} đang gọi ${call.callType === 'video' ? 'video' : 'thoại'}`,
        'Mở WinChat để trả lời cuộc gọi.'
      );
      bridge.flash();
    }
  }, [call.callState, call.callType, peerName, bridge]);

  // Thông báo lỗi/trạng thái cuộc gọi tự tắt sau vài giây
  const { notice, clearNotice } = call;
  useEffect(() => {
    if (!notice) return undefined;
    const t = setTimeout(clearNotice, 9000);
    return () => clearTimeout(t);
  }, [notice, clearNotice]);

  // Hiện số tin chưa đọc trên tiêu đề cửa sổ
  useEffect(() => {
    document.title = chat.unread > 0 ? `(${chat.unread}) WinChat` : 'WinChat';
  }, [chat.unread]);

  const handleJoin = useCallback(
    async ({ mode, name, room, serverUrl, port, accessKey }) => {
      let url = serverUrl;
      let hosting = null;

      if (mode === 'host') {
        const started = await bridge.server.start(port);
        if (!started.ok) return { ok: false, error: started.error };
        url = `http://127.0.0.1:${started.port}`;
        hosting = { port: started.port, ips: started.ips };
      }

      const result = await conn.connect({ serverUrl: url, room, name, accessKey: mode === 'host' ? '' : accessKey });
      if (!result.ok) {
        if (hosting) await bridge.server.stop();
        return result;
      }
      chat.reset();
      setSession({ serverUrl: url, hosting });
      return result;
    },
    [bridge, chat, conn]
  );

  const handleLeave = useCallback(async () => {
    call.endCall();
    conn.disconnect();
    chat.reset();
    if (session && session.hosting && bridge) await bridge.server.stop();
    setSession(null);
  }, [bridge, call, chat, conn, session]);

  const inRoom = Boolean(conn.me && session);
  const peerOnline = conn.status === 'connected' && Boolean(conn.peer);

  return (
    <div className="flex h-screen flex-col bg-zinc-950 text-zinc-100">
      <TitleBar subtitle={inRoom ? `Phòng ${conn.me.room}` : ''} unread={chat.unread} />

      <div className="relative flex min-h-0 flex-1">
        {!inRoom ? (
          <LoginScreen onSubmit={handleJoin} lastError={conn.lastError} />
        ) : (
          <>
            <Sidebar
              me={conn.me}
              peer={conn.peer}
              status={conn.status}
              unread={chat.unread}
              hosting={session.hosting}
              serverUrl={session.serverUrl}
              onLeave={handleLeave}
            />
            <ChatPanel
              peer={conn.peer}
              peerOnline={peerOnline}
              connectionStatus={conn.status}
              chat={chat}
              inCall={call.callState !== 'idle'}
              onStartCall={call.startCall}
            />
            <CallLayer call={call} peerName={peerName} />
          </>
        )}

        {notice && (
          <div
            role="alert"
            className="absolute left-1/2 top-4 z-50 flex w-[min(520px,90%)] -translate-x-1/2 items-start gap-3 rounded-xl border border-zinc-700 bg-zinc-800 px-4 py-3 text-sm text-zinc-100 shadow-2xl"
          >
            <p className="flex-1 leading-relaxed">{notice}</p>
            <button
              type="button"
              onClick={clearNotice}
              aria-label="Đóng thông báo"
              className="mt-0.5 text-zinc-400 hover:text-zinc-100"
            >
              <X size={16} />
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
