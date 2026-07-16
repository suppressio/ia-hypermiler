// budget.js — logica di calcolo budget/efficienza/previsionale (vedi ARCHITECTURE.md §0 e §3)
//
// Modello: ogni account (Claude/Copilot) espone una o più "quotaWindow":
//   { id, label, periodType: 'rolling-hours'|'rolling-days'|'billing-cycle',
//     periodLength, unit: 'percentage'|'count', used, total, resetsAt }
// - unit 'percentage': used è già 0-100 (caso Claude: nessun totale in token noto).
// - unit 'count': used/total sono valori assoluti (caso Copilot: premium requests/crediti).
//
// Tutte le funzioni sono pure (nessun I/O), testabili da terminale con `node budget.js`.

const { addDays, differenceInCalendarDays, isBefore, startOfDay, setDate, addMonths } = require('date-fns');

const DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

/** Unità lavorativa di un singolo giorno di calendario: 1 (full), 0.5 (half), 0 (off). */
function getDayUnit(date, workSchedule) {
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
function workingUnitsBetween(startDate, endDate, workSchedule) {
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
function normalizedUtilization(window) {
  if (window.unit === 'percentage') return window.used;
  if (window.unit === 'count' && typeof window.total === 'number' && window.total > 0) {
    return (window.used / window.total) * 100;
  }
  return null;
}

/** Sceglie la finestra di quota più critica (utilizzo normalizzato più alto). */
function pickCriticalWindow(quotaWindows) {
  if (!Array.isArray(quotaWindows) || quotaWindows.length === 0) return null;
  const withUtilization = quotaWindows
    .map((w) => ({ window: w, utilization: normalizedUtilization(w) }))
    .filter((x) => x.utilization !== null);
  if (withUtilization.length === 0) return quotaWindows[0];
  withUtilization.sort((a, b) => b.utilization - a.utilization);
  return withUtilization[0].window;
}

/**
 * Indice di efficienza: rapporto tra ritmo ideale e ritmo reale, calcolato sulle
 * unità lavorative (non giorni di calendario). ~1 = in linea col budget;
 * >1 = si sta consumando meno del previsto; <1 = si sta consumando più del sostenibile.
 * Ritorna null se non calcolabile (dati insufficienti).
 */
function efficiencyIndex({ window, workSchedule, periodStart, periodEnd, now = new Date() }) {
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
function projectedUsage({ window, workSchedule, periodStart, periodEnd, now = new Date() }) {
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
function daysUntilReset(resetsAt, now = new Date()) {
  return Math.max(0, differenceInCalendarDays(new Date(resetsAt), now));
}

/** Giorni/unità lavorative mancanti al reset (>= 0). */
function workingDaysUntilReset(resetsAt, workSchedule, now = new Date()) {
  return workingUnitsBetween(now, resetsAt, workSchedule);
}

/**
 * Stima delle unità lavorative di autonomia residua al ritmo medio attuale
 * (quante unità lavorative mancano prima di raggiungere il 100%).
 * Ritorna Infinity se il ritmo attuale è ~0 (nessun consumo osservato).
 */
function estimatedAutonomyWorkingDays({ window, workSchedule, periodStart, now = new Date() }) {
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
function remainingBudgetPerWorkingDay({ window, workSchedule, periodEnd, now = new Date() }) {
  if (window.unit !== 'count' || typeof window.total !== 'number') return null;
  const remaining = Math.max(0, window.total - window.used);
  const remainingUnits = workingUnitsBetween(now, periodEnd, workSchedule);
  if (remainingUnits <= 0) return remaining;
  return Math.floor(remaining / remainingUnits);
}

/**
 * Risolve la prossima data di rinnovo abbonamento a partire da una renewalRule.
 * Supporta oggi solo { type: 'dayOfMonth', day }. { type: 'rrule', rrule } non è
 * ancora implementato (richiederebbe una libreria dedicata, da valutare se serve
 * davvero una ricorrenza più complessa del semplice giorno del mese).
 */
function resolveRenewalDate(renewalRule, referenceDate = new Date()) {
  if (renewalRule?.type === 'dayOfMonth') {
    const day = renewalRule.day;
    let candidate = setDate(startOfDay(new Date(referenceDate)), day);
    if (!isBefore(referenceDate, candidate)) {
      candidate = setDate(addMonths(candidate, 1), day);
    }
    return candidate;
  }
  throw new Error(`resolveRenewalDate: renewalRule.type "${renewalRule?.type}" non supportato`);
}

module.exports = {
  workingUnitsBetween,
  normalizedUtilization,
  pickCriticalWindow,
  efficiencyIndex,
  projectedUsage,
  daysUntilReset,
  workingDaysUntilReset,
  estimatedAutonomyWorkingDays,
  remainingBudgetPerWorkingDay,
  resolveRenewalDate,
};
