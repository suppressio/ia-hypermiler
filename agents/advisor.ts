// agents/advisor.ts — Claude agent for usage advice
// TODO (Day 2, Session 2): Anthropic SDK call with context
//   (consumption of the last 7 days, current daily budget, services used).
// Constraints from CLAUDE.md: model "claude-sonnet-4-6", max_tokens 1000,
//   cached in electron-store, regenerated at most once every 24 hours,
//   system prompt asking for specific, practical advice (not generic).

import type { AccountSnapshot, WorkSchedule } from '../types/index';

export interface AdvisorContext {
  account: AccountSnapshot;
  workSchedule: WorkSchedule;
}

export function getAdvice(_context: AdvisorContext): Promise<string> {
  return Promise.reject(new Error('getAdvice not implemented yet — see Day 2, Session 2'));
}
