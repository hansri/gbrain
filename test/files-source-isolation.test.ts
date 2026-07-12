import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  spyOn,
  test,
} from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runFiles } from '../src/commands/files.ts';
import { contentAddressedStoragePath } from '../src/core/file-storage-publish.ts';
import { resolveFile } from '../src/core/file-resolver.ts';
import { operationsByName, type OperationContext } from '../src/core/operations.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { LocalStorage } from '../src/core/storage/local.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { withEnv } from './helpers/with-env.ts';

let engine: PGLiteEngine;
let scratch: string[] = [];

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  // This suite exercises the post-canary capability. The release schema keeps
  // the legacy global constraint temporarily so the previous binary remains a
  // valid rollback target.
  await engine.executeRaw('ALTER TABLE files DROP CONSTRAINT IF EXISTS files_storage_path_key');
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
  await engine.executeRaw(
    `INSERT INTO sources (id, name, config)
     VALUES ('source-a', 'source-a', '{}'::jsonb),
            ('source-b', 'source-b', '{}'::jsonb)`,
  );
});

afterEach(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
  scratch = [];
});

function ctx(sourceId: string, storageRoot?: string): OperationContext {
  return {
    engine,
    config: {
      engine: 'pglite',
      ...(storageRoot ? {
        storage: { backend: 'local', bucket: 'test', localPath: storageRoot },
      } : {}),
    },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    dryRun: false,
    remote: false,
    sourceId,
  };
}

async function seedSharedPath(): Promise<void> {
  await engine.upsertFile({
    source_id: 'source-a',
    filename: 'shared.bin',
    storage_path: 'shared/shared.bin',
    content_hash: 'sha256:a',
  });
  await engine.upsertFile({
    source_id: 'source-b',
    filename: 'shared.bin',
    storage_path: 'shared/shared.bin',
    content_hash: 'sha256:b',
  });
}

