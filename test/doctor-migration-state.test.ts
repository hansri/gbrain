import { describe, expect, test } from 'bun:test';
import { buildMigrationLedgerCheck } from '../src/commands/doctor.ts';
import type { CompletedMigrationEntry } from '../src/core/preferences.ts';

describe('doctor migration ledger scoping', () => {
  test('reports only the selected brain and cannot be suppressed cross-brain', () => {
    const entries: CompletedMigrationEntry[] = [
      { version: '0.20.0', brain_id: 'brain-a', status: 'partial' },
      { version: '0.20.0', brain_id: 'brain-b', status: 'complete' },
    ];
    expect(buildMigrationLedgerCheck(entries, 'brain-a')).toMatchObject({
      status: 'fail',
      message: expect.stringContaining('[brain-a] 0.20.0'),
    });
    expect(buildMigrationLedgerCheck(entries, 'brain-b')).toBeNull();
  });

  test('filesystem-only diagnostics name partitions without combining attempts', () => {
    const entries: CompletedMigrationEntry[] = [
      { version: '0.20.0', brain_id: 'brain-a', status: 'partial' },
      { version: '0.20.0', brain_id: 'brain-a', status: 'partial' },
      { version: '0.20.0', brain_id: 'brain-b', status: 'partial' },
    ];
    const check = buildMigrationLedgerCheck(entries);
    expect(check?.message).toContain('[brain-a] 0.20.0');
    expect(check?.message).toContain('[brain-b] 0.20.0');
    expect(check?.message).not.toContain('WEDGED');
  });

  test('later migration completion never suppresses independent older work', () => {
    const ordinary: CompletedMigrationEntry[] = [
      { version: '0.20.0', brain_id: 'brain-a', status: 'partial' },
      { version: '0.21.0', brain_id: 'brain-a', status: 'complete' },
    ];
    expect(buildMigrationLedgerCheck(ordinary, 'brain-a')?.message).toContain('0.20.0');

    const ambiguous: CompletedMigrationEntry[] = [
      { version: '0.20.0', brain_id: 'brain-a', status: 'partial', ambiguous_state: true },
      { version: '0.21.0', brain_id: 'brain-a', status: 'complete' },
    ];
    expect(buildMigrationLedgerCheck(ambiguous, 'brain-a')?.message).toContain('AMBIGUOUS');
  });
});
