// budget.ts — logica di calcolo budget/efficienza/previsionale (vedi ARCHITECTURE.md §0 e §3)
//
// Modello: ogni account (Claude/Copilot) espone una o più QuotaWindow:
//   { id, label, periodType, periodLength, unit: 'percentage'|'count', used, total, resetsAt }
// - unit 'percentage': used è già 0-100 (caso Claude: nessun totale in token noto).
// - unit 'count': used/total sono valori assoluti (caso Copilot: premium requests/crediti).
//
// Tutte le funzioni sono pure (nessun I/O), testabili da terminale/test runner.

import { addDays, differenceInCalendarDays, isBefore, startOfDay, setDate, addMonths } from 'date-fns';
import type { QuotaWindow, WorkSchedule, RenewalRule, DailyUsagePoint, EcoScore } from './types/index';

const DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;

/** Unità lavorativa di un singolo giorno di calendario: 1 (full), 0.5 (half), 0 (off). */
export function getDayUnit(date: Date, workSchedule: WorkSchedule): number {
  const key = DAY_KEYS[date.getDay()];
  const status = workSchedule?.days?.[key] ?? 'off';
  if (status === 'full') return 1;
  if (status === 'half') return 0.5;
  return 0;
}

/**
 * Somma le unità lavorative sui giorni di calendario nell'intervallo [startDate, endDate).
 * Se endDate precede startDate, ritorna 0 (nessuna unità negativa).
 */
export function workingUnitsBetween(startDate: Date | string, endDate: Date | string, workSchedule: WorkSchedule): number {
  const start = startOfDay(new Date(startDate));
  const end = startOfDay(new Date(endDate));
  if (!isBefore(start, end)) return 0;

  let units = 0;
  let cursor = start;
  while (isBefore(cursor, end)) {
    units += getDayUnit(cursor, workSchedule);
    cursor = addDays(cursor, 1);
  }
  return units;
}

/** Utilizzo normalizzato a percentuale 0-100, o null se non calcolabile (count senza total). */
export function normalizedUtilization(win: QuotaWindow): number | null {
  if (win.unit === 'percentage') return win.used;
  if (win.unit === 'count' && typeof win.total === 'number' && win.total > 0) {
    return (win.used / win.total) * 100;
  }
  return null;
}

/** Sceglie la finestra di quota più critica (utilizzo normalizzato più alto). */
export function pickCriticalWindow(quotaWindows: QuotaWindow[]): QuotaWindow | null {
  if (!Array.isArray(quotaWindows) || quotaWindows.length === 0) return null;
  const withUtilization = quotaWindows
    .map((w) => ({ window: w, utilization: normalizedUtilization(w) }))
    .filter((x): x is { window: QuotaWindow; utilization: number } => x.utilization !== null);
  if (withUtilization.length === 0) return quotaWindows[0];
  withUtilization.sort((a, b) => b.utilization - a.utilization);
  return withUtilization[0].window;
}

export interface PeriodContext {
  window: QuotaWindow;
  workSchedule: WorkSchedule;
  periodStart: Date | string;
  periodEnd: Date | string;
  now?: Date;
}

/**
 * Indice di efficienza: rapporto tra ritmo ideale e ritmo reale, calcolato sulle
 * unità lavorative (non giorni di calendario). ~1 = in linea col budget;
 * >1 = si sta consumando meno del previsto; <1 = si sta consumando più del sostenibile.
 * Ritorna null se non calcolabile (dati insufficienti).
 */
export function efficiencyIndex({ window, workSchedule, periodStart, periodEnd, now = new Date() }: PeriodContext): number | null {
  const utilization = normalizedUtilization(window);
  if (utilization === null) return null;

  const totalUnits = workingUnitsBetween(periodStart, periodEnd, workSchedule);
  const elapsedUnits = workingUnitsBetween(periodStart, now, workSchedule);
  if (totalUnits <= 0 || elapsedUnits <= 0) return null;

  const idealPace = 100 / totalUnits;
  const actualPace = utilization / elapsedUnits;
  if (actualPace === 0) return null;

  return Math.round((idealPace / actualPace) * 100) / 100;
}

/**
 * Proiezione dell'utilizzo (%) alla fine del periodo, estrapolando il ritmo medio
 * reale sulle unità lavorative rimanenti. Limitata a 100.
 */
