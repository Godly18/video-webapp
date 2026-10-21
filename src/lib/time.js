const pad = (n, w = 2) => String(n).padStart(w, '0');
/** HH:MM:SS (floored). Pass {precise:true} to append milliseconds. */
export function formatDuration(seconds, { precise = false } = {}) {
  if (!Number.isFinite(seconds) || seconds < 0) return '--:--:--';
  const whole = Math.floor(seconds);
  const h = Math.floor(whole / 3600), m = Math.floor((whole % 3600) / 60), s = whole % 60;
  let out = `${pad(h)}:${pad(m)}:${pad(s)}`;
  if (precise) out += '.' + pad(Math.round((seconds - whole) * 1000), 3).slice(0, 3);
  return out;
}
/** Display string for the limit check: switches to millisecond precision when flooring would hide an over-limit value. */
export function displayDuration(seconds, maxSeconds) {
  const floored = Math.floor(seconds);
  return formatDuration(seconds, { precise: seconds > maxSeconds && floored <= maxSeconds });
}
