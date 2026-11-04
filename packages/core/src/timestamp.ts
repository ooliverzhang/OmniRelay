/**
 * Converts platform timestamps to ISO-8601.
 *
 * Numeric values below 1e12 are treated as epoch seconds (QQ official bot),
 * larger ones as epoch milliseconds (Discord snowflake timestamps).
 */
export function toIsoTimestamp(value: string | number | Date): string {
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      return new Date().toISOString();
    }
    const millis = value < 1_000_000_000_000 ? value * 1000 : value;
    return new Date(millis).toISOString();
  }
  const parsed = new Date(value);
  if (!Number.isNaN(parsed.getTime())) {
    return parsed.toISOString();
  }
  const numeric = value.trim().length > 0 ? Number(value) : Number.NaN;
  if (Number.isFinite(numeric)) {
    const millis = numeric < 1_000_000_000_000 ? numeric * 1000 : numeric;
    return new Date(millis).toISOString();
  }
  throw new Error(`Invalid timestamp: ${value}`);
}
