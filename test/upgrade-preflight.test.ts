import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import {
  escapeTerminalText,
  assertUpgradePreflightSchemaAuthority,
  inspectSourcePathOwnership,
  repairSourcePathOwnership,
} from '../src/commands/upgrade-preflight.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

describe('upgrade-preflight source_path ownership', () => {
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

  test('reports a clean fresh brain', async () => {
    expect(await inspectSourcePathOwnership(engine)).toEqual([]);
  });

  test('lists duplicate owners deterministically on PGLite', async () => {
    await seedDuplicateOwners(engine);

    expect(await inspectSourcePathOwnership(engine)).toEqual([{
      source_id: 'default',
      source_path: 'notes/shared.md',
      owners: ['notes/a', 'notes/b'],
    }]);
  });

  test('keeps the explicit owner and preserves every page row', async () => {
    await seedDuplicateOwners(engine);

    const receipt = await repairSourcePathOwnership(engine, {
      sourceId: 'default',
      sourcePath: 'notes/shared.md',
      keepSlug: 'notes/a',
    });

    expect(receipt).toEqual({
      sourceId: 'default',
      sourcePath: 'notes/shared.md',
      keepSlug: 'notes/a',
      cleared_slugs: ['notes/b'],
      remaining_conflicts: 0,
    });
    const rows = await engine.executeRaw<{
      slug: string;
      source_path: string | null;
      compiled_truth: string;
    }>(
      `SELECT slug, source_path, compiled_truth
         FROM pages
        WHERE slug IN ('notes/a', 'notes/b')
        ORDER BY slug`,
    );
    expect(rows).toEqual([
      { slug: 'notes/a', source_path: 'notes/shared.md', compiled_truth: 'body A' },
      { slug: 'notes/b', source_path: null, compiled_truth: 'body B' },
    ]);
  });

  test('refuses an unknown keep slug without changing ownership', async () => {
    await seedDuplicateOwners(engine);

    await expect(repairSourcePathOwnership(engine, {
      sourceId: 'default',
      sourcePath: 'notes/shared.md',
      keepSlug: 'notes/missing',
    })).rejects.toThrow('is not an owner');

    expect(await inspectSourcePathOwnership(engine)).toEqual([{
      source_id: 'default',
      source_path: 'notes/shared.md',
      owners: ['notes/a', 'notes/b'],
    }]);
  });

  test('can deliberately repair legacy empty-path owners', async () => {
    await engine.executeRaw('DROP INDEX pages_source_path_owner_uniq');
    await engine.executeRaw(
      `INSERT INTO pages
         (source_id, slug, source_path, type, title, compiled_truth, timeline, frontmatter)
       VALUES
         ('default', 'empty/a', '', 'note', 'A', '', '', '{}'::jsonb),
         ('default', 'empty/b', '', 'note', 'B', '', '', '{}'::jsonb)`,
    );

    expect((await inspectSourcePathOwnership(engine))[0]?.source_path).toBe('');
    const receipt = await repairSourcePathOwnership(engine, {
      sourceId: 'default',
      sourcePath: '',
      keepSlug: 'empty/a',
    });
    expect(receipt.cleared_slugs).toEqual(['empty/b']);
    expect(receipt.remaining_conflicts).toBe(0);
  });

  test('rejects a hostile shadow search_path without mutating either schema', async () => {
    const shadowSchema = 'upgrade_preflight_shadow';
    await seedDuplicateOwners(engine);
    await engine.executeRaw(`DROP SCHEMA IF EXISTS ${shadowSchema} CASCADE`);
    await engine.executeRaw(`CREATE SCHEMA ${shadowSchema}`);
    await engine.executeRaw(
      `CREATE TABLE ${shadowSchema}.pages (
        id BIGSERIAL PRIMARY KEY,
        source_id TEXT NOT NULL,
        source_path TEXT,
        slug TEXT NOT NULL
      )`,
    );
    await engine.executeRaw(
      `INSERT INTO ${shadowSchema}.pages (source_id, source_path, slug)
      VALUES
        ('default', 'notes/shared.md', 'shadow/a'),
        ('default', 'notes/shared.md', 'shadow/b')`,
    );
    await engine.executeRaw(`SET search_path = ${shadowSchema}, public`);

    try {
      await expect(assertUpgradePreflightSchemaAuthority(engine))
        .rejects.toThrow('incompatible search_path');
      await expect(inspectSourcePathOwnership(engine))
        .rejects.toThrow('incompatible search_path');
      await expect(repairSourcePathOwnership(engine, {
        sourceId: 'default',
        sourcePath: 'notes/shared.md',
        keepSlug: 'notes/a',
      })).rejects.toThrow('incompatible search_path');
    } finally {
      await engine.executeRaw('SET search_path = public');
    }

    const publicRows = await engine.executeRaw<{ slug: string; source_path: string | null }>(
      `SELECT slug, source_path
         FROM public.pages
        WHERE slug IN ('notes/a', 'notes/b')
        ORDER BY slug`,
    );
    expect(publicRows).toEqual([
      { slug: 'notes/a', source_path: 'notes/shared.md' },
      { slug: 'notes/b', source_path: 'notes/shared.md' },
    ]);
    const shadowRows = await engine.executeRaw<{ slug: string; source_path: string | null }>(
      `SELECT slug, source_path
         FROM ${shadowSchema}.pages
        ORDER BY slug`,
    );
    expect(shadowRows).toEqual([
      { slug: 'shadow/a', source_path: 'notes/shared.md' },
      { slug: 'shadow/b', source_path: 'notes/shared.md' },
    ]);
    await engine.executeRaw(`DROP SCHEMA ${shadowSchema} CASCADE`);
  });
});

