// main/windowLabel.ts — localized quota window labels.

import type { QuotaWindow, ProviderId } from '../types/index';
import { t } from './i18n/index';
import { en } from './i18n/en';
import type { MainMessageKey } from './i18n/en';

function isMessageKey(key: string): key is MainMessageKey { return key in en; }

// Known window ids have their own translation; generic labels use snapshot data.
// Claude count windows represent extra credit; Codex labels preserve identity and
// duration. Windows without a usable duration fall back to their id.
export function windowLabel(win: QuotaWindow, provider: ProviderId): string {
  const key = `windows.${win.id}`;
  if (isMessageKey(key)) return t(key);
  if (provider === 'codex') {
    if (win.periodLength === null || win.periodType === 'billing-cycle') return win.id;
    const limit = t(win.periodType === 'rolling-hours' ? 'windows.codexHours' : 'windows.codexDays', { n: win.periodLength });
    if (win.id.startsWith('codex-review-')) return t('windows.codexReview', { limit });
    const array = /^codex-additional-array-(\d+)-/.exec(win.id);
    const keyed = /^codex-additional-key-(.*)-\d+[hd]$/.exec(win.id);
    const name = array ? t('windows.codexAdditional', { i: Number(array[1]) + 1 }) : keyed?.[1] !== undefined ? `“${keyed[1]}”` : win.id;
    return t('windows.codexNamed', { name, limit });
  }
  if (provider === 'claude') {
    return t(win.unit === 'count' ? 'windows.claudeExtraCredit' : 'windows.claudeUndocumented', { name: win.id });
  }
  return t('windows.copilotSnapshot', { name: win.id });
}
