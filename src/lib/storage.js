const KEY = 'winchat.settings.v1';

const DEFAULTS = {
  name: '',
  mode: 'join', // 'host' | 'join'
  serverAddress: '',
  port: 3001,
  room: '',
  accessKey: '',
  turnUrl: '',
  turnUser: '',
  turnPass: '',
};

export function loadSettings() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULTS };
    return { ...DEFAULTS, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveSettings(partial) {
  try {
    const next = { ...loadSettings(), ...partial };
    localStorage.setItem(KEY, JSON.stringify(next));
    return next;
  } catch {
    return { ...DEFAULTS, ...partial };
  }
}
