// renderer/renewal.ts — is the account's renewal day needed, or does the provider
// report the reset? The main process resolves a window's period end as: its own
// resetsAt, then the provider's subscriptionRenewsAt, then the renewal day entered by
// hand (main.ts resolvePeriodBounds). The manual field is editable only when some
// paced window would fall back to it.

import type { LastGoodUsage, QuotaWindow } from './types.js';

export interface RenewalSource {
  // True when the renewal day entered by hand is used (or unknown yet: no data).
  needsManual: boolean;
  // Earliest renewal reported by the provider among the paced windows, ISO.
  next: string | null;
}

// Same rule as main.ts canEstimatePacing: a billing cycle of unknown length gets no
// pacing, so it needs no period end either.
function isPaced(win: QuotaWindow): boolean {
  return win.periodType !== 'billing-cycle' || win.periodLength !== null;
}

export function renewalFromProvider(lastGood: LastGoodUsage | null | undefined): RenewalSource {
  const paced = lastGood ? lastGood.quotaWindows.filter(isPaced) : [];
  if (!lastGood || paced.length === 0) return { needsManual: true, next: null };
  const ends = paced.map((w) => w.resetsAt ?? lastGood.subscriptionRenewsAt);
  const known = ends.filter((d): d is string => d !== null);
  const next = known.reduce<string | null>(
    (min, d) => (min === null || new Date(d).getTime() < new Date(min).getTime() ? d : min),
    null,
  );
  return { needsManual: known.length < ends.length, next };
}
