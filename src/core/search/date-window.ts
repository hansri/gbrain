/**
 * Canonical temporal-window parsing for search.
 *
 * Public search accepts either ISO-8601 boundaries or compact relative
 * durations (`7d`, `2w`, `1y`). Normalize once at the hybrid-search boundary
 * so both engines and the semantic-cache key see the exact same instants.
 */

export class SearchDateWindowError extends Error {
  readonly code = 'INVALID_SEARCH_DATE_WINDOW';

  constructor(message: string) {
    super(message);
    this.name = 'SearchDateWindowError';
  }
}

export interface SearchDateWindowInput {
  since?: string;
  until?: string;
  /** Default true. Set false for deprecated beforeDate midnight semantics. */
  untilDateOnlyEndOfDay?: boolean;
}

export interface NormalizedSearchDateWindow {
  since?: string;
  until?: string;
}

const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;
const RELATIVE_RE = /^(\d+)(d|w|y)$/i;
const EXPLICIT_ZONE_RE = /(Z|[+-]\d{2}:?\d{2})$/i;
const ISO_TIMESTAMP_RE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?)(?:\.(\d{1,9}))?(Z|[+-]\d{2}:?\d{2})$/i;

export function isRelativeSearchDateBoundary(value: string | undefined): boolean {
  return value !== undefined && RELATIVE_RE.test(value.trim());
}

function invalid(label: 'since' | 'until', raw: string): SearchDateWindowError {
  return new SearchDateWindowError(
    `Invalid ${label} value "${raw}". Use YYYY-MM-DD, an ISO-8601 timestamp, or a relative duration such as 7d, 2w, or 1y.`,
  );
}

function normalizeBoundary(
  rawValue: string | undefined,
  label: 'since' | 'until',
  now: Date,
  untilDateOnlyEndOfDay: boolean,
): string | undefined {
  if (rawValue === undefined) return undefined;
  const raw = rawValue.trim();
  if (!raw) throw invalid(label, rawValue);

  const relative = RELATIVE_RE.exec(raw);
  if (relative) {
    const amount = Number(relative[1]);
    if (!Number.isSafeInteger(amount) || amount <= 0) throw invalid(label, rawValue);
    const unitDays = relative[2].toLowerCase() === 'd'
      ? 1
      : relative[2].toLowerCase() === 'w'
        ? 7
        : 365;
    const millis = amount * unitDays * 86_400_000;
    const parsed = new Date(now.getTime() - millis);
    if (!Number.isFinite(parsed.getTime())) throw invalid(label, rawValue);
    return parsed.toISOString();
  }

  if (DATE_ONLY_RE.test(raw)) {
    // Date-only `until` is inclusive of the whole UTC day, matching the
    // public operation contract. `since` begins at the first millisecond.
    const endOfDay = label === 'until' && untilDateOnlyEndOfDay;
    const suffix = endOfDay ? 'T23:59:59.999Z' : 'T00:00:00.000Z';
    const parsed = new Date(`${raw}${suffix}`);
    if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== raw) {
      throw invalid(label, rawValue);
    }
    // PostgreSQL stores microseconds. Returning JS's millisecond-resolution
    // `.999Z` would exclude rows in the final 999 microseconds of the day.
    return endOfDay ? `${raw}T23:59:59.999999Z` : parsed.toISOString();
  }

  // Zone-less ISO timestamps are interpreted as UTC, not the host timezone,
  // so a laptop and a server produce identical cache keys and containment.
  const candidate = EXPLICIT_ZONE_RE.test(raw) ? raw : `${raw}Z`;
  const parsed = new Date(candidate);
  if (!Number.isFinite(parsed.getTime())) throw invalid(label, rawValue);
  const iso = parsed.toISOString();
  const timestamp = ISO_TIMESTAMP_RE.exec(candidate);
  const fraction = timestamp?.[2];
  if (!fraction || fraction.length <= 3) return iso;

  // Date preserves milliseconds only. Append the remaining fractional
  // digits after timezone normalization so PostgreSQL receives its full
  // six-digit precision without changing the represented instant.
  const micros = fraction.padEnd(6, '0').slice(0, 6);
  return `${iso.slice(0, -1)}${micros.slice(3)}Z`;
}

function boundaryMicros(value: string): bigint {
  const millis = Date.parse(value);
  const fraction = /\.(\d{1,6})Z$/.exec(value)?.[1] ?? '';
  const microsWithinMillisecond = Number(fraction.padEnd(6, '0').slice(3, 6) || '0');
  return BigInt(millis) * 1000n + BigInt(microsWithinMillisecond);
}

export function normalizeSearchDateWindow(
  input: SearchDateWindowInput,
  now: Date = new Date(),
): NormalizedSearchDateWindow {
  if (!Number.isFinite(now.getTime())) {
    throw new SearchDateWindowError('Search date-window clock is invalid.');
  }

  const untilDateOnlyEndOfDay = input.untilDateOnlyEndOfDay !== false;
  const since = normalizeBoundary(input.since, 'since', now, untilDateOnlyEndOfDay);
  const until = normalizeBoundary(input.until, 'until', now, untilDateOnlyEndOfDay);
  if (since && until && boundaryMicros(since) > boundaryMicros(until)) {
    throw new SearchDateWindowError(
      `Invalid search date window: since (${since}) is after until (${until}).`,
    );
  }
  return {
    ...(since ? { since } : {}),
    ...(until ? { until } : {}),
  };
}
