/** User-facing clocks are Asia/Taipei (UTC+8), independent of the browser zone. */
export const TAIPEI_TIME_ZONE = 'Asia/Taipei';

function toDate(value: number | string | Date | null | undefined): Date | null {
  if (value === null || value === undefined || value === '') return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date;
}

export function formatTaipeiDateTime(
  value: number | string | Date | null | undefined
): string {
  const date = toDate(value);
  if (!date) return value === null || value === undefined || value === '' ? '—' : String(value);
  return new Intl.DateTimeFormat('zh-TW', {
    timeZone: TAIPEI_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(date);
}

export function formatTaipeiTime(
  value: number | string | Date | null | undefined
): string {
  const date = toDate(value);
  if (!date) return value === null || value === undefined || value === '' ? '—' : String(value);
  return new Intl.DateTimeFormat('zh-TW', {
    timeZone: TAIPEI_TIME_ZONE,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(date);
}
