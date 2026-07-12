/**
 * Fail-closed authority guard for destructive real-Postgres tests.
 *
 * A URL alone is never sufficient: callers must opt in with GBRAIN_TEST_DB=1
 * and the URL must select the one canonical disposable database. Errors never
 * include the supplied URL, so credentials cannot be reflected into CI logs.
 */

export const POSTGRES_TEST_DATABASE = 'gbrain_test';

export type PostgresTestUrlVariable =
  | 'DATABASE_URL'
  | 'GBRAIN_DATABASE_URL'
  | 'GBRAIN_PGBOUNCER_URL'
  | 'GBRAIN_PGBOUNCER_DIRECT_URL'
  | 'GBRAIN_PGBOUNCER_WRONG_DIRECT_URL';

type TestEnvironment = Record<string, string | undefined>;

function authorityError(variable: PostgresTestUrlVariable, reason: string): Error {
  return new Error(`Postgres E2E authority denied for ${variable}: ${reason}`);
}

/**
 * Return an authorized test URL, or undefined when the variable is absent.
 * A configured-but-unsafe value throws instead of silently skipping.
 */
export function getPostgresTestUrl(
  variable: PostgresTestUrlVariable = 'DATABASE_URL',
  env: TestEnvironment = process.env,
): string | undefined {
  const raw = env[variable];
  if (raw === undefined || raw.trim() === '') return undefined;

  if (env.GBRAIN_TEST_DB !== '1') {
    throw authorityError(variable, 'GBRAIN_TEST_DB must equal "1"');
  }

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw authorityError(variable, 'URL is invalid');
  }

  if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') {
    throw authorityError(variable, 'URL must use the postgres or postgresql scheme');
  }

  let databasePath: string;
  try {
    databasePath = decodeURIComponent(parsed.pathname);
  } catch {
    throw authorityError(variable, 'database name is invalid');
  }
  if (databasePath !== `/${POSTGRES_TEST_DATABASE}`) {
    throw authorityError(variable, `database name must be exactly ${POSTGRES_TEST_DATABASE}`);
  }

  return raw;
}

/** Require a configured and authorized real-Postgres test URL. */
export function requirePostgresTestUrl(
  variable: PostgresTestUrlVariable = 'DATABASE_URL',
  env: TestEnvironment = process.env,
): string {
  const url = getPostgresTestUrl(variable, env);
  if (!url) throw authorityError(variable, 'URL is not configured');
  return url;
}
