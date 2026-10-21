// Times and numbers in words: how long ago, how long it took, the time of day, a moment.

export function ago(at: number, now: number) {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 5) return "刚刚";
  if (s < 60) return `${s} 秒前`;
  if (s < 3600) return `${Math.round(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
  return `${Math.floor(s / 86400)} 天前`;
}

export function tookText(ms: number) {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} 秒`;
  const m = Math.floor(s / 60);
  if (m < 60) return s % 60 === 0 ? `${m} 分` : `${m} 分 ${s % 60} 秒`;
  return m % 60 === 0 ? `${Math.floor(m / 60)} 小时` : `${Math.floor(m / 60)} 小时 ${m % 60} 分`;
}

const two = (n: number) => String(n).padStart(2, "0");

export function wallClockText(at: number) {
  const d = new Date(Math.round(at));
  return `${d.getHours()}:${two(d.getMinutes())}:${two(d.getSeconds())}`;
}

/** A whole number without its .0, as the server writes ids and counts. */
export const numberText = (v: number) => String(v);

/** A moment as a date and a time of day. */
export function momentText(at: number) {
  const d = new Date(Math.round(at));
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()} ${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`;
}
