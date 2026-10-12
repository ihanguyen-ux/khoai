import { useCallback, useEffect, useRef, useState } from 'react';
import { buildIceServers } from '../lib/rtcConfig';
import { startRingtone, stopRingtone } from '../lib/ringtone';
import { formatDuration } from '../lib/format';

const RING_TIMEOUT_MS = 45000;

function mediaErrorMessage(err) {
  switch (err && err.name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return 'Không có quyền dùng micro/camera. Vào Cài đặt Windows → Quyền riêng tư → Micro / Camera, bật "Cho phép ứng dụng trên máy tính để bàn truy cập".';
    case 'NotFoundError':
      return 'Không tìm thấy micro (hoặc webcam). Hãy cắm thiết bị rồi thử lại.';
    case 'NotReadableError':
      return 'Micro/camera đang được ứng dụng khác sử dụng. Hãy đóng ứng dụng đó rồi thử lại.';
    default:
      return `Không mở được thiết bị: ${(err && err.message) || err}`;
  }
}

/**
 * Lấy micro (+ webcam nếu là cuộc gọi video).
 * Nếu máy không có webcam, tự động hạ xuống chỉ thoại và trả về cảnh báo.
 */
async function acquireMedia(type) {
  const audio = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
  const md = navigator.mediaDevices;
  if (!md || !md.getUserMedia) throw Object.assign(new Error('getUserMedia không khả dụng'), { name: 'NotFoundError' });

  if (type === 'video') {
    try {
      const stream = await md.getUserMedia({
        audio,
        video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
      });
      return { stream, hasVideo: true, warning: '' };
    } catch (err) {
      if (['NotFoundError', 'OverconstrainedError', 'NotReadableError'].includes(err && err.name)) {
        const stream = await md.getUserMedia({ audio });
        return { stream, hasVideo: false, warning: 'Không mở được webcam — cuộc gọi tiếp tục chỉ có tiếng.' };
      }
      throw err;
    }
  }
  const stream = await md.getUserMedia({ audio });
  return { stream, hasVideo: false, warning: '' };
}

/**
 * Toàn bộ vòng đời cuộc gọi 1-1.
 *
 * callState: 'idle' | 'calling' (đang đổ chuông bên kia) | 'incoming' (có người gọi đến)
 *            | 'connecting' | 'connected'
 *
 * Luồng signaling:
 *   Người gọi: getUserMedia → call:invite ──▶ người nghe
 *   Người nghe: bấm nghe → getUserMedia → tạo RTCPeerConnection → call:accept ──▶
 *   Người gọi: tạo RTCPeerConnection → createOffer → webrtc:offer ──▶
 *   Người nghe: setRemoteDescription → createAnswer → webrtc:answer ──▶
 *   Hai bên trao đổi webrtc:ice, sau đó audio/video chạy P2P.
 */
