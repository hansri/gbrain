import { createHash } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';

function canonicalPostgresUrl(raw: string): string {
  try {
    const url = new URL(raw);
    // Passwords rotate and must not invalidate durable checkpoints. The
    // principal is part of database identity, however: two roles can have
    // different search_path/RLS visibility over the same host/database.
    url.password = '';
    url.protocol = url.protocol.toLowerCase();
    if (url.protocol === 'postgres:') url.protocol = 'postgresql:';
    url.hostname = url.hostname.toLowerCase();
    if ((url.protocol === 'postgres:' || url.protocol === 'postgresql:') && url.port === '5432') {
      url.port = '';
    }
    // URLSearchParams serialization gives query parameters a deterministic
    // order (notably options/search_path and sslmode).
    const sorted = [...url.searchParams.entries()].sort(([ak, av], [bk, bv]) =>
      ak.localeCompare(bk) || av.localeCompare(bv));
    url.search = '';
    for (const [key, value] of sorted) url.searchParams.append(key, value);
    return url.toString();
  } catch {
    // Preserve fail-closed differentiation for unusual postgres-js URLs while
    // still removing only the password. Do not erase the username as the old
    // `//[^@]*@` replacement did.
    return raw.replace(/(\/\/[^:/@]+):[^@]*@/, '$1@');
  }
}

function canonicalPglitePath(raw: string): string {
  if (raw.startsWith('memory:')) return raw;
  const absolute = resolve(raw);
  return existsSync(absolute) ? realpathSync.native(absolute) : absolute;
}

/** Credential-stable identity for one concrete database configuration. */
export function databaseIdentity(config: {
  database_url?: string | null;
  database_path?: string | null;
}): string {
  if (config.database_url) {
    return createHash('sha256')
      .update(`postgres:${canonicalPostgresUrl(config.database_url)}`)
      .digest('hex')
      .slice(0, 16);
  }
  return createHash('sha256')
    .update(`pglite:${canonicalPglitePath(config.database_path ?? 'default')}`)
    .digest('hex')
    .slice(0, 16);
}
