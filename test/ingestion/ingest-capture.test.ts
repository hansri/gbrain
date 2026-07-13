/**
 * ingest_capture Minion handler tests. Exercises the slug-resolution
 * fallback chain, content-type gating (binary rejection), validation,
 * and the importFromContent integration against an in-memory PGLite.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { resetPgliteState } from '../helpers/reset-pglite.ts';
import {
  defaultSlugForEvent,
  makeIngestCaptureHandler,
} from '../../src/core/minions/handlers/ingest-capture.ts';
import {
  computeContentHash,
  type IngestionEvent,
} from '../../src/core/ingestion/types.ts';
import type { MinionJobContext } from '../../src/core/minions/types.ts';
import { MinionQueue } from '../../src/core/minions/queue.ts';
import { TRUSTED_LOCAL_INGEST_MARKER } from '../../src/core/minions/ingest-boundary.ts';
import { runJobs } from '../../src/commands/jobs.ts';

let engine: PGLiteEngine;

// 30s hook timeout — when this file runs deep in a shard process that's
// already created ~20 PGLite engines, the WASM cold-start + 95 migrations
// on a fresh DB legitimately exceeds bun's 5s hook default. CI shard 4
// hit this on v0.41.17.0 (95 migrations × 21 files × 1 bun process).
beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 30_000);

afterAll(async () => {
  await engine.disconnect();
}, 30_000);

beforeEach(async () => {
  await resetPgliteState(engine);
  await engine.executeRaw(
    `INSERT INTO sources (id, name, config)
       VALUES ('webhook-test', 'webhook-test', '{"federated": false}'::jsonb)`,
  );
});

function makeEvent(overrides: Partial<IngestionEvent> = {}): IngestionEvent {
  const content = overrides.content ?? '# captured thought';
  return {
    source_id: 'webhook-test',
    source_kind: 'webhook',
    source_uri: 'mcp-webhook:client-x:1234',
    received_at: new Date('2026-05-20T12:00:00Z').toISOString(),
    content_type: 'text/markdown',
    content,
    content_hash: overrides.content_hash ?? computeContentHash(content),
    ...overrides,
  };
}

function makeJob(data: Record<string, unknown>): MinionJobContext {
  const persistedData = data.remote === true
    ? data
    : { ...data, remote: false, [TRUSTED_LOCAL_INGEST_MARKER]: true };
  return {
    id: 1,
    name: 'ingest_capture',
    data: persistedData,
    attempts_made: 1,
    signal: new AbortController().signal,
    shutdownSignal: new AbortController().signal,
    updateProgress: async () => {},
    updateTokens: async () => {},
    log: async () => {},
    isActive: async () => true,
    readInbox: async () => [],
  };
}

describe('defaultSlugForEvent', () => {
  test('builds inbox/YYYY-MM-DD-<hash6> slug', () => {
    const ev = makeEvent({ content_hash: 'abcdef1234567890'.padEnd(64, '0') });
    const slug = defaultSlugForEvent(ev, new Date('2026-05-20T00:00:00Z'));
    expect(slug).toBe('inbox/2026-05-20-abcdef');
  });

  test('stable for same content (deterministic hash)', () => {
    const ev = makeEvent({ content: 'same thought' });
    const date = new Date('2026-05-20T00:00:00Z');
    expect(defaultSlugForEvent(ev, date)).toBe(defaultSlugForEvent(ev, date));
  });

  test('UTC date math (no tz drift)', () => {
    const ev = makeEvent();
    const slug = defaultSlugForEvent(ev, new Date('2026-01-05T23:59:59Z'));
    expect(slug).toMatch(/^inbox\/2026-01-05-/);
  });
});

describe('ingest_capture handler — slug resolution', () => {
  test('uses caller-provided job.data.slug when present', async () => {
    const handler = makeIngestCaptureHandler(engine);
    const ev = makeEvent({ content: 'with explicit slug' });
    const result = await handler(makeJob({ event: ev, slug: 'wiki/specific/page' }));
    expect(result.slug).toBe('wiki/specific/page');
    expect(result.status).toBe('imported');
  });

  test('uses event.metadata.slug when set', async () => {
    const handler = makeIngestCaptureHandler(engine);
    const ev = makeEvent({ content: 'metadata slug', metadata: { slug: 'inbox/custom-from-meta' } });
    const result = await handler(makeJob({ event: ev }));
    expect(result.slug).toBe('inbox/custom-from-meta');
  });

  test('falls back to inbox/YYYY-MM-DD-<hash6> when no slug provided', async () => {
    const handler = makeIngestCaptureHandler(engine);
    const ev = makeEvent({ content: 'fallback slug' });
    const result = await handler(makeJob({ event: ev }));
    expect(result.slug).toMatch(/^inbox\/\d{4}-\d{2}-\d{2}-[a-f0-9]{6}$/);
  });
});

describe('ingest_capture handler — validation + routing', () => {
  test('throws when event missing', async () => {
    const handler = makeIngestCaptureHandler(engine);
    await expect(handler(makeJob({}))).rejects.toThrow(/job.data.event is required/);
  });

  test('throws on invalid event payload (caught at the handler boundary)', async () => {
    const handler = makeIngestCaptureHandler(engine);
    const ev = { ...makeEvent(), content_hash: 'short' };
    await expect(handler(makeJob({ event: ev }))).rejects.toThrow(/invalid event payload/);
  });

  test('rejects a durable job whose target source disagrees with the event', async () => {
    const handler = makeIngestCaptureHandler(engine);
    const ev = makeEvent({ content: 'source mismatch' });
    await expect(
      handler(makeJob({ event: ev, sourceId: 'default', remote: true })),
    ).rejects.toThrow(/sourceId does not match event\.source_id/);
  });

  test('rejects a legacy/spoofed false/false row without the queue-owned local marker', async () => {
    const handler = makeIngestCaptureHandler(engine);
    const ev = makeEvent({ content: 'forged trust downgrade', untrusted_payload: false });
    const job = makeJob({ event: ev });
    job.data = { event: ev, sourceId: 'webhook-test', remote: false };
    await expect(handler(job)).rejects.toThrow(/missing trusted local marker/);
  });

  test('queue strips a forged local marker and stamps it only via trusted options', async () => {
    await engine.setConfig('version', '7');
    const queue = new MinionQueue(engine);
    const ev = makeEvent({ content: 'queue trust boundary', untrusted_payload: false });

    const forged = await queue.add('ingest_capture', {
      event: ev,
      sourceId: 'webhook-test',
      remote: false,
      [TRUSTED_LOCAL_INGEST_MARKER]: true,
    });
    expect(forged.data[TRUSTED_LOCAL_INGEST_MARKER]).toBeUndefined();
    const forgedJob = makeJob({});
    forgedJob.data = forged.data;
    await expect(makeIngestCaptureHandler(engine)(forgedJob)).rejects.toThrow(
      /missing trusted local marker/,
    );

    const trusted = await queue.add(
      'ingest_capture',
      { event: ev, sourceId: 'webhook-test', remote: false },
      undefined,
      { allowTrustedLocalIngest: true },
    );
    expect(trusted.data[TRUSTED_LOCAL_INGEST_MARKER]).toBe(true);
    const trustedJob = makeJob({});
    trustedJob.data = trusted.data;
    await expect(makeIngestCaptureHandler(engine)(trustedJob)).resolves.toMatchObject({
      untrusted_payload: false,
    });
  });

  test('local jobs submit stamps trust out of band and reaches the worker', async () => {
    await engine.setConfig('version', '7');
    const ev = makeEvent({ content: 'local CLI trust boundary', untrusted_payload: false });

    await runJobs(engine, [
      'submit',
      'ingest_capture',
      '--params',
      JSON.stringify({
        event: ev,
        // A caller-provided marker must not be the source of trust. The queue
        // strips this value before stamping its own out-of-band marker.
        [TRUSTED_LOCAL_INGEST_MARKER]: 'forged-caller-value',
      }),
    ]);

    const rows = await engine.executeRaw<{ data: Record<string, unknown> }>(
      `SELECT data FROM minion_jobs WHERE name = 'ingest_capture' ORDER BY id DESC LIMIT 1`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.data.remote).toBe(false);
    expect(rows[0]?.data[TRUSTED_LOCAL_INGEST_MARKER]).toBe(true);

    const queuedJob = makeJob({});
    queuedJob.data = rows[0]!.data;
    await expect(makeIngestCaptureHandler(engine)(queuedJob)).resolves.toMatchObject({
      untrusted_payload: false,
    });
  });

  test('rejects binary content_type with helpful message', async () => {
    const handler = makeIngestCaptureHandler(engine);
    const ev = makeEvent({
      content_type: 'image/*',
      content: '/path/to/screenshot.png',
      content_hash: computeContentHash('/path/to/screenshot.png'),
    });
    await expect(handler(makeJob({ event: ev }))).rejects.toThrow(
      /content_type 'image\/\*' requires a content-type processor/,
    );
  });

  test('untrusted_payload flag round-trips to the result', async () => {
    const handler = makeIngestCaptureHandler(engine);
    const ev = makeEvent({ content: 'untrusted', untrusted_payload: true });
    const result = await handler(makeJob({ event: ev }));
    expect(result.untrusted_payload).toBe(true);
  });

  test('trusted (default) payload round-trips as false', async () => {
    const handler = makeIngestCaptureHandler(engine);
    const ev = makeEvent({ content: 'trusted' });
    const result = await handler(makeJob({ event: ev }));
    expect(result.untrusted_payload).toBe(false);
  });

  test('source provenance round-trips into the result', async () => {
    const handler = makeIngestCaptureHandler(engine);
    const ev = makeEvent({
      content: 'with provenance',
      source_kind: 'inbox-folder',
      source_uri: '/Users/test/.gbrain/inbox/note.md',
    });
    const result = await handler(makeJob({ event: ev }));
    expect(result.source_kind).toBe('inbox-folder');
    expect(result.source_uri).toBe('/Users/test/.gbrain/inbox/note.md');
  });
});

describe('ingest_capture handler — integration with importFromContent', () => {
  test('imported event lands as a page in the DB', async () => {
    const handler = makeIngestCaptureHandler(engine);
    const ev = makeEvent({
      content: '---\ntitle: Test Page\n---\n\n# E2E import\n\nbody content',
    });
    const result = await handler(makeJob({ event: ev, slug: 'wiki/e2e-test' }));
    expect(result.status).toBe('imported');

    const page = await engine.getPage('wiki/e2e-test', { sourceId: 'webhook-test' });
    expect(page).not.toBeNull();
    expect(page?.compiled_truth).toContain('E2E import');
  });

  test('persists authenticated source and evidence provenance on the page', async () => {
    const handler = makeIngestCaptureHandler(engine);
    const ev = makeEvent({
      content: '# provenance proof',
      source_kind: 'webhook',
      source_uri: 'https://example.test/evidence/42',
      untrusted_payload: true,
    });

    await handler(makeJob({
      event: ev,
      sourceId: 'webhook-test',
      slug: 'inbox/provenance-proof',
      remote: true,
    }));

    const page = await engine.getPage('inbox/provenance-proof', { sourceId: 'webhook-test' });
    expect(page).not.toBeNull();
    expect(page?.source_id).toBe('webhook-test');
    expect(page?.source_kind).toBe('webhook');
    expect(page?.source_uri).toBe('https://example.test/evidence/42');
    expect(page?.ingested_via).toBe('http:ingest');
    expect(page?.ingested_at).not.toBeNull();
    expect(await engine.getPage('inbox/provenance-proof', { sourceId: 'default' })).toBeNull();
  });

  test('remote/untrusted ingest cannot persist trust-owned frontmatter markers', async () => {
    const handler = makeIngestCaptureHandler(engine);
    const content = [
      '---',
      'title: Untrusted evidence',
      'quarantine: forged',
      'embed_skip: forged',
      'content_flag:',
      '  reason: forged',
      '---',
      '',
      '# Safe evidence body',
    ].join('\n');
    const ev = makeEvent({
      content,
      content_hash: computeContentHash(content),
      untrusted_payload: true,
    });

    await handler(makeJob({
      event: ev,
      sourceId: 'webhook-test',
      slug: 'inbox/trust-proof',
      remote: true,
    }));

    const page = await engine.getPage('inbox/trust-proof', { sourceId: 'webhook-test' });
    expect(page).not.toBeNull();
    expect(page?.frontmatter).not.toHaveProperty('quarantine');
    expect(page?.frontmatter).not.toHaveProperty('embed_skip');
    expect(page?.frontmatter).not.toHaveProperty('content_flag');
    expect(page?.compiled_truth).toContain('Safe evidence body');
  });

  test('repeat ingest of same content returns skipped status (content_hash dedup at importFromContent level)', async () => {
    const handler = makeIngestCaptureHandler(engine);
    const ev = makeEvent({ content: '# stable content' });
    const result1 = await handler(makeJob({ event: ev, slug: 'wiki/stable' }));
    expect(result1.status).toBe('imported');

    const result2 = await handler(makeJob({ event: ev, slug: 'wiki/stable' }));
    expect(result2.status).toBe('skipped');
  });

  test('chunks count is reported on imported events', async () => {
    const handler = makeIngestCaptureHandler(engine);
    const longContent = '---\ntitle: long\n---\n\n' + 'Paragraph.\n\n'.repeat(50);
    const ev = makeEvent({ content: longContent });
    const result = await handler(makeJob({ event: ev, slug: 'wiki/long' }));
    expect(result.chunks).toBeGreaterThan(0);
  });
});
