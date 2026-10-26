/** Display helpers. Times are shown in the viewer's local time zone; the ISO UTC value is in the title. */

const pad = (n: number) => String(n).padStart(2, "0");

export function dayKey(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function formatDay(iso: string, now: Date = new Date()): string {
  const key = dayKey(iso);
  if (key === dayKey(now.toISOString())) return "Today";
  const y = new Date(now);
  y.setDate(y.getDate() - 1);
  if (key === dayKey(y.toISOString())) return "Yesterday";
  return new Date(iso).toLocaleDateString(undefined, {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

export function formatTime(iso: string): string {
  const d = new Date(iso);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${formatTime(iso)}`;
}

/** Human duration, e.g. "3 s", "4 min", "2 h 5 min", "3 d". */
export function formatDuration(ms: number): string {
  const abs = Math.abs(ms);
  if (abs < 1000) return `${Math.round(abs)} ms`;
  const s = Math.round(abs / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 48) return m % 60 ? `${h} h ${m % 60} min` : `${h} h`;
  return `${Math.floor(h / 24)} d`;
}

export function formatRelative(iso: string | null | undefined, now: Date = new Date()): string {
  if (!iso) return "never";
  const ms = now.getTime() - new Date(iso).getTime();
  if (Math.abs(ms) < 5000) return "just now";
  return ms >= 0 ? `${formatDuration(ms)} ago` : `in ${formatDuration(ms)}`;
}

export function shortHash(h: string | null | undefined, n = 12): string {
  if (!h) return "—";
  return h.length > n ? `${h.slice(0, n)}…` : h;
}

export function humanize(s: string | null | undefined): string {
  if (!s) return "";
  return s.replace(/[_.]/g, " ");
}

export function formatBytes(n: number | null | undefined): string {
  if (n === null || n === undefined) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${(n / 1024 / 1024).toFixed(1)} MiB`;
}
