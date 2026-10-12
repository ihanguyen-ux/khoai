import { useCallback, useEffect, useRef, useState } from 'react';
import { uid } from '../lib/format';

const RANK = { failed: 0, sending: 1, sent: 2, delivered: 3, seen: 4 };

/**
 * Logic chat: gửi/nhận, trạng thái tin (đang gửi → đã gửi → đã nhận → đã xem),
 * "đang gõ...", số tin chưa đọc, và dòng thông báo hệ thống.
 *
 * active: cửa sổ đang được focus (người dùng đang nhìn thấy tin nhắn).
 */
export function useChat({ socket, peer, active, onIncoming }) {
  const [messages, setMessages] = useState([]);
  const [peerTyping, setPeerTyping] = useState(false);
  const [unread, setUnread] = useState(0);

  const activeRef = useRef(active);
  const onIncomingRef = useRef(onIncoming);
  const seenSent = useRef(new Set());
  const lastTypingSent = useRef(0);
  const typingTimer = useRef(null);
  const peerTypingTimer = useRef(null);
  const prevPeer = useRef(null);

  useEffect(() => {
    activeRef.current = active;
    onIncomingRef.current = onIncoming;
  });

  const addSystem = useCallback((text) => {
    setMessages((prev) => [...prev, { id: uid(), from: 'system', text, ts: Date.now() }]);
  }, []);

  const updateStatus = useCallback((id, status) => {
    setMessages((prev) =>
      prev.map((m) => {
        if (m.id !== id || m.from !== 'me') return m;
        if (status === 'sending') return { ...m, status };
        if (status === 'failed') return m.status === 'sending' ? { ...m, status } : m;
        return RANK[status] > RANK[m.status] ? { ...m, status } : m;
      })
    );
  }, []);

  // --- Nhận sự kiện từ server -------------------------------------------------
  useEffect(() => {
    if (!socket) return undefined;

    const onMessage = (m) => {
      if (!m || typeof m.id !== 'string' || typeof m.text !== 'string') return;
      setMessages((prev) =>
        prev.some((x) => x.id === m.id)
          ? prev
          : [...prev, { id: m.id, from: 'peer', text: m.text, ts: Number(m.ts) || Date.now() }]
      );
      socket.emit('chat:delivered', { id: m.id });
      setPeerTyping(false);
      if (!activeRef.current) {
        setUnread((n) => n + 1);
        if (onIncomingRef.current) onIncomingRef.current(m);
      }
    };
    const onDelivered = (d) => d && updateStatus(d.id, 'delivered');
    const onSeen = (d) => {
      if (d && Array.isArray(d.ids)) d.ids.forEach((id) => updateStatus(id, 'seen'));
    };
    const onTyping = (d) => {
      clearTimeout(peerTypingTimer.current);
      const typing = Boolean(d && d.typing);
      setPeerTyping(typing);
      if (typing) peerTypingTimer.current = setTimeout(() => setPeerTyping(false), 4000);
    };

    socket.on('chat:message', onMessage);
    socket.on('chat:delivered', onDelivered);
    socket.on('chat:seen', onSeen);
    socket.on('chat:typing', onTyping);
    return () => {
      socket.off('chat:message', onMessage);
      socket.off('chat:delivered', onDelivered);
      socket.off('chat:seen', onSeen);
      socket.off('chat:typing', onTyping);
      clearTimeout(peerTypingTimer.current);
    };
  }, [socket, updateStatus]);

  // --- Báo "đã xem" khi người dùng đang nhìn cửa sổ ---------------------------
  useEffect(() => {
    if (!active || !socket) return;
    setUnread(0);
    const ids = messages
      .filter((m) => m.from === 'peer' && !seenSent.current.has(m.id))
      .map((m) => m.id);
    if (ids.length > 0) {
      ids.forEach((id) => seenSent.current.add(id));
      socket.emit('chat:seen', { ids });
    }
  }, [active, messages, socket]);

  // --- Thông báo hệ thống khi đối phương vào/rời phòng ------------------------
  useEffect(() => {
    const prev = prevPeer.current;
    if (peer && (!prev || prev.id !== peer.id)) addSystem(`${peer.name} đã tham gia phòng`);
    else if (!peer && prev) {
      addSystem(`${prev.name} đã rời phòng`);
      setPeerTyping(false);
    }
    prevPeer.current = peer;
  }, [peer, addSystem]);

  // --- Gửi tin ----------------------------------------------------------------
  const transmit = useCallback(
    (msg) => {
      if (!socket) {
        updateStatus(msg.id, 'failed');
        return;
      }
      socket.timeout(5000).emit('chat:message', { id: msg.id, text: msg.text, ts: msg.ts }, (err, res) => {
        if (err || !res || !res.ok || !res.peerOnline) updateStatus(msg.id, 'failed');
        else updateStatus(msg.id, 'sent');
      });
    },
    [socket, updateStatus]
  );

  const stopTyping = useCallback(() => {
    clearTimeout(typingTimer.current);
    if (socket && lastTypingSent.current !== 0) socket.emit('chat:typing', { typing: false });
    lastTypingSent.current = 0;
  }, [socket]);

  const send = useCallback(
    (text) => {
      const trimmed = String(text || '').trim().slice(0, 4000);
      if (!trimmed) return;
      const msg = { id: uid(), from: 'me', text: trimmed, ts: Date.now(), status: 'sending' };
      setMessages((prev) => [...prev, msg]);
      stopTyping();
      transmit(msg);
    },
    [transmit, stopTyping]
  );

  const resend = useCallback(
    (id) => {
      const msg = messages.find((m) => m.id === id && m.from === 'me');
      if (!msg) return;
      updateStatus(id, 'sending');
      transmit(msg);
    },
    [messages, transmit, updateStatus]
  );

  /** Gọi mỗi khi người dùng gõ phím. */
  const notifyTyping = useCallback(() => {
    if (!socket) return;
    const now = Date.now();
    if (now - lastTypingSent.current > 2000) {
      socket.emit('chat:typing', { typing: true });
      lastTypingSent.current = now;
    }
    clearTimeout(typingTimer.current);
    typingTimer.current = setTimeout(() => {
      socket.emit('chat:typing', { typing: false });
      lastTypingSent.current = 0;
    }, 2500);
  }, [socket]);

  const reset = useCallback(() => {
    setMessages([]);
    setPeerTyping(false);
    setUnread(0);
    seenSent.current = new Set();
    prevPeer.current = null;
  }, []);

  useEffect(
    () => () => {
      clearTimeout(typingTimer.current);
      clearTimeout(peerTypingTimer.current);
    },
    []
  );

  return { messages, peerTyping, unread, send, resend, notifyTyping, addSystem, reset };
}
