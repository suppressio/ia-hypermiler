// diagnostics/githubIssue.ts — costruisce l'URL di una issue GitHub precompilata
// quando un service rileva che il formato di un endpoint è cambiato (vedi
// services/_shape.ts, main.ts). Funzione pura, nessuna dipendenza da Electron:
// l'apertura vera e propria del browser (shell.openExternal) resta in main.ts.
//
// Deliberatamente NON automatizza la creazione della issue via API GitHub: apre
// solo una bozza precompilata che l'utente deve rivedere e confermare — scelta
// esplicita per non pubblicare mai dati reali senza un click umano di conferma
// (vedi CLAUDE.md).

import type { AccountId } from '../types/index';

const REPO_OWNER = 'suppressio';
const REPO_NAME = 'ia-hypermiler';

export interface FormatDriftIssueParams {
  accountId: AccountId;
  endpointLabel: string;
  shape: unknown;
}

export function buildFormatDriftIssueUrl({ accountId, endpointLabel, shape }: FormatDriftIssueParams): string {
  const serviceName = accountId === 'claude' ? 'Claude' : 'Copilot';
  const title = `Formato risposta cambiato: ${serviceName} (${endpointLabel})`;

  const body = [
    `Rilevato automaticamente da IA Hypermiler il ${new Date().toISOString()}.`,
    '',
    `Servizio: **${serviceName}**`,
    `Endpoint: \`${endpointLabel}\``,
    '',
    'Struttura della risposta ricevuta — solo nomi di campo e tipo, **mai valori reali** ' +
      '(percentuali di utilizzo, importi, date di rinnovo non vengono mai inclusi qui, vedi CLAUDE.md):',
    '',
    '```json',
    JSON.stringify(shape, null, 2),
    '```',
    '',
    `Formato precedentemente atteso: vedi \`RESEARCH.md\` e \`services/${accountId}.ts\`.`,
    '',
    '_Bozza generata automaticamente — rivedi il contenuto prima di inviare._',
  ].join('\n');

  const url = new URL(`https://github.com/${REPO_OWNER}/${REPO_NAME}/issues/new`);
  url.searchParams.set('title', title);
  url.searchParams.set('body', body);
  url.searchParams.set('labels', 'api-drift,auto-generated');
  return url.toString();
}
