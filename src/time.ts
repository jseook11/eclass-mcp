// KST (Asia/Seoul) ISO formatting, matching the convention used by
// get-assignments / get-announcements.

const KST_OFFSET = 9 * 60 * 60 * 1000;
const pad = (n: number): string => String(n).padStart(2, '0');

export function toKstIso(dt: Date): string {
  const kst = new Date(dt.getTime() + KST_OFFSET);
  return `${kst.getUTCFullYear()}-${pad(kst.getUTCMonth() + 1)}-${pad(kst.getUTCDate())}T` +
         `${pad(kst.getUTCHours())}:${pad(kst.getUTCMinutes())}:${pad(kst.getUTCSeconds())}.000+09:00`;
}

export function parseIsoToKst(value: string | null | undefined): string | null {
  if (!value) return null;
  const dt = new Date(value);
  if (isNaN(dt.getTime())) return null;
  return toKstIso(dt);
}
