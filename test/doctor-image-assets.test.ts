import { describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { imageAssetsHealthCheck } from '../src/commands/doctor.ts';

function engineWithRows(rows: Array<{ source_id: string; storage_path: string }>): BrainEngine {
  return {
    executeRaw: async () => rows,
  } as unknown as BrainEngine;
}

describe('doctor image_assets storage routing', () => {
  test('healthy object-backed rows use configured storage and never fs.stat', async () => {
    const paths: string[] = [];
    let statCalls = 0;
    const check = await imageAssetsHealthCheck(
      engineWithRows([
        { source_id: 'default', storage_path: 'default/images/a.png.sha256-deadbeef' },
        { source_id: 'notes', storage_path: 'notes/images/b.png.sha256-cafebabe' },
      ]),
      {
        resolveStorage: async () => ({
          exists: async (path) => {
            paths.push(path);
            return true;
          },
        }),
        statLocalPath: () => { statCalls++; },
      },
    );

    expect(check?.status).toBe('ok');
    expect(check?.message).toContain('all present in configured storage');
    expect(paths).toEqual([
      'default/images/a.png.sha256-deadbeef',
      'notes/images/b.png.sha256-cafebabe',
    ]);
    expect(statCalls).toBe(0);
  });

  test('missing object-backed rows warn without real cloud or filesystem calls', async () => {
    let statCalls = 0;
    const check = await imageAssetsHealthCheck(
      engineWithRows([
        { source_id: 'default', storage_path: 'default/images/present.png' },
        { source_id: 'notes', storage_path: 'notes/images/missing.png' },
      ]),
      {
        resolveStorage: async () => ({
          exists: async (path) => path !== 'notes/images/missing.png',
        }),
        statLocalPath: () => { statCalls++; },
      },
    );

    expect(check?.status).toBe('warn');
    expect(check?.message).toContain('1 of 2 image(s) missing from configured storage');
    expect(check?.message).toContain('notes:notes/images/missing.png');
    expect(check?.message).toContain('gbrain files verify --source <id>');
    expect(statCalls).toBe(0);
  });

  test('relative keys without storage config are unverifiable, not local missing files', async () => {
    let statCalls = 0;
    const check = await imageAssetsHealthCheck(
      engineWithRows([
        { source_id: 'default', storage_path: 'default/images/object-key.png' },
      ]),
      {
        resolveStorage: async () => null,
        statLocalPath: () => { statCalls++; },
      },
    );

    expect(check?.status).toBe('warn');
    expect(check?.message).toContain('unverifiable because no storage backend is configured');
    expect(check?.message).not.toContain('missing from legacy');
    expect(statCalls).toBe(0);
  });

  test('absolute legacy paths use fs.stat even when object storage is configured', async () => {
    let storageCalls = 0;
    const localPaths: string[] = [];
    const check = await imageAssetsHealthCheck(
      engineWithRows([
        { source_id: 'default', storage_path: '/legacy/brain/images/photo.png' },
      ]),
      {
        resolveStorage: async () => ({
          exists: async () => {
            storageCalls++;
            return true;
          },
        }),
        statLocalPath: (path) => { localPaths.push(path); },
      },
    );

    expect(check?.status).toBe('ok');
    expect(check?.message).toContain('legacy absolute local paths');
    expect(localPaths).toEqual(['/legacy/brain/images/photo.png']);
    expect(storageCalls).toBe(0);
  });
});
