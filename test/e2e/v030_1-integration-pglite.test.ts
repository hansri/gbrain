/**
 * v0.30.1 integration smoke test — PGLite path.
 *
 * Exercises the Lane A-D surfaces together against an in-memory PGLite
 * brain to prove the new modules integrate. No DATABASE_URL required.
 *
 * What this proves:
 *   Lane A: ConnectionManager constructed; doctor diagnostic shape
 *           (single-mode for non-Supabase URL).
 *   Lane B: Migration runner applies pending migrations cleanly via the
 *           new retry wrapper. v44 (emotional_weight_recomputed_at)
 *           lands on PGLite.
 *   Lane C: Backfill registry resolves all 3 entries; running
 *           emotional_weight backfill on an empty brain returns
 *           examined=0 (no work).
 *   Lane D: dropZombieIndexes on PGLite returns dropped=[] (no-op).
 *
 * Postgres-only e2es (connection-routing, hnsw-lifecycle, migrate-supabase
 * timeout/wedge recovery) live in their own DATABASE_URL-gated files;
 * those verify behaviors that PGLite can't exercise (pooler timeout,
 * CONCURRENTLY index, multi-tenant lock, etc.).
 */

import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { listBackfills, getBackfill } from '../../src/core/backfill-registry.ts';
import { runBackfill } from '../../src/core/backfill-base.ts';
import { dropZombieIndexes, checkActiveBuild } from '../../src/core/vector-index.ts';
import { LATEST_VERSION } from '../../src/core/migrate.ts';

let tmpHome: string;
let originalHome: string | undefined;
let engine: PGLiteEngine;

beforeEach(async () => {
  tmpHome = mkdtempSync(join(tmpdir(), 'v030_1-int-'));
  originalHome = process.env.GBRAIN_HOME;
  process.env.GBRAIN_HOME = tmpHome;
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterEach(async () => {
  await engine.disconnect();
  if (originalHome === undefined) delete process.env.GBRAIN_HOME;
  else process.env.GBRAIN_HOME = originalHome;
  if (existsSync(tmpHome)) rmSync(tmpHome, { recursive: true, force: true });
});

describe('Lane B — migration runner applies cleanly through retry wrapper', () => {
  test('after initSchema, config.version is at LATEST_VERSION', async () => {
    const ver = await engine.getConfig('version');
    expect(parseInt(ver || '1', 10)).toBe(LATEST_VERSION);
  });

  test('v44 emotional_weight_recomputed_at column exists on pages', async () => {
    // PGLite supports information_schema.columns. ALTER TABLE ADD COLUMN
    // is idempotent, so v44 should have applied even on a freshly-created
    // PGLite brain.
    const rows = await engine.executeRaw<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name = 'pages' AND column_name = 'emotional_weight_recomputed_at'`,
    );
    expect(rows.length).toBe(1);
  });
});

describe('Lane C — backfill registry on empty brain', () => {
  test('listBackfills returns the canonical registry entries', () => {
    // v0.30.1 shipped 3 entries (effective_date, embedding_voyage,
    // emotional_weight). v0.36 cross-modal wave adds `modality` for
    // historical image-asset chunks. Extend this assertion as new
    // backfills land.
    const list = listBackfills();
    const names = list.map(e => e.spec.name).sort();
    expect(names).toEqual(['effective_date', 'embedding_voyage', 'emotional_weight', 'modality']);
  });

  test('embedding_voyage is declared-only in v0.30.1', () => {
    const reg = getBackfill('embedding_voyage');
    expect(reg).toBeDefined();
    expect(reg!.v030_1_status).toBe('declared-only');
  });

  test('emotional_weight backfill on empty brain: examined=0', async () => {
    const reg = getBackfill('emotional_weight');
    expect(reg).toBeDefined();
    const result = await runBackfill(engine, reg!.spec, { batchSize: 100 });
    expect(result.examined).toBe(0);
    expect(result.errors).toBe(0);
  });

  test('effective_date backfill on empty brain: examined=0', async () => {
    const reg = getBackfill('effective_date');
    expect(reg).toBeDefined();
    const result = await runBackfill(engine, reg!.spec, { batchSize: 100 });
    expect(result.examined).toBe(0);
  });
});

describe('Lane D — vector-index lifecycle on PGLite', () => {
  test('dropZombieIndexes on PGLite is a no-op', async () => {
    const r = await dropZombieIndexes(engine);
    expect(r.dropped).toEqual([]);
  });

  test('checkActiveBuild on PGLite returns active: false', async () => {
    const r = await checkActiveBuild(engine, 'idx_chunks_embedding');
    expect(r.active).toBe(false);
  });
});

describe('Cross-lane integration', () => {
  test('PostgresEngine.connectionManager is null on PGLite (engine kind branch)', () => {
    // PGLite engines don't get a ConnectionManager — that's a Postgres-only
    // concern. PGLiteEngine doesn't have the property at all.
    const hasManager = 'connectionManager' in engine;
    expect(hasManager).toBe(false);
  });

  test('schema_version on BrainHealth is the optional v0.30.1 marker', async () => {
    // Engines don't yet populate this field; it's an optional contract.
    // The SHAPE compiles, the runtime read returns undefined.
    const health = await engine.getHealth();
    // schema_version is OPTIONAL (v0.30.1 declares the contract; engines
    // populate in v0.30.2). undefined is a valid v0.30.1 state.
    expect(health.schema_version === undefined || health.schema_version === '1').toBe(true);
  });
});
