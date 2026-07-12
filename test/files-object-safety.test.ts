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
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  replaceLocalWithRedirectDurable,
  promoteRestoredFileAtomic,
  readRedirectOriginalSnapshot,
  retireRedirectAfterRestoredPromotion,
  retireOwnedRedirectPointer,
  runFiles,
  type RedirectDurabilityStep,
} from '../src/commands/files.ts';
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
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
});

afterEach(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
  scratch = [];
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratch.push(dir);
  return dir;
}

function operationContext(storageRoot?: string): OperationContext {
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
    sourceId: 'default',
  };
}

function writeConfig(home: string, storageRoot?: string): void {
  mkdirSync(join(home, '.gbrain'), { recursive: true });
  writeFileSync(join(home, '.gbrain', 'config.json'), JSON.stringify({
    engine: 'pglite',
    ...(storageRoot ? {
      storage: { backend: 'local', bucket: 'test', localPath: storageRoot },
    } : {}),
  }));
}

describe('files object-storage crash safety', () => {
  test('file_upload fails closed and writes no DB metadata without storage', async () => {
    const dir = tempDir('gbrain-files-no-storage-');
    const filePath = join(dir, 'report.pdf');
    writeFileSync(filePath, 'report bytes');

    await expect(operationsByName.file_upload.handler(operationContext(), {
      path: filePath,
    })).rejects.toThrow(/No storage backend configured/);

    const rows = await engine.executeRaw<{ count: number }>('SELECT COUNT(*)::int AS count FROM files');
    expect(rows[0]?.count).toBe(0);
  });

  test('changed content uploads an immutable revision before one DB pointer switch', async () => {
    const dir = tempDir('gbrain-files-replace-');
    const storageRoot = tempDir('gbrain-files-store-');
    const filePath = join(dir, 'report.pdf');
    await engine.putPage('docs/report', {
      type: 'note', title: 'Report', compiled_truth: '',
    });

    const firstBytes = Buffer.from('first revision');
    writeFileSync(filePath, firstBytes);
    const firstHash = createHash('sha256').update(firstBytes).digest('hex');
    const logicalPath = 'docs/report/report.pdf';
    const firstPath = contentAddressedStoragePath('default', logicalPath, firstHash);
    const first = await operationsByName.file_upload.handler(operationContext(storageRoot), {
      path: filePath,
      page_slug: 'docs/report',
    }) as { storage_path: string };
    expect(first.storage_path).toBe(firstPath);

    const secondBytes = Buffer.from('second revision');
    writeFileSync(filePath, secondBytes);
    const secondHash = createHash('sha256').update(secondBytes).digest('hex');
    const secondPath = contentAddressedStoragePath('default', logicalPath, secondHash);
    const second = await operationsByName.file_upload.handler(operationContext(storageRoot), {
      path: filePath,
      page_slug: 'docs/report',
    }) as { storage_path: string };

    expect(second.storage_path).toBe(secondPath);
    expect(secondPath).not.toBe(firstPath);
    const rows = await engine.executeRaw<{
      storage_path: string;
      content_hash: string;
      logical_path: string;
    }>(
      `SELECT storage_path, content_hash, metadata->>'logical_path' AS logical_path
         FROM files
        WHERE source_id = 'default'`,
    );
    expect(rows).toEqual([{
      storage_path: secondPath,
      content_hash: secondHash,
      logical_path: logicalPath,
    }]);
    // Inline GC is intentionally absent. A crash after the DB switch leaves a
    // harmless old object, never a dangling pointer.
    expect(existsSync(join(storageRoot, firstPath))).toBe(true);
    expect(existsSync(join(storageRoot, secondPath))).toBe(true);
  });

  test('DB failure leaves the previously referenced object and pointer intact', async () => {
    const dir = tempDir('gbrain-files-db-fail-');
    const storageRoot = tempDir('gbrain-files-db-fail-store-');
    const filePath = join(dir, 'critical.pdf');
    await engine.putPage('docs/critical', {
      type: 'note', title: 'Critical', compiled_truth: '',
    });

    const firstBytes = Buffer.from('committed bytes');
    writeFileSync(filePath, firstBytes);
    const logicalPath = 'docs/critical/critical.pdf';
    const firstHash = createHash('sha256').update(firstBytes).digest('hex');
    const firstPath = contentAddressedStoragePath('default', logicalPath, firstHash);
    await operationsByName.file_upload.handler(operationContext(storageRoot), {
      path: filePath,
      page_slug: 'docs/critical',
    });

    const secondBytes = Buffer.from('uncommitted bytes');
    writeFileSync(filePath, secondBytes);
    const secondHash = createHash('sha256').update(secondBytes).digest('hex');
    const secondPath = contentAddressedStoragePath('default', logicalPath, secondHash);
    const transaction = spyOn(engine, 'transaction').mockImplementation(async () => {
      throw new Error('simulated DB commit failure');
    });
    try {
      await expect(operationsByName.file_upload.handler(operationContext(storageRoot), {
        path: filePath,
        page_slug: 'docs/critical',
      })).rejects.toThrow('simulated DB commit failure');
    } finally {
      transaction.mockRestore();
    }

    const row = await engine.getFile('default', firstPath);
    expect(row?.content_hash).toBe(firstHash);
    expect(existsSync(join(storageRoot, firstPath))).toBe(true);
    // The failed revision may remain orphaned for later GC; deleting it in
    // rollback would be unsafe because a retry could already reference it.
    expect(existsSync(join(storageRoot, secondPath))).toBe(true);
  });

  test('redirect repairs stale remote bytes and verifies them before unlink', async () => {
    const dir = tempDir('gbrain-files-redirect-');
    const storageRoot = tempDir('gbrain-files-redirect-store-');
    const home = tempDir('gbrain-files-redirect-home-');
    writeConfig(home, storageRoot);
    const filePath = join(dir, 'archive.bin');
    const localBytes = Buffer.from('current exact archive');
    writeFileSync(filePath, localBytes);
    writeFileSync(join(dir, '.supabase'), [
      'bucket: test',
      'source_id: default',
      'prefix: default/',
      'file_count: 1',
      '',
    ].join('\n'));
    const storagePath = 'default/archive.bin';
    const storage = new LocalStorage(storageRoot);
    // Same size but different bytes proves redirect checks the hash too, not
    // only object existence or Content-Length.
    await storage.upload(storagePath, Buffer.alloc(localBytes.byteLength, 0x78));

    await withEnv({ GBRAIN_HOME: home }, async () => {
      await runFiles(engine, ['redirect', dir]);
      // A retry after a crash/restart must ignore its own breadcrumb instead
      // of recursively redirecting and deleting it.
      await runFiles(engine, ['redirect', dir]);
    });

    expect(existsSync(filePath)).toBe(false);
    expect(existsSync(`${filePath}.redirect.yaml`)).toBe(true);
    expect((await storage.download(storagePath)).equals(localBytes)).toBe(true);
    const pointer = readFileSync(`${filePath}.redirect.yaml`, 'utf-8');
    expect(pointer).toContain(`size: ${localBytes.byteLength}`);
    expect(pointer).toContain(`hash: sha256:${createHash('sha256').update(localBytes).digest('hex')}`);
  });

  test('redirect without storage leaves the only local copy untouched', async () => {
    const dir = tempDir('gbrain-files-redirect-closed-');
    const home = tempDir('gbrain-files-redirect-closed-home-');
    writeConfig(home);
    const filePath = join(dir, 'only-copy.bin');
    writeFileSync(filePath, 'only copy');
    writeFileSync(join(dir, '.supabase'), [
      'bucket: test',
      'source_id: default',
      'prefix: default/',
      'file_count: 1',
      '',
    ].join('\n'));

    await withEnv({ GBRAIN_HOME: home }, async () => {
      await expect(runFiles(engine, ['redirect', dir]))
        .rejects.toThrow(/No storage backend configured/);
    });

    expect(existsSync(filePath)).toBe(true);
    expect(existsSync(`${filePath}.redirect.yaml`)).toBe(false);
  });

  test('redirect replacement fsyncs pointer before unlink and fsyncs unlink after', () => {
    const dir = tempDir('gbrain-files-redirect-order-');
    const originalPath = join(dir, 'ordered.bin');
    const pointerPath = `${originalPath}.redirect.yaml`;
    writeFileSync(originalPath, 'only local copy');
    const steps: RedirectDurabilityStep[] = [];

    replaceLocalWithRedirectDurable(
      originalPath,
      pointerPath,
      'storage_path: default/ordered.bin\n',
      step => steps.push(step),
    );

    expect(steps).toEqual([
      'temp_fsynced',
      'pointer_renamed',
      'pointer_parent_fsynced',
      'original_quarantined',
      'quarantine_verified',
      'original_unlinked',
      'unlink_parent_fsynced',
    ]);
    expect(existsSync(originalPath)).toBe(false);
    expect(readFileSync(pointerPath, 'utf-8')).toContain('default/ordered.bin');
  });

  test('failure before pointer directory durability preserves the local original', () => {
    const dir = tempDir('gbrain-files-redirect-failure-');
    const originalPath = join(dir, 'preserved.bin');
    const pointerPath = `${originalPath}.redirect.yaml`;
    writeFileSync(originalPath, 'preserve me');
    const steps: RedirectDurabilityStep[] = [];

    expect(() => replaceLocalWithRedirectDurable(
      originalPath,
      pointerPath,
      'storage_path: default/preserved.bin\n',
      step => {
        steps.push(step);
        if (step === 'pointer_renamed') throw new Error('simulated crash before parent fsync');
      },
    )).toThrow(/simulated crash/);

    expect(steps).toEqual(['temp_fsynced', 'pointer_renamed']);
    expect(readFileSync(originalPath, 'utf-8')).toBe('preserve me');
    expect(existsSync(pointerPath)).toBe(true);
    expect(readdirSync(dir).some(name => name.endsWith('.tmp'))).toBe(false);
  });

  test('concurrent replacement after pointer durability preserves and exposes the newer original', async () => {
    const dir = tempDir('gbrain-files-redirect-race-');
    const originalPath = join(dir, 'changing.bin');
    const replacementPath = join(dir, 'replacement.bin');
    const pointerPath = `${originalPath}.redirect.yaml`;
    writeFileSync(originalPath, 'uploaded old revision');
    writeFileSync(replacementPath, 'newer local revision');
    const steps: RedirectDurabilityStep[] = [];

    expect(() => replaceLocalWithRedirectDurable(
      originalPath,
      pointerPath,
      'storage_path: default/changing.bin\n',
      step => {
        steps.push(step);
        if (step === 'pointer_parent_fsynced') {
          renameSync(replacementPath, originalPath);
        }
      },
    )).toThrow(/changed during redirect; preserving the newer file/);

    expect(steps).toEqual([
      'temp_fsynced',
      'pointer_renamed',
      'pointer_parent_fsynced',
      'original_quarantined',
      'stale_pointer_retired',
    ]);
    expect(readFileSync(originalPath, 'utf-8')).toBe('newer local revision');
    expect(existsSync(pointerPath)).toBe(false);
    const resolved = await resolveFile('changing.bin', dir);
    expect(resolved.source).toBe('local');
    expect(resolved.data.toString('utf8')).toBe('newer local revision');
  });

  test('replacement after final identity compare cannot be deleted or hidden by the stale pointer', async () => {
    const dir = tempDir('gbrain-files-redirect-final-race-');
    const originalPath = join(dir, 'late-changing.bin');
    const pointerPath = `${originalPath}.redirect.yaml`;
    writeFileSync(originalPath, 'uploaded old revision');
    const steps: RedirectDurabilityStep[] = [];

    expect(() => replaceLocalWithRedirectDurable(
      originalPath,
      pointerPath,
      'storage_path: default/late-changing.bin\n',
      step => {
        steps.push(step);
        if (step === 'quarantine_verified') {
          writeFileSync(originalPath, 'newer local revision after final compare');
        }
      },
    )).toThrow(/changed during redirect; preserving the newer file/);

    expect(steps).toEqual([
      'temp_fsynced',
      'pointer_renamed',
      'pointer_parent_fsynced',
      'original_quarantined',
      'quarantine_verified',
      'stale_pointer_retired',
      'original_unlinked',
      'unlink_parent_fsynced',
    ]);
    expect(readFileSync(originalPath, 'utf-8')).toBe(
      'newer local revision after final compare',
    );
    expect(existsSync(pointerPath)).toBe(false);
    const resolved = await resolveFile('late-changing.bin', dir);
    expect(resolved.source).toBe('local');
    expect(resolved.data.toString('utf8')).toBe(
      'newer local revision after final compare',
    );
  });

  test('restore refuses to clobber a divergent partial local file', async () => {
    const dir = tempDir('gbrain-files-restore-partial-');
    const storageRoot = tempDir('gbrain-files-restore-partial-store-');
    const home = tempDir('gbrain-files-restore-partial-home-');
    writeConfig(home, storageRoot);
    const filePath = join(dir, 'archive.bin');
    const stored = Buffer.from('complete restored archive');
    const storagePath = 'default/archive.bin';
    const hash = createHash('sha256').update(stored).digest('hex');
    const storage = new LocalStorage(storageRoot);
    await storage.upload(storagePath, stored);
    writeFileSync(filePath, stored.subarray(0, 6));
    writeFileSync(`${filePath}.redirect.yaml`, [
      `target: supabase://test/${storagePath}`,
      'bucket: test',
      `storage_path: ${storagePath}`,
      `size: ${stored.byteLength}`,
      `hash: sha256:${hash}`,
      'mime: application/octet-stream',
      'uploaded: 2026-07-10T00:00:00Z',
      '',
    ].join('\n'));

    await withEnv({ GBRAIN_HOME: home }, async () => {
      await expect(runFiles(engine, ['restore', dir])).rejects.toThrow(/Restore incomplete/);
    });

    expect(readFileSync(filePath).equals(stored.subarray(0, 6))).toBe(true);
    expect(existsSync(`${filePath}.redirect.yaml`)).toBe(true);
    expect(readdirSync(dir).some(name => name.endsWith('.restore.tmp'))).toBe(false);
  });

  test('restore accepts an exact existing local file and retires only its pointer', async () => {
    const dir = tempDir('gbrain-files-restore-exact-');
    const storageRoot = tempDir('gbrain-files-restore-exact-store-');
    const home = tempDir('gbrain-files-restore-exact-home-');
    writeConfig(home, storageRoot);
    const filePath = join(dir, 'archive.bin');
    const stored = Buffer.from('already complete local bytes');
    const storagePath = 'default/archive.bin';
    const hash = createHash('sha256').update(stored).digest('hex');
    const storage = new LocalStorage(storageRoot);
    await storage.upload(storagePath, stored);
    writeFileSync(filePath, stored);
    writeFileSync(`${filePath}.redirect.yaml`, [
      `target: supabase://test/${storagePath}`,
      'bucket: test',
      `storage_path: ${storagePath}`,
      `size: ${stored.byteLength}`,
      `hash: sha256:${hash}`,
      'mime: application/octet-stream',
      'uploaded: 2026-07-11T00:00:00Z',
      '',
    ].join('\n'));

    await withEnv({ GBRAIN_HOME: home }, async () => {
      await expect(runFiles(engine, ['restore', dir])).resolves.toBeUndefined();
    });
    expect(readFileSync(filePath).equals(stored)).toBe(true);
    expect(existsSync(`${filePath}.redirect.yaml`)).toBe(false);
  });

  test('restore keeps partial local state and pointer when downloaded bytes are corrupt', async () => {
    const dir = tempDir('gbrain-files-restore-corrupt-');
    const storageRoot = tempDir('gbrain-files-restore-corrupt-store-');
    const home = tempDir('gbrain-files-restore-corrupt-home-');
    writeConfig(home, storageRoot);
    const filePath = join(dir, 'critical.bin');
    const expected = Buffer.from('authoritative critical bytes');
    const partial = Buffer.from('partial');
    const storagePath = 'default/critical.bin';
    const hash = createHash('sha256').update(expected).digest('hex');
    const storage = new LocalStorage(storageRoot);
    await storage.upload(storagePath, Buffer.alloc(expected.byteLength, 0x78));
    writeFileSync(filePath, partial);
    writeFileSync(`${filePath}.redirect.yaml`, [
      `target: supabase://test/${storagePath}`,
      'bucket: test',
      `storage_path: ${storagePath}`,
      `size: ${expected.byteLength}`,
      `hash: sha256:${hash}`,
      'mime: application/octet-stream',
      'uploaded: 2026-07-10T00:00:00Z',
      '',
    ].join('\n'));

    await withEnv({ GBRAIN_HOME: home }, async () => {
      await expect(runFiles(engine, ['restore', dir])).rejects.toThrow(/Restore incomplete/);
    });

    expect(readFileSync(filePath).equals(partial)).toBe(true);
    expect(existsSync(`${filePath}.redirect.yaml`)).toBe(true);
    expect(readdirSync(dir).some(name => name.endsWith('.restore.tmp'))).toBe(false);
  });

  test('restore promotion accepts exact local bytes but never clobbers divergent bytes', () => {
    const dir = tempDir('gbrain-files-restore-noclobber-');
    const exact = join(dir, 'exact.bin');
    const divergent = join(dir, 'divergent.bin');
    const data = Buffer.from('verified bytes');
    writeFileSync(exact, data);
    writeFileSync(divergent, 'newer local revision');
    expect(() => promoteRestoredFileAtomic(exact, data)).not.toThrow();
    expect(() => promoteRestoredFileAtomic(divergent, data)).toThrow(/Refusing to overwrite divergent/);
    expect(readFileSync(divergent, 'utf8')).toBe('newer local revision');
  });

  test('post-promotion divergent replacement preserves the new file and recovery pointer', () => {
    const dir = tempDir('gbrain-files-restore-retire-race-');
    const original = join(dir, 'asset.bin');
    const replacement = join(dir, 'replacement.bin');
    const pointer = `${original}.redirect.yaml`;
    const restored = Buffer.from('verified restored bytes');
    const pointerBytes = Buffer.from('storage_path: default/asset.bin\n');
    writeFileSync(pointer, pointerBytes);
    writeFileSync(replacement, 'new divergent local revision');

    const expectedPointer = readRedirectOriginalSnapshot(pointer);
    const promoted = promoteRestoredFileAtomic(original, restored);
    const steps: string[] = [];
    const retired = retireRedirectAfterRestoredPromotion(
      pointer,
      expectedPointer,
      original,
      promoted,
      step => {
        steps.push(step);
        // This is the narrow race the old two-call protocol missed: the
        // destination changes after promotion and the first exact comparison,
        // but before pointer retirement commits.
        if (step === 'restore_destination_verified') {
          renameSync(replacement, original);
        }
      },
    );

    expect(retired).toBe(false);
    expect(readFileSync(original, 'utf8')).toBe('new divergent local revision');
    expect(readFileSync(pointer).equals(pointerBytes)).toBe(true);
    expect(steps).toEqual([
      'restore_pointer_quarantined',
      'restore_destination_verified',
      'restore_pointer_retired',
      'restore_pointer_reinstated',
    ]);
  });

  test('pointer retirement never reports success over a concurrently-created newer pointer', () => {
    const dir = tempDir('gbrain-files-restore-new-pointer-');
    const original = join(dir, 'asset.bin');
    const pointer = `${original}.redirect.yaml`;
    const restored = Buffer.from('verified restored bytes');
    const oldPointer = Buffer.from('storage_path: default/old.bin\n');
    const newPointer = Buffer.from('storage_path: default/new.bin\n');
    writeFileSync(pointer, oldPointer);

    const expectedPointer = readRedirectOriginalSnapshot(pointer);
    const promoted = promoteRestoredFileAtomic(original, restored);
    const retired = retireRedirectAfterRestoredPromotion(
      pointer,
      expectedPointer,
      original,
      promoted,
      step => {
        if (step === 'restore_pointer_quarantined') writeFileSync(pointer, newPointer);
      },
    );

    expect(retired).toBe(false);
    expect(readFileSync(original).equals(restored)).toBe(true);
    expect(readFileSync(pointer).equals(newPointer)).toBe(true);
    expect(readdirSync(dir).some(name => name.includes('redirect-pointer-quarantine'))).toBe(true);
  });

  test('pointer retirement preserves a concurrent same-content replacement inode', () => {
    const dir = tempDir('gbrain-files-pointer-inode-');
    const pointer = join(dir, 'asset.bin.redirect.yaml');
    const replacement = join(dir, 'replacement.yaml');
    const content = 'storage_path: default/asset.bin\n';
    writeFileSync(pointer, content);
    const expected = readRedirectOriginalSnapshot(pointer);
    writeFileSync(replacement, content);
    renameSync(replacement, pointer);

    expect(retireOwnedRedirectPointer(pointer, expected)).toBe(false);
    expect(readFileSync(pointer, 'utf8')).toBe(content);
  });

  test('restore promotion failure retains pointer and cleans its same-directory temp', async () => {
    const dir = tempDir('gbrain-files-restore-crash-');
    const storageRoot = tempDir('gbrain-files-restore-crash-store-');
    const home = tempDir('gbrain-files-restore-crash-home-');
    writeConfig(home, storageRoot);
    const originalPath = join(dir, 'occupied.bin');
    mkdirSync(originalPath); // rename(file, non-empty/occupied directory) fails atomically.
    const stored = Buffer.from('valid object survives failed promotion');
    const storagePath = 'default/occupied.bin';
    const hash = createHash('sha256').update(stored).digest('hex');
    const storage = new LocalStorage(storageRoot);
    await storage.upload(storagePath, stored);
    const pointerPath = `${originalPath}.redirect.yaml`;
    writeFileSync(pointerPath, [
      `target: supabase://test/${storagePath}`,
      'bucket: test',
      `storage_path: ${storagePath}`,
      `size: ${stored.byteLength}`,
      `hash: sha256:${hash}`,
      'mime: application/octet-stream',
      'uploaded: 2026-07-10T00:00:00Z',
      '',
    ].join('\n'));

    await withEnv({ GBRAIN_HOME: home }, async () => {
      await expect(runFiles(engine, ['restore', dir])).rejects.toThrow(/Restore incomplete/);
    });

    expect(existsSync(pointerPath)).toBe(true);
    expect(lstatSync(originalPath).isDirectory()).toBe(true);
    expect(readdirSync(dir).some(name => name.endsWith('.restore.tmp'))).toBe(false);
  });

  test('files verify downloads every object and checks exact size plus SHA-256', async () => {
    const storageRoot = tempDir('gbrain-files-verify-store-');
    const home = tempDir('gbrain-files-verify-home-');
    writeConfig(home, storageRoot);
    const storage = new LocalStorage(storageRoot);
    const data = Buffer.from('verified object bytes');
    const hash = createHash('sha256').update(data).digest('hex');
    const storagePath = 'default/verified.bin';
    await storage.upload(storagePath, data);
    await engine.upsertFile({
      source_id: 'default', filename: 'verified.bin', storage_path: storagePath,
      size_bytes: data.byteLength, content_hash: hash,
    });

    await withEnv({ GBRAIN_HOME: home }, async () => {
      await expect(runFiles(engine, ['verify'])).resolves.toBeUndefined();
    });
  });

  test('files verify fails on same-size object corruption', async () => {
    const storageRoot = tempDir('gbrain-files-verify-mismatch-store-');
    const home = tempDir('gbrain-files-verify-mismatch-home-');
    writeConfig(home, storageRoot);
    const storage = new LocalStorage(storageRoot);
    const expected = Buffer.from('expected bytes');
    const corrupt = Buffer.alloc(expected.byteLength, 0x78);
    const hash = createHash('sha256').update(expected).digest('hex');
    const storagePath = 'default/mismatch.bin';
    await storage.upload(storagePath, corrupt);
    await engine.upsertFile({
      source_id: 'default', filename: 'mismatch.bin', storage_path: storagePath,
      size_bytes: expected.byteLength, content_hash: hash,
    });

    await withEnv({ GBRAIN_HOME: home }, async () => {
      await expect(runFiles(engine, ['verify'])).rejects.toThrow(/1 mismatches/);
    });
  });

  test('files verify fails when a referenced object is missing', async () => {
    const storageRoot = tempDir('gbrain-files-verify-missing-store-');
    const home = tempDir('gbrain-files-verify-missing-home-');
    writeConfig(home, storageRoot);
    const expected = Buffer.from('missing bytes');
    await engine.upsertFile({
      source_id: 'default', filename: 'missing.bin', storage_path: 'default/missing.bin',
      size_bytes: expected.byteLength,
      content_hash: createHash('sha256').update(expected).digest('hex'),
    });

    await withEnv({ GBRAIN_HOME: home }, async () => {
      await expect(runFiles(engine, ['verify'])).rejects.toThrow(/1 missing/);
    });
  });

  test('files verify rejects NULL size metadata even for an empty matching object', async () => {
    const storageRoot = tempDir('gbrain-files-verify-null-size-store-');
    const home = tempDir('gbrain-files-verify-null-size-home-');
    writeConfig(home, storageRoot);
    const storage = new LocalStorage(storageRoot);
    const empty = Buffer.alloc(0);
    const storagePath = 'default/null-size.bin';
    await storage.upload(storagePath, empty);
    await engine.upsertFile({
      source_id: 'default', filename: 'null-size.bin', storage_path: storagePath,
      size_bytes: null,
      content_hash: createHash('sha256').update(empty).digest('hex'),
    });

    await withEnv({ GBRAIN_HOME: home }, async () => {
      await expect(runFiles(engine, ['verify'])).rejects.toThrow(/1 mismatches/);
    });
  });

  test('CLI upload without storage also leaves no metadata row', async () => {
    const dir = tempDir('gbrain-files-cli-closed-');
    const home = tempDir('gbrain-files-cli-closed-home-');
    writeConfig(home);
    const filePath = join(dir, 'no-backend.pdf');
    writeFileSync(filePath, 'not uploaded');

    await withEnv({ GBRAIN_HOME: home }, async () => {
      await expect(runFiles(engine, ['upload', filePath]))
        .rejects.toThrow(/No storage backend configured/);
    });

    const rows = await engine.executeRaw<{ count: number }>('SELECT COUNT(*)::int AS count FROM files');
    expect(rows[0]?.count).toBe(0);
  });

  test('CLI directory sync without storage leaves every file unrecorded', async () => {
    const dir = tempDir('gbrain-files-sync-closed-');
    const home = tempDir('gbrain-files-sync-closed-home-');
    writeConfig(home);
    writeFileSync(join(dir, 'first.bin'), 'first');
    writeFileSync(join(dir, 'second.bin'), 'second');

    await withEnv({ GBRAIN_HOME: home }, async () => {
      await expect(runFiles(engine, ['sync', dir]))
        .rejects.toThrow(/No storage backend configured/);
    });

    const rows = await engine.executeRaw<{ count: number }>('SELECT COUNT(*)::int AS count FROM files');
    expect(rows[0]?.count).toBe(0);
  });
});
