import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { registerBuiltinHandlers } from '../src/commands/jobs.ts';

let engine: PGLiteEngine;
let importHandler: ((job: any) => Promise<any>) | undefined;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  const handlers = new Map<string, (job: any) => Promise<any>>();
  await registerBuiltinHandlers({
    register(name: string, fn: (job: any) => Promise<any>) { handlers.set(name, fn); },
  } as never, engine, { quiet: true });
  importHandler = handlers.get('import');
});

afterAll(async () => {
  await engine.disconnect();
});

describe('background import job result propagation', () => {
  test('returns the real successful runImport status and exit code', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-job-import-ok-'));
    try {
      writeFileSync(join(dir, 'good.md'), '# Good\n\nUseful evidence.\n');
      const result = await importHandler!({ data: { dir, noEmbed: true } });
      expect(result.status).toBe('success');
      expect(result.exitCode).toBe(0);
      expect(result.imported).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('throws a failed job with the partial runImport receipt attached', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-job-import-partial-'));
    try {
      writeFileSync(
        join(dir, 'bad.md'),
        '---\nslug: another-slug\ntitle: Bad\n---\n\nThis path and slug disagree.\n',
      );
      let caught: (Error & { exitCode?: number; importResult?: { status: string; exitCode: number } }) | null = null;
      try {
        await importHandler!({ data: { dir, noEmbed: true } });
      } catch (error) {
        caught = error as typeof caught;
      }
      expect(caught).not.toBeNull();
      expect(caught!.exitCode).toBe(1);
      expect(caught!.importResult?.status).toBe('partial_failure');
      expect(caught!.importResult?.exitCode).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('validation failures are typed and a subsequent job still runs in the same worker', async () => {
    for (const [data, code] of [
      [{ noEmbed: true }, 'missing_directory'],
      [{ dir: join(tmpdir(), 'does-not-exist-gbrain-job'), noEmbed: true }, 'invalid_directory'],
      [{ dir: tmpdir(), noEmbed: true, workers: 0 }, 'invalid_workers'],
    ] as const) {
      let caught: (Error & { exitCode?: number; importResult?: { status: string; code: string } }) | null = null;
      try { await importHandler!({ data }); } catch (error) { caught = error as typeof caught; }
      expect(caught).not.toBeNull();
      const failure = caught as unknown as Error & { exitCode?: number; importResult?: { status: string; code: string } };
      expect(failure.exitCode).toBe(1);
      expect(failure.importResult).toMatchObject({ status: 'failed', code });
    }

    const dir = mkdtempSync(join(tmpdir(), 'gbrain-job-import-after-reject-'));
    try {
      writeFileSync(join(dir, 'still-alive.md'), '# Still alive\n\nThe worker survived.\n');
      const result = await importHandler!({ data: { dir, noEmbed: true } });
      expect(result.status).toBe('success');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
