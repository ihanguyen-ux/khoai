import { useEffect, useRef, useState } from 'react';
import { Maximize2, Mic, MicOff, Minimize2, Phone, PhoneOff, Video, VideoOff, WifiOff } from 'lucide-react';
import Avatar from './Avatar';
import { formatDuration } from '../lib/format';

function VideoView({ stream, mirror = false, className = '' }) {
  const ref = useRef(null);
  useEffect(() => {
    const el = ref.current;
    if (el && el.srcObject !== stream) el.srcObject = stream || null;
  }, [stream]);
  // muted: tiếng của đối phương phát qua <audio> riêng (AudioSink), tránh phát 2 lần
  return <video ref={ref} autoPlay playsInline muted className={`${className} ${mirror ? '-scale-x-100' : ''}`} />;
}

function AudioSink({ stream }) {
  const ref = useRef(null);
  useEffect(() => {
    const el = ref.current;
    if (el && el.srcObject !== stream) el.srcObject = stream || null;
  }, [stream]);
  return <audio ref={ref} autoPlay />;
}

function RoundButton({ onClick, title, active = true, danger = false, disabled = false, children }) {
  let cls = 'bg-zinc-700/80 text-white hover:bg-zinc-600';
  if (!active) cls = 'bg-white text-zinc-900 hover:bg-zinc-200';
  if (danger) cls = 'bg-red-600 text-white hover:bg-red-500';
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={title}
      disabled={disabled}
      className={`flex h-12 w-12 items-center justify-center rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${cls}`}
    >
      {children}
    </button>
  );
}

/**
 * Lớp phủ cuộc gọi: nằm trong vùng nội dung (dưới titlebar) nên vẫn kéo/thu nhỏ cửa sổ được.
 *  - incoming: hộp thoại nhận/từ chối
 *  - calling/connecting/connected: toàn khung, có thể thu nhỏ thành cửa sổ nổi để vừa gọi vừa chat
 */
