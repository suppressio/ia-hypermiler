// renderer/severity.ts — warning colour of a "percent of quota" value (issue #13):
// red from the configurable notification threshold (ui.notificationThresholdPercent,
// default 80%) so that the colour and the system notification agree, orange
// CAUTION_POINTS below it. Colour is never the only signal: values and verdict texts
// stay as they are.

export type Severity = 'none' | 'caution' | 'warning';

const CAUTION_POINTS = 5;

export function severityLevel(percent: number | null | undefined, threshold: number): Severity {
  if (percent === null || percent === undefined || Number.isNaN(percent)) return 'none';
  if (percent >= threshold) return 'warning';
  if (percent >= threshold - CAUTION_POINTS) return 'caution';
  return 'none';
}

/**
 * Colour of today's consumption against today's budget: red only once the budget is
 * passed, orange from the alert threshold (as a share of the budget) up to it. The
 * quota rule above made it red at 80% of the budget, while still under it (user
 * feedback: a value in red under its budget read as over budget).
 */
export function todaySeverity(usedToday: number, budget: number, threshold: number): Severity {
  if (usedToday > budget) return 'warning';
  if (budget > 0 && (usedToday / budget) * 100 >= threshold) return 'caution';
  return 'none';
}

const CLASSES: Record<Exclude<Severity, 'none'>, string> = { caution: 'severity-caution', warning: 'severity-warning' };

/** Sets the severity class of an element (renderer/style.css, `.severity-*`). */
export function applySeverity(el: HTMLElement, severity: Severity): void {
  el.classList.remove(CLASSES.caution, CLASSES.warning);
  if (severity !== 'none') el.classList.add(CLASSES[severity]);
}
