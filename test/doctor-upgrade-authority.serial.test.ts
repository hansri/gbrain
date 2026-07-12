import { describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { tmpdir } from 'os';
import {
  buildUpgradeErrorEvidenceCheck,
  buildUpgradeStateCheck,
} from '../src/commands/doctor.ts';
import { loadReconciledUpgradeState } from '../src/commands/upgrade.ts';
import { VERSION } from '../src/version.ts';

const COMPLETE_TRANSITION = '11111111-1111-4111-8111-111111111111';
const PENDING_TRANSITION = '22222222-2222-4222-8222-222222222222';

function writeOwned(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  chmodSync(dirname(path), 0o700);
  writeFileSync(path, content, { mode: 0o600 });
  chmodSync(path, 0o600);
}

function stateRecord(opts: {
  status: 'complete' | 'post_upgrade_pending';
  ts: string;
  transitionId: string;
}): string {
  return `${JSON.stringify({
    last_upgrade: {
      from: '0.42.58.0',
      to: VERSION,
      status: opts.status,
      ts: opts.ts,
      transition_id: opts.transitionId,
      brain_id: null,
      brain_required: false,
    },
  })}\n`;
}

function errorRecord(opts: {
  ts: string;
  phase: string;
  transitionId: string;
}): string {
  return `${JSON.stringify({
    ts: opts.ts,
    phase: opts.phase,
    from_version: '0.42.58.0',
    to_version: VERSION,
    error: 'migration failed',
    hint: 'Run: gbrain post-upgrade',
    transition_id: opts.transitionId,
    brain_id: null,
  })}\n`;
}

function withUpgradeHomes(run: (paths: {
  canonicalDir: string;
  legacyDir: string;
}) => void): void {
  const root = mkdtempSync(join(tmpdir(), 'gbrain-doctor-upgrade-authority-'));
  const stateParent = join(root, 'configured');
  const home = join(root, 'home');
  mkdirSync(stateParent, { recursive: true, mode: 0o700 });
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const priorGbrainHome = process.env.GBRAIN_HOME;
  const priorHome = process.env.HOME;
  process.env.GBRAIN_HOME = stateParent;
  process.env.HOME = home;
  try {
    run({
      canonicalDir: join(stateParent, '.gbrain'),
      legacyDir: join(home, '.gbrain'),
    });
  } finally {
    if (priorGbrainHome === undefined) delete process.env.GBRAIN_HOME;
    else process.env.GBRAIN_HOME = priorGbrainHome;
    if (priorHome === undefined) delete process.env.HOME;
    else process.env.HOME = priorHome;
    rmSync(root, { recursive: true, force: true });
  }
}

describe('doctor reconciled upgrade authority', () => {
  test('newer legacy pending state and error cannot be hidden by stale canonical completion', () => {
    withUpgradeHomes(({ canonicalDir, legacyDir }) => {
      writeOwned(
        join(canonicalDir, 'upgrade-state.json'),
        stateRecord({
          status: 'complete',
          ts: '2026-07-12T00:02:00.000Z',
          transitionId: COMPLETE_TRANSITION,
        }),
      );
      writeOwned(
        join(legacyDir, 'upgrade-state.json'),
        stateRecord({
          status: 'post_upgrade_pending',
          ts: '2026-07-12T00:03:00.000Z',
          transitionId: PENDING_TRANSITION,
        }),
      );
      writeOwned(
        join(canonicalDir, 'upgrade-errors.jsonl'),
        errorRecord({
          ts: '2026-07-12T00:01:00.000Z',
          phase: 'canonical-older',
          transitionId: COMPLETE_TRANSITION,
        }),
      );
      writeOwned(
        join(legacyDir, 'upgrade-errors.jsonl'),
        errorRecord({
          ts: '2026-07-12T00:04:00.000Z',
          phase: 'legacy-newer',
          transitionId: PENDING_TRANSITION,
        }),
      );

      expect(loadReconciledUpgradeState()).toMatchObject({
        kind: 'pending',
        status: 'post_upgrade_pending',
        transitionId: PENDING_TRANSITION,
      });
      expect(buildUpgradeStateCheck()).toMatchObject({ status: 'fail' });
      expect(buildUpgradeErrorEvidenceCheck()).toMatchObject({
        status: 'warn',
        message: expect.stringContaining('legacy-newer'),
      });
    });
  });

  test('newer malformed legacy state keeps a stale canonical completion red', () => {
    withUpgradeHomes(({ canonicalDir, legacyDir }) => {
      writeOwned(
        join(canonicalDir, 'upgrade-state.json'),
        stateRecord({
          status: 'complete',
          ts: '2026-07-12T00:02:00.000Z',
          transitionId: COMPLETE_TRANSITION,
        }),
      );
      writeOwned(join(legacyDir, 'upgrade-state.json'), '{"last_upgrade":{"status":"running"}}\n');

      expect(loadReconciledUpgradeState()).toMatchObject({ kind: 'invalid' });
      expect(buildUpgradeStateCheck()).toMatchObject({ status: 'fail' });
    });
  });

  test('suppresses a failure only with an exact later reconciled completion', () => {
    withUpgradeHomes(({ canonicalDir }) => {
      writeOwned(
        join(canonicalDir, 'upgrade-state.json'),
        stateRecord({
          status: 'complete',
          ts: '2026-07-12T00:02:00.000Z',
          transitionId: COMPLETE_TRANSITION,
        }),
      );
      writeOwned(
        join(canonicalDir, 'upgrade-errors.jsonl'),
        errorRecord({
          ts: '2026-07-12T00:01:00.000Z',
          phase: 'matching-failure',
          transitionId: COMPLETE_TRANSITION,
        }),
      );
      expect(buildUpgradeErrorEvidenceCheck()).toBeNull();

      writeOwned(
        join(canonicalDir, 'upgrade-errors.jsonl'),
        errorRecord({
          ts: '2026-07-12T00:03:00.000Z',
          phase: 'failure-after-completion',
          transitionId: COMPLETE_TRANSITION,
        }),
      );
      expect(buildUpgradeErrorEvidenceCheck()).toMatchObject({
        status: 'warn',
        message: expect.stringContaining('failure-after-completion'),
      });
    });
  });

  test('fails closed when canonical and legacy logs disagree at the newest timestamp', () => {
    withUpgradeHomes(({ canonicalDir, legacyDir }) => {
      writeOwned(
        join(canonicalDir, 'upgrade-errors.jsonl'),
        errorRecord({
          ts: '2026-07-12T00:04:00.000Z',
          phase: 'canonical',
          transitionId: COMPLETE_TRANSITION,
        }),
      );
      writeOwned(
        join(legacyDir, 'upgrade-errors.jsonl'),
        errorRecord({
          ts: '2026-07-12T00:04:00.000Z',
          phase: 'legacy',
          transitionId: PENDING_TRANSITION,
        }),
      );
      expect(buildUpgradeErrorEvidenceCheck()).toMatchObject({ status: 'fail' });
    });
  });

  test('uses append order for same-millisecond failures within one log', () => {
    withUpgradeHomes(({ canonicalDir }) => {
      const ts = '2026-07-12T00:04:00.000Z';
      writeOwned(
        join(canonicalDir, 'upgrade-errors.jsonl'),
        errorRecord({
          ts,
          phase: 'first-in-log',
          transitionId: COMPLETE_TRANSITION,
        }) + errorRecord({
          ts,
          phase: 'second-in-log',
          transitionId: COMPLETE_TRANSITION,
        }),
      );
      expect(buildUpgradeErrorEvidenceCheck()).toMatchObject({
        status: 'warn',
        message: expect.stringContaining('second-in-log'),
      });
    });
  });
});
