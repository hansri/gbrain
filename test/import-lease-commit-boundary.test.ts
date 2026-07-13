import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const source = readFileSync('src/core/import-file.ts', 'utf8');
const importCommandSource = readFileSync('src/commands/import.ts', 'utf8');
const syncCommandSource = readFileSync('src/commands/sync.ts', 'utf8');

function bodyBetween(start: string, end: string, text = source): string {
  const from = text.indexOf(start);
  const to = text.indexOf(end, from + start.length);
  expect(from).toBeGreaterThanOrEqual(0);
  expect(to).toBeGreaterThan(from);
  return text.slice(from, to);
}

describe('import transaction commit-boundary fencing', () => {
  test('markdown reasserts the active lease after its last alias write', () => {
    const tail = bodyBetween(
      'await tx.setPageAliases(slug, effectiveSourceId, aliasNorms);',
      "return {\n    slug,\n    status: 'imported'",
    );
    expect(tail).toContain('await assertSourceWriterLeaseAtCommit(opts.writerLease!, tx, effectiveSourceId)');
  });

  test('code reasserts after page, chunk, and edge replacement', () => {
    const body = bodyBetween(
      'export async function importCodeFile(',
      '// Backward compat',
    );
    const edgeEnd = body.lastIndexOf('await tx.addCodeEdges(edgeInputs)');
    const fence = body.lastIndexOf('await assertSourceWriterLeaseAtCommit(opts.writerLease!, tx, effectiveSourceId)');
    expect(edgeEnd).toBeGreaterThanOrEqual(0);
    expect(fence).toBeGreaterThan(edgeEnd);
  });

  test('shared image transaction reasserts after the type-specific callback', () => {
    const body = bodyBetween(
      'export async function withImportTransaction(',
      'export function pLimit(',
    );
    const after = body.indexOf('if (spec.after) await spec.after(tx)');
    const fence = body.lastIndexOf('await assertSourceWriterLeaseAtCommit(spec.writerLease, tx, sourceId)');
    expect(after).toBeGreaterThanOrEqual(0);
    expect(fence).toBeGreaterThan(after);
  });

  test('managed import finalizer takes the DB fence after anchor writes', () => {
    const body = bodyBetween(
      'export async function finalizeImportConvergence(',
      '/**\n * Open and read one filesystem import target',
      importCommandSource,
    );
    const advance = body.lastIndexOf('await advance?.(tx)');
    const fence = body.lastIndexOf('await assertSourceWriterLeaseAtCommit(writerLease, tx, receipt.sourceId)');
    expect(advance).toBeGreaterThanOrEqual(0);
    expect(fence).toBeGreaterThan(advance);
  });

  test('resumed sync finalizer takes the DB fence after anchor writes', () => {
    const body = bodyBetween(
      'async function finalizeSyncResumeProofs(',
      '/** Sentinels a clean rerun',
      syncCommandSource,
    );
    const advance = body.lastIndexOf('await advance(tx)');
    const fence = body.lastIndexOf('await assertSourceWriterLeaseAtCommit(writerLease, tx, sourceId)');
    expect(advance).toBeGreaterThanOrEqual(0);
    expect(fence).toBeGreaterThan(advance);
  });

  test('full sync delegates stale selection to the final convergence transaction', () => {
    const body = bodyBetween(
      'async function performFullSync(',
      '/**\n * Grace window',
      syncCommandSource,
    );
    expect(body).toContain('reconcileStale: true');
    expect(body).toContain('finalizeImportConvergence(');
    expect(body).not.toContain('const staleRows =');
    expect(body).not.toContain('engine.deletePages(');
  });
});
