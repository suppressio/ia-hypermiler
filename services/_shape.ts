// services/_shape.ts — reduces a payload to its structure only (field names and
// types), NEVER the real value. Used when a service receives a response in an
// unrecognized format: it helps understand what changed without exposing potentially
// sensitive data (usage percentages, amounts, renewal dates — see the real case in the
// CLAUDE.md progress log that exposed used_dollars/limit_dollars of a real account)
// in a public report.

/**
 * Recursively replaces every leaf value with its `typeof` (or `'null'`), keeping
 * only the key names (sorted, for a stable signature) and the shape of arrays (a
 * single representative element, so long arrays need no truncation).
 * Never returns real numbers, strings or dates.
 */
export function extractShape(value: unknown, depth = 0): unknown {
  if (depth > 4) return 'truncated';
  if (value === null) return 'null';
  if (Array.isArray(value)) {
    return value.length > 0 ? [extractShape(value[0], depth + 1)] : [];
  }
  if (typeof value === 'object') {
    const shape: Record<string, unknown> = {};
    const record = value as Record<string, unknown>;
    for (const key of Object.keys(record).sort()) {
      shape[key] = extractShape(record[key], depth + 1);
    }
    return shape;
  }
  return typeof value;
}

/**
 * Deterministic signature (not cryptographic, no need) of an already extracted
 * shape — used to deduplicate reports: when the same shape comes back on the next
 * refresh, a second issue draft is not opened (see main.ts).
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
 * Error thrown by services when an endpoint response does not match the expected
 * format. It carries only `shape` (never the original payload): whoever catches this
 * error (main.ts) never has access to the real values.
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
