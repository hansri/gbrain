import { afterEach, describe, expect, test } from 'bun:test';
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import {
  appendOwnedStateFile,
  isDirectoryFsyncUnsupported,
  ownedStateFileTesting,
  readOwnedStateFile,
  withOwnedStateReadPolicy,
} from '../src/core/owned-state-file.ts';

const roots: string[] = [];

afterEach(() => {
  ownedStateFileTesting.setAfterBoundedReadHook();
  ownedStateFileTesting.setForceNoFollowFallback();
  ownedStateFileTesting.setForceDirectoryHandleFallback();
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe('owner-only state durability primitive', () => {
  test('missing-file read is side-effect free and preserves ENOENT', () => {
    const parent = mkdtempSync(join(tmpdir(), 'gbrain-owned-state-missing-'));
    roots.push(parent);
    const root = join(parent, '.gbrain');
    const file = join(root, 'migrations', 'completed.jsonl');

    expect(() => readOwnedStateFile(file, 1_024, root)).toThrow();
    expect(existsSync(root)).toBe(false);
  });

  test('inspection policy rejects loose permissions without chmod side effects', () => {
    const parent = mkdtempSync(join(tmpdir(), 'gbrain-owned-state-readonly-'));
    roots.push(parent);
    const root = join(parent, '.gbrain');
    const dir = join(root, 'migrations');
    const file = join(dir, 'completed.jsonl');
    mkdirSync(dir, { recursive: true, mode: 0o755 });
    writeFileSync(file, '{}\n', { mode: 0o644 });
    chmodSync(root, 0o755);
    chmodSync(dir, 0o755);
    chmodSync(file, 0o644);

    expect(() => withOwnedStateReadPolicy(false, () =>
      readOwnedStateFile(file, 1_024, root)))
      .toThrow(/permissions are not 0700/i);
    expect(statSync(root).mode & 0o777).toBe(0o755);
    expect(statSync(dir).mode & 0o777).toBe(0o755);
    expect(statSync(file).mode & 0o777).toBe(0o644);
  });

  test('fresh append creates durable owner-only directories and a bounded file', () => {
    const parent = mkdtempSync(join(tmpdir(), 'gbrain-owned-state-'));
    roots.push(parent);
    const root = join(parent, '.gbrain');
    const file = join(root, 'migrations', 'completed.jsonl');

    appendOwnedStateFile(file, '{"ok":true}\n', 1_024, root);

    expect(readFileSync(file, 'utf8')).toBe('{"ok":true}\n');
    expect(statSync(root).mode & 0o777).toBe(0o700);
    expect(statSync(join(root, 'migrations')).mode & 0o777).toBe(0o700);
    expect(statSync(file).mode & 0o777).toBe(0o600);

    const source = readFileSync(new URL('../src/core/owned-state-file.ts', import.meta.url), 'utf8');
    const appendBody = source.slice(
      source.indexOf('export function appendOwnedStateFile'),
      source.indexOf('/** Write, fsync, rename', source.indexOf('export function appendOwnedStateFile')),
    );
    expect(appendBody.indexOf('fsyncSync(fd)')).toBeGreaterThan(-1);
    expect(appendBody.indexOf('fsyncDirectory(dirname(path))')).toBeGreaterThan(appendBody.indexOf('fsyncSync(fd)'));
  });

  test('rejects a concurrent append instead of returning a stale prefix', () => {
    const parent = mkdtempSync(join(tmpdir(), 'gbrain-owned-state-race-'));
    roots.push(parent);
    const root = join(parent, '.gbrain');
    const file = join(root, 'migrations', 'completed.jsonl');
    appendOwnedStateFile(file, '{"first":true}\n', 1_024, root);

    ownedStateFileTesting.setAfterBoundedReadHook(() => {
      appendFileSync(file, '{"late":true}\n');
    });
    expect(() => readOwnedStateFile(file, 1_024, root)).toThrow(/changed while it was being read/i);
  });

  test('simulated no-O_NOFOLLOW fallback proves exact identity and rejects symlinks', () => {
    const parent = mkdtempSync(join(tmpdir(), 'gbrain-owned-state-fallback-'));
    roots.push(parent);
    const root = join(parent, '.gbrain');
    const file = join(root, 'migrations', 'completed.jsonl');
    ownedStateFileTesting.setForceNoFollowFallback(true);
    ownedStateFileTesting.setForceDirectoryHandleFallback(true);

    appendOwnedStateFile(file, '{"fallback":true}\n', 1_024, root);
    expect(readOwnedStateFile(file, 1_024, root)).toBe('{"fallback":true}\n');

    const victim = join(parent, 'victim.jsonl');
    const redirected = join(root, 'migrations', 'redirected.jsonl');
    writeFileSync(victim, 'private\n');
    symlinkSync(victim, redirected);
    expect(() => readOwnedStateFile(redirected, 1_024, root)).toThrow(/symbolic link/i);
    expect(readFileSync(victim, 'utf8')).toBe('private\n');
  });

  test('directory fsync limitations are narrow and Windows-only', () => {
    expect(isDirectoryFsyncUnsupported({ code: 'EINVAL' }, 'win32')).toBe(true);
    expect(isDirectoryFsyncUnsupported({ code: 'ENOTSUP' }, 'win32')).toBe(true);
    expect(isDirectoryFsyncUnsupported({ code: 'EACCES' }, 'win32')).toBe(false);
    expect(isDirectoryFsyncUnsupported({ code: 'EINVAL' }, 'darwin')).toBe(false);
  });
});
