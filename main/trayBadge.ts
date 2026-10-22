// main/trayBadge.ts — usage badge of the tray icon (issue #33): which percentage it
// shows, its colour and the icon bitmap. Pure (no Electron), tested in trayBadge.test.ts.

import type { AccountSnapshot } from '../types/index';
import { normalizedUtilization } from '../budget';

/** `ui.trayBadge`: 'off', 'critical' (highest account) or the id of one account. */
export const TRAY_BADGE_OFF = 'off';
export const TRAY_BADGE_CRITICAL = 'critical';

type BadgeAccount = Pick<AccountSnapshot, 'accountId' | 'criticalWindow' | 'stale'>;

export interface Badge {
  percent: number;
  stale: boolean;
}

/**
 * The percentage the icon shows. 'critical' = the highest utilization across accounts;
 * an account id = that account's critical window, falling back to 'critical' when the
 * account is gone or disabled. Accounts with unknown usage are skipped.
 */
export function pickBadge(accounts: BadgeAccount[], choice: string): Badge | null {
  if (choice === TRAY_BADGE_OFF) return null;
  const known = accounts.flatMap((a) => {
    const percent = a.criticalWindow ? normalizedUtilization(a.criticalWindow) : null;
    return percent === null ? [] : [{ id: a.accountId, percent, stale: a.stale === true }];
  });
  const chosen = known.find((a) => a.id === choice);
  const top = chosen ?? [...known].sort((a, b) => b.percent - a.percent)[0];
  return top ? { percent: top.percent, stale: top.stale } : null;
}

export type BadgeTone = 'ok' | 'caution' | 'warning' | 'stale';

const CAUTION_POINTS = 5;

/** Same bands as the widget (renderer/severity.ts): red from the notification threshold. */
export function badgeTone(badge: Badge, threshold: number): BadgeTone {
  if (badge.stale) return 'stale';
  if (badge.percent >= threshold) return 'warning';
  if (badge.percent >= threshold - CAUTION_POINTS) return 'caution';
  return 'ok';
}

const TONE_RGB: Record<BadgeTone, [number, number, number]> = {
  ok: [22, 163, 74],
  caution: [217, 119, 6],
  warning: [220, 38, 38],
  stale: [107, 114, 128],
};

// 3×5 digit glyphs, one string per row ('#' = lit).
const GLYPHS: Record<string, readonly string[]> = {
  '0': ['###', '# #', '# #', '# #', '###'],
  '1': [' # ', '## ', ' # ', ' # ', '###'],
  '2': ['###', '  #', '###', '#  ', '###'],
  '3': ['###', '  #', '###', '  #', '###'],
  '4': ['# #', '# #', '###', '  #', '  #'],
  '5': ['###', '#  ', '###', '  #', '###'],
  '6': ['###', '#  ', '###', '# #', '###'],
  '7': ['###', '  #', '  #', '  #', '  #'],
  '8': ['###', '# #', '###', '# #', '###'],
  '9': ['###', '# #', '###', '  #', '###'],
};

export const BADGE_SIZE = 32;
const CORNER = 6;

export function badgeText(percent: number): string {
  return String(Math.min(100, Math.max(0, Math.round(percent))));
}

/** RGBA bitmap (BADGE_SIZE², row-major): a rounded square in the tone colour with white digits. */
export function renderBadge(percent: number, tone: BadgeTone): Uint8Array {
  const size = BADGE_SIZE;
  const pixels = new Uint8Array(size * size * 4);
  const [r, g, b] = TONE_RGB[tone];
  const inside = (x: number, y: number): boolean => {
    const dx = Math.max(CORNER - x, x - (size - 1 - CORNER), 0);
    const dy = Math.max(CORNER - y, y - (size - 1 - CORNER), 0);
    return dx * dx + dy * dy <= CORNER * CORNER;
  };
  const put = (x: number, y: number, rgb: readonly [number, number, number]): void => {
    const i = (y * size + x) * 4;
    pixels.set([rgb[0], rgb[1], rgb[2], 255], i);
  };
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (inside(x, y)) put(x, y, [r, g, b]);

  const text = badgeText(percent);
  const scale = text.length >= 3 ? 3 : 4;
  const gap = text.length >= 3 ? 1 : 2;
  const width = text.length * 3 * scale + (text.length - 1) * gap;
  const left = Math.floor((size - width) / 2);
  const top = Math.floor((size - 5 * scale) / 2);
  text.split('').forEach((char, index) => {
    const rows = GLYPHS[char] ?? [];
    const originX = left + index * (3 * scale + gap);
    rows.forEach((row, ry) => {
      row.split('').forEach((cell, rx) => {
        if (cell !== '#') return;
        for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < scale; dx++) put(originX + rx * scale + dx, top + ry * scale + dy, [255, 255, 255]);
      });
    });
  });
  return pixels;
}
