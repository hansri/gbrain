#!/usr/bin/env bun

import postgres from 'postgres';
import { requirePostgresTestUrl } from '../test/helpers/postgres-test-authority.ts';

/**
 * Give every real-Postgres E2E file a fresh schema. Sharing only a database
 * process is safe; sharing schema defaults is not, because files intentionally
 * exercise different embedding dimensions and historical migration states.
 */
const databaseUrl = requirePostgresTestUrl();
const sql = postgres(databaseUrl, {
  max: 1,
  prepare: false,
  connect_timeout: 10,
  onnotice: () => {},
});

try {
  await sql.unsafe(`
    SELECT pg_terminate_backend(pid)
      FROM pg_stat_activity
     WHERE pid != pg_backend_pid()
       AND datname = current_database()
  `);
  await sql.unsafe(`
    SET client_min_messages = warning;
    DROP SCHEMA IF EXISTS public CASCADE;
    CREATE SCHEMA public;
  `);
} finally {
  await sql.end({ timeout: 5 });
}
