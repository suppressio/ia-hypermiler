// renderer/dates.ts — local calendar-day keys (YYYY-MM-DD) of the daily history. Copy
// of budget.localDateKey/parseDateKey: the renderer TS project is isolated and cannot
// import budget.ts. Keys are LOCAL days, never `toISOString().slice(0, 10)` (UTC).

export function localDateKey(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${String(date.getFullYear())}-${month}-${day}`;
}

/** Local midnight of a YYYY-MM-DD key (`new Date(key)` would be UTC midnight). */
export function parseDateKey(key: string): Date {
  const [year = NaN, month = NaN, day = NaN] = key.split('-').map(Number);
  return new Date(year, month - 1, day);
}
