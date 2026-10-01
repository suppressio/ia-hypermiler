// budget.ts — logica di calcolo budget/efficienza/previsionale (vedi ARCHITECTURE.md §0 e §3)
//
// Modello: ogni account (Claude/Copilot) espone una o più QuotaWindow:
//   { id, label, periodType, periodLength, unit: 'percentage'|'count', used, total, resetsAt }
// - unit 'percentage': used è già 0-100 (caso Claude: nessun totale in token noto).
// - unit 'count': used/total sono valori assoluti (caso Copilot: premium requests/crediti).
//
// Tutte le funzioni sono pure (nessun I/O), testabili da terminale/test runner.

import { addDays, differenceInCalendarDays, isBefore, startOfDay, setDate, addMonths } from 'date-fns';
import type {
  QuotaWindow,
  WorkSchedule,
  RenewalRule,
  DailyUsagePoint,
  EfficiencyRating,
  DailyDelta,
  DeltaStats,
  WindowVerdict,
  LocalDailyTokens,
  TokenYield,
  DailyTip,
  ConsumptionCause,
} from './types/index';

const DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;

/**
 * Unità lavorativa di un singolo giorno di calendario: 1 (full), 0.5 (half), 0 (off).
 * Se `workSchedule.enabled` è esplicitamente `false` (calendario disattivato, es.
 * account personale senza giorni/ore da rispettare), ogni giorno vale 1 a
 * prescindere da `days` — il pacing torna a considerare i giorni di calendario
 * uniformemente. `undefined` (installazioni precedenti a questo campo, vedi
 * l'avviso sul merge shallow di electron-store in store/index.ts) è trattato come
 * "attivo", preservando il comportamento già in uso.
 */
export function getDayUnit(date: Date, workSchedule: WorkSchedule): number {
  if (!workSchedule.enabled) return 1;
  const key = DAY_KEYS[date.getDay()];
  if (!key) return 0;
  const status = workSchedule.days[key];
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
  if (typeof win.total === 'number' && win.total > 0) {
    return (win.used / win.total) * 100;
  }
  return null;
}

