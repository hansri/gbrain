import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PostgresEngine } from '../../src/core/postgres-engine.ts';
import {
  finalizeImportConvergence,
  type ImportConvergenceReceipt,
} from '../../src/commands/import.ts';
import { withSourceWriterLease } from '../../src/core/source-writer-lease.ts';

const DATABASE_URL = process.env.DATABASE_URL;

describe.skipIf(!DATABASE_URL)('Postgres full-import convergence transaction', () => {
  let engine: PostgresEngine;

  beforeAll(async () => {
    engine = new PostgresEngine();
    await engine.connect({ database_url: DATABASE_URL! });
    await engine.initSchema();
  }, 60_000);

  afterAll(async () => {
    await engine?.disconnect();
  });

  test('exact stale proof deletes only the still-managed owner and atomically advances', async () => {
    const suffix = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
    const sourceId = `e2e-full-${suffix}`;
    const anchorKey = `test.full-anchor.${suffix}`;
    await engine.executeRaw(
      `INSERT INTO sources (id, name) VALUES ($1, $1) ON CONFLICT (id) DO NOTHING`,
      [sourceId],
    );
    try {
      await engine.putPage('notes/current', {
        type: 'note',
        title: 'Current',
        compiled_truth: 'current',
        timeline: '',
        content_hash: 'current-hash',
        source_path: 'current.md',
      }, { sourceId });
      await engine.putPage('notes/delete-me', {
        type: 'note',
        title: 'Delete',
        compiled_truth: 'stale',
        timeline: '',
        content_hash: 'delete-hash',
        source_path: 'delete-me.md',
      }, { sourceId });
      await engine.putPage('notes/reclassify-me', {
        type: 'note',
        title: 'Reclassify',
        compiled_truth: 'manual now',
        timeline: '',
        content_hash: 'manual-hash',
        source_path: 'reclassify-me.md',
      }, { sourceId });
      const current = await engine.executeRaw<{
        id: number;
        slug: string;
        content_hash: string;
      }>(
        `SELECT id, slug, content_hash FROM pages
          WHERE source_id = $1 AND source_path = 'current.md'`,
        [sourceId],
      );
      const receipt: ImportConvergenceReceipt = {
        checkpointPath: `/tmp/gbrain-e2e-full-${suffix}.json`,
        checkpointIdentity: `e2e:${suffix}`,
        sourceId,
        completedPaths: ['current.md'],
        completedProofs: {
          'current.md': {
            authorityFingerprint: 'git:test',
            pageId: Number(current[0]!.id),
            slug: current[0]!.slug,
            contentHash: current[0]!.content_hash,
          },
        },
        authoritativePaths: ['current.md'],
        strategy: 'markdown',
      };

      const result = await withSourceWriterLease(engine, sourceId, async lease =>
        finalizeImportConvergence(
          engine,
          receipt,
          lease,
          async tx => { await tx.setConfig(anchorKey, 'advanced'); },
          {
            reconcileStale: true,
            afterStaleSelection: async (tx, selected) => {
              expect(selected.map(row => row.sourcePath).sort()).toEqual([
                'delete-me.md',
                'reclassify-me.md',
              ]);
              await tx.executeRaw(
                `UPDATE pages SET source_path = 'manual.json'
                  WHERE source_id = $1
                    AND slug = 'notes/reclassify-me'
                    AND source_path = 'reclassify-me.md'`,
                [sourceId],
              );
            },
          },
        ),
      );

      expect(result.deleted).toBe(1);
      expect(await engine.getConfig(anchorKey)).toBe('advanced');
      const live = await engine.executeRaw<{ slug: string; source_path: string }>(
        `SELECT slug, source_path FROM pages
          WHERE source_id = $1 AND deleted_at IS NULL ORDER BY slug`,
        [sourceId],
      );
      expect(live).toEqual([
        { slug: 'notes/current', source_path: 'current.md' },
        { slug: 'notes/reclassify-me', source_path: 'manual.json' },
      ]);
    } finally {
      await engine.executeRaw(`DELETE FROM sources WHERE id = $1`, [sourceId]);
      await engine.executeRaw(`DELETE FROM config WHERE key = $1`, [anchorKey]);
    }
  });
});
