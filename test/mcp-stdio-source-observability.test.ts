import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import {
  dispatchStdioToolCall,
  resolveStdioMcpPolicy,
  stdioAuthForPolicy,
} from '../src/mcp/stdio-policy.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

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
    `INSERT INTO sources (id, name, local_path, config)
     VALUES
       ('source-a', 'Visible Source', '/safe/source-a', '{}'::jsonb),
       ('source-b', 'SECRET SOURCE B', '/private/secret-source-b', '{}'::jsonb)`,
  );
  await engine.executeRaw(
    `INSERT INTO pages
       (source_id, slug, type, title, compiled_truth, timeline, frontmatter)
     VALUES
       ('source-a', 'visible/a', 'note', 'Visible A', 'visible', '', '{}'::jsonb),
       ('source-b', 'secret-b/one', 'person', 'Secret B One', 'secret', '', '{}'::jsonb),
       ('source-b', 'secret-b/two', 'person', 'Secret B Two', 'secret', '', '{}'::jsonb)`,
  );
  await engine.executeRaw(
    `INSERT INTO content_chunks (page_id, chunk_index, chunk_text, embedded_at)
     SELECT id, 0, compiled_truth, now() FROM pages`,
  );
  await engine.executeRaw(
    `INSERT INTO ingest_log (source_id, source_type, source_ref, pages_updated, summary)
     VALUES ('source-a', 'test', 'visible', '[]'::jsonb, 'visible ingest'),
            ('source-b', 'test', '/private/secret-source-b', '[]'::jsonb, 'secret ingest')`,
  );
});

function parseBody(result: Awaited<ReturnType<typeof dispatchStdioToolCall>>) {
  return JSON.parse(result.content[0]!.text) as Record<string, unknown>;
}

describe('source-bound stdio observability', () => {
  const policy = resolveStdioMcpPolicy();
  const opts = {
    sourceId: 'source-a',
    auth: stdioAuthForPolicy('source-a', policy),
  };

  test('statistics count only the configured source', async () => {
    const result = await dispatchStdioToolCall(
      engine,
      'get_source_stats',
      {},
      policy,
      opts,
    );
    expect(result.isError).not.toBe(true);
    expect(parseBody(result)).toMatchObject({
      source_id: 'source-a',
      page_count: 1,
      chunk_count: 1,
      embedded_count: 1,
      pages_by_type: { note: 1 },
    });
    const serialized = result.content[0]!.text;
    expect(serialized).not.toContain('source-b');
    expect(serialized).not.toContain('secret-b');
    expect(serialized).not.toContain('/private/secret-source-b');
  });

  test('health returns no foreign names, slugs, paths, or counts', async () => {
    const result = await dispatchStdioToolCall(
      engine,
      'get_source_health',
      {},
      policy,
      opts,
    );
    expect(result.isError).not.toBe(true);
    expect(parseBody(result)).toMatchObject({
      component: 'gbrain',
      source_id: 'source-a',
      status: 'healthy',
      page_count: 1,
      embed_coverage: 1,
      missing_embeddings: 0,
      orphan_pages: 1,
    });
    const serialized = result.content[0]!.text;
    expect(serialized).not.toContain('SECRET SOURCE B');
    expect(serialized).not.toContain('secret-b');
    expect(serialized).not.toContain('/private/secret-source-b');
    expect(serialized).not.toContain('"page_count": 2');

    await engine.executeRaw(
      `INSERT INTO links (from_page_id, to_page_id)
       SELECT a.id, b.id
         FROM pages a, pages b
        WHERE a.source_id = 'source-a' AND a.slug = 'visible/a'
          AND b.source_id = 'source-b' AND b.slug = 'secret-b/one'`,
    );
    const afterCrossSourceLink = await dispatchStdioToolCall(
      engine,
      'get_source_health',
      {},
      policy,
      opts,
    );
    expect(parseBody(afterCrossSourceLink).orphan_pages).toBe(1);
  });
});
