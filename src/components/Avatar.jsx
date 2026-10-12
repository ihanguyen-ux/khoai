import { initials } from '../lib/format';

const COLORS = ['bg-blue-600', 'bg-emerald-600', 'bg-violet-600', 'bg-amber-600', 'bg-rose-600', 'bg-cyan-600'];

function colorFor(name) {
  let sum = 0;
  for (const ch of String(name)) sum += ch.charCodeAt(0);
  return COLORS[sum % COLORS.length];
}

export default function Avatar({ name, size = 40, online = null, className = '' }) {
  return (
    <div className={`relative shrink-0 ${className}`} style={{ width: size, height: size }}>
      <div
        className={`flex h-full w-full items-center justify-center rounded-full font-semibold text-white ${colorFor(name)}`}
        style={{ fontSize: size * 0.38 }}
      >
        {initials(name)}
      </div>
      {online !== null && (
        <span
          className={`absolute bottom-0 right-0 block rounded-full border-2 border-zinc-900 ${
            online ? 'bg-emerald-500' : 'bg-zinc-500'
          }`}
          style={{ width: size * 0.3, height: size * 0.3 }}
        />
      )}
    </div>
  );
}
