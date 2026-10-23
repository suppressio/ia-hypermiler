import type { WorkSchedule } from '../types/index';

export function isWorkingDay(schedule: WorkSchedule, now: Date): boolean {
  if (!schedule.enabled) return true;
  // Schedules have day statuses and a duration, but no clock-time boundaries.
  const day = (['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const)[now.getDay()];
  return day !== undefined && schedule.days[day] !== 'off';
}

/**
 * Where the arrows live (#125): only between the end of the bar and the target marker,
 * as fractions of the gauge width, so they point to where the bar should go instead of
 * reading as a flow across the whole bar.
 */
export function flowSpan(barEnd: number, target: number): { left: number; width: number } {
  return { left: Math.min(barEnd, target), width: Math.abs(target - barEnd) };
}

export function instantFlow(
  hourlyAverage: number | null,
  sustainable: number | null,
  working: boolean,
): { direction: 'left' | 'right'; durationSeconds: number } | null {
  if (hourlyAverage === null || sustainable === null
    || !Number.isFinite(hourlyAverage) || !Number.isFinite(sustainable)
    || hourlyAverage < 0 || sustainable < 0) return null;
  if (hourlyAverage >= sustainable * 0.85 && hourlyAverage <= sustainable * 1.15) return null;
  const direction = hourlyAverage > sustainable ? 'left' : 'right';
  if (direction === 'right' && !working) return null;
  const distance = sustainable === 0 ? 2 : Math.min(2, Math.abs(hourlyAverage / sustainable - 1));
  // A 48 px repeat moves at 18 px/s per unit of relative distance, capped at 36 px/s.
  return { direction, durationSeconds: 48 / (18 * distance) };
}
