/**
 * v0.39 trust-boundary contract test (GAP 3 of the e2e-test-wave audit).
 *
 * Hybrid design (D7 — pure + targeted handler invocation):
 *
 *   - Pure assertions over ALL operations (~74 ops): scope annotations
 *     present + correct; localOnly ops are filtered out of the canonical
 *     mcpOperations list; hasScope semantics work for the standard tiers.
 *
 *   - Handler-invocation cases for sensitive handlers that retain a
 *     defense-in-depth remote check even when transport filtering should make
 *     the path unreachable:
 *
 *       * submit_job   — every name + ctx.remote=true MUST reject
 *                        (generic maintenance submission is host-local)
 *       * search_by_image — image_path + ctx.remote=true MUST reject
 *                        (D18 P0 source-isolation leak class)
 *
 *     The other local-only operations are covered by the structural filter
 *     contract; submit_job gets an additional direct-handler regression
 *     because caller-controlled queue payloads are especially sensitive.
 *
 * Criterion for the curated sensitive-ops list:
 *   ops whose HANDLER (not transport) has been broken historically.
 *   Add an op here when a real exploit class is fixed at the handler level.
 *
 * Companion guard at scripts/check-operations-filter-bypass.sh enforces
 * the canonical filter site so a future HTTP route can't bypass it.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { operations, type OperationContext } from '../src/core/operations.ts';
import { hasScope } from '../src/core/scope.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
});

// Minimal context factory — every test that invokes a handler builds
// one of these. Defaults to remote=true (untrusted) because that's the
// trust posture the bug-class regressions live in; tests opt back to
// local trust by overriding remote=false.
function makeContext(overrides: Partial<OperationContext> = {}): OperationContext {
  return {
    engine: engine as any,
    config: {} as any,
    logger: console as any,
    dryRun: false,
    remote: true,
    sourceId: 'default',
    ...overrides,
  };
}

describe('operations contract — every op has scope + correct mutability shape', () => {
  test('every op declares a scope annotation', () => {
    for (const op of operations) {
      expect(op.scope, `op "${op.name}" missing scope annotation`).toBeDefined();
    }
  });

  test('every mutating op has a write-class scope (not "read")', () => {
    const WRITE_CLASS_SCOPES = new Set([
      'write',
      'admin',
      'sources_admin',
      'users_admin',
      'agent',
    ]);
    for (const op of operations) {
      if (op.mutating === true) {
        expect(
          WRITE_CLASS_SCOPES.has(op.scope ?? 'read'),
          `mutating op "${op.name}" has read-tier scope "${op.scope}"; expected one of ${[...WRITE_CLASS_SCOPES].join('/')}`,
        ).toBe(true);
      }
    }
  });

  test('scope is one of the documented enum values', () => {
    const KNOWN_SCOPES = new Set([
      'read',
      'write',
      'admin',
      'sources_admin',
      'users_admin',
      'agent',
    ]);
    for (const op of operations) {
      expect(
        KNOWN_SCOPES.has(op.scope!),
        `op "${op.name}" has unknown scope "${op.scope}"`,
      ).toBe(true);
    }
  });
});

describe('mcpOperations filter — localOnly ops are excluded from the HTTP-exposed surface', () => {
  // This filter is what serve-http.ts uses to build the tools/list response:
  //   const mcpOperations = operations.filter(op => !op.localOnly);
  // A localOnly op that leaks into mcpOperations is exposed via HTTP MCP
  // and bypasses the trust boundary. Pin the filter contract here so a
  // regression surfaces as a structural test failure.

  test('the canonical filter excludes every localOnly op', () => {
    const mcpOps = operations.filter(op => !op.localOnly);
    const mcpNames = new Set(mcpOps.map(op => op.name));
    const localOnlyOps = operations.filter(op => op.localOnly === true);

    expect(localOnlyOps.length).toBeGreaterThan(0);
    for (const op of localOnlyOps) {
      expect(
        mcpNames.has(op.name),
        `localOnly op "${op.name}" leaked into the HTTP MCP surface`,
      ).toBe(false);
    }
  });

  test('known historically-sensitive localOnly ops stay filtered', () => {
    // Pin every localOnly op by name so a refactor that flips localOnly off
    // on any of them fails this test even if the generic contract above
    // somehow regresses. Codex /ship review caught the original 4-name
    // snapshot was missing purge_deleted_pages, get_recent_transcripts, and
    // code_traversal_cache_clear — additions that already qualified.
    //
    // When adding a NEW localOnly op: add its name here too. The generic
    // contract above proves the filter rule applies; this list proves the
    // specific ops we care about haven't silently shed their localOnly flag.
    const KNOWN_LOCAL_ONLY = [
      'sync_brain',
      'file_upload',
      'file_list',
      'file_url',
      'purge_deleted_pages',
      'get_recent_transcripts',
      'code_traversal_cache_clear',
      'submit_job',
    ];
    const lookup = new Map(operations.map(op => [op.name, op] as const));
    for (const name of KNOWN_LOCAL_ONLY) {
      const op = lookup.get(name);
      expect(op, `expected canonical op "${name}" to still exist`).toBeDefined();
      expect(op!.localOnly, `"${name}" must stay localOnly`).toBe(true);
    }
  });
});

describe('hasScope — read-only token cannot satisfy write or admin scopes', () => {
  // The HTTP path computes `requiredScope = op.scope || 'read'` and gates
  // every call on `hasScope(authInfo.scopes, requiredScope)`. Pin the
  // semantics here so a refactor of the IMPLIES table can't silently
  // grant admin via a read-class token.
  test('read scope does NOT satisfy write', () => {
    expect(hasScope(['read'], 'write')).toBe(false);
  });

  test('read scope does NOT satisfy admin', () => {
    expect(hasScope(['read'], 'admin')).toBe(false);
  });

  test('write scope satisfies write AND read', () => {
    expect(hasScope(['write'], 'write')).toBe(true);
    expect(hasScope(['write'], 'read')).toBe(true);
  });

  test('admin scope satisfies admin, write, AND read (umbrella implies)', () => {
    expect(hasScope(['admin'], 'admin')).toBe(true);
    expect(hasScope(['admin'], 'write')).toBe(true);
    expect(hasScope(['admin'], 'read')).toBe(true);
  });

  test('unknown scope strings are ignored, do not satisfy anything', () => {
    expect(hasScope(['bogus'], 'read')).toBe(false);
    expect(hasScope(['bogus'], 'write')).toBe(false);
  });

  test('every read-scope op accepts a read-only token; every write-scope op rejects it', () => {
    // Walk the op surface and assert that a synthetic read-only token
    // satisfies every read-scope op but no write/admin op.
    const READ_TOKEN_SCOPES = ['read'] as const;
    for (const op of operations) {
      const required = op.scope ?? 'read';
      const accepted = hasScope(READ_TOKEN_SCOPES, required);
      if (required === 'read') {
        expect(accepted, `read op "${op.name}" should accept read-only token`).toBe(true);
      } else {
        expect(accepted, `${required} op "${op.name}" must reject read-only token`).toBe(false);
      }
    }
  });
});

describe('handler invocation — sensitive trust-boundary classes', () => {
  // submit_job is localOnly and also rejects direct remote invocation as
  // defense in depth. search_by_image remains remotely callable, but never
  // accepts a server-local image path from an untrusted caller.

  test('submit_job rejects every job type with ctx.remote=true', async () => {
    const submitJob = operations.find(op => op.name === 'submit_job');
    expect(submitJob).toBeDefined();
    expect(submitJob!.localOnly).toBe(true);
    for (const [name, data] of [
      ['shell', { cmd: 'echo hi' }],
      ['import', { dir: '/etc' }],
      ['reindex', { repoPath: '/srv/private' }],
      ['ingest_capture', { remote: false, event: { untrusted_payload: false } }],
    ] as const) {
      await expect(
        submitJob!.handler(makeContext({ remote: true }), { name, data }),
      ).rejects.toMatchObject({ code: 'permission_denied' });
    }
  });

  test('submit_job allows shell when ctx.remote=false (local CLI is trusted)', async () => {
    // The flip side of the trust boundary: a local trusted caller with
    // explicit remote=false MUST be allowed to submit shell jobs (that's
    // how the CLI works in production). We don't actually want to run the
    // job — pass dryRun so the op short-circuits.
    const submitJob = operations.find(op => op.name === 'submit_job');
    const ctx = makeContext({ remote: false, dryRun: true });

    const result = await submitJob!.handler(ctx, { name: 'shell', data: { cmd: 'echo hi' } });
    expect(result).toMatchObject({ dry_run: true, action: 'submit_job', name: 'shell' });
  });

  test('local submit_job overwrites caller sourceId with ctx.sourceId', async () => {
    // resetPgliteState preserves the base schema marker (v1), while the
    // minion queue intentionally refuses to run below its migration gate.
    // The fixture schema already contains minion_jobs, so advance only to the
    // queue's minimum supported version for this handler-level contract test.
    await engine.setConfig('version', '7');
    const submitJob = operations.find(op => op.name === 'submit_job')!;
    const ctx = makeContext({ remote: false, sourceId: 'trusted-source' });
    const result = await submitJob.handler(ctx, {
      name: 'import',
      data: { dir: '/tmp/fixture', sourceId: 'spoofed-source', noEmbed: true },
    }) as { id: number };
    const rows = await engine.executeRaw<{ data: Record<string, unknown> }>(
      `SELECT data FROM minion_jobs WHERE id = $1`,
      [result.id],
    );
    expect(rows[0]?.data.sourceId).toBe('trusted-source');
  });

  test('search_by_image rejects image_path with ctx.remote=true (D18 P0)', async () => {
    const searchByImage = operations.find(op => op.name === 'search_by_image');
    expect(searchByImage).toBeDefined();
    const ctx = makeContext({ remote: true });

    let threw = false;
    let message = '';
    try {
      await searchByImage!.handler(ctx, { image_path: '/tmp/some-image.png' });
    } catch (e) {
      threw = true;
      message = e instanceof Error ? e.message : String(e);
    }
    expect(threw, 'search_by_image(image_path) with remote=true MUST reject').toBe(true);
    expect(message.toLowerCase()).toContain('image_path');
    expect(message.toLowerCase()).toContain('permission_denied');
  });
});
