import { useCallback, useEffect, useRef, useState } from 'react';
import { SignalClient, buildSignalUrl, CLOSE_REPLACED } from '../lib/signal';
import { newClientId } from '../lib/format';

const JOIN_ERRORS = {
  ROOM_FULL: 'Phòng này đã đủ 2 người. Hãy dùng mã phòng khác (hoặc đợi ~1 phút nếu vừa tắt app đột ngột).',
  INVALID: 'Tên hoặc mã phòng không hợp lệ.',
  ALREADY_JOINED: 'Kết nối đã ở trong một phòng.',
  NOT_IN_ROOM: 'Chưa vào phòng.',
  UNAUTHORIZED: 'Khoá truy cập không đúng. Kiểm tra mục "Nâng cao → Khoá truy cập".',
};

/**
 * Quản lý kết nối WebSocket tới signaling server và việc vào phòng.
 *
 * status: 'idle' | 'connecting' | 'connected' | 'reconnecting'
 * me:     { id, name, room } sau khi vào phòng thành công
 * peer:   { id, name } hoặc null nếu đối phương chưa/không còn trong phòng
 * iceServers: danh sách STUN/TURN do server cấp (Cloudflare) — có thể rỗng
 */
export function useConnection() {
  const [status, setStatus] = useState('idle');
  const [socket, setSocket] = useState(null);
  const [me, setMe] = useState(null);
  const [peer, setPeer] = useState(null);
  const [iceServers, setIceServers] = useState([]);
  const [lastError, setLastError] = useState('');
  const socketRef = useRef(null);

  const disconnect = useCallback(() => {
    const s = socketRef.current;
    socketRef.current = null;
    if (s) {
      s.removeAllListeners();
      s.disconnect();
    }
    setSocket(null);
    setStatus('idle');
    setMe(null);
    setPeer(null);
    setIceServers([]);
  }, []);

  /** @returns {Promise<{ok: true} | {ok: false, error: string}>} */
  const connect = useCallback(
    ({ serverUrl, room, name, accessKey = '' }) =>
      new Promise((resolve) => {
        disconnect();
        setStatus('connecting');
        setLastError('');

        let url;
        try {
          url = buildSignalUrl(serverUrl, room);
        } catch {
          setStatus('idle');
          resolve({ ok: false, error: 'Địa chỉ server không hợp lệ.' });
          return;
        }

        const cid = newClientId();
        const s = new SignalClient(url, cid);
        socketRef.current = s;
        setSocket(s);

        let settled = false;
        const finish = (result) => {
          if (settled) return;
          settled = true;
          resolve(result);
        };
        const abort = (message) => {
          if (socketRef.current === s) socketRef.current = null;
          s.removeAllListeners();
          s.disconnect();
          setSocket(null);
          setStatus('idle');
          setMe(null);
          setPeer(null);
          setIceServers([]);
          return message;
        };

        const join = () => {
          s.timeout(8000).emit('join', { name, cid, key: accessKey }, (err, res) => {
            if (socketRef.current !== s) return;
            if (err || !res) {
              if (!settled) finish({ ok: false, error: abort('Server không phản hồi khi vào phòng.') });
              return;
            }
            if (!res.ok) {
              const message = JOIN_ERRORS[res.error] || 'Không thể vào phòng.';
              if (!settled) finish({ ok: false, error: abort(message) });
              else {
                abort(message);
                setLastError(message);
              }
              return;
            }
            setMe({ id: res.id, name, room });
            setPeer(res.peer || null);
            setIceServers(Array.isArray(res.iceServers) ? res.iceServers : []);
            setStatus('connected');
            finish({ ok: true });
          });
        };

        s.on('connect', join); // chạy lại mỗi lần tự kết nối lại
        s.on('connect_error', () => {
          if (!settled) {
            finish({
              ok: false,
              error: abort(
                `Không kết nối được tới server (${serverUrl}). Kiểm tra địa chỉ, mạng và tường lửa.`
              ),
            });
          } else if (socketRef.current === s) {
            setStatus('reconnecting');
          }
        });
        s.on('disconnect', (info) => {
          if (socketRef.current !== s) return;
          if (info && info.code === CLOSE_REPLACED) {
            const message = 'Phiên này đã bị thay thế bởi một kết nối khác.';
            abort(message);
            setLastError(message);
            return;
          }
          setStatus('reconnecting');
        });
        s.on('peer:joined', (p) => setPeer({ id: p.id, name: p.name }));
        s.on('peer:left', () => setPeer(null));
      }),
    [disconnect]
  );

  useEffect(() => () => disconnect(), [disconnect]);

  return { status, socket, me, peer, iceServers, lastError, connect, disconnect };
}
