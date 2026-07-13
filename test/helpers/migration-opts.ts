import { existsSync, realpathSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

import { databaseIdentity } from '../../src/core/database-identity.ts';
import type { EngineConfig } from '../../src/core/types.ts';
import type { OrchestratorOpts } from '../../src/commands/migrations/types.ts';

/** Snapshot fixture for dry-run/phase-only migration tests. */
export function migrationTestOpts(
  overrides: Partial<OrchestratorOpts> = {},
  engineConfig: EngineConfig = {
    engine: 'pglite',
    database_path: join(tmpdir(), 'gbrain-migration-test-snapshot'),
  },
): OrchestratorOpts {
  const engine = engineConfig.engine ?? 'pglite';
  let canonicalEngineConfig = { ...engineConfig, engine };
  if (canonicalEngineConfig.database_path && !existsSync(canonicalEngineConfig.database_path)) {
    try {
      canonicalEngineConfig = {
        ...canonicalEngineConfig,
        database_path: join(
          realpathSync.native(dirname(canonicalEngineConfig.database_path)),
          basename(canonicalEngineConfig.database_path),
        ),
      };
    } catch { /* parent may not exist in a phase-only fixture */ }
  }
  return {
    yes: true,
    dryRun: false,
    noAutopilotInstall: true,
    brainId: databaseIdentity(canonicalEngineConfig),
    engineConfig: canonicalEngineConfig,
    gbrainConfig: {
      engine,
      database_url: canonicalEngineConfig.database_url,
      database_path: canonicalEngineConfig.database_path,
    },
    ...overrides,
  };
}
