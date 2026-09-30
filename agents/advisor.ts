// agents/advisor.ts — agente Claude per i consigli d'uso
// TODO (Giorno 2, Sessione 2): chiamata Anthropic SDK con contesto
//   (consumo ultimi 7 giorni, budget giornaliero corrente, servizi usati).
// Vincoli da CLAUDE.md: model "claude-sonnet-4-6", max_tokens 1000,
//   cache su electron-store, rigenerazione max una volta ogni 24 ore,
//   system prompt che richiede consigli specifici e pratici (non generici).

import type { AccountSnapshot, WorkSchedule } from '../types/index';

export interface AdvisorContext {
  account: AccountSnapshot;
  workSchedule: WorkSchedule;
}

export function getAdvice(_context: AdvisorContext): Promise<string> {
  return Promise.reject(new Error('getAdvice non ancora implementato — vedi Giorno 2, Sessione 2'));
}
