import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import {
  buildChecks,
  buildDatabaseMigrationAuthorityChecks,
  doctorReportRemote,
} from '../src/commands/doctor.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import {
  getOrCreateDatabaseInstanceId,
} from '../src/core/database-instance-id.ts';
import { claimMigrationInflight } from '../src/core/migration-inflight.ts';
import { appendCompletedMigration, loadCompletedMigrations } from '../src/core/preferences.ts';

let home: string;
let engine: PGLiteEngine;
let brainId: string;
let priorHome: string | undefined;
let priorGbrainHome: string | undefined;

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'gbrain-doctor-migration-authority-'));
  priorHome = process.env.HOME;
  priorGbrainHome = process.env.GBRAIN_HOME;
  process.env.HOME = home;
  process.env.GBRAIN_HOME = home;
  engine = new PGLiteEngine();
  await engine.connect({ engine: 'pglite', database_path: join(home, 'brain') });
  await engine.initSchema();
  brainId = await getOrCreateDatabaseInstanceId(engine);
});

afterEach(async () => {
  await engine.disconnect();
  if (priorHome === undefined) delete process.env.HOME;
  else process.env.HOME = priorHome;
  if (priorGbrainHome === undefined) delete process.env.GBRAIN_HOME;
  else process.env.GBRAIN_HOME = priorGbrainHome;
  rmSync(home, { recursive: true, force: true });
});

describe('doctor database migration authority', () => {
  test('an empty local ledger cannot hide a database-only inflight fence', async () => {
    expect(loadCompletedMigrations()).toEqual([]);
    await claimMigrationInflight(engine, {
      version: '0.42.59.0',
      brain_id: brainId,
      attempt_id: randomUUID(),
      started_at: new Date().toISOString(),
    });

    const checks = await buildChecks(engine, ['--fast', '--scope=brain']);
    expect(checks.find(check => check.name === 'migration_inflight')).toMatchObject({
      status: 'fail',
      message: expect.stringContaining('0.42.59.0'),
    });
  }, 60_000);

  test('missing and malformed identities are explicit migration_identity failures', async () => {
    await engine.executeRaw("DELETE FROM config WHERE key = 'database_instance_id'");
    let result = await buildDatabaseMigrationAuthorityChecks(engine);
    expect(result.brainId).toBeNull();
    expect(result.checks.find(check => check.name === 'migration_identity')).toMatchObject({
      status: 'fail',
      message: expect.stringContaining('no durable database instance identity'),
    });

    await engine.executeRaw(
      "INSERT INTO config (key, value) VALUES ('database_instance_id', 'not-a-uuid')",
    );
    result = await buildDatabaseMigrationAuthorityChecks(engine);
    expect(result.brainId).toBeNull();
    expect(result.checks.find(check => check.name === 'migration_identity')).toMatchObject({
      status: 'fail',
      message: expect.stringContaining('malformed'),
    });
  });

  test('remote doctor scopes receipts with the same database-owned UUID', async () => {
    appendCompletedMigration({
      version: '0.42.59.0',
      brain_id: brainId,
      status: 'partial',
    });
    const report = await doctorReportRemote(engine);
    expect(report.checks.find(check => check.name === 'migration_identity'))
      .toMatchObject({ status: 'ok' });
    expect(report.checks.find(check => check.name === 'migration_inflight'))
      .toMatchObject({ status: 'ok' });
    expect(report.checks.find(check => check.name === 'minions_migration')).toMatchObject({
      status: 'fail',
      message: expect.stringContaining(brainId),
    });
  }, 60_000);

  test('malformed database inflight evidence fails closed on both surfaces', async () => {
    await engine.executeRaw(
      "INSERT INTO config (key, value) VALUES ('migration_inflight:0.42.59.0', '{malformed')",
    );
    const local = await buildDatabaseMigrationAuthorityChecks(engine);
    expect(local.checks.find(check => check.name === 'migration_inflight')).toMatchObject({
      status: 'fail',
      message: expect.stringContaining('malformed or unreadable'),
    });
    const remote = await doctorReportRemote(engine);
    expect(remote.checks.find(check => check.name === 'migration_inflight')).toMatchObject({
      status: 'fail',
    });
  }, 60_000);
});
