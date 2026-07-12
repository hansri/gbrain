import { describe, expect, test } from 'bun:test';
import type { CompletedMigrationEntry } from '../src/core/preferences.ts';
import {
  indexMigrationEntries,
  listUnresolvedMigrationStates,
  migrationStatusForVersion,
} from '../src/core/migration-state.ts';

describe('brain-scoped migration ledger state', () => {
  test('never lets another brain completion suppress a partial or ambiguity', () => {
    const entries: CompletedMigrationEntry[] = [
      { version: '0.20.0', brain_id: 'brain-a', status: 'partial' },
      { version: '0.20.0', brain_id: 'brain-b', status: 'complete' },
      { version: '0.21.0', brain_id: 'brain-a', status: 'partial', ambiguous_state: true },
      { version: '0.22.0', brain_id: 'brain-b', status: 'complete' },
    ];

    expect(listUnresolvedMigrationStates(entries, 'brain-a')).toEqual([
      { brain_id: 'brain-a', version: '0.20.0', status: 'partial' },
      { brain_id: 'brain-a', version: '0.21.0', status: 'ambiguous' },
    ]);
    expect(listUnresolvedMigrationStates(entries, 'brain-b')).toEqual([]);
  });

  test('partials from different brains never combine into a wedge', () => {
    const entries: CompletedMigrationEntry[] = [
      { version: '0.20.0', brain_id: 'brain-a', status: 'partial' },
      { version: '0.20.0', brain_id: 'brain-a', status: 'partial' },
      { version: '0.20.0', brain_id: 'brain-b', status: 'partial' },
    ];
    expect(migrationStatusForVersion('0.20.0', indexMigrationEntries(entries, 'brain-a'))).toBe('partial');
    expect(migrationStatusForVersion('0.20.0', indexMigrationEntries(entries, 'brain-b'))).toBe('partial');
  });

  test('retry resets the trailing-consecutive partial count', () => {
    const entries: CompletedMigrationEntry[] = [
      { version: '0.20.0', brain_id: 'brain-a', status: 'partial' },
      { version: '0.20.0', brain_id: 'brain-a', status: 'partial' },
      { version: '0.20.0', brain_id: 'brain-a', status: 'retry' },
      { version: '0.20.0', brain_id: 'brain-a', status: 'partial' },
    ];
    expect(migrationStatusForVersion('0.20.0', indexMigrationEntries(entries, 'brain-a'))).toBe('partial');
  });

  test('ambiguity dominates every complete until a later explicit retry', () => {
    const entries: CompletedMigrationEntry[] = [
      { version: '0.20.0', brain_id: 'brain-a', status: 'complete' },
      { version: '0.20.0', brain_id: 'brain-a', status: 'partial', ambiguous_state: true },
    ];
    const status = () => migrationStatusForVersion(
      '0.20.0',
      indexMigrationEntries(entries, 'brain-a'),
    );

    expect(status()).toBe('ambiguous');
    entries.push({ version: '0.20.0', brain_id: 'brain-a', status: 'complete' });
    expect(status()).toBe('ambiguous');
    expect(listUnresolvedMigrationStates(entries, 'brain-a')).toEqual([
      { brain_id: 'brain-a', version: '0.20.0', status: 'ambiguous' },
    ]);

    entries.push({ version: '0.20.0', brain_id: 'brain-a', status: 'retry' });
    expect(status()).toBe('pending');
  });

  test('retry clears prior ambiguity and scopes partial counting to the new attempt', () => {
    const entries: CompletedMigrationEntry[] = [
      { version: '0.20.0', brain_id: 'brain-a', status: 'partial', ambiguous_state: true, ambiguity_fence_part: 1 },
      { version: '0.20.0', brain_id: 'brain-a', status: 'partial', ambiguous_state: true, ambiguity_fence_part: 2 },
      { version: '0.20.0', brain_id: 'brain-a', status: 'partial', ambiguous_state: true, ambiguity_fence_part: 3 },
      { version: '0.20.0', brain_id: 'brain-a', status: 'retry' },
    ];
    const status = () => migrationStatusForVersion(
      '0.20.0',
      indexMigrationEntries(entries, 'brain-a'),
    );

    expect(status()).toBe('pending');
    entries.push({ version: '0.20.0', brain_id: 'brain-a', status: 'partial' });
    expect(status()).toBe('partial');
    entries.push({ version: '0.20.0', brain_id: 'brain-a', status: 'partial' });
    expect(status()).toBe('partial');
    entries.push({ version: '0.20.0', brain_id: 'brain-a', status: 'partial' });
    expect(status()).toBe('wedged');
  });

  test('later-version completion never suppresses independent older work', () => {
    const entries: CompletedMigrationEntry[] = [
      { version: '0.20.0', brain_id: 'brain-a', status: 'partial' },
      { version: '0.21.0', brain_id: 'brain-a', status: 'complete' },
      { version: '0.19.0', brain_id: 'brain-b', status: 'partial', ambiguous_state: true },
      { version: '0.22.0', brain_id: 'brain-b', status: 'complete' },
    ];
    expect(listUnresolvedMigrationStates(entries, 'brain-a')).toEqual([
      { brain_id: 'brain-a', version: '0.20.0', status: 'partial' },
    ]);
    expect(listUnresolvedMigrationStates(entries, 'brain-b')).toEqual([
      { brain_id: 'brain-b', version: '0.19.0', status: 'ambiguous' },
    ]);
  });

  test('filesystem-only diagnostics keep every brain in a separate result', () => {
    const entries: CompletedMigrationEntry[] = [
      { version: '0.20.0', brain_id: 'brain-a', status: 'partial' },
      { version: '0.20.0', brain_id: 'brain-b', status: 'partial' },
      { version: '0.20.0', status: 'partial' },
    ];
    expect(listUnresolvedMigrationStates(entries)).toEqual([
      { brain_id: undefined, version: '0.20.0', status: 'partial' },
      { brain_id: 'brain-a', version: '0.20.0', status: 'partial' },
      { brain_id: 'brain-b', version: '0.20.0', status: 'partial' },
    ]);
  });

  test('unresolved write-ahead inflight fence dominates older or unrelated completes', () => {
    const attempt = '11111111-1111-4111-8111-111111111111';
    const entries: CompletedMigrationEntry[] = [
      { version: '0.20.0', brain_id: 'brain-a', status: 'complete' },
      { version: '0.20.0', brain_id: 'brain-a', status: 'partial', inflight_state: true, attempt_id: attempt },
      { version: '0.20.0', brain_id: 'brain-a', status: 'complete', attempt_id: '22222222-2222-4222-8222-222222222222', attempt_terminal: true },
    ];
    expect(migrationStatusForVersion('0.20.0', indexMigrationEntries(entries, 'brain-a'))).toBe('ambiguous');
  });

  test('matching terminal receipt settles inflight and excludes fence rows from wedge count', () => {
    const attempt = '33333333-3333-4333-8333-333333333333';
    const inflight = Array.from({ length: 3 }, (_, index): CompletedMigrationEntry => ({
      version: '0.20.0', brain_id: 'brain-a', status: 'partial',
      inflight_state: true, ambiguity_fence_part: index + 1, attempt_id: attempt,
    }));
    const partial = [
      ...inflight,
      { version: '0.20.0', brain_id: 'brain-a', status: 'partial' as const, attempt_id: attempt, attempt_terminal: true },
    ];
    expect(migrationStatusForVersion('0.20.0', indexMigrationEntries(partial, 'brain-a'))).toBe('partial');
    const complete = [
      ...inflight,
      { version: '0.20.0', brain_id: 'brain-a', status: 'complete' as const, attempt_id: attempt, attempt_terminal: true },
    ];
    expect(migrationStatusForVersion('0.20.0', indexMigrationEntries(complete, 'brain-a'))).toBe('complete');
  });

  test('a later settled attempt never hides an earlier unresolved inflight attempt', () => {
    const attemptA = '44444444-4444-4444-8444-444444444444';
    const attemptB = '55555555-5555-4555-8555-555555555555';
    const entries: CompletedMigrationEntry[] = [
      { version: '0.20.0', brain_id: 'brain-a', status: 'partial', inflight_state: true, attempt_id: attemptA },
      { version: '0.20.0', brain_id: 'brain-a', status: 'partial', inflight_state: true, attempt_id: attemptB },
      { version: '0.20.0', brain_id: 'brain-a', status: 'complete', attempt_id: attemptB, attempt_terminal: true },
    ];
    expect(migrationStatusForVersion('0.20.0', indexMigrationEntries(entries, 'brain-a'))).toBe('ambiguous');
  });
});
