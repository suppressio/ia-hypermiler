// services/claudeLocalSessions.ts — insight comportamentali da sessioni Claude Code
// LOCALI (CLI + estensione VS Code, stessa sorgente — vedi RESEARCH.md §5). Non è
// un dato dell'account claude.ai: legge le trascrizioni di sessione su questa
// macchina tramite l'SDK ufficiale (@anthropic-ai/claude-agent-sdk) invece di fare
// parsing diretto del formato JSONL interno — non documentato e che cambia tra
// versioni (vedi RESEARCH.md §5.1).
//
// Disciplina sui contenuti: legge SOLO campi strutturali/numerici (usage a livello
// di turno, nomi di tool/server MCP) — MAI il testo dei messaggi (blocchi content
// di tipo "text"), stessa regola già applicata in services/_shape.ts per la
// diagnostica format-drift.

// @anthropic-ai/claude-agent-sdk è distribuito solo come ESM puro (nessuna
// condizione "require" in package.json/exports, solo "default": "./sdk.mjs") —
// un `import` statico verrebbe compilato da tsc in un `require()` (tsconfig.json
// usa CommonJS) che nel Node bundlato da Electron 31 fallisce con ERR_REQUIRE_ESM
// (verificato lanciando `npm start`: il Node di sistema tollera require() di ESM
// via interop, quello dentro Electron no). Fix: import() dinamico, che tsc lascia
// nativo anche in emit CommonJS — unico modo di caricare ESM da qui.
import type { ListSessionsOptions, GetSessionMessagesOptions, SDKSessionInfo, SessionMessage } from '@anthropic-ai/claude-agent-sdk';
import type { ClaudeLocalInsights, ToolUsageShare } from '../types/index';

const HIGH_CONTEXT_THRESHOLD = 150_000; // token di contesto stimato, stessa soglia del pannello VS Code che ha ispirato questa funzionalità
const LONG_SESSION_HOURS = 8;
const MAX_SESSIONS_SCANNED = 300; // margine di sicurezza: listSessions() ritorna già dal più recente
const TOP_TOOLS_LIMIT = 5;

type PlainRecord = Record<string, unknown>;