export default function CallLayer({ call, peerName }) {
  const {
    callState,
    callType,
    localStream,
    remoteStream,
    remoteHasVideo,
    micOn,
    camOn,
    remoteMedia,
    linkIssue,
    acceptCall,
    endCall,
    toggleMic,
    toggleCam,
  } = call;

  const [minimized, setMinimized] = useState(false);
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    if (callState !== 'connected') {
      setElapsed(0);
      return undefined;
    }
    const start = Date.now();
    const timer = setInterval(() => setElapsed((Date.now() - start) / 1000), 1000);
    return () => clearInterval(timer);
  }, [callState]);

  useEffect(() => {
    if (callState === 'idle') setMinimized(false);
  }, [callState]);

  if (callState === 'idle') return null;

  if (callState === 'incoming') {
    return (
      <div className="absolute inset-0 z-40 flex items-center justify-center bg-black/70 backdrop-blur-sm">
        <div className="w-80 rounded-2xl border border-zinc-700 bg-zinc-900 p-7 text-center shadow-2xl">
          <div className="ring-pulse mx-auto w-fit rounded-full">
            <Avatar name={peerName} size={88} />
          </div>
          <h2 className="mt-4 text-lg font-semibold">{peerName}</h2>
          <p className="mt-1 text-sm text-zinc-400">
            đang gọi {callType === 'video' ? 'video' : 'thoại'} cho bạn…
          </p>
          <div className="mt-6 flex items-center justify-center gap-8">
            <div className="flex flex-col items-center gap-1.5">
              <RoundButton danger onClick={endCall} title="Từ chối">
                <PhoneOff size={22} />
              </RoundButton>
              <span className="text-xs text-zinc-400">Từ chối</span>
            </div>
            <div className="flex flex-col items-center gap-1.5">
              <button
                type="button"
                onClick={acceptCall}
                title="Nghe"
                aria-label="Nghe"
                className="flex h-12 w-12 items-center justify-center rounded-full bg-emerald-600 text-white transition-colors hover:bg-emerald-500"
              >
                {callType === 'video' ? <Video size={22} /> : <Phone size={22} />}
              </button>
              <span className="text-xs text-zinc-400">Nghe</span>
            </div>
          </div>
        </div>
      </div>
    );
  }

  const showRemoteVideo = Boolean(remoteStream && remoteHasVideo && remoteMedia.cam);
  const hasLocalVideo = Boolean(localStream && localStream.getVideoTracks().length > 0);
  let statusText = formatDuration(elapsed);
  if (callState === 'calling') statusText = 'Đang đổ chuông…';
  else if (callState === 'connecting') statusText = 'Đang kết nối…';
  else if (linkIssue) statusText = 'Kết nối không ổn định…';

  const stage = showRemoteVideo ? (
    <VideoView stream={remoteStream} className="h-full w-full object-contain" />
  ) : (
    <div className="flex h-full flex-col items-center justify-center gap-3">
      <Avatar name={peerName} size={minimized ? 56 : 120} />
      {!minimized && (
        <>
          <p className="text-xl font-semibold">{peerName}</p>
          <p className="text-sm text-zinc-400">{statusText}</p>
        </>
      )}
    </div>
  );

  return (
    <>
      {/* Luôn mounted để không ngắt tiếng khi đổi giao diện */}
      <AudioSink stream={remoteStream} />

      {minimized ? (
        // Đặt ở góc trên phải (dưới header chat) để không che ô nhập và nút Gửi
        <div className="absolute right-4 top-[76px] z-40 w-72 overflow-hidden rounded-xl border border-zinc-700 bg-zinc-900 shadow-2xl">
          <div className="relative aspect-video bg-black">
            {stage}
            <button
              type="button"
              onClick={() => setMinimized(false)}
              title="Mở rộng"
              aria-label="Mở rộng cuộc gọi"
              className="absolute inset-0 flex items-start justify-end p-2 text-white/0 transition-colors hover:bg-black/30 hover:text-white"
            >
              <Maximize2 size={16} />
            </button>
          </div>
          <div className="flex items-center justify-between gap-2 px-3 py-2">
            <div className="min-w-0">
              <p className="truncate text-sm font-medium">{peerName}</p>
              <p className="text-xs text-zinc-400">{statusText}</p>
            </div>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={toggleMic}
                title={micOn ? 'Tắt mic' : 'Bật mic'}
                aria-label={micOn ? 'Tắt mic' : 'Bật mic'}
                className={`flex h-9 w-9 items-center justify-center rounded-full ${
                  micOn ? 'bg-zinc-700 text-white hover:bg-zinc-600' : 'bg-white text-zinc-900'
                }`}
              >
                {micOn ? <Mic size={16} /> : <MicOff size={16} />}
              </button>
              <button
                type="button"
                onClick={endCall}
                title="Kết thúc"
                aria-label="Kết thúc cuộc gọi"
                className="flex h-9 w-9 items-center justify-center rounded-full bg-red-600 text-white hover:bg-red-500"
              >
                <PhoneOff size={16} />
              </button>
            </div>
          </div>
        </div>
      ) : (
        <div className="absolute inset-0 z-40 flex flex-col bg-zinc-950">
          <div className="relative flex-1 overflow-hidden bg-black">
            {stage}

            {/* Thanh trạng thái phía trên */}
            <div className="absolute inset-x-0 top-0 flex items-center justify-between bg-gradient-to-b from-black/70 to-transparent p-4">
              <div>
                <p className="text-sm font-semibold">{peerName}</p>
                <p className="flex items-center gap-1.5 text-xs text-zinc-300">
                  {linkIssue && <WifiOff size={12} className="text-amber-400" />}
                  {callType === 'video' ? 'Cuộc gọi video' : 'Cuộc gọi thoại'} · {statusText}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setMinimized(true)}
                title="Thu nhỏ để vừa gọi vừa chat"
                aria-label="Thu nhỏ cuộc gọi"
                className="flex h-9 w-9 items-center justify-center rounded-full bg-zinc-800/80 text-zinc-200 hover:bg-zinc-700"
              >
                <Minimize2 size={16} />
              </button>
            </div>

            {remoteMedia && !remoteMedia.mic && callState === 'connected' && (
              <div className="absolute left-4 top-16 flex items-center gap-1.5 rounded-full bg-black/60 px-2.5 py-1 text-xs text-zinc-200">
                <MicOff size={12} /> {peerName} đã tắt mic
              </div>
            )}

            {/* Hình của mình */}
            {hasLocalVideo && (
              <div className="absolute bottom-4 right-4 h-28 w-44 overflow-hidden rounded-xl border border-zinc-700 bg-zinc-900 shadow-lg">
                <VideoView stream={localStream} mirror className="h-full w-full object-cover" />
                {!camOn && (
                  <div className="absolute inset-0 flex items-center justify-center bg-zinc-900 text-xs text-zinc-400">
                    Camera đang tắt
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Nút điều khiển */}
          <div className="flex shrink-0 items-center justify-center gap-5 border-t border-zinc-800 bg-zinc-950 py-4">
            <RoundButton onClick={toggleMic} active={micOn} title={micOn ? 'Tắt mic' : 'Bật mic'}>
              {micOn ? <Mic size={22} /> : <MicOff size={22} />}
            </RoundButton>
            <RoundButton
              onClick={toggleCam}
              active={camOn}
              disabled={!hasLocalVideo}
              title={!hasLocalVideo ? 'Không có webcam' : camOn ? 'Tắt camera' : 'Bật camera'}
            >
              {camOn ? <Video size={22} /> : <VideoOff size={22} />}
            </RoundButton>
            <RoundButton danger onClick={endCall} title={callState === 'calling' ? 'Hủy cuộc gọi' : 'Kết thúc cuộc gọi'}>
              <PhoneOff size={22} />
            </RoundButton>
          </div>
        </div>
      )}
    </>
  );
}
