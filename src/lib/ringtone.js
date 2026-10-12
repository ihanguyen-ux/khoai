// Chuông cuộc gọi tạo bằng WebAudio (không cần file âm thanh).

let ctx = null;
let timer = null;

function tone(freq, start, duration, volume = 0.15) {
  if (!ctx) return;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = 'sine';
  osc.frequency.value = freq;
  gain.gain.setValueAtTime(0, start);
  gain.gain.linearRampToValueAtTime(volume, start + 0.02);
  gain.gain.linearRampToValueAtTime(0, start + duration);
  osc.connect(gain).connect(ctx.destination);
  osc.start(start);
  osc.stop(start + duration + 0.05);
}

/** kind: 'incoming' (chuông đến) | 'outgoing' (tút tút khi đang gọi đi) */
export function startRingtone(kind = 'incoming') {
  stopRingtone();
  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return;
    ctx = new AudioCtx();
    const play = () => {
      if (!ctx) return;
      const t = ctx.currentTime;
      if (kind === 'incoming') {
        tone(880, t, 0.28);
        tone(660, t + 0.32, 0.28);
        tone(880, t + 1.0, 0.28);
        tone(660, t + 1.32, 0.28);
      } else {
        tone(440, t, 0.9, 0.08);
      }
    };
    play();
    timer = setInterval(play, kind === 'incoming' ? 3000 : 3500);
  } catch {
    /* không có âm thanh cũng không sao */
  }
}

export function stopRingtone() {
  if (timer) clearInterval(timer);
  timer = null;
  if (ctx) {
    ctx.close().catch(() => {});
    ctx = null;
  }
}
