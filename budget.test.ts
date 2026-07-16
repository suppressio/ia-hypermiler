// budget.test.ts — test unitari per la logica pura di budget.ts (nessuna rete,
// nessun mock necessario: tutte le funzioni sono deterministiche).
// Esegui con: npm test (compila e lancia `node --test dist`).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as budget from './budget';
import type { QuotaWindow, WorkSchedule } from './types/index';

const FULL_WEEK_SCHEDULE: WorkSchedule = {
  days: { mon: 'full', tue: 'full', wed: 'full', thu: 'full', fri: 'full', sat: 'off', sun: 'off' },
  hoursPerDay: 8,
};

function pctWindow(used: number, overrides: Partial<QuotaWindow> = {}): QuotaWindow {
  return {
    id: 'test-window',
    label: 'Test',
    periodType: 'rolling-days',
    periodLength: 7,
    unit: 'percentage',
    used,
    total: null,
    resetsAt: null,
    ...overrides,
  };
}

test('workingUnitsBetween conta solo i giorni lavorativi (lun-ven)', () => {
  // Lunedì 2026-07-13 -> lunedì successivo: esattamente 5 giorni lavorativi.
  const start = new Date(2026, 6, 13);
  const end = new Date(2026, 6, 20);
  assert.equal(budget.workingUnitsBetween(start, end, FULL_WEEK_SCHEDULE), 5);
});

test('workingUnitsBetween ritorna 0 se end precede start', () => {
  const start = new Date(2026, 6, 20);
  const end = new Date(2026, 6, 13);
  assert.equal(budget.workingUnitsBetween(start, end, FULL_WEEK_SCHEDULE), 0);
});

test('normalizedUtilization: percentage ritorna used direttamente', () => {
  assert.equal(budget.normalizedUtilization(pctWindow(42)), 42);
});

test('normalizedUtilization: count con total calcola la percentuale', () => {
  const win = pctWindow(0, { unit: 'count', used: 150, total: 300 });
  assert.equal(budget.normalizedUtilization(win), 50);
});

test('normalizedUtilization: count senza total ritorna null', () => {
  const win = pctWindow(0, { unit: 'count', used: 150, total: null });
  assert.equal(budget.normalizedUtilization(win), null);
});

test('pickCriticalWindow sceglie la finestra con utilizzo più alto', () => {
  const windows = [pctWindow(30, { id: 'a' }), pctWindow(70, { id: 'b' }), pctWindow(0, { id: 'c', unit: 'count', used: 90, total: 100 })];
  const picked = budget.pickCriticalWindow(windows);
  assert.equal(picked?.id, 'c'); // 90% > 70% > 30%
});

test('pickCriticalWindow ritorna null su lista vuota', () => {
  assert.equal(budget.pickCriticalWindow([]), null);
});

test('efficiencyIndex ~1 quando il ritmo reale eguaglia quello ideale', () => {
  // Periodo di 10 giorni lavorativi (2 settimane lun-ven), a metà (5 lavorativi
  // trascorsi) con il 50% di utilizzo: ritmo esattamente in linea.
  const periodStart = new Date(2026, 6, 13); // lunedì
  const periodEnd = new Date(2026, 6, 27); // due lunedì dopo (10 giorni lavorativi)
  const now = new Date(2026, 6, 20); // lunedì intermedio (5 giorni lavorativi trascorsi)
  const result = budget.efficiencyIndex({ window: pctWindow(50), workSchedule: FULL_WEEK_SCHEDULE, periodStart, periodEnd, now });
  assert.equal(result, 1);
});

test('efficiencyIndex < 1 quando si consuma più veloce del sostenibile', () => {
  const periodStart = new Date(2026, 6, 13);
  const periodEnd = new Date(2026, 6, 27);
  const now = new Date(2026, 6, 20);
  const result = budget.efficiencyIndex({ window: pctWindow(90), workSchedule: FULL_WEEK_SCHEDULE, periodStart, periodEnd, now });
  assert.ok(result !== null && result < 1);
});

test('efficiencyIndex ritorna null se il periodo non è ancora iniziato', () => {
  const periodStart = new Date(2026, 6, 20);
  const periodEnd = new Date(2026, 6, 27);
  const now = new Date(2026, 6, 13); // prima dell'inizio periodo
  const result = budget.efficiencyIndex({ window: pctWindow(10), workSchedule: FULL_WEEK_SCHEDULE, periodStart, periodEnd, now });
  assert.equal(result, null);
});

test('projectedUsage estrapola linearmente e satura a 100', () => {
  const periodStart = new Date(2026, 6, 13);
  const periodEnd = new Date(2026, 6, 27);
  const now = new Date(2026, 6, 20);
  const result = budget.projectedUsage({ window: pctWindow(90), workSchedule: FULL_WEEK_SCHEDULE, periodStart, periodEnd, now });
  assert.equal(result, 100); // 90% a metà periodo => proietterebbe oltre 100, va saturato
});

test('daysUntilReset non è mai negativo', () => {
  const past = new Date(2026, 6, 1);
  const now = new Date(2026, 6, 20);
  assert.equal(budget.daysUntilReset(past, now), 0);
});

test('estimatedAutonomyWorkingDays ritorna 0 se già al 100%', () => {
  const periodStart = new Date(2026, 6, 13);
  const now = new Date(2026, 6, 20);
  const result = budget.estimatedAutonomyWorkingDays({ window: pctWindow(100), workSchedule: FULL_WEEK_SCHEDULE, periodStart, now });
  assert.equal(result, 0);
});

test('resolveRenewalDate: dayOfMonth futuro nel mese corrente', () => {
  const ref = new Date(2026, 6, 10); // 10 luglio
  const result = budget.resolveRenewalDate({ type: 'dayOfMonth', day: 20 }, ref);
  assert.equal(result.getFullYear(), 2026);
  assert.equal(result.getMonth(), 6); // luglio (0-based)
  assert.equal(result.getDate(), 20);
});

test('resolveRenewalDate: dayOfMonth già passato slitta al mese successivo', () => {
  const ref = new Date(2026, 6, 25); // 25 luglio
  const result = budget.resolveRenewalDate({ type: 'dayOfMonth', day: 5 }, ref);
  assert.equal(result.getMonth(), 7); // agosto
  assert.equal(result.getDate(), 5);
});

test('resolveRenewalDate: rrule non supportato lancia errore esplicito', () => {
  assert.throws(() => budget.resolveRenewalDate({ type: 'rrule', rrule: 'FREQ=WEEKLY' }), /non supportato/);
});
