import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerBuiltinHandlers } from '../src/commands/jobs.ts';
import { configureGateway, resetGateway } from '../src/core/ai/gateway.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';

let engine: PGLiteEngine;
let home: string;
let oldHome: string | undefined;
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

beforeEach(() => {
  oldHome = process.env.GBRAIN_HOME;
  home = mkdtempSync(join(tmpdir(), 'gbrain-job-preflight-'));
  process.env.GBRAIN_HOME = home;
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, 'config.json'), JSON.stringify({
    engine: 'pglite',
    database_path: join(home, 'brain'),
    embedding_model: 'openai:text-embedding-3-small',
    embedding_dimensions: 1536,
  }));
  delete process.env.OPENAI_API_KEY;
  configureGateway({
    embedding_model: 'openai:text-embedding-3-small',
    embedding_dimensions: 1536,
    env: {},
  });
});

afterEach(() => {
  resetGateway();
  if (oldHome === undefined) delete process.env.GBRAIN_HOME;
  else process.env.GBRAIN_HOME = oldHome;
  rmSync(home, { recursive: true, force: true });
});

afterAll(async () => engine.disconnect());

test('missing embedding credentials fail one job with a typed receipt and do not kill the worker', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gbrain-job-preflight-corpus-'));
  try {
    writeFileSync(join(dir, 'page.md'), '# Page\n\nEvidence.\n');
    let caught: (Error & { exitCode?: number; importResult?: { status: string; code: string } }) | null = null;
    try { await importHandler!({ data: { dir } }); } catch (error) { caught = error as typeof caught; }
    expect(caught).not.toBeNull();
    const failure = caught as unknown as Error & { exitCode?: number; importResult?: { status: string; code: string } };
    expect(failure.exitCode).toBe(1);
    expect(failure.importResult).toMatchObject({
      status: 'failed',
      code: 'embedding_credentials_missing',
    });

    const next = await importHandler!({ data: { dir, noEmbed: true } });
    expect(next.status).toBe('success');
    expect(next.exitCode).toBe(0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