export function projectedUsage({ window, workSchedule, periodStart, periodEnd, now = new Date() }: PeriodContext): number | null {
  const utilization = normalizedUtilization(window);
  if (utilization === null) return null;

  const elapsedUnits = workingUnitsBetween(periodStart, now, workSchedule);
  const remainingUnits = workingUnitsBetween(now, periodEnd, workSchedule);
  if (elapsedUnits <= 0) return Math.min(100, utilization);

  const avgPacePerUnit = utilization / elapsedUnits;
  const projected = utilization + avgPacePerUnit * remainingUnits;
  return Math.round(Math.min(100, projected) * 10) / 10;
}

/** Giorni di calendario mancanti al reset (>= 0). */
export function daysUntilReset(resetsAt: Date | string, now: Date = new Date()): number {
  return Math.max(0, differenceInCalendarDays(new Date(resetsAt), now));
}

/** Giorni/unità lavorative mancanti al reset (>= 0). */
export function workingDaysUntilReset(resetsAt: Date | string, workSchedule: WorkSchedule, now: Date = new Date()): number {
  return workingUnitsBetween(now, resetsAt, workSchedule);
}

/**
 * Stima delle unità lavorative di autonomia residua al ritmo medio attuale
 * (quante unità lavorative mancano prima di raggiungere il 100%).
 * Ritorna Infinity se il ritmo attuale è ~0 (nessun consumo osservato).
 */
export function estimatedAutonomyWorkingDays({ window, workSchedule, periodStart, now = new Date() }: Omit<PeriodContext, 'periodEnd'>): number | null {
  const utilization = normalizedUtilization(window);
  if (utilization === null) return null;
  if (utilization >= 100) return 0;

  const elapsedUnits = workingUnitsBetween(periodStart, now, workSchedule);
  if (elapsedUnits <= 0) return Infinity;

  const avgPacePerUnit = utilization / elapsedUnits;
  if (avgPacePerUnit <= 0) return Infinity;

  const remainingPercent = 100 - utilization;
  return Math.round((remainingPercent / avgPacePerUnit) * 10) / 10;
}

/**
 * Per finestre count-based (es. Copilot premium requests): quante unità residue
 * ci si può permettere per ogni unità lavorativa rimanente. Null se non applicabile.
 */
export function remainingBudgetPerWorkingDay({ window, workSchedule, periodEnd, now = new Date() }: Omit<PeriodContext, 'periodStart'>): number | null {
  if (window.unit !== 'count' || typeof window.total !== 'number') return null;
  const remaining = Math.max(0, window.total - window.used);
  const remainingUnits = workingUnitsBetween(now, periodEnd, workSchedule);
  if (remainingUnits <= 0) return remaining;
  return Math.floor(remaining / remainingUnits);
}

/**
 * Ritmo di consumo recente (%/ora), calcolato tra il campione più vecchio e quello
 * più recente disponibili entro `lookbackMinutes` (default 3h). È l'analogo del
 * "consumo istantaneo" dei cruscotti hypermiling (Honda Insight/Fiat 500e): non
 * un valore realmente istantaneo (il refresh è ogni 30 min, vedi CLAUDE.md), ma
 * il ritmo osservato nella finestra recente. Ritorna null se i campioni sono
 * insufficienti o l'intervallo è troppo corto (< 5 min) per essere significativo.
 * Un delta negativo (reset della finestra di quota nel mezzo) viene clampato a 0
 * invece di mostrare un ritmo negativo privo di senso per l'utente.
 */
export function instantaneousRate(
  samples: { timestamp: Date | string; used: number }[],
  now: Date = new Date(),
  lookbackMinutes = 180,
): number | null {
  if (!Array.isArray(samples) || samples.length < 2) return null;

  const cutoff = now.getTime() - lookbackMinutes * 60 * 1000;
  const points = samples
    .map((s) => ({ time: new Date(s.timestamp).getTime(), used: s.used }))
    .filter((s) => s.time <= now.getTime())
    .sort((a, b) => a.time - b.time);

  const withinLookback = points.filter((s) => s.time >= cutoff);
  const relevant = withinLookback.length >= 2 ? withinLookback : points;
  if (relevant.length < 2) return null;

  const oldest = relevant[0];
  const latest = relevant[relevant.length - 1];
  const elapsedHours = (latest.time - oldest.time) / (3600 * 1000);
  if (elapsedHours < 5 / 60) return null;

  const delta = Math.max(0, latest.used - oldest.used);
  return Math.round((delta / elapsedHours) * 100) / 100;
}