/** Sceglie la finestra di quota più critica (utilizzo normalizzato più alto). */
export function pickCriticalWindow(quotaWindows: QuotaWindow[]): QuotaWindow | null {
  const [first] = quotaWindows;
  if (!first) return null;
  const [top] = quotaWindows
    .map((w) => ({ window: w, utilization: normalizedUtilization(w) }))
    .filter((x): x is { window: QuotaWindow; utilization: number } => x.utilization !== null)
    .sort((a, b) => b.utilization - a.utilization);
  return top ? top.window : first;
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
 * più recente disponibili entro `lookbackMinutes` (default 3h). Non è un valore
 * realmente istantaneo (il refresh è ogni 30 min, vedi CLAUDE.md), ma il ritmo
 * osservato nella finestra recente. Ritorna null se i campioni sono
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
  const latest = relevant.at(-1);
  if (!oldest || !latest) return null;
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

const EFFICIENCY_RATING_MAX_RATIO = 3;

/**
 * Rating efficienza a stelle (1-5) sugli ultimi `days` giorni: media del rapporto
 * tra quota ideale del giorno e consumo osservato quel giorno (>1 = si è
 * consumato meno dell'ideale). A differenza di `efficiencyIndex` (istantanea
 * cumulativa dall'inizio del periodo), qui si guarda giorno per giorno su una
 * finestra mobile — quanto costantemente si è rimasti vicini al ritmo ideale
 * nell'ultima settimana, non solo il totale ad oggi. Un giorno non lavorativo è
 * escluso (nessuna quota ideale da rispettare); un delta negativo (reset della
 * finestra nel mezzo) è escluso allo stesso modo di instantaneousRate, non
 * attribuibile all'uso di quel giorno. Ogni rapporto è limitato a
 * EFFICIENCY_RATING_MAX_RATIO per evitare che un singolo giorno a consumo zero
 * domini la media. Ritorna null se non ci sono abbastanza dati validi.
 */
export function efficiencyRating(
  dailyHistory: DailyUsagePoint[],
  workSchedule: WorkSchedule,
  totalPeriodWorkingUnits: number,
  days = 7,
): EfficiencyRating | null {
  if (!Array.isArray(dailyHistory) || dailyHistory.length < 2 || totalPeriodWorkingUnits <= 0) return null;

  const sorted = [...dailyHistory].sort((a, b) => a.date.localeCompare(b.date)).slice(-(days + 1));
  const ratios: number[] = [];

  for (const { delta, idealShare } of dailyDeltas(sorted, workSchedule, totalPeriodWorkingUnits)) {
    if (idealShare === null || idealShare <= 0 || delta === null) continue;
    const ratio = delta === 0 ? EFFICIENCY_RATING_MAX_RATIO : Math.min(EFFICIENCY_RATING_MAX_RATIO, idealShare / delta);
    ratios.push(ratio);
  }

  if (ratios.length === 0) return null;
  const avgRatio = ratios.reduce((s, r) => s + r, 0) / ratios.length;
  const stars = avgRatio >= 1.5 ? 5 : avgRatio >= 1.1 ? 4 : avgRatio >= 0.9 ? 3 : avgRatio >= 0.6 ? 2 : 1;
  return { stars, avgRatio: Math.round(avgRatio * 100) / 100 };
}

/**
 * Consumo di ogni giorno (differenza con il punto precedente dello storico, in
 * punti percentuali di quota) affiancato alla quota ideale di quel giorno —
 * EVOLUTION.md punto 1: il grafico del widget mostra questo, non più la %
 * cumulata per giorno che ricalcava la dashboard del provider.
 * - `delta` null: la finestra si è resettata in mezzo (delta negativo), il valore
 *   non è attribuibile all'uso di quel giorno (stessa regola di instantaneousRate);
 * - `idealShare` null: pacing non disponibile (periodo di durata ignota,
 *   totalPeriodWorkingUnits <= 0); 0 in un giorno non lavorativo.
 * Il primo punto dello storico non ha un precedente e non produce un delta.
 */
export function dailyDeltas(
  dailyHistory: DailyUsagePoint[],
  workSchedule: WorkSchedule,
  totalPeriodWorkingUnits: number,
): DailyDelta[] {
  if (!Array.isArray(dailyHistory)) return [];
  const sorted = [...dailyHistory].sort((a, b) => a.date.localeCompare(b.date));
  const result: DailyDelta[] = [];
  let prev: DailyUsagePoint | undefined;
  for (const curr of sorted) {
    if (prev) {
      const rawDelta = curr.used - prev.used;
      const idealShare = totalPeriodWorkingUnits > 0
        ? round2(getDayUnit(new Date(curr.date), workSchedule) * (100 / totalPeriodWorkingUnits))
        : null;
      result.push({ date: curr.date, delta: rawDelta < 0 ? null : round2(rawDelta), idealShare });
    }
    prev = curr;
  }
  return result;
}

/**
 * Picco/media del consumo giornaliero e streak di giorni consecutivi (dal più
 * recente) entro la quota ideale — calcolati sui delta di `dailyDeltas`, non sul
 * valore cumulato: sul cumulato il "picco" coincideva sempre con l'ultimo giorno
 * e lo streak non aveva significato. I giorni con reset (delta null) sono
 * ignorati; lo streak è null senza pacing (nessuna quota ideale con cui confrontare).
 */
export function deltaStats(deltas: DailyDelta[]): DeltaStats {
  const valid = deltas.filter((d): d is DailyDelta & { delta: number } => d.delta !== null);
  if (valid.length === 0) return { peak: null, avg: null, streakUnderBudget: null };
  const values = valid.map((d) => d.delta);
  const peak = round2(Math.max(...values));
  const avg = round2(values.reduce((sum, v) => sum + v, 0) / values.length);

  let streakUnderBudget: number | null = null;
  if (valid.some((d) => d.idealShare !== null)) {
    streakUnderBudget = 0;
    for (const { delta, idealShare } of [...valid].reverse()) {
      if (idealShare !== null && delta <= idealShare) streakUnderBudget += 1;
      else break;
    }
  }
  return { peak, avg, streakUnderBudget };
}

export interface WindowVerdictContext {
  window: QuotaWindow;
  projectedUsage: number | null;
  workingDaysUntilReset: number | null;
  estimatedAutonomyWorkingDays: number | null;
}

/**
 * Verdetto sintetico di una finestra di quota per la lista finestre del widget
 * (EVOLUTION.md punto 1: al posto delle tab che affiancavano solo le metriche del
 * provider). In ordine di gravità: esaurita → a rischio (autonomia più corta del
 * tempo al reset, o proiezione oltre il 100%) → in linea → pacing non disponibile.
 * Il testo è composto dal renderer (formattazione della data di reset lato UI).
 */
export function windowVerdict(ctx: WindowVerdictContext): WindowVerdict {
  const utilization = normalizedUtilization(ctx.window);
  if (utilization !== null && utilization >= 100) return { kind: 'exhausted' };
  if (
    ctx.estimatedAutonomyWorkingDays !== null &&
    ctx.workingDaysUntilReset !== null &&
    ctx.estimatedAutonomyWorkingDays < ctx.workingDaysUntilReset
  ) {
    return { kind: 'at-risk', autonomyWorkingDays: round1(ctx.estimatedAutonomyWorkingDays) };
  }
  if (ctx.projectedUsage !== null && ctx.projectedUsage > 100) {
    return { kind: 'at-risk', projectedUsage: round1(ctx.projectedUsage) };
  }
  if (ctx.projectedUsage !== null) return { kind: 'on-track' };
  return { kind: 'no-pacing' };
}

// ---------------------------------------------------------------------------
// Valore per token (EVOLUTION.md punto 4): incrocio tra i token prodotti nelle
// sessioni Claude Code locali (services/claudeLocalSessions.ts, per giorno) e il
// consumo di quota dello stesso giorno (dailyDeltas). Si confrontano solo i giorni
// presenti in entrambe le fonti: un giorno con quota consumata ma nessuna sessione
// locale (es. uso di claude.ai dal browser) non sarebbe attribuibile.
// ---------------------------------------------------------------------------

const TOKEN_YIELD_MIN_DAYS = 3;
const TOKEN_YIELD_MIN_TOTAL_DELTA = 1; // punti % di quota: sotto, il rapporto è rumore
const CAUSE_MIN_DAYS = 5;
const CAUSE_MIN_RATIO = 1.5;
const CAUSE_MIN_GAP_POINTS = 20;

interface PairedDay { date: string; delta: number; outputTokens: number; highContextOutputTokens: number }

function pairDays(localDaily: LocalDailyTokens[], deltas: DailyDelta[]): PairedDay[] {
  const local = new Map(localDaily.map((d) => [d.date, d]));
  const paired: PairedDay[] = [];
  for (const d of deltas) {
    const l = local.get(d.date);
    if (d.delta === null || d.delta <= 0 || !l || l.outputTokens <= 0) continue;
    paired.push({ date: d.date, delta: d.delta, outputTokens: l.outputTokens, highContextOutputTokens: l.highContextOutputTokens });
  }
  return paired.sort((a, b) => a.date.localeCompare(b.date));
}

function medianOf(values: number[]): number | null {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const upper = sorted[mid];
  if (upper === undefined) return null;
  if (sorted.length % 2) return upper;
  const lower = sorted[mid - 1];
  return lower === undefined ? upper : (lower + upper) / 2;
}

function yieldOf(days: PairedDay[]): number | null {
  const totalDelta = days.reduce((s, d) => s + d.delta, 0);
  if (totalDelta <= 0) return null;
  return days.reduce((s, d) => s + d.outputTokens, 0) / totalDelta;
}

/**
 * "Resa": token di output prodotti per ogni punto percentuale di quota consumato,
 * sui giorni presenti in entrambe le fonti. È una misura di valore, non di ritmo:
 * a parità di lavoro prodotto, una resa più bassa significa che ogni token è
 * costato più quota (tipicamente contesto molto ampio riletto ad ogni turno).
 * Trend: resa della seconda metà dei giorni confrontati rispetto alla prima.
 * null con meno di TOKEN_YIELD_MIN_DAYS giorni o consumo totale troppo basso.
 */
export function tokenYield(localDaily: LocalDailyTokens[], deltas: DailyDelta[]): TokenYield | null {
  const paired = pairDays(localDaily, deltas);
  if (paired.length < TOKEN_YIELD_MIN_DAYS) return null;
  if (paired.reduce((s, d) => s + d.delta, 0) < TOKEN_YIELD_MIN_TOTAL_DELTA) return null;
  const overall = yieldOf(paired);
  if (overall === null) return null;

  const half = Math.floor(paired.length / 2);
  const first = yieldOf(paired.slice(0, half));
  const second = yieldOf(paired.slice(paired.length - half));
  const trendPercent = first !== null && second !== null && first > 0 ? round1((second / first - 1) * 100) : null;

  return { tokensPerPercent: Math.round(overall), trendPercent, daysCompared: paired.length };
}

/**
 * Legame tra consumo di quota e contesto ampio, dichiarato SOLO se netto:
 * almeno CAUSE_MIN_DAYS giorni confrontati, e nei giorni sopra la mediana di
 * consumo la quota di token prodotti a contesto >150k è almeno CAUSE_MIN_RATIO
 * volte (e CAUSE_MIN_GAP_POINTS punti sopra) quella dei giorni sotto la mediana.
 * Altrimenti null: meglio nessuna frase che una correlazione debole presentata
 * come causa (EVOLUTION.md, "un cattivo insight mina la fiducia più di nessun insight").
 */
export function consumptionCause(localDaily: LocalDailyTokens[], deltas: DailyDelta[]): ConsumptionCause | null {
  const paired = pairDays(localDaily, deltas);
  if (paired.length < CAUSE_MIN_DAYS) return null;

  const median = medianOf(paired.map((d) => d.delta));
  if (median === null) return null;
  const high = paired.filter((d) => d.delta > median);
  const low = paired.filter((d) => d.delta <= median);
  if (high.length === 0 || low.length === 0) return null;

  const share = (days: PairedDay[]) => {
    const out = days.reduce((s, d) => s + d.outputTokens, 0);
    return out > 0 ? (days.reduce((s, d) => s + d.highContextOutputTokens, 0) / out) * 100 : 0;
  };
  const highShare = share(high);
  const lowShare = share(low);
  if (highShare < lowShare * CAUSE_MIN_RATIO || highShare - lowShare < CAUSE_MIN_GAP_POINTS) return null;

  return { highDaysHighContextPercent: Math.round(highShare), lowDaysHighContextPercent: Math.round(lowShare), daysCompared: paired.length };
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

export interface DailyTipContext {
  window: QuotaWindow;
  efficiencyIndex: number | null;
  projectedUsage: number | null;
  daysUntilReset: number | null;
  workingDaysUntilReset: number | null;
  estimatedAutonomyWorkingDays: number | null;
  instantRate: number | null;
  sustainableRate: number | null;
  efficiencyRating: EfficiencyRating | null;
  // Solo per l'account Claude con insight locali attivi — vedi consumptionCause.
  consumptionCause?: ConsumptionCause | null;
}

export const NO_TIP: DailyTip = { key: 'none', params: {} };

/**
 * Daily tip as DATA, not a sentence: a message key plus the real numbers it
 * states. The renderer turns it into text in the active language
 * (renderer/i18n, keys `tips.<key>`), so the tip follows a language switch
 * without a refresh. Every candidate below has an explicit condition on values
 * already computed in this file — never a generic tip picked at random. When
 * several hold, one is chosen among the applicable ones (variety without ever
 * stating something false); when none holds, `none` says so honestly.
 */
export function generateDailyTip(ctx: DailyTipContext, random: () => number = Math.random): DailyTip {
  const {
    window,
    projectedUsage,
    daysUntilReset,
    workingDaysUntilReset,
    estimatedAutonomyWorkingDays,
    instantRate,
    sustainableRate,
    efficiencyRating,
    consumptionCause: cause,
  } = ctx;
  const utilization = normalizedUtilization(window);
  const candidates: DailyTip[] = [];

  // 1. Estimated autonomy at the current pace is shorter than the time left to
  // the reset: a concrete risk of running out first. Includes the slowdown
  // needed to make it (ratio between the two durations).
  if (
    estimatedAutonomyWorkingDays !== null && Number.isFinite(estimatedAutonomyWorkingDays) &&
    workingDaysUntilReset !== null && workingDaysUntilReset > 0 &&
    estimatedAutonomyWorkingDays < workingDaysUntilReset
  ) {
    candidates.push({
      key: 'autonomy',
      params: {
        autonomyDays: round1(estimatedAutonomyWorkingDays),
        daysToReset: round1(workingDaysUntilReset),
        reductionPercent: Math.round((1 - estimatedAutonomyWorkingDays / workingDaysUntilReset) * 100),
      },
    });
  }

  // 2. The pace of the last hours is above the sustainable one to reach the
  // reset exactly at 100% — see instantaneousRate/sustainableHourlyRate.
  if (instantRate !== null && sustainableRate !== null && instantRate > sustainableRate) {
    candidates.push({
      key: 'instantRate',
      params: { instantRate: round2(instantRate), sustainableRate: round2(sustainableRate) },
    });
  }

  // 3. High rating over the last days: real room for heavier use today.
  if (efficiencyRating !== null && efficiencyRating.stars >= 4) {
    candidates.push({
      key: 'rating',
      params: { stars: efficiencyRating.stars, avgRatio: round2(efficiencyRating.avgRatio) },
    });
  }

  // 4. Few days to the reset and usage already high: better to ration what is left.
  if (daysUntilReset !== null && daysUntilReset <= 2 && utilization !== null && utilization >= 70) {
    candidates.push({
      key: daysUntilReset === 0 ? 'nearResetToday' : 'nearReset',
      params: { days: daysUntilReset, utilization: round1(utilization) },
    });
  }

  // 5. The linear projection to the end of the period exceeds 100%, even though
  // it has not been reached yet — earlier signal than case 1 (which needs autonomy).
  if (projectedUsage !== null && projectedUsage >= 100 && utilization !== null && utilization < 100) {
    candidates.push({ key: 'projected', params: { projectedUsage: round1(projectedUsage) } });
  }

  // 6. Strong link between high-consumption days and large context (local
  // Claude Code sessions) — see consumptionCause: present only when the signal is clear.
  if (cause) {
    candidates.push({
      key: 'cause',
      params: {
        highPercent: cause.highDaysHighContextPercent,
        lowPercent: cause.lowDaysHighContextPercent,
        days: cause.daysCompared,
      },
    });
  }

  // Index capped to the last candidate: an injected random returning 1
  // (Math.random() never does, tests may) would otherwise yield undefined.
  const index = Math.min(candidates.length - 1, Math.floor(random() * candidates.length));
  return candidates[index] ?? NO_TIP;
}

/**
 * Risolve la prossima data di rinnovo abbonamento a partire da una renewalRule.
 * Supporta oggi solo { type: 'dayOfMonth', day }. { type: 'rrule', rrule } non è
 * ancora implementato (richiederebbe una libreria dedicata, da valutare se serve
 * davvero una ricorrenza più complessa del semplice giorno del mese).
 */
export function resolveRenewalDate(renewalRule: RenewalRule, referenceDate: Date = new Date()): Date {
  if (renewalRule.type === 'dayOfMonth' && typeof renewalRule.day === 'number') {
    const day = renewalRule.day;
    let candidate = setDate(startOfDay(new Date(referenceDate)), day);
    if (!isBefore(referenceDate, candidate)) {
      candidate = setDate(addMonths(candidate, 1), day);
    }
    return candidate;
  }
  throw new Error(`resolveRenewalDate: renewalRule.type "${renewalRule.type}" non supportato`);
}