function isPlainRecord(value: unknown): value is PlainRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readNumber(record: PlainRecord, key: string): number {
  const value = record[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/** Contesto stimato del turno: token letti dalla cache + creati in cache + input diretto. */
function turnContextTokens(usage: PlainRecord): number {
  return readNumber(usage, 'cache_read_input_tokens') + readNumber(usage, 'cache_creation_input_tokens') + readNumber(usage, 'input_tokens');
}

// Iniettabili nei test (services/claudeLocalSessions.test.ts) per evitare accesso
// reale al filesystem/SDK — stesso principio del mock di `fetch` già usato in
// services/claude.test.ts e services/copilot.test.ts.
export interface LocalSessionsDeps {
  listSessions: (options?: ListSessionsOptions) => Promise<SDKSessionInfo[]>;
  getSessionMessages: (sessionId: string, options?: GetSessionMessagesOptions) => Promise<SessionMessage[]>;
}

// tsc, con tsconfig.json a "module": "CommonJS", trasforma ANCHE un `import()`
// dinamico in `Promise.resolve().then(() => require(...))` — stesso ERR_REQUIRE_ESM
// del require() statico (verificato con una build reale). L'unico modo di ottenere
// un import() nativo da un file compilato in CommonJS è nasconderlo dall'analisi
// statica del compilatore passando per un Function costruito a runtime — pattern
// noto per questo esatto scenario (caricare un pacchetto ESM-only da codice CJS),
// non un aggiramento accidentale. Verificato funzionante sia in Node diretto sia
// dentro Electron 31 (lanciando `npm start`).
const dynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<typeof import('@anthropic-ai/claude-agent-sdk')>;

let sdkDepsPromise: Promise<LocalSessionsDeps> | null = null;

function loadSdkDeps(): Promise<LocalSessionsDeps> {
  if (!sdkDepsPromise) {
    sdkDepsPromise = dynamicImport('@anthropic-ai/claude-agent-sdk').then((mod) => ({
      listSessions: mod.listSessions,
      getSessionMessages: mod.getSessionMessages,
    }));
  }
  return sdkDepsPromise;
}

/**
 * Aggrega insight comportamentali sulle sessioni Claude Code locali degli ultimi
 * `windowDays` giorni. Le quote sono pesate per volume di output_tokens (l'uso che
 * consuma davvero credito), non per conteggio di turni. Ritorna null se non ci sono
 * sessioni nella finestra — non un errore, solo niente da mostrare.
 */
export async function computeClaudeLocalInsights(
  windowDays: number,
  deps?: LocalSessionsDeps,
): Promise<ClaudeLocalInsights | null> {
  const resolvedDeps = deps ?? (await loadSdkDeps());
  let sessions: SDKSessionInfo[];
  try {
    sessions = await resolvedDeps.listSessions({ limit: MAX_SESSIONS_SCANNED });
  } catch (err) {
    console.error('[services/claudeLocalSessions] listSessions fallita:', (err as Error).message);
    return null;
  }

  const cutoff = Date.now() - windowDays * 24 * 3600 * 1000;
  const inWindow = sessions.filter((s) => s.lastModified >= cutoff);
  if (inWindow.length === 0) return null;

  let totalOutputTokens = 0;
  let highContextOutputTokens = 0;
  let longSessionOutputTokens = 0;
  const toolCounts = new Map<string, number>();
  let totalToolCalls = 0;

  for (const session of inWindow) {
    const durationMs = typeof session.createdAt === 'number' ? session.lastModified - session.createdAt : null;
    const isLongSession = durationMs !== null && durationMs >= LONG_SESSION_HOURS * 3600 * 1000;

    let messages: SessionMessage[];
    try {
      messages = await resolvedDeps.getSessionMessages(session.sessionId);
    } catch (err) {
      // Una sessione illeggibile (file corrotto, formato interno cambiato) non deve
      // interrompere l'aggregazione delle altre — stessa filosofia di resilienza
      // già applicata al resto dell'app (mai un crash per un singolo dato mancante).
      console.error(`[services/claudeLocalSessions] sessione ${session.sessionId} illeggibile, saltata:`, (err as Error).message);
      continue;
    }

    for (const entry of messages) {
      if (entry.type !== 'assistant' || !isPlainRecord(entry.message)) continue;
      const usage = entry.message.usage;
      if (!isPlainRecord(usage)) continue;

      const outputTokens = readNumber(usage, 'output_tokens');
      if (outputTokens <= 0) continue;

      totalOutputTokens += outputTokens;
      if (turnContextTokens(usage) > HIGH_CONTEXT_THRESHOLD) highContextOutputTokens += outputTokens;
      if (isLongSession) longSessionOutputTokens += outputTokens;

      // Solo il nome del tool/server MCP invocato — mai i parametri della chiamata
      // né altri blocchi content (es. type "text", il testo reale dei messaggi).
      const content = entry.message.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (isPlainRecord(block) && block.type === 'tool_use' && typeof block.name === 'string') {
            toolCounts.set(block.name, (toolCounts.get(block.name) ?? 0) + 1);
            totalToolCalls += 1;
          }
        }
      }
    }
  }

  if (totalOutputTokens === 0) return null;

  const topTools: ToolUsageShare[] = [...toolCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, TOP_TOOLS_LIMIT)
    .map(([name, count]) => ({ name, sharePercent: Math.round((count / totalToolCalls) * 1000) / 10 }));

  return {
    computedAt: new Date().toISOString(),
    windowDays,
    sessionsAnalyzed: inWindow.length,
    highContextSharePercent: Math.round((highContextOutputTokens / totalOutputTokens) * 1000) / 10,
    longSessionSharePercent: Math.round((longSessionOutputTokens / totalOutputTokens) * 1000) / 10,
    topTools,
  };
}