describe('files source isolation', () => {
  test('CLI list derives one exact source and prints source-qualified rows', async () => {
    await seedSharedPath();
    const lines: string[] = [];
    const log = spyOn(console, 'log').mockImplementation((value?: unknown) => {
      lines.push(String(value));
    });
    try {
      await runFiles(engine, ['list', '--source', 'source-a']);
    } finally {
      log.mockRestore();
    }

    expect(lines.some(line => line.includes('[source-a]'))).toBe(true);
    expect(lines.some(line => line.includes('[source-b]'))).toBe(false);
  });

  test('CLI sync does not treat another source same-path row as its checkpoint', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-file-source-'));
    scratch.push(dir);
    const storageRoot = mkdtempSync(join(tmpdir(), 'gbrain-file-storage-'));
    scratch.push(storageRoot);
    const gbrainHome = mkdtempSync(join(tmpdir(), 'gbrain-file-home-'));
    scratch.push(gbrainHome);
    mkdirSync(join(gbrainHome, '.gbrain'), { recursive: true });
    writeFileSync(join(gbrainHome, '.gbrain', 'config.json'), JSON.stringify({
      engine: 'pglite',
      storage: { backend: 'local', bucket: 'test', localPath: storageRoot },
    }));
    writeFileSync(join(dir, 'shared.bin'), 'source-a bytes');

    await engine.upsertFile({
      source_id: 'source-b',
      filename: 'shared.bin',
      storage_path: 'source-b/shared.bin',
      content_hash: 'source-b-hash',
    });

    const log = spyOn(console, 'log').mockImplementation(() => {});
    try {
      await withEnv({ GBRAIN_HOME: gbrainHome }, async () => {
        await runFiles(engine, ['sync', dir, '--source=source-a']);
      });
    } finally {
      log.mockRestore();
    }

    const expected = createHash('sha256').update('source-a bytes').digest('hex');
    const expectedPath = contentAddressedStoragePath('source-a', 'shared.bin', expected);
    expect((await engine.getFile('source-a', expectedPath))?.content_hash).toBe(expected);
    expect((await engine.getFile('source-b', 'source-b/shared.bin'))?.content_hash).toBe('source-b-hash');
    expect(existsSync(join(storageRoot, expectedPath))).toBe(true);
  });

  test('file_list and file_url never return a same-path row from another source', async () => {
    await seedSharedPath();

    const listA = await operationsByName.file_list.handler(ctx('source-a'), {}) as Array<{
      source_id: string;
      content_hash: string;
    }>;
    expect(listA).toHaveLength(1);
    expect(listA[0]).toMatchObject({ source_id: 'source-a', content_hash: 'sha256:a' });

    const urlA = await operationsByName.file_url.handler(ctx('source-a'), {
      storage_path: 'shared/shared.bin',
    }) as { source_id: string; url: string };
    expect(urlA.source_id).toBe('source-a');
    expect(urlA.url).toBe('gbrain:files/source-a/shared/shared.bin');

    await expect(
      operationsByName.file_url.handler(ctx('default'), {
        storage_path: 'shared/shared.bin',
      }),
    ).rejects.toThrow(/File not found/);
  });

  test('file_upload gives equal logical files different source-prefixed object keys', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-file-upload-'));
    scratch.push(dir);
    const storageRoot = mkdtempSync(join(tmpdir(), 'gbrain-file-storage-'));
    scratch.push(storageRoot);
    const path = join(dir, 'same.pdf');
    const content = 'same source-qualified bytes';
    writeFileSync(path, content);
    const hash = createHash('sha256').update(content).digest('hex');
    const logicalPath = `unsorted/${hash.slice(0, 8)}-same.pdf`;
    const sourceAPath = contentAddressedStoragePath('source-a', logicalPath, hash);
    const sourceBPath = contentAddressedStoragePath('source-b', logicalPath, hash);

    const resultA = await operationsByName.file_upload.handler(ctx('source-a', storageRoot), {
      path,
    }) as { source_id: string; storage_path: string };
    const resultB = await operationsByName.file_upload.handler(ctx('source-b', storageRoot), {
      path,
    }) as { source_id: string; storage_path: string };

    expect(resultA).toMatchObject({ source_id: 'source-a', storage_path: sourceAPath });
    expect(resultB).toMatchObject({ source_id: 'source-b', storage_path: sourceBPath });
    expect(sourceAPath).not.toBe(sourceBPath);
    expect((await engine.getFile('source-a', sourceAPath))?.content_hash).toBe(hash);
    expect((await engine.getFile('source-b', sourceBPath))?.content_hash).toBe(hash);
    expect(existsSync(join(storageRoot, sourceAPath))).toBe(true);
    expect(existsSync(join(storageRoot, sourceBPath))).toBe(true);
    expect(existsSync(join(storageRoot, logicalPath))).toBe(false);
  });

  test('wrong-source mirror lifecycle commands have zero filesystem or storage effects', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-file-wrong-source-'));
    scratch.push(dir);
    const storageRoot = mkdtempSync(join(tmpdir(), 'gbrain-file-wrong-source-store-'));
    scratch.push(storageRoot);
    const home = mkdtempSync(join(tmpdir(), 'gbrain-file-wrong-source-home-'));
    scratch.push(home);
    mkdirSync(join(home, '.gbrain'), { recursive: true });
    writeFileSync(join(home, '.gbrain', 'config.json'), JSON.stringify({
      engine: 'pglite',
      storage: { backend: 'local', bucket: 'test', localPath: storageRoot },
    }));
    const original = join(dir, 'source-b.bin');
    const marker = join(dir, '.supabase');
    writeFileSync(original, 'source-b local bytes');
    writeFileSync(marker, [
      'bucket: test',
      'source_id: source-b',
      'prefix: source-b/',
      'file_count: 1',
      '',
    ].join('\n'));
    const markerBefore = readFileSync(marker);

    await withEnv({ GBRAIN_HOME: home }, async () => {
      await expect(runFiles(engine, ['redirect', dir, '--source', 'source-a']))
        .rejects.toThrow(/source mismatch/);
      await expect(runFiles(engine, ['clean', dir, '--yes', '--source', 'source-a']))
        .rejects.toThrow(/source mismatch/);
      await expect(runFiles(engine, ['unmirror', dir, '--source', 'source-a']))
        .rejects.toThrow(/source mismatch/);
    });

    expect(readFileSync(original, 'utf8')).toBe('source-b local bytes');
    expect(readFileSync(marker).equals(markerBefore)).toBe(true);
    expect(existsSync(`${original}.redirect.yaml`)).toBe(false);
    expect(readdirSync(storageRoot)).toEqual([]);
  });

  test('upload-raw writes a source-qualified pointer consumed only by that source', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-file-upload-raw-source-'));
    scratch.push(dir);
    const storageRoot = mkdtempSync(join(tmpdir(), 'gbrain-file-upload-raw-source-store-'));
    scratch.push(storageRoot);
    const home = mkdtempSync(join(tmpdir(), 'gbrain-file-upload-raw-source-home-'));
    scratch.push(home);
    mkdirSync(join(home, '.gbrain'), { recursive: true });
    writeFileSync(join(home, '.gbrain', 'config.json'), JSON.stringify({
      engine: 'pglite',
      storage: { backend: 'local', bucket: 'test', localPath: storageRoot },
    }));
    const image = join(dir, 'diagram.png');
    const bytes = Buffer.from('small media still routes to storage');
    writeFileSync(image, bytes);

    await withEnv({ GBRAIN_HOME: home }, async () => {
      await runFiles(engine, [
        'upload-raw', image, '--page', 'docs/example', '--source', 'source-a',
      ]);
    });

    const pointer = readFileSync(`${image}.redirect.yaml`, 'utf8');
    expect(pointer).toContain('source_id: source-a');
    expect(pointer).toContain('storage_path: source-a/');
    const storage = new LocalStorage(storageRoot);
    const resolved = await resolveFile('diagram.png', dir, storage, 'source-a');
    expect(resolved.data.equals(bytes)).toBe(true);
    await expect(resolveFile('diagram.png', dir, storage, 'source-b'))
      .rejects.toThrow(/source mismatch/);
  });
});
