import { test, expect, describe } from 'bun:test';
import { parseAuthCreateArgs, parseAuthPermissionsArgs } from '../src/commands/auth.ts';

describe('parseAuthCreateArgs', () => {
  test('bare name (no flag) resolves the name — regression for the dropped-name bug', () => {
    // Pre-fix this returned name='' because rest[takesIdx+1] === rest[0] when
    // takesIdx === -1, excluding the only positional from the search.
    expect(parseAuthCreateArgs(['claude-code'])).toEqual({
      name: 'claude-code',
      takesHolders: undefined,
      scopes: undefined,
      allowedTools: undefined,
    });
  });

  test('name + --takes-holders', () => {
    expect(parseAuthCreateArgs(['claude-code', '--takes-holders', 'world,garry'])).toEqual({
      name: 'claude-code',
      takesHolders: ['world', 'garry'],
      scopes: undefined,
      allowedTools: undefined,
    });
  });

  test('--takes-holders before the name still finds the name', () => {
    expect(parseAuthCreateArgs(['--takes-holders', 'world', 'claude-code'])).toEqual({
      name: 'claude-code',
      takesHolders: ['world'],
      scopes: undefined,
      allowedTools: undefined,
    });
  });

  test('the takes-holders value is not mistaken for the name', () => {
    // 'world' is the flag value, 'mybot' is the name.
    expect(parseAuthCreateArgs(['--takes-holders', 'world', 'mybot']).name).toBe('mybot');
  });

  test('no name → empty string (caller prints usage)', () => {
    expect(parseAuthCreateArgs([]).name).toBe('');
    expect(parseAuthCreateArgs(['--takes-holders', 'world']).name).toBe('');
  });

  test('takes-holders trims + drops empties', () => {
    expect(parseAuthCreateArgs(['n', '--takes-holders', ' world , , garry ']).takesHolders).toEqual(['world', 'garry']);
  });

  test('least-privilege scope and exact tools parse in any flag order', () => {
    expect(parseAuthCreateArgs([
      '--tools', 'search,get_page,search',
      'agent',
      '--scopes', 'read',
    ])).toEqual({
      name: 'agent',
      takesHolders: undefined,
      scopes: ['read'],
      allowedTools: ['search', 'get_page'],
    });
  });

  test('missing values and unknown flags fail closed', () => {
    expect(() => parseAuthCreateArgs(['agent', '--scopes'])).toThrow(/requires a value/);
    expect(() => parseAuthCreateArgs(['agent', '--unknown', 'x'])).toThrow(/Unknown flag/);
    expect(() => parseAuthCreateArgs(['one', 'two'])).toThrow(/Unexpected positional/);
    expect(() => parseAuthCreateArgs(['agent', '--scopes', 'root'])).toThrow(/Unknown scope/);
    expect(() => parseAuthCreateArgs(['agent', '--tools', 'search,$shell'])).toThrow(/Invalid tool name/);
    expect(() => parseAuthCreateArgs(['agent', '--tools', ''])).toThrow(/cannot be empty/);
  });
});

describe('parseAuthPermissionsArgs', () => {
  test('parses and deduplicates each supported capability action', () => {
    expect(parseAuthPermissionsArgs(['agent', 'set-scopes', 'admin,admin'])).toEqual({
      name: 'agent', action: 'set-scopes', values: ['admin'],
    });
    expect(parseAuthPermissionsArgs(['agent', 'set-tools', 'search,get_page,search'])).toEqual({
      name: 'agent', action: 'set-tools', values: ['search', 'get_page'],
    });
  });

  test('rejects unknown actions, invalid values, missing fields, and trailing args', () => {
    expect(() => parseAuthPermissionsArgs(['agent', 'set-admin', 'yes'])).toThrow(/Unknown permissions action/);
    expect(() => parseAuthPermissionsArgs(['agent', 'set-scopes', 'root'])).toThrow(/Unknown scope/);
    expect(() => parseAuthPermissionsArgs(['agent', 'set-tools', '$shell'])).toThrow(/Invalid tool name/);
    expect(() => parseAuthPermissionsArgs(['agent', 'set-tools'])).toThrow(/exactly/);
    expect(() => parseAuthPermissionsArgs(['agent', 'set-tools', 'search', 'ignored'])).toThrow(/exactly/);
  });
});
