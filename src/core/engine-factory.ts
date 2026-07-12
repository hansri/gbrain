import type { BrainEngine } from './engine.ts';
import type { EngineConfig } from './types.ts';
import {
  captureExistingPgliteDataDirAuthority,
  type ExistingPgliteDataDirAuthority,
} from './pglite-lock.ts';

/**
 * Fail closed before a read-only workflow constructs an engine for a
 * configured persistent PGLite brain.
 *
 * PGLite creates `database_path` on connect. That is desirable for explicit
 * init/migration paths, but disastrous for authority/preflight reads: a moved
 * or symlinked configured path would otherwise become a fresh empty store and
 * could be mistaken for the configured brain. Keep this opt-in so in-memory
 * PGLite and intentional mutating initialization retain their existing
 * behavior.
 */
export function assertExistingPgliteDataDirForReadOnlyOpen(
  config: EngineConfig,
): ExistingPgliteDataDirAuthority | undefined {
  if (config.engine !== 'pglite') return undefined;
  const configuredPath = config.database_path?.trim();
  if (!configuredPath) return undefined; // Intentional in-memory PGLite has no data dir.
  return captureExistingPgliteDataDirAuthority(configuredPath);
}

export interface CreateEngineOptions {
  /** Capability returned by assertExistingPgliteDataDirForReadOnlyOpen(). */
  pgliteReadOnlyAuthority?: ExistingPgliteDataDirAuthority;
}

/**
 * Create an engine instance based on config.
 * Uses dynamic imports so PGLite WASM is never loaded for Postgres users.
 */
export async function createEngine(
  config: EngineConfig,
  options: CreateEngineOptions = {},
): Promise<BrainEngine> {
  const engineType = config.engine || 'postgres';

  switch (engineType) {
    case 'pglite': {
      const { PGLiteEngine } = await import('./pglite-engine.ts');
      return new PGLiteEngine({
        existingDataDirAuthority: options.pgliteReadOnlyAuthority,
      });
    }
    case 'postgres': {
      const { PostgresEngine } = await import('./postgres-engine.ts');
      return new PostgresEngine();
    }
    default:
      throw new Error(
        `Unknown engine type: "${engineType}". Supported engines: postgres, pglite.` +
        (engineType === 'sqlite' ? ' SQLite is not supported. Use pglite instead.' : '')
      );
  }
}