export function useWebRTC({ socket, peer, iceServers, onLog }) {
  const [callState, setCallStateRaw] = useState('idle');
  const [callType, setCallType] = useState('audio');
  const [localStream, setLocalStream] = useState(null);
  const [remoteStream, setRemoteStream] = useState(null);
  const [remoteHasVideo, setRemoteHasVideo] = useState(false);
  const [micOn, setMicOn] = useState(true);
  const [camOn, setCamOn] = useState(false);
  const [remoteMedia, setRemoteMedia] = useState({ mic: true, cam: false });
  const [linkIssue, setLinkIssue] = useState(false);
  const [notice, setNotice] = useState('');

  const stateRef = useRef('idle');
  const typeRef = useRef('audio');
  const socketRef = useRef(socket);
  const peerRef = useRef(peer);
  const iceRef = useRef(iceServers);
  const onLogRef = useRef(onLog);
  const pcRef = useRef(null);
  const localRef = useRef(null);
  const pendingIce = useRef([]);
  const ringTimer = useRef(null);
  const connectedAt = useRef(0);

  useEffect(() => {
    socketRef.current = socket;
    peerRef.current = peer;
    iceRef.current = iceServers;
    onLogRef.current = onLog;
  });

  const setCallState = useCallback((s) => {
    stateRef.current = s;
    setCallStateRaw(s);
  }, []);

  const log = useCallback((text) => {
    if (onLogRef.current) onLogRef.current(text);
  }, []);

  const cleanup = useCallback(() => {
    clearTimeout(ringTimer.current);
    const pc = pcRef.current;
    if (pc) {
      pc.onicecandidate = null;
      pc.ontrack = null;
      pc.onconnectionstatechange = null;
      try {
        pc.close();
      } catch {
        /* đã đóng */
      }
      pcRef.current = null;
    }
    if (localRef.current) {
      localRef.current.getTracks().forEach((t) => t.stop());
      localRef.current = null;
    }
    pendingIce.current = [];
    connectedAt.current = 0;
    setLocalStream(null);
    setRemoteStream(null);
    setRemoteHasVideo(false);
    setMicOn(true);
    setCamOn(false);
    setRemoteMedia({ mic: true, cam: false });
    setLinkIssue(false);
    setCallState('idle');
  }, [setCallState]);

  /** Kết thúc cuộc gọi, ghi dòng nhật ký vào khung chat. */
  const finish = useCallback(
    (logText) => {
      if (logText) log(logText);
      cleanup();
    },
    [cleanup, log]
  );

  const typeLabel = () => (typeRef.current === 'video' ? 'video' : 'thoại');

  const describeEnd = useCallback(
    (byMe) => {
      switch (stateRef.current) {
        case 'connected': {
          const secs = (Date.now() - connectedAt.current) / 1000;
          return `Cuộc gọi ${typeLabel()} đã kết thúc • ${formatDuration(secs)}`;
        }
        case 'calling':
          return byMe ? 'Bạn đã hủy cuộc gọi' : 'Cuộc gọi không được trả lời';
        case 'incoming':
          return byMe ? 'Bạn đã từ chối cuộc gọi' : `Cuộc gọi ${typeLabel()} nhỡ`;
        default:
          return `Cuộc gọi ${typeLabel()} đã kết thúc`;
      }
    },
    []
  );

  const flushIce = useCallback(async (pc) => {
    const queued = pendingIce.current;
    pendingIce.current = [];
    for (const c of queued) {
      try {
        await pc.addIceCandidate(c);
      } catch {
        /* ứng viên không hợp lệ/đã hết hạn: bỏ qua */
      }
    }
  }, []);

  const createPeerConnection = useCallback(() => {
    const pc = new RTCPeerConnection({ iceServers: buildIceServers(iceRef.current) });

    pc.onicecandidate = (e) => {
      if (e.candidate && socketRef.current) {
        socketRef.current.emit('webrtc:ice', { candidate: e.candidate.toJSON() });
      }
    };
    pc.ontrack = (e) => {
      setRemoteStream(e.streams && e.streams[0] ? e.streams[0] : new MediaStream([e.track]));
      if (e.track.kind === 'video') setRemoteHasVideo(true);
    };
    pc.onconnectionstatechange = () => {
      const s = pc.connectionState;
      if (s === 'connected') {
        if (!connectedAt.current) connectedAt.current = Date.now();
        setLinkIssue(false);
        setCallState('connected');
      } else if (s === 'disconnected') {
        setLinkIssue(true);
      } else if (s === 'failed') {
        if (socketRef.current) socketRef.current.emit('call:end', { reason: 'failed' });
        setNotice(
          'Không thiết lập được kết nối trực tiếp giữa 2 máy (mạng chặn P2P). Qua Internet hãy cấu hình TURN server ở mục "Nâng cao".'
        );
        finish('Cuộc gọi thất bại do lỗi mạng');
      }
    };

    if (localRef.current) {
      localRef.current.getTracks().forEach((t) => pc.addTrack(t, localRef.current));
    }
    return pc;
  }, [finish, setCallState]);

  // --- Thao tác của người dùng ------------------------------------------------

  const startCall = useCallback(
    async (type) => {
      if (stateRef.current !== 'idle') return;
      if (!socketRef.current || !peerRef.current) {
        setNotice('Đối phương chưa trực tuyến.');
        return;
      }
      setNotice('');
      typeRef.current = type;
      setCallType(type);
      setCallState('calling'); // đặt ngay để chặn bấm 2 lần
      try {
        const { stream, hasVideo, warning } = await acquireMedia(type);
        if (stateRef.current !== 'calling') {
          stream.getTracks().forEach((t) => t.stop()); // bị hủy trong lúc chờ xin quyền
          return;
        }
        localRef.current = stream;
        setLocalStream(stream);
        setCamOn(hasVideo);
        if (warning) setNotice(warning);
        socketRef.current.emit('call:invite', { callType: type, cam: hasVideo });
        ringTimer.current = setTimeout(() => {
          if (stateRef.current === 'calling') {
            if (socketRef.current) socketRef.current.emit('call:end', { reason: 'timeout' });
            setNotice('Đối phương không trả lời.');
            finish('Cuộc gọi không được trả lời');
          }
        }, RING_TIMEOUT_MS);
      } catch (err) {
        setNotice(mediaErrorMessage(err));
        cleanup();
      }
    },
    [cleanup, finish, setCallState]
  );

  const acceptCall = useCallback(async () => {
    if (stateRef.current !== 'incoming') return;
    setNotice('');
    setCallState('connecting');
    try {
      const { stream, hasVideo, warning } = await acquireMedia(typeRef.current);
      if (stateRef.current !== 'connecting') {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      localRef.current = stream;
      setLocalStream(stream);
      setCamOn(hasVideo);
      if (warning) setNotice(warning);
      pcRef.current = createPeerConnection(); // phải có trước khi offer tới
      socketRef.current.emit('call:accept', { cam: hasVideo });
    } catch (err) {
      if (socketRef.current) socketRef.current.emit('call:reject', { reason: 'device' });
      setNotice(mediaErrorMessage(err));
      cleanup();
    }
  }, [cleanup, createPeerConnection, setCallState]);

  /** Dùng cho cả hủy cuộc gọi đi, từ chối cuộc gọi đến, và cúp máy. */
  const endCall = useCallback(() => {
    const s = stateRef.current;
    if (s === 'idle') return;
    const text = describeEnd(true);
    if (socketRef.current) {
      socketRef.current.emit(s === 'incoming' ? 'call:reject' : 'call:end', {});
    }
    finish(text);
  }, [describeEnd, finish]);

  const broadcastMedia = useCallback(() => {
    const stream = localRef.current;
    if (!stream || !socketRef.current) return;
    const a = stream.getAudioTracks()[0];
    const v = stream.getVideoTracks()[0];
    socketRef.current.emit('call:media', { mic: Boolean(a && a.enabled), cam: Boolean(v && v.enabled) });
  }, []);

  const toggleMic = useCallback(() => {
    const t = localRef.current && localRef.current.getAudioTracks()[0];
    if (!t) return;
    t.enabled = !t.enabled;
    setMicOn(t.enabled);
    broadcastMedia();
  }, [broadcastMedia]);

  const toggleCam = useCallback(() => {
    const t = localRef.current && localRef.current.getVideoTracks()[0];
    if (!t) return;
    t.enabled = !t.enabled;
    setCamOn(t.enabled);
    broadcastMedia();
  }, [broadcastMedia]);

  // --- Sự kiện signaling từ đối phương ---------------------------------------

  useEffect(() => {
    if (!socket) return undefined;

    const onInvite = (data) => {
      const type = data && data.callType === 'video' ? 'video' : 'audio';
      const s = stateRef.current;

      const showIncoming = () => {
        typeRef.current = type;
        setCallType(type);
        setRemoteMedia({ mic: true, cam: Boolean(data && data.cam) });
        setCallState('incoming');
      };

      if (s === 'idle') return showIncoming();

      if (s === 'calling') {
        // Hai bên gọi nhau cùng lúc: bên có id nhỏ hơn nhường, nhận cuộc gọi của bên kia.
        const other = peerRef.current ? peerRef.current.id : '';
        if (socket.id < other) {
          clearTimeout(ringTimer.current);
          if (localRef.current) {
            localRef.current.getTracks().forEach((t) => t.stop());
            localRef.current = null;
          }
          setLocalStream(null);
          showIncoming();
        }
        return undefined;
      }

      socket.emit('call:busy', {});
      return undefined;
    };

    const onAccept = async (data) => {
      if (stateRef.current !== 'calling') return;
      clearTimeout(ringTimer.current);
      setRemoteMedia({ mic: true, cam: Boolean(data && data.cam) });
      setCallState('connecting');
      try {
        const pc = createPeerConnection();
        pcRef.current = pc;
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        socket.emit('webrtc:offer', { sdp: pc.localDescription.toJSON() });
      } catch (err) {
        socket.emit('call:end', { reason: 'error' });
        setNotice(`Không thể thiết lập cuộc gọi: ${err.message}`);
        finish('Cuộc gọi thất bại');
      }
    };

    const onOffer = async (data) => {
      const pc = pcRef.current;
      if (!pc || !data || !data.sdp || stateRef.current === 'idle') return;
      try {
        await pc.setRemoteDescription(data.sdp);
        await flushIce(pc);
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        socket.emit('webrtc:answer', { sdp: pc.localDescription.toJSON() });
      } catch (err) {
        socket.emit('call:end', { reason: 'error' });
        setNotice(`Không thể trả lời cuộc gọi: ${err.message}`);
        finish('Cuộc gọi thất bại');
      }
    };

    const onAnswer = async (data) => {
      const pc = pcRef.current;
      if (!pc || !data || !data.sdp) return;
      try {
        await pc.setRemoteDescription(data.sdp);
        await flushIce(pc);
      } catch (err) {
        socket.emit('call:end', { reason: 'error' });
        setNotice(`Lỗi thiết lập cuộc gọi: ${err.message}`);
        finish('Cuộc gọi thất bại');
      }
    };

    const onIce = async (data) => {
      const pc = pcRef.current;
      if (!pc || !data || !data.candidate) return;
      if (pc.remoteDescription) {
        try {
          await pc.addIceCandidate(data.candidate);
        } catch {
          /* bỏ qua */
        }
      } else {
        pendingIce.current.push(data.candidate); // chưa có remote description: xếp hàng
      }
    };

    const onReject = () => {
      if (stateRef.current === 'idle') return;
      setNotice('Đối phương đã từ chối cuộc gọi.');
      finish('Đối phương đã từ chối cuộc gọi');
    };
    const onBusy = () => {
      if (stateRef.current === 'idle') return;
      setNotice('Đối phương đang trong một cuộc gọi khác.');
      finish('Đối phương đang bận');
    };
    const onEnd = () => {
      if (stateRef.current === 'idle') return;
      finish(describeEnd(false));
    };
    const onMedia = (data) => {
      if (data) setRemoteMedia({ mic: Boolean(data.mic), cam: Boolean(data.cam) });
    };

    socket.on('call:invite', onInvite);
    socket.on('call:accept', onAccept);
    socket.on('webrtc:offer', onOffer);
    socket.on('webrtc:answer', onAnswer);
    socket.on('webrtc:ice', onIce);
    socket.on('call:reject', onReject);
    socket.on('call:busy', onBusy);
    socket.on('call:end', onEnd);
    socket.on('call:media', onMedia);
    return () => {
      socket.off('call:invite', onInvite);
      socket.off('call:accept', onAccept);
      socket.off('webrtc:offer', onOffer);
      socket.off('webrtc:answer', onAnswer);
      socket.off('webrtc:ice', onIce);
      socket.off('call:reject', onReject);
      socket.off('call:busy', onBusy);
      socket.off('call:end', onEnd);
      socket.off('call:media', onMedia);
    };
  }, [socket, createPeerConnection, describeEnd, finish, flushIce, setCallState]);

  // Đối phương rời phòng giữa chừng → kết thúc cuộc gọi
  useEffect(() => {
    if (!peer && stateRef.current !== 'idle') {
      setNotice('Đối phương đã rời phòng.');
      finish('Cuộc gọi kết thúc vì đối phương đã rời phòng');
    }
  }, [peer, finish]);

  // Chuông: đổ chuông khi có cuộc gọi đến, tút tút khi đang gọi đi
  useEffect(() => {
    if (callState === 'incoming') startRingtone('incoming');
    else if (callState === 'calling') startRingtone('outgoing');
    else stopRingtone();
    return () => stopRingtone();
  }, [callState]);

  // Dọn dẹp khi thoát
  useEffect(() => cleanup, [cleanup]);

  const clearNotice = useCallback(() => setNotice(''), []);

  return {
    callState,
    callType,
    localStream,
    remoteStream,
    remoteHasVideo,
    micOn,
    camOn,
    remoteMedia,
    linkIssue,
    notice,
    clearNotice,
    startCall,
    acceptCall,
    endCall,
    toggleMic,
    toggleCam,
  };
}
