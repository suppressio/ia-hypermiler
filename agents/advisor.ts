// agents/advisor.ts — Claude agent for usage advice
// Dormant: not wired anywhere. See #29, which will use plain HTTP calls through the
//   accounts the user already connected (no Anthropic SDK, removed in #35).
// TODO (#29): advice request with context
//   (consumption of the last 7 days, current daily budget, services used).
// Constraints from AGENTS.md: model "claude-sonnet-4-6", max_tokens 1000,
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
