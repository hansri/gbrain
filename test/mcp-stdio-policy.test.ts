import { describe, expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import type { BrainEngine } from '../src/core/engine.ts';
import { runServe } from '../src/commands/serve.ts';
import {
  DEFAULT_STDIO_MCP_READ_TOOLS,
  dispatchStdioToolCall,
  resolveStdioMcpPolicy,
  stdioAuthForPolicy,
  stdioMcpPolicyFromEnv,
} from '../src/mcp/stdio-policy.ts';

const unreachableEngine = {} as BrainEngine;

function resultBody(result: Awaited<ReturnType<typeof dispatchStdioToolCall>>) {
  return JSON.parse(result.content[0]!.text) as Record<string, unknown>;
}

describe('stdio MCP capability policy', () => {
  test('secure default advertises only the curated read-only retrieval set', () => {
    const policy = resolveStdioMcpPolicy();
    const names = policy.allowedOperations.map(op => op.name);

    expect(names).toEqual([...DEFAULT_STDIO_MCP_READ_TOOLS]);
    expect(names).toContain('search');
    expect(names).toContain('get_page');
    expect(names).toContain('get_source_stats');
    expect(names).toContain('get_source_health');
    expect(names).not.toContain('get_stats');
    expect(names).not.toContain('get_health');
    expect(names).not.toContain('get_status_snapshot');
    expect(names).not.toContain('get_brain_identity');
    expect(names).not.toContain('sync_brain');
    expect(names).not.toContain('file_upload');
    expect(names).not.toContain('put_page');
    expect(policy.includeHotMemory).toBe(false);
    expect(policy.fingerprint).toMatch(/^[a-f0-9]{16}$/);
    for (const op of policy.allowedOperations) {
      expect(op.localOnly).not.toBe(true);
      expect(op.mutating).not.toBe(true);
      expect(op.scope ?? 'read').toBe('read');
    }
  });

  test('secure profile cannot allow-list localOnly, admin, or mutating tools', () => {
    const policy = resolveStdioMcpPolicy({
      allowedTools: ['search', 'sync_brain', 'file_upload', 'get_stats', 'run_doctor', 'put_page'],
      allowedScopes: ['read', 'write', 'admin'],
    });

    expect(policy.allowedOperations.map(op => op.name)).toEqual(['search']);
  });

  test('direct calls to hidden filesystem/admin tools are denied before dispatch', async () => {
    const policy = resolveStdioMcpPolicy();

    for (const name of ['sync_brain', 'file_upload', 'get_stats', 'run_doctor']) {
      const result = await dispatchStdioToolCall(unreachableEngine, name, {}, policy);
      expect(result.isError).toBe(true);
      expect(resultBody(result)).toMatchObject({
        error: 'permission_denied',
        profile: 'retrieval-readonly',
      });
    }
  });

  test('launcher allow-list is enforced at invocation, not only advertisement', async () => {
    const policy = resolveStdioMcpPolicy({ allowedTools: ['search'] });
    const result = await dispatchStdioToolCall(
      unreachableEngine,
      'get_page',
      { slug: 'notes/example' },
      policy,
    );

    expect(policy.allowedOperations.map(op => op.name)).toEqual(['search']);
    expect(resultBody(result).error).toBe('permission_denied');
  });

  test('routine stdio principal rejects a caller-selected foreign source', async () => {
    const policy = resolveStdioMcpPolicy();
    const result = await dispatchStdioToolCall(
      unreachableEngine,
      'query',
      { query: 'private', source_id: 'source-b' },
      policy,
      {
        sourceId: 'source-a',
        auth: stdioAuthForPolicy('source-a', policy),
      },
    );

    expect(result.isError).toBe(true);
    expect(resultBody(result)).toMatchObject({ error: 'permission_denied' });
  });

  test('unknown configured tools fail closed instead of silently drifting', () => {
    expect(() => resolveStdioMcpPolicy({
      allowedTools: ['search', 'renamed_or_missing_tool'],
    })).toThrow('Unknown stdio MCP tool(s): renamed_or_missing_tool');
  });

  test('historical broad surface requires the explicit unsafe maintenance profile', () => {
    const policy = resolveStdioMcpPolicy({ profile: 'unsafe-local-maintenance' });
    const names = policy.allowedOperations.map(op => op.name);

    expect(names).toContain('sync_brain');
    expect(names).toContain('file_upload');
    expect(names).toContain('get_stats');
    expect(names).toContain('put_page');
  });

  test('launcher env parser keeps unsafe compatibility opt-in explicit', () => {
    expect(stdioMcpPolicyFromEnv({})).toEqual({});
    expect(stdioMcpPolicyFromEnv({
      GBRAIN_MCP_STDIO_PROFILE: 'unsafe-local-maintenance',
      GBRAIN_MCP_STDIO_ALLOWED_TOOLS: 'search, get_page',
      GBRAIN_MCP_STDIO_ALLOWED_SCOPES: 'read',
      GBRAIN_MCP_STDIO_HOT_MEMORY: 'true',
    })).toEqual({
      profile: 'unsafe-local-maintenance',
      allowedTools: ['search', 'get_page'],
      allowedScopes: ['read'],
      includeHotMemory: true,
    });
    expect(() => stdioMcpPolicyFromEnv({
      GBRAIN_MCP_STDIO_HOT_MEMORY: 'sometimes',
    })).toThrow('GBRAIN_MCP_STDIO_HOT_MEMORY');
  });

  test('serve launcher passes its explicit policy to the stdio server', async () => {
    const stdin = Object.assign(new EventEmitter(), { isTTY: true });
    const signals = new EventEmitter();
    let captured: unknown;
    const logs: string[] = [];

    await runServe(unreachableEngine, [], {
      stdin: stdin as never,
      signals: signals as never,
      exit: () => {},
      log: (message) => { logs.push(message); },
      getParentPid: () => 1,
      probeWatchdog: () => true,
      mcpPolicy: { allowedTools: ['search'], allowedScopes: ['read'] },
      startMcpServer: async (_engine, policy) => { captured = policy; },
    });

    expect(captured).toMatchObject({
      profile: 'retrieval-readonly',
      includeHotMemory: false,
      fingerprint: expect.stringMatching(/^[a-f0-9]{16}$/),
    });
    expect((captured as { allowedOperations: Array<{ name: string }> }).allowedOperations)
      .toEqual([expect.objectContaining({ name: 'search' })]);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatch(/profile=retrieval-readonly tools=1 fingerprint=[a-f0-9]{16}/);
    expect(logs[0]).toContain('hot_memory=off source_bound=yes');
  });
});
