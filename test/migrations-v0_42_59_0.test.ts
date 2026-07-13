import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { getMigration } from '../src/commands/migrations/index.ts';
import { phaseAPreflight } from '../src/commands/migrations/v0_42_59_0.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { migrationTestOpts } from './helpers/migration-opts.ts';
import { VERSION } from '../src/version.ts';

describe('v0.42.59.0 ownership migration orchestrator', () => {
  let engine: PGLiteEngine;

  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
  }, 60_000);

  afterAll(async () => {
    await engine.disconnect();
  });

  beforeEach(async () => {
    await resetPgliteState(engine);
    await engine.executeRaw(
      'CREATE UNIQUE INDEX IF NOT EXISTS pages_source_path_owner_uniq ON pages(source_id, source_path) WHERE source_path IS NOT NULL',
    );
  });

  test('is registered in the compiled migration registry', () => {
    expect(getMigration('0.42.59.0')?.featurePitch.headline).toContain('Multi-source');
  });

  test('preflight passes without duplicate owners', async () => {
    expect(await phaseAPreflight(engine)).toEqual({
      name: 'ownership_preflight',
      status: 'complete',
      detail: 'no duplicate owners',
    });
  });

  test('preflight fails closed before schema migration when duplicates exist', async () => {
    await engine.executeRaw('DROP INDEX pages_source_path_owner_uniq');
    await engine.executeRaw(
      `INSERT INTO pages
         (source_id, slug, source_path, type, title, compiled_truth, timeline, frontmatter)
       VALUES
         ('default', 'legacy/a', 'legacy/shared.md', 'note', 'A', '', '', '{}'::jsonb),
         ('default', 'legacy/b', 'legacy/shared.md', 'note', 'B', '', '', '{}'::jsonb)`,
    );

    const result = await phaseAPreflight(engine);
    expect(result.status).toBe('failed');
    expect(result.detail).toContain('gbrain upgrade-preflight repair');
    expect(result.detail).toContain('legacy/a, legacy/b');

    const bound = await phaseAPreflight(engine, migrationTestOpts({
      upgradeTransition: {
        transitionId: '11111111-1111-4111-8111-111111111111',
        brainId: 'db:22222222-2222-4222-8222-222222222222',
        fromVersion: '0.42.58.0',
        toVersion: VERSION,
      },
    }));
    expect(bound.detail).toContain('gbrain post-upgrade repair-ownership');
    expect(bound.detail).not.toContain('gbrain upgrade-preflight repair');
  });
});
