// v0.40.6.0 — owner-sentinel directory lock contract tests.

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  acquirePackLock,
  holdPackLock,
  isLockStale,
  PackLockBusyError,
  withPackLock,
  type LockFileRecord,
} from '../src/core/schema-pack/pack-lock.ts';

let lockDir: string;

beforeEach(() => {
  lockDir = mkdtempSync(join(tmpdir(), 'gbrain-pack-lock-test-'));
});

afterEach(() => {
  try { rmSync(lockDir, { recursive: true, force: true }); } catch { /* swallow */ }
});

const liveAlways = (_pid: number): boolean => true;
const deadAlways = (_pid: number): boolean => false;
const OWNER_A = '11111111-1111-4111-8111-111111111111';

function packLockPath(pack = 'foo'): string {
  return join(lockDir, `${pack}.lock`);
}

function ownerPath(owner: string, pack = 'foo'): string {
  return join(packLockPath(pack), `owner-${owner}.json`);
}

function readOwner(pack = 'foo'): { name: string; raw: string; record: LockFileRecord } {
  const names = readdirSync(packLockPath(pack));
  expect(names).toHaveLength(1);
  const name = names[0]!;
  const raw = readFileSync(join(packLockPath(pack), name), 'utf-8');
  return { name, raw, record: JSON.parse(raw) as LockFileRecord };
}

function seedOwnedLock(overrides: Partial<LockFileRecord> = {}): LockFileRecord {
  const record: LockFileRecord = {
    owner: OWNER_A,
    pid: 99_999,
    hostname: 'test',
    ts: Date.now(),
    ttlMs: 60_000,
    ...overrides,
  };
  mkdirSync(packLockPath());
  writeFileSync(ownerPath(record.owner!), JSON.stringify(record), 'utf-8');
  return record;
}

function setMtime(path: string, timestampMs: number): void {
  const timestamp = new Date(timestampMs);
  utimesSync(path, timestamp, timestamp);
}