async function seedDuplicateOwners(engine: PGLiteEngine): Promise<void> {
  await engine.executeRaw('DROP INDEX pages_source_path_owner_uniq');
  await engine.executeRaw(
    `INSERT INTO pages
       (source_id, slug, source_path, type, title, compiled_truth, timeline, frontmatter)
     VALUES
       ('default', 'notes/b', 'notes/shared.md', 'note', 'B', 'body B', '', '{}'::jsonb),
       ('default', 'notes/a', 'notes/shared.md', 'note', 'A', 'body A', '', '{}'::jsonb)`,
  );
}

describe('upgrade-preflight compatibility before source_path exists', () => {
  let legacyEngine: PGLiteEngine;
  let legacyRoot: string;

  beforeAll(async () => {
    // Use a dedicated persistent data dir so ci:local's post-init snapshot is
    // not loaded into this deliberately pre-schema compatibility fixture.
    legacyRoot = mkdtempSync(join(tmpdir(), 'gbrain-upgrade-preflight-legacy-'));
    legacyEngine = new PGLiteEngine();
    await legacyEngine.connect({ database_path: join(legacyRoot, 'db') });
  });

  afterAll(async () => {
    await legacyEngine.disconnect();
    rmSync(legacyRoot, { recursive: true, force: true });
  });

  test('treats a pre-source_path schema as not applicable', async () => {
    await legacyEngine.executeRaw(
      `CREATE TABLE pages (
         id BIGSERIAL PRIMARY KEY,
         slug TEXT NOT NULL,
         title TEXT NOT NULL
       )`,
    );
    expect(await inspectSourcePathOwnership(legacyEngine)).toEqual([]);
  }, 60_000);
});

test('human preflight rendering visibly escapes terminal and bidi controls', () => {
  const hostile = 'path\u001b[2J\nforged\u202e.md';
  const rendered = escapeTerminalText(hostile);
  expect(rendered).not.toContain('\u001b');
  expect(rendered).not.toContain('\n');
  expect(rendered).not.toContain('\u202e');
  expect(rendered).toContain('\\u{1b}');
  expect(rendered).toContain('\\u{a}');
  expect(rendered).toContain('\\u{202e}');
});
