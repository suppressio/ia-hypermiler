// services/claudeLocalSessions.test.ts — test unitari per l'aggregazione insight
// locali. Nessun accesso reale al filesystem/SDK: listSessions/getSessionMessages
// vengono iniettati come dipendenze fasulle (stesso principio del mock di `fetch`
// già usato in services/claude.test.ts/services/copilot.test.ts).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeClaudeLocalInsights } from './claudeLocalSessions';
import type { LocalSessionsDeps } from './claudeLocalSessions';
import type { SDKSessionInfo, SessionMessage } from '@anthropic-ai/claude-agent-sdk';

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;

function session(overrides: Partial<SDKSessionInfo> = {}): SDKSessionInfo {
  return {
    sessionId: 's1',
    summary: 'test',
    lastModified: Date.now(),
    createdAt: Date.now() - HOUR,
    ...overrides,
  };
}

function assistantMessage(usage: Record<string, unknown>, toolNames: string[] = []): SessionMessage {
  const content = toolNames.map((name) => ({ type: 'tool_use', name }));
  return {
    type: 'assistant',
    uuid: 'u1',
    session_id: 's1',
    parent_tool_use_id: null,
    parent_agent_id: null,
    message: { usage, content },
  } as SessionMessage;
}

function makeDeps(sessions: SDKSessionInfo[], messagesBySession: Record<string, SessionMessage[]>): LocalSessionsDeps {
  return {
    listSessions: (async () => sessions) as LocalSessionsDeps['listSessions'],
    getSessionMessages: (async (sessionId: string) => messagesBySession[sessionId] ?? []) as LocalSessionsDeps['getSessionMessages'],
  };
}

test('computeClaudeLocalInsights ritorna null se nessuna sessione è nella finestra', async () => {
  const deps = makeDeps([session({ lastModified: Date.now() - 10 * DAY })], {});
  const result = await computeClaudeLocalInsights(7, deps);
  assert.equal(result, null);
});

test('computeClaudeLocalInsights esclude le sessioni fuori dalla finestra', async () => {
  const inWindow = session({ sessionId: 'in', lastModified: Date.now() - DAY, createdAt: Date.now() - DAY - HOUR });
  const outOfWindow = session({ sessionId: 'out', lastModified: Date.now() - 30 * DAY });
  const deps = makeDeps([inWindow, outOfWindow], {
    in: [assistantMessage({ output_tokens: 100, input_tokens: 10 })],
    out: [assistantMessage({ output_tokens: 9999, input_tokens: 10 })],
  });
  const result = await computeClaudeLocalInsights(7, deps);
  assert.equal(result?.sessionsAnalyzed, 1);
});

test('computeClaudeLocalInsights calcola highContextSharePercent pesato sui token', async () => {
  const s = session({ sessionId: 's1' });
  const deps = makeDeps([s], {
    s1: [
      assistantMessage({ output_tokens: 30, input_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }), // contesto basso
      assistantMessage({ output_tokens: 70, input_tokens: 10, cache_read_input_tokens: 200_000, cache_creation_input_tokens: 0 }), // contesto alto
    ],
  });
  const result = await computeClaudeLocalInsights(7, deps);
  assert.equal(result?.highContextSharePercent, 70); // 70 dei 100 output_tokens totali vengono da turni a contesto alto
});

test('computeClaudeLocalInsights calcola longSessionSharePercent solo per sessioni durate 8h+', async () => {
  const shortSession = session({ sessionId: 'short', createdAt: Date.now() - HOUR, lastModified: Date.now() });
  const longSession = session({ sessionId: 'long', createdAt: Date.now() - 9 * HOUR, lastModified: Date.now() });
  const deps = makeDeps([shortSession, longSession], {
    short: [assistantMessage({ output_tokens: 40, input_tokens: 1 })],
    long: [assistantMessage({ output_tokens: 60, input_tokens: 1 })],
  });
  const result = await computeClaudeLocalInsights(7, deps);
  assert.equal(result?.longSessionSharePercent, 60);
});

test('computeClaudeLocalInsights tronca topTools a 5 e ordina per frequenza', async () => {
  const s = session({ sessionId: 's1' });
  const messages = [
    assistantMessage({ output_tokens: 1, input_tokens: 1 }, ['Bash', 'Bash', 'Read']),
    assistantMessage({ output_tokens: 1, input_tokens: 1 }, ['Bash', 'Edit', 'Write', 'ToolSearch', 'AskUserQuestion', 'EnterPlanMode']),
  ];
  const deps = makeDeps([s], { s1: messages });
  const result = await computeClaudeLocalInsights(7, deps);
  assert.equal(result?.topTools.length, 5);
  assert.equal(result?.topTools[0].name, 'Bash'); // 3 occorrenze, il più frequente
});

test('computeClaudeLocalInsights salta una sessione illeggibile senza interrompere le altre', async () => {
  const broken = session({ sessionId: 'broken' });
  const ok = session({ sessionId: 'ok' });
  const deps: LocalSessionsDeps = {
    listSessions: (async () => [broken, ok]) as LocalSessionsDeps['listSessions'],
    getSessionMessages: (async (sessionId: string) => {
      if (sessionId === 'broken') throw new Error('file corrotto');
      return [assistantMessage({ output_tokens: 50, input_tokens: 1 })];
    }) as LocalSessionsDeps['getSessionMessages'],
  };
  const result = await computeClaudeLocalInsights(7, deps);
  assert.equal(result?.sessionsAnalyzed, 2); // entrambe contate come "nella finestra", solo una contribuisce dati
  assert.equal(result?.highContextSharePercent, 0);
});

test('computeClaudeLocalInsights ritorna null se listSessions fallisce', async () => {
  const deps: LocalSessionsDeps = {
    listSessions: (async () => { throw new Error('errore SDK'); }) as LocalSessionsDeps['listSessions'],
    getSessionMessages: (async () => []) as LocalSessionsDeps['getSessionMessages'],
  };
  const result = await computeClaudeLocalInsights(7, deps);
  assert.equal(result, null);
});
