// store/merge.ts — deep merge "value on disk over defaults", shared by normalize.ts
// (whole store) and migrate.ts (single account). Rules in normalize.ts.

type PlainRecord = Record<string, unknown>;

export function isPlainRecord(value: unknown): value is PlainRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function mergeWithDefaults(defaults: unknown, raw: unknown): unknown {
  if (Array.isArray(defaults)) return Array.isArray(raw) ? raw : defaults;
  if (isPlainRecord(defaults)) {
    if (!isPlainRecord(raw)) return defaults;
    const out: PlainRecord = { ...raw };
    for (const [key, defaultValue] of Object.entries(defaults)) {
      out[key] = mergeWithDefaults(defaultValue, raw[key]);
    }
    return out;
  }
  if (defaults === null) return raw === undefined ? null : raw;
  return typeof raw === typeof defaults ? raw : defaults;
}
