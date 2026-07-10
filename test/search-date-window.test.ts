import { describe, expect, test } from 'bun:test';
import {
  normalizeSearchDateWindow,
  SearchDateWindowError,
} from '../src/core/search/date-window.ts';
import { knobsHash, resolveSearchMode } from '../src/core/search/mode.ts';

describe('normalizeSearchDateWindow', () => {
  test('date-only boundaries include the full UTC day', () => {
    expect(normalizeSearchDateWindow({
      since: '2026-07-09',
      until: '2026-07-09',
    })).toEqual({
      since: '2026-07-09T00:00:00.000Z',
      until: '2026-07-09T23:59:59.999999Z',
    });
  });

  test('normalizes explicit offsets and treats zone-less timestamps as UTC', () => {
    expect(normalizeSearchDateWindow({
      since: '2026-07-09T12:30:00+02:00',
      until: '2026-07-09T12:30:00',
    })).toEqual({
      since: '2026-07-09T10:30:00.000Z',
      until: '2026-07-09T12:30:00.000Z',
    });
  });

  test('resolves relative durations against the injected clock', () => {
    const now = new Date('2026-07-10T12:00:00.000Z');
    expect(normalizeSearchDateWindow({ since: '2w', until: '7d' }, now)).toEqual({
      since: '2026-06-26T12:00:00.000Z',
      until: '2026-07-03T12:00:00.000Z',
    });
  });

  test('rejects malformed dates and inverted windows before SQL', () => {
    expect(() => normalizeSearchDateWindow({ since: '2026-02-30' }))
      .toThrow(SearchDateWindowError);
    expect(() => normalizeSearchDateWindow({ since: '2026-07-10', until: '2026-07-09' }))
      .toThrow(/since .* is after until/);
  });
});

describe('temporal semantic-cache isolation', () => {
  test('unfiltered and differently filtered windows get distinct knob hashes', () => {
    const knobs = resolveSearchMode({ mode: 'balanced' });
    const base = { embeddingColumn: 'embedding', embeddingModel: 'openai:text-embedding-3-large' };
    const unfiltered = knobsHash(knobs, base);
    const oneDay = knobsHash(knobs, {
      ...base,
      since: '2026-07-09T00:00:00.000Z',
      until: '2026-07-09T23:59:59.999999Z',
      sinceInclusive: true,
      untilInclusive: true,
    });
    const nextDay = knobsHash(knobs, {
      ...base,
      since: '2026-07-10T00:00:00.000Z',
      until: '2026-07-10T23:59:59.999999Z',
      sinceInclusive: true,
      untilInclusive: true,
    });

    expect(oneDay).not.toBe(unfiltered);
    expect(nextDay).not.toBe(oneDay);
  });
});
