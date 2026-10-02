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

const CLASSES: Record<Exclude<Severity, 'none'>, string> = { caution: 'severity-caution', warning: 'severity-warning' };

/** Sets the severity class of an element (renderer/style.css, `.severity-*`). */
export function applySeverity(el: HTMLElement, severity: Severity): void {
  el.classList.remove(CLASSES.caution, CLASSES.warning);
  if (severity !== 'none') el.classList.add(CLASSES[severity]);
}