describe('acquirePackLock — owner-sentinel directory protocol', () => {
  it('atomically creates a lock directory with one unique owner sentinel', () => {
    const result = acquirePackLock('foo', { lockDir });
    expect(result.outcome).toBe('acquired');
    expect(existsSync(packLockPath())).toBe(true);
    const stored = readOwner();
    expect(stored.record).toEqual(result.record);
    expect(stored.name).toBe(`owner-${result.record.owner}.json`);
    expect(result.record.pid).toBe(process.pid);
    expect(result.record.owner).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('auto-creates the parent directory on first acquire', () => {
    const deepDir = join(lockDir, 'a', 'b', 'c');
    const result = acquirePackLock('bar', { lockDir: deepDir });
    expect(result.outcome).toBe('acquired');
    expect(existsSync(join(deepDir, 'bar.lock', `owner-${result.record.owner}.json`))).toBe(true);
  });

  it('uses a different owner token for every pack acquisition', () => {
    const first = acquirePackLock('first', { lockDir });
    const second = acquirePackLock('second', { lockDir });
    expect(first.record.owner).not.toBe(second.record.owner);
  });

  it('rejects path traversal before creating anything outside lockDir', () => {
    const escaped = join(lockDir, '..', 'escaped.lock');
    expect(() => acquirePackLock('../escaped', { lockDir })).toThrow(/invalid pack lock name/);
    expect(() => acquirePackLock('/tmp/escaped', { lockDir })).toThrow(/invalid pack lock name/);
    expect(existsSync(escaped)).toBe(false);
  });
});

describe('acquirePackLock — contention and stale recovery', () => {
  it('refuses a fresh live holder', () => {
    seedOwnedLock();
    expect(() => acquirePackLock('foo', { lockDir, isPidAlive: liveAlways }))
      .toThrow(PackLockBusyError);
  });

  it('recovers a holder whose PID is confirmed dead', () => {
    seedOwnedLock();
    const result = acquirePackLock('foo', { lockDir, isPidAlive: deadAlways });
    expect(result.outcome).toBe('stolen_stale');
    expect(result.record.pid).toBe(process.pid);
    expect(result.record.owner).not.toBe(OWNER_A);
    expect(readOwner().record.owner).toBe(result.record.owner);
  });

  it('never steals a TTL-expired live holder', () => {
    seedOwnedLock({ ts: Date.now() - 120_000, ttlMs: 60_000 });
    expect(() => acquirePackLock('foo', { lockDir, isPidAlive: liveAlways }))
      .toThrow(PackLockBusyError);
    expect(readOwner().record.owner).toBe(OWNER_A);
  });

  it('force never steals a live holder, even after TTL expiry', () => {
    seedOwnedLock({ ts: Date.now() - 120_000, ttlMs: 60_000 });
    expect(() => acquirePackLock('foo', {
      lockDir,
      force: true,
      isPidAlive: liveAlways,
    })).toThrow(PackLockBusyError);
    expect(readOwner().record.owner).toBe(OWNER_A);
  });

  it('PackLockBusyError carries holder diagnostics', () => {
    const past = Date.now() - 1500;
    seedOwnedLock({ pid: 88_888, ts: past });
    try {
      acquirePackLock('foo', { lockDir, isPidAlive: liveAlways });
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(PackLockBusyError);
      const lockErr = err as PackLockBusyError;
      expect(lockErr.heldBy).toBe(88_888);
      expect(lockErr.ageMs).toBeGreaterThanOrEqual(1500);
      expect(lockErr.ttlMs).toBe(60_000);
    }
  });
});

describe('ambiguous and legacy state fails closed', () => {
  it('quarantines a just-created empty directory as publishing', () => {
    const now = 1_800_000_000_000;
    mkdirSync(packLockPath());
    setMtime(packLockPath(), now);
    expect(() => acquirePackLock('foo', {
      lockDir,
      force: true,
      now: () => now + 500,
      isPidAlive: deadAlways,
    })).toThrow(/still being published/);
    expect(readdirSync(packLockPath())).toHaveLength(0);
  });

  it('does not auto-remove an abandoned empty directory after grace', () => {
    const now = 1_800_000_000_000;
    mkdirSync(packLockPath());
    setMtime(packLockPath(), now - 60_001);
    expect(() => acquirePackLock('foo', {
      lockDir,
      force: true,
      now: () => now,
      isPidAlive: deadAlways,
    })).toThrow(/no owner sentinel/);
    expect(readdirSync(packLockPath())).toHaveLength(0);
  });

  it('does not auto-remove a malformed owner sentinel', () => {
    mkdirSync(packLockPath());
    writeFileSync(join(packLockPath(), 'owner-not-a-uuid.json'), 'not-json', 'utf-8');
    expect(() => acquirePackLock('foo', {
      lockDir,
      force: true,
      isPidAlive: deadAlways,
    })).toThrow(/malformed or multiple/);
    expect(existsSync(join(packLockPath(), 'owner-not-a-uuid.json'))).toBe(true);
  });

  it('does not auto-remove multiple owner sentinels', () => {
    seedOwnedLock();
    writeFileSync(join(packLockPath(), 'unexpected'), 'x');
    expect(() => acquirePackLock('foo', {
      lockDir,
      force: true,
      isPidAlive: deadAlways,
    })).toThrow(/malformed or multiple/);
    expect(readdirSync(packLockPath())).toHaveLength(2);
  });

  it('fails closed on an old file lock instead of inspect-then-unlink recovery', () => {
    writeFileSync(packLockPath(), JSON.stringify({
      owner: OWNER_A,
      pid: 99_999,
      hostname: 'test',
      ts: Date.now() - 120_000,
      ttlMs: 60_000,
    }));
    expect(() => acquirePackLock('foo', {
      lockDir,
      force: true,
      isPidAlive: deadAlways,
    })).toThrow(/legacy\/unsupported lock file/);
    expect(readFileSync(packLockPath(), 'utf-8')).toContain(OWNER_A);
  });
});

describe('isLockStale — live PID is the hard fence', () => {
  it('returns live when fresh and alive', () => {
    const rec: LockFileRecord = { owner: OWNER_A, pid: 1, hostname: 'h', ts: 1000, ttlMs: 60_000 };
    expect(isLockStale(rec, 30_000, liveAlways)).toEqual({ stale: false, reason: 'live' });
  });

  it('returns live when TTL expired but PID remains alive', () => {
    const rec: LockFileRecord = { owner: OWNER_A, pid: 1, hostname: 'h', ts: 1000, ttlMs: 1000 };
    expect(isLockStale(rec, 5000, liveAlways)).toEqual({ stale: false, reason: 'live' });
  });

  it('returns pid_dead for a fresh dead holder', () => {
    const rec: LockFileRecord = { owner: OWNER_A, pid: 1, hostname: 'h', ts: 1000, ttlMs: 60_000 };
    expect(isLockStale(rec, 2000, deadAlways)).toEqual({ stale: true, reason: 'pid_dead' });
  });

  it('returns ttl_expired only when the expired holder is also dead', () => {
    const rec: LockFileRecord = { owner: OWNER_A, pid: 1, hostname: 'h', ts: 1000, ttlMs: 1000 };
    expect(isLockStale(rec, 5000, deadAlways)).toEqual({ stale: true, reason: 'ttl_expired' });
  });
});

describe('withPackLock — async-context ownership', () => {
  it('runs the callback and releases its owner on success', async () => {
    await withPackLock('foo', { lockDir }, async () => {
      expect(existsSync(packLockPath())).toBe(true);
    });
    expect(existsSync(packLockPath())).toBe(false);
  });

  it('releases its owner even when the callback throws', async () => {
    await expect(withPackLock('foo', { lockDir }, async () => {
      throw new Error('boom');
    })).rejects.toThrow('boom');
    expect(existsSync(packLockPath())).toBe(false);
  });

  it('returns the callback value', async () => {
    expect(await withPackLock('foo', { lockDir }, async () => 42)).toBe(42);
  });

  it('reuses the exact owner/path for descendant nested calls, ignoring inner force', async () => {
    await withPackLock('foo', { lockDir }, async () => {
      const outer = readOwner();
      await withPackLock('foo', {
        lockDir: join(lockDir, '.'),
        force: true,
        isPidAlive: deadAlways,
      }, async () => {
        const inner = readOwner();
        expect(inner.name).toBe(outer.name);
        expect(inner.raw).toBe(outer.raw);
      });
      expect(readOwner().name).toBe(outer.name);
    });
    expect(existsSync(packLockPath())).toBe(false);
  });

  it('gives an unrelated top-level context LOCK_BUSY, even with force', async () => {
    let entered!: () => void;
    const active = new Promise<void>((resolve) => { entered = resolve; });
    let finish!: () => void;
    const wait = new Promise<void>((resolve) => { finish = resolve; });
    const first = withPackLock('foo', { lockDir }, async () => {
      entered();
      await wait;
    });
    await active;
    await expect(withPackLock('foo', {
      lockDir,
      force: true,
      isPidAlive: liveAlways,
    }, async () => 'second')).rejects.toMatchObject({ code: 'LOCK_BUSY' });
    finish();
    await first;
  });
});

describe('owner-aware refresh and release fencing', () => {
  it('a stale old handle cannot refresh or release a replacement owner', () => {
    let now = 1_800_000_000_000;
    const oldHolder = holdPackLock('foo', { lockDir, now: () => now });
    const oldOwner = readOwner().record.owner;

    now += 1;
    const newer = acquirePackLock('foo', {
      lockDir,
      now: () => now,
      isPidAlive: deadAlways,
    });
    const newerSnapshot = readOwner();
    expect(newer.record.owner).not.toBe(oldOwner);

    now += 10_000;
    expect(oldHolder.refresh()).toBe(false);
    expect(readOwner()).toEqual(newerSnapshot);

    oldHolder.release();
    expect(readOwner()).toEqual(newerSnapshot);
  });

  it('an exact owner handle releases idempotently', () => {
    const holder = holdPackLock('foo', { lockDir });
    expect(existsSync(packLockPath())).toBe(true);
    holder.release();
    holder.release();
    expect(existsSync(packLockPath())).toBe(false);
  });
});

describe('cleanup invariants', () => {
  it('does not leak lock directories across many acquire/release cycles', async () => {
    for (let i = 0; i < 100; i++) {
      await withPackLock('foo', { lockDir }, async () => i);
    }
    expect(existsSync(packLockPath())).toBe(false);
  });
});
