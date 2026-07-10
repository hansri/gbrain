import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { hybridSearch, hybridSearchCached } from '../src/core/search/hybrid.ts';
import {
  __setEmbedTransportForTests,
  configureGateway,
  resetGateway,
} from '../src/core/ai/gateway.ts';
import type { ChunkInput } from '../src/core/types.ts';

let engine: PGLiteEngine;

function basisEmbedding(index: number, dimensions = 1536): Float32Array {
  const vector = new Float32Array(dimensions);
  vector[index] = 1;
  return vector;
}

const fixtures = [
  ['meetings/temporal-before', '2026-07-08T23:59:59.999Z'],
  ['meetings/temporal-start', '2026-07-09T00:00:00.000Z'],
  ['meetings/temporal-end', '2026-07-09T23:59:59.999Z'],
  ['meetings/temporal-microsecond-end', '2026-07-09T23:59:59.999500Z'],
  ['meetings/temporal-after', '2026-07-10T00:00:00.000Z'],
] as const;

beforeAll(async () => {
  resetGateway();
  configureGateway({
    embedding_model: 'openai:text-embedding-3-large',
    embedding_dimensions: 1536,
    env: { OPENAI_API_KEY: 'sk-test-temporal' },
  });
  __setEmbedTransportForTests(async ({ values }: { values: string[] }) => ({
    embeddings: values.map(() => Array.from(basisEmbedding(42))),
    usage: { tokens: 0 },
  }) as any);
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();

  for (const [slug, iso] of fixtures) {
    await engine.putPage(slug, {
      type: 'meeting',
      title: 'Temporal Boundary Sentinel',
      compiled_truth: 'temporal boundary sentinel evidence',
      effective_date: new Date(iso),
      effective_date_source: 'event_date',
    });
    // Preserve sub-millisecond precision for the end-of-day regression.
    await engine.executeRaw(
      `UPDATE pages SET effective_date = $1::timestamptz WHERE slug = $2 AND source_id = 'default'`,
      [iso, slug],
    );
    const chunks: ChunkInput[] = [{
      chunk_index: 0,
      chunk_text: 'temporal boundary sentinel evidence',
      chunk_source: 'compiled_truth',
      embedding: basisEmbedding(42),
      token_count: 4,
    }];
    await engine.upsertChunks(slug, chunks);
  }
});

afterAll(async () => {
  await engine.disconnect();
  __setEmbedTransportForTests(null);
  resetGateway();
});

const window = {
  afterDate: '2026-07-09T00:00:00.000Z',
  beforeDate: '2026-07-09T23:59:59.999999Z',
  afterDateInclusive: true,
  beforeDateInclusive: true,
  limit: 20,
};

function expectOnlyBoundaryPages(slugs: string[]): void {
  expect(new Set(slugs)).toEqual(new Set([
    'meetings/temporal-start',
    'meetings/temporal-end',
    'meetings/temporal-microsecond-end',
  ]));
}

describe('PGLite temporal search containment', () => {
  test('keyword search uses effective_date and includes both boundaries', async () => {
    const results = await engine.searchKeyword('temporal boundary sentinel', window);
    expectOnlyBoundaryPages(results.map((result) => result.slug));
  });

  test('chunk keyword search uses the same inclusive window', async () => {
    const results = await engine.searchKeywordChunks('temporal boundary sentinel', window);
    expectOnlyBoundaryPages(results.map((result) => result.slug));
  });

  test('vector search uses the same inclusive window', async () => {
    const results = await engine.searchVector(basisEmbedding(42), window);
    expectOnlyBoundaryPages(results.map((result) => result.slug));
  });

  test('public since/until includes the entire day through PostgreSQL microsecond precision', async () => {
    const results = await hybridSearch(engine, 'temporal boundary sentinel', {
      since: '2026-07-09',
      until: '2026-07-09',
      expansion: false,
      relationalRetrieval: false,
      dedupOpts: { cosineThreshold: 1.1, maxTypeRatio: 1, maxPerPage: 3 },
      limit: 20,
    });
    expectOnlyBoundaryPages(results.map((result) => result.slug));
  });

  test('post-retrieval alias injection cannot escape the requested date window', async () => {
    await engine.putPage('meetings/temporal-alias-outside', {
      type: 'meeting',
      title: 'Unrelated historical title',
      compiled_truth: 'unrelated historical body',
      effective_date: new Date('2026-07-08T12:00:00.000Z'),
      effective_date_source: 'event_date',
    });
    await engine.executeRaw(
      `INSERT INTO page_aliases (source_id, alias_norm, slug)
       VALUES ('default', 'chosen temporal alias', 'meetings/temporal-alias-outside')`,
    );

    const results = await hybridSearch(engine, 'chosen temporal alias', {
      since: '2026-07-09',
      until: '2026-07-09',
      expansion: false,
      relationalRetrieval: false,
      limit: 20,
    });
    expect(results.map((result) => result.slug))
      .not.toContain('meetings/temporal-alias-outside');
  });

  test('relative windows bypass semantic cache instead of creating millisecond-keyed rows', async () => {
    await engine.executeRaw('DELETE FROM query_cache');
    await hybridSearchCached(engine, 'temporal boundary sentinel', {
      since: '7d',
      expansion: false,
      relationalRetrieval: false,
      useCache: true,
      limit: 20,
    });
    const rows = await engine.executeRaw<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM query_cache`,
    );
    expect(Number(rows[0]?.n ?? 0)).toBe(0);
  });

  test('deprecated afterDate/beforeDate remain exclusive', async () => {
    const legacy = {
      afterDate: '2026-07-09T00:00:00.000Z',
      beforeDate: '2026-07-09T23:59:59.999Z',
      limit: 20,
    };
    const results = await engine.searchKeyword('temporal boundary sentinel', legacy);
    expect(results.map((result) => result.slug)).toEqual([]);
  });
});
