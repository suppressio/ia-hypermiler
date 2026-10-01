// renderer/schedule.ts — one-line summary of an account's work schedule, shown on the
// collapsed schedule section of the account detail ("Mon–Thu, half day: Fri").

import { formatWeekdayShort, t } from './i18n/index.js';
import type { AccountConfig } from './types.js';

type WorkSchedule = AccountConfig['workSchedule'];
type DayKey = keyof WorkSchedule['days'];

const DAY_ORDER: readonly DayKey[] = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

// Consecutive days (in Monday–Sunday order) joined as ranges: "Mon–Tue, Thu–Fri".
function ranges(days: DayKey[]): string {
  const parts: string[] = [];
  let start = 0;
  for (let i = 1; i <= days.length; i += 1) {
    const prev = days[i - 1];
    const curr = days[i];
    if (prev === undefined) break;
    if (curr !== undefined && DAY_ORDER.indexOf(curr) === DAY_ORDER.indexOf(prev) + 1) continue;
    const first = days[start];
    if (first === undefined) break;
    parts.push(first === prev ? formatWeekdayShort(first) : `${formatWeekdayShort(first)}–${formatWeekdayShort(prev)}`);
    start = i;
  }
  return parts.join(', ');
}

export function summarizeWorkSchedule(schedule: WorkSchedule): string {
  if (!schedule.enabled) return t('settings.schedule.summaryOff');
  const full = DAY_ORDER.filter((day) => schedule.days[day] === 'full');
  const half = DAY_ORDER.filter((day) => schedule.days[day] === 'half');
  if (full.length === 0 && half.length === 0) return t('settings.schedule.summaryNone');
  const halfPart = half.length > 0 ? t('settings.schedule.summaryHalf', { days: ranges(half) }) : '';
  return [ranges(full), halfPart].filter((part) => part !== '').join(', ');
}
