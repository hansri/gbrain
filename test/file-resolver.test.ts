import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, symlinkSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createHash } from 'crypto';
import { resolveFile, parseRedirect, parseMarker } from '../src/core/file-resolver.ts';
import { LocalStorage } from '../src/core/storage/local.ts';

function sha256(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

describe('file-resolver', () => {
  let brainRoot: string;
  let storageDir: string;
  let storage: LocalStorage;

  beforeAll(() => {
    brainRoot = mkdtempSync(join(tmpdir(), 'gbrain-resolver-'));
    storageDir = mkdtempSync(join(tmpdir(), 'gbrain-resolver-storage-'));
    storage = new LocalStorage(storageDir);

    // Create a local file
    mkdirSync(join(brainRoot, 'people'), { recursive: true });
    writeFileSync(join(brainRoot, 'people/sarah.json'), '{"name":"Sarah"}');
  });

  afterAll(() => {
    rmSync(brainRoot, { recursive: true });
    rmSync(storageDir, { recursive: true });
  });

  test('resolves local file', async () => {
    const result = await resolveFile('people/sarah.json', brainRoot);
    expect(result.source).toBe('local');
    expect(result.data.toString()).toBe('{"name":"Sarah"}');
  });

  test('throws for missing file with no redirect or marker', async () => {
    expect(resolveFile('nonexistent.json', brainRoot)).rejects.toThrow('not found');
  });

  test('resolves via .redirect breadcrumb', async () => {
    // Upload to storage
    const stored = Buffer.from('{"from":"storage"}');
    await storage.upload('redirected/file.json', stored);

    // Create redirect breadcrumb
    writeFileSync(join(brainRoot, 'people/redirected.json.redirect'),
      `moved_to: supabase\nbucket: brain-files\npath: redirected/file.json\nmoved_at: 2026-04-09\noriginal_hash: sha256:${sha256(stored)}\n`
    );

    const result = await resolveFile('people/redirected.json', brainRoot, storage);
    expect(result.source).toBe('redirect');
    expect(result.data.toString()).toBe('{"from":"storage"}');
  });

  test('throws when redirect exists but no storage backend', async () => {
    writeFileSync(join(brainRoot, 'people/no-storage.json.redirect'),
      `moved_to: supabase\nbucket: test\npath: test.json\nmoved_at: 2026-04-09\noriginal_hash: sha256:${'a'.repeat(64)}\n`
    );

    expect(resolveFile('people/no-storage.json', brainRoot)).rejects.toThrow('no storage backend');
  });

  test('blocks resolveFile path traversal at root level', async () => {
    await expect(
      resolveFile('../../etc/passwd', brainRoot, storage)
    ).rejects.toThrow('Path traversal blocked');
  });

  test('blocks an ancestor directory symlink that escapes the brain root', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'gbrain-resolver-outside-'));
    writeFileSync(join(outside, 'secret.json'), '{"outside":true}');
    symlinkSync(outside, join(brainRoot, 'escape-dir'));
    try {
      await expect(resolveFile('escape-dir/secret.json', brainRoot, storage))
        .rejects.toThrow(/ancestor symlink/);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test('preserves valid reads through an ancestor symlink that remains in-root', async () => {
    const target = join(brainRoot, 'in-root-target');
    mkdirSync(target);
    writeFileSync(join(target, 'safe.json'), '{"inside":true}');
    symlinkSync(target, join(brainRoot, 'in-root-link'));

    const result = await resolveFile('in-root-link/safe.json', brainRoot, storage);
    expect(result.source).toBe('local');
    expect(result.data.toString()).toBe('{"inside":true}');
  });

  test('blocks .supabase marker with traversal prefix', async () => {
    const subDir = join(brainRoot, 'poisoned');
    mkdirSync(subDir, { recursive: true });
    writeFileSync(join(subDir, '.supabase'),
      'synced_at: 2026-04-12\nbucket: brain-files\nprefix: ../../etc/\nfile_count: 1\n'
    );
    await expect(
      resolveFile('poisoned/secret.json', brainRoot, storage)
    ).rejects.toThrow('marker prefix contains path traversal');
  });

  test('blocks .supabase marker with absolute path prefix', async () => {
    const subDir = join(brainRoot, 'abs');
    mkdirSync(subDir, { recursive: true });
    writeFileSync(join(subDir, '.supabase'),
      'synced_at: 2026-04-12\nbucket: brain-files\nprefix: /etc/\nfile_count: 1\n'
    );
    await expect(
      resolveFile('abs/passwd', brainRoot, storage)
    ).rejects.toThrow('marker prefix contains path traversal');
  });

  test('allows .supabase marker with clean prefix', async () => {
    const subDir = join(brainRoot, 'media');
    mkdirSync(subDir, { recursive: true });
    await storage.upload('media/.raw/photo.jpg', Buffer.from('jpeg-data'));
    writeFileSync(join(subDir, '.supabase'),
      'synced_at: 2026-04-12\nbucket: brain-files\nprefix: media/.raw/\nfile_count: 1\n'
    );
    const result = await resolveFile('media/photo.jpg', brainRoot, storage);
    expect(result.source).toBe('storage');
    expect(result.data.toString()).toBe('jpeg-data');
  });

  test('valid YAML pointer overrides a partial local file and verifies stored bytes', async () => {
    const stored = Buffer.from('complete authoritative object');
    await storage.upload('default/partial.bin', stored);
    writeFileSync(join(brainRoot, 'people/partial.bin'), stored.subarray(0, 7));
    writeFileSync(join(brainRoot, 'people/partial.bin.redirect.yaml'), [
      'target: supabase://brain-files/default/partial.bin',
      'bucket: brain-files',
      'storage_path: default/partial.bin',
      `size: ${stored.byteLength}`,
      `hash: sha256:${sha256(stored)}`,
      'mime: application/octet-stream',
      'uploaded: 2026-07-10T00:00:00Z',
      '',
    ].join('\n'));

    const result = await resolveFile('people/partial.bin', brainRoot, storage);
    expect(result.source).toBe('redirect');
    expect(result.data.equals(stored)).toBe(true);
  });

  test('rejects corrupt stored bytes instead of blessing them through a pointer', async () => {
    const expected = Buffer.from('expected bytes');
    await storage.upload('default/corrupt.bin', Buffer.from('corrupt bytes!'));
    writeFileSync(join(brainRoot, 'people/corrupt.bin.redirect.yaml'), [
      'target: supabase://brain-files/default/corrupt.bin',
      'bucket: brain-files',
      'storage_path: default/corrupt.bin',
      `size: ${expected.byteLength}`,
      `hash: sha256:${sha256(expected)}`,
      'mime: application/octet-stream',
      'uploaded: 2026-07-10T00:00:00Z',
      '',
    ].join('\n'));

    await expect(resolveFile('people/corrupt.bin', brainRoot, storage))
      .rejects.toThrow(/integrity check failed/);
  });

  test('rejects malformed pointer integrity metadata even when a local file exists', async () => {
    writeFileSync(join(brainRoot, 'people/untrusted.bin'), 'local bytes');
    writeFileSync(join(brainRoot, 'people/untrusted.bin.redirect.yaml'), [
      'target: supabase://brain-files/default/untrusted.bin',
      'bucket: brain-files',
      'storage_path: default/untrusted.bin',
      'size: 11',
      'hash: sha256:not-a-real-hash',
      '',
    ].join('\n'));

    await expect(resolveFile('people/untrusted.bin', brainRoot, storage))
      .rejects.toThrow(/Invalid redirect hash/);
  });

  test('does not let a local symlink shadow a valid redirect pointer', async () => {
    const stored = Buffer.from('pointer-controlled content');
    const outside = join(brainRoot, '..', `gbrain-outside-${Date.now()}.bin`);
    writeFileSync(outside, stored);
    await storage.upload('default/symlink.bin', stored);
    symlinkSync(outside, join(brainRoot, 'people/symlink.bin'));
    writeFileSync(join(brainRoot, 'people/symlink.bin.redirect.yaml'), [
      'target: supabase://brain-files/default/symlink.bin',
      'bucket: brain-files',
      'storage_path: default/symlink.bin',
      `size: ${stored.byteLength}`,
      `hash: sha256:${sha256(stored)}`,
      '',
    ].join('\n'));
    try {
      const result = await resolveFile('people/symlink.bin', brainRoot, storage);
      expect(result.source).toBe('redirect');
      expect(result.data.equals(stored)).toBe(true);
    } finally {
      rmSync(outside, { force: true });
    }
  });
});

describe('parseRedirect', () => {
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'gbrain-redirect-'));
  });

  afterAll(() => {
    rmSync(tmpDir, { recursive: true });
  });

  test('parses redirect YAML', () => {
    const path = join(tmpDir, 'test.redirect');
    writeFileSync(path, `moved_to: supabase\nbucket: brain-files\npath: people/sarah.json\nmoved_at: 2026-04-09\noriginal_hash: sha256:${'b'.repeat(64)}\n`);

    const info = parseRedirect(path);
    expect(info.moved_to).toBe('supabase');
    expect(info.bucket).toBe('brain-files');
    expect(info.path).toBe('people/sarah.json');
    expect(info.original_hash).toBe(`sha256:${'b'.repeat(64)}`);
  });
});

describe('parseMarker', () => {
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'gbrain-marker-'));
  });

  afterAll(() => {
    rmSync(tmpDir, { recursive: true });
  });

  test('parses .supabase marker YAML', () => {
    const path = join(tmpDir, '.supabase');
    writeFileSync(path, 'synced_at: 2026-04-09T14:58:00Z\nbucket: brain-files\nprefix: people/.raw/\nfile_count: 484\n');

    const info = parseMarker(path);
    expect(info.synced_at).toBe('2026-04-09T14:58:00Z');
    expect(info.bucket).toBe('brain-files');
    expect(info.prefix).toBe('people/.raw/');
    expect(info.file_count as any).toBe('484');
  });
});
