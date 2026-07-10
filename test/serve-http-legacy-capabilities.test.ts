import { describe, expect, test } from 'bun:test';
import {
  filterDiscoverableMcpOperationsForAuth,
  filterMcpOperationsForAuth,
} from '../src/commands/serve-http.ts';

const operations = [
  { name: 'search', scope: 'read', marker: 1 },
  { name: 'get_page', scope: 'read', marker: 2 },
  { name: 'put_page', scope: 'write', marker: 3 },
];

describe('serve-http legacy capability filter', () => {
  test('undefined preserves the backwards-compatible operation surface', () => {
    expect(filterMcpOperationsForAuth(operations, {}).map(op => op.name)).toEqual([
      'search',
      'get_page',
      'put_page',
    ]);
  });

  test('an explicit list is exact for both discovery and call lookup', () => {
    const filtered = filterMcpOperationsForAuth(operations, {
      allowedTools: ['get_page', 'search', 'not-installed'],
    });
    expect(filtered.map(op => op.name)).toEqual(['search', 'get_page']);
    expect(filtered.find(op => op.name === 'put_page')).toBeUndefined();
  });

  test('an explicit empty list denies all operations', () => {
    expect(filterMcpOperationsForAuth(operations, { allowedTools: [] })).toEqual([]);
  });

  test('discovery intersects the exact list with callable scopes', () => {
    expect(filterDiscoverableMcpOperationsForAuth(operations, {
      scopes: ['read'],
      allowedTools: ['search', 'put_page'],
    }).map(op => op.name)).toEqual(['search']);
    expect(filterDiscoverableMcpOperationsForAuth(operations, {
      scopes: ['admin'],
      allowedTools: ['search', 'put_page'],
    }).map(op => op.name)).toEqual(['search', 'put_page']);
  });
});