/**
 * Ritmo orario massimo (%/ora) sostenibile per arrivare esattamente al 100% al
 * reset della finestra — il "pallino target" del gauge di consumo istantaneo.
 * Usa solo `window.resetsAt`, non `periodStart`/`workSchedule`: a differenza di
 * `efficiencyIndex`/`projectedUsage` funziona anche per finestre con periodo di
 * riferimento sconosciuto (es. crediti una tantum, vedi main.ts canEstimatePacing),
 * perché non serve sapere quando il periodo è iniziato per sapere quanto manca alla
 * scadenza. Ritorna null se `resetsAt` è assente o l'utilizzo non è calcolabile.
 */
export function sustainableHourlyRate(window: QuotaWindow, now: Date = new Date()): number | null {
  const utilization = normalizedUtilization(window);
  if (utilization === null || !window.resetsAt) return null;

  const hoursUntilReset = (new Date(window.resetsAt).getTime() - now.getTime()) / (3600 * 1000);
  if (hoursUntilReset <= 0) return 0;

  const remainingPercent = Math.max(0, 100 - utilization);
  return Math.round((remainingPercent / hoursUntilReset) * 100) / 100;
}

const ECO_SCORE_MAX_RATIO = 3;

/**
 * Punteggio eco a stelle (1-5), ispirato alle foglioline della Honda Insight:
 * media, sugli ultimi `days` giorni di storico, del rapporto tra quota ideale del
 * giorno e consumo osservato quel giorno (>1 = si è consumato meno dell'ideale).
 * Un giorno non lavorativo è escluso (nessuna quota ideale da rispettare); un
 * delta negativo (reset della finestra nel mezzo) è escluso allo stesso modo di
 * instantaneousRate, non attribuibile alla "guida" di quel giorno. Ogni rapporto
 * è limitato a ECO_SCORE_MAX_RATIO per evitare che un singolo giorno a consumo
 * zero domini la media. Ritorna null se non ci sono abbastanza dati validi.
 */
export function ecoScore(
  dailyHistory: DailyUsagePoint[],
  workSchedule: WorkSchedule,
  totalPeriodWorkingUnits: number,
  days = 7,
): EcoScore | null {
  if (!Array.isArray(dailyHistory) || dailyHistory.length < 2 || totalPeriodWorkingUnits <= 0) return null;

  const sorted = [...dailyHistory].sort((a, b) => a.date.localeCompare(b.date)).slice(-(days + 1));
  const ratios: number[] = [];

  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1];
    const curr = sorted[i];
    const dayUnit = getDayUnit(new Date(curr.date), workSchedule);
    if (dayUnit <= 0) continue;

    const delta = curr.used - prev.used;
    if (delta < 0) continue;

    const idealShare = dayUnit * (100 / totalPeriodWorkingUnits);
    const ratio = delta === 0 ? ECO_SCORE_MAX_RATIO : Math.min(ECO_SCORE_MAX_RATIO, idealShare / delta);
    ratios.push(ratio);
  }

  if (ratios.length === 0) return null;
  const avgRatio = ratios.reduce((s, r) => s + r, 0) / ratios.length;
  const stars = avgRatio >= 1.5 ? 5 : avgRatio >= 1.1 ? 4 : avgRatio >= 0.9 ? 3 : avgRatio >= 0.6 ? 2 : 1;
  return { stars, avgRatio: Math.round(avgRatio * 100) / 100 };
}

/**
 * Risolve la prossima data di rinnovo abbonamento a partire da una renewalRule.
 * Supporta oggi solo { type: 'dayOfMonth', day }. { type: 'rrule', rrule } non è
 * ancora implementato (richiederebbe una libreria dedicata, da valutare se serve
 * davvero una ricorrenza più complessa del semplice giorno del mese).
 */
export function resolveRenewalDate(renewalRule: RenewalRule, referenceDate: Date = new Date()): Date {
  if (renewalRule?.type === 'dayOfMonth' && typeof renewalRule.day === 'number') {
    const day = renewalRule.day;
    let candidate = setDate(startOfDay(new Date(referenceDate)), day);
    if (!isBefore(referenceDate, candidate)) {
      candidate = setDate(addMonths(candidate, 1), day);
    }
    return candidate;
  }
  throw new Error(`resolveRenewalDate: renewalRule.type "${renewalRule?.type}" non supportato`);
}
