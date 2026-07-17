// services/_shape.ts — riduzione di un payload alla sola struttura (nomi di campo
// e tipo), MAI il valore reale. Usato quando un service riceve una risposta con un
// formato non riconosciuto: serve per capire cosa è cambiato senza esporre dati
// potenzialmente sensibili (percentuali di utilizzo, importi, date di rinnovo — vedi
// il caso reale in CLAUDE.md, "Stato avanzamento", che ha esposto used_dollars/
// limit_dollars di un account reale) in una eventuale segnalazione pubblica.

/**
 * Sostituisce ricorsivamente ogni valore foglia con il suo `typeof` (o `'null'`),
 * mantenendo solo i nomi delle chiavi (ordinati, per una firma stabile) e la forma
 * degli array (un solo elemento rappresentativo, per non dover troncare array lunghi).
 * Non ritorna mai numeri, stringhe o date reali.
 */
export function extractShape(value: unknown, depth = 0): unknown {
  if (depth > 4) return 'truncated';
  if (value === null) return 'null';
  if (Array.isArray(value)) {
    return value.length > 0 ? [extractShape(value[0], depth + 1)] : [];
  }
  if (typeof value === 'object') {
    const shape: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      shape[key] = extractShape((value as Record<string, unknown>)[key], depth + 1);
    }
    return shape;
  }
  return typeof value;
}

/**
 * Firma deterministica (non crittografica, non serve) di una shape già estratta —
 * usata per deduplicare le segnalazioni: se la stessa forma si ripresenta al
 * refresh successivo, non riapriamo una seconda bozza di issue (vedi main.ts).
 */
export function shapeSignature(shape: unknown): string {
  const json = JSON.stringify(shape);
  let hash = 0;
  for (let i = 0; i < json.length; i++) {
    hash = (hash * 31 + json.charCodeAt(i)) | 0;
  }
  return `sig_${(hash >>> 0).toString(16)}`;
}

/**
 * Errore lanciato dai service quando la risposta di un endpoint non corrisponde
 * al formato atteso. Porta con sé solo `shape` (mai il payload originale): chi
 * intercetta questo errore (main.ts) non ha mai accesso ai valori reali.
 */
export class FormatDriftError extends Error {
  readonly endpointLabel: string;
  readonly shape: unknown;

  constructor(message: string, endpointLabel: string, shape: unknown) {
    super(message);
    this.name = 'FormatDriftError';
    this.endpointLabel = endpointLabel;
    this.shape = shape;
  }
}
