import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import {
  finalizeImportConvergence,
  ImportConvergenceLostError,
  type ImportConvergenceReceipt,
} from '../src/commands/import.ts';
import { withSourceWriterLease } from '../src/core/source-writer-lease.ts';

let engine: PGLiteEngine;
const sourceId = 'absence-proof';

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await engine.executeRaw(
    `INSERT INTO sources (id, name) VALUES ($1, $1) ON CONFLICT (id) DO NOTHING`,
    [sourceId],
  );
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await engine.executeRaw(`DELETE FROM pages WHERE source_id = $1`, [sourceId]);
  await engine.setConfig('test.absence_anchor', 'unset');
});

function receipt(
  absentProofs: ImportConvergenceReceipt['absentProofs'] = [],
): ImportConvergenceReceipt {
  return {
    checkpointPath: '/tmp/gbrain-test-absence-proof.json',
    checkpointIdentity: 'test',
    sourceId,
    completedPaths: [],
    completedProofs: {},
    authoritativePaths: ['current.md'],
    strategy: 'markdown',
    absentProofs,
  };
}

describe('managed full-import absence proof', () => {
  test('a stale row restored before finalization blocks anchor promotion', async () => {
    await engine.putPage('notes/stale', {
      type: 'note', title: 'Stale', compiled_truth: '', timeline: '',
      source_path: 'stale.md',
    }, { sourceId });
    const rows = await engine.executeRaw<{ id: number }>(
      `SELECT id FROM pages WHERE source_id = $1 AND slug = 'notes/stale'`,
      [sourceId],
    );

    await expect(withSourceWriterLease(engine, sourceId, async lease => {
      await finalizeImportConvergence(
        engine,
        receipt([{ pageId: Number(rows[0]!.id), slug: 'notes/stale', sourcePath: 'stale.md' }]),
        lease,
        async tx => { await tx.setConfig('test.absence_anchor', 'advanced'); },
      );
    })).rejects.toBeInstanceOf(ImportConvergenceLostError);
    expect(await engine.getConfig('test.absence_anchor')).toBe('unset');
  });

  test('a retained tombstone and manifest-contained live rows advance atomically', async () => {
    await engine.putPage('notes/current', {
      type: 'note', title: 'Current', compiled_truth: '', timeline: '',
      source_path: 'current.md',
    }, { sourceId });
    await engine.putPage('notes/stale', {
      type: 'note', title: 'Stale', compiled_truth: '', timeline: '',
      source_path: 'stale.md',
    }, { sourceId });
    const rows = await engine.executeRaw<{ id: number }>(
      `SELECT id FROM pages WHERE source_id = $1 AND slug = 'notes/stale'`,
      [sourceId],
    );
    await engine.executeRaw(
      `UPDATE pages SET deleted_at = now() WHERE source_id = $1 AND slug = 'notes/stale'`,
      [sourceId],
    );

    await withSourceWriterLease(engine, sourceId, async lease => {
      await finalizeImportConvergence(
        engine,
        receipt([{ pageId: Number(rows[0]!.id), slug: 'notes/stale', sourcePath: 'stale.md' }]),
        lease,
        async tx => { await tx.setConfig('test.absence_anchor', 'advanced'); },
      );
    });
    expect(await engine.getConfig('test.absence_anchor')).toBe('advanced');
  });

  test('moving a selected stale row onto an unproven manifest path blocks the anchor', async () => {
    await engine.putPage('notes/stale', {
      type: 'note', title: 'Stale', compiled_truth: '', timeline: '',
      source_path: 'stale.md', content_hash: 'stale-hash',
    }, { sourceId });

    await expect(withSourceWriterLease(engine, sourceId, async lease => {
      await finalizeImportConvergence(
        engine,
        receipt(),
        lease,
        async tx => { await tx.setConfig('test.absence_anchor', 'advanced'); },
        {
          reconcileStale: true,
          afterStaleSelection: async tx => {
            await tx.executeRaw(
              `UPDATE pages SET source_path = 'current.md'
                WHERE source_id = $1 AND slug = 'notes/stale'`,
              [sourceId],
            );
          },
        },
      );
    })).rejects.toBeInstanceOf(ImportConvergenceLostError);

    expect(await engine.getConfig('test.absence_anchor')).toBe('unset');
    const rows = await engine.executeRaw<{ source_path: string }>(
      `SELECT source_path FROM pages WHERE source_id = $1 AND slug = 'notes/stale'`,
      [sourceId],
    );
    expect(rows[0]?.source_path).toBe('stale.md');
  });
});
