/**
 * Capability policy for the unauthenticated stdio MCP transport.
 *
 * The stdio pipe is local, but its caller is still an untrusted agent.  The
 * launcher must opt into any surface broader than the curated retrieval set;
 * operation metadata alone is not an authorization boundary.
 */

import type { BrainEngine } from '../core/engine.ts';
import { operations } from '../core/operations.ts';
import type { AuthInfo, Operation } from '../core/operations.ts';
import { createHash } from 'node:crypto';
import {
  dispatchToolCall,
  type DispatchOpts,
  type ToolResult,
} from './dispatch.ts';

export const STDIO_MCP_PROFILES = [
  'retrieval-readonly',
  'unsafe-local-maintenance',
] as const;

export type StdioMcpProfile = typeof STDIO_MCP_PROFILES[number];
export type StdioMcpScope =
  | 'read'
  | 'write'
  | 'admin'
  | 'sources_admin'
  | 'users_admin'
  // submit_agent currently carries this runtime-only scope.
  | 'agent';

/**
 * Small, intentionally boring default.  These operations retrieve source-
 * scoped knowledge or its immediate graph/timeline context; they do not expose
 * maintenance, filesystem, job, schema, or write surfaces.
 */
export const DEFAULT_STDIO_MCP_READ_TOOLS: readonly string[] = Object.freeze([
  'query',
  'search',
  'get_page',
  'list_pages',
  'get_tags',
  'get_links',
  'get_backlinks',
  'list_link_sources',
  'traverse_graph',
  'get_timeline',
  'get_source_stats',
  'get_source_health',
]);

export interface StdioMcpPolicyInput {
  /** Secure by default. The unsafe profile restores the historical broad surface. */
  profile?: StdioMcpProfile;
  /** Exact operation names the launcher permits. Omit for the profile default. */
  allowedTools?: readonly string[];
  /** Exact operation scopes the launcher permits. Omit for the profile default. */
  allowedScopes?: readonly StdioMcpScope[];
  /** Ambient recent-fact metadata. Off by default to keep retrieval precise and lean. */
  includeHotMemory?: boolean;
}

export interface ResolvedStdioMcpPolicy {
  profile: StdioMcpProfile;
  allowedOperations: readonly Operation[];
  allowedToolNames: ReadonlySet<string>;
  includeHotMemory: boolean;
  fingerprint: string;
}

const KNOWN_SCOPES: ReadonlySet<string> = new Set<StdioMcpScope>([
  'read',
  'write',
  'admin',
  'sources_admin',
  'users_admin',
  'agent',
]);

function operationScope(op: Operation): StdioMcpScope {
  // Operation.scope historically defaults to read. One legacy operation uses
  // the runtime-only `agent` scope through an `as any` declaration.
  return (op.scope ?? 'read') as StdioMcpScope;
}

function normalizeNames(values: readonly string[]): string[] {
  return [...new Set(values.map(value => value.trim()).filter(Boolean))];
}

export function resolveStdioMcpPolicy(
  input: StdioMcpPolicyInput = {},
): ResolvedStdioMcpPolicy {
  const profile = input.profile ?? 'retrieval-readonly';
  if (!(STDIO_MCP_PROFILES as readonly string[]).includes(profile)) {
    throw new Error(`Unknown stdio MCP profile: ${String(profile)}`);
  }

  const requestedTools = new Set(normalizeNames(
    input.allowedTools
      ?? (profile === 'unsafe-local-maintenance'
        ? operations.map(op => op.name)
        : DEFAULT_STDIO_MCP_READ_TOOLS),
  ));

  const requestedScopes = input.allowedScopes
    ? new Set(normalizeNames(input.allowedScopes))
    : null;
  if (requestedScopes) {
    for (const scope of requestedScopes) {
      if (!KNOWN_SCOPES.has(scope)) {
        throw new Error(`Unknown stdio MCP scope: ${scope}`);
      }
    }
  }

  const operationsByName = new Map(operations.map(op => [op.name, op]));
  const unknownTools = [...requestedTools].filter(name => !operationsByName.has(name));
  if (unknownTools.length > 0) {
    throw new Error(`Unknown stdio MCP tool(s): ${unknownTools.sort().join(', ')}`);
  }
  const allowedOperations = [...requestedTools].flatMap(name => {
    const op = operationsByName.get(name);
    if (!op) return [];
    const scope = operationScope(op);
    if (requestedScopes && !requestedScopes.has(scope)) return [];

    if (profile === 'retrieval-readonly') {
      // Defense in depth: a launcher typo or stale allow-list cannot punch
      // through metadata boundaries. A broader surface requires the explicit
      // unsafe-local-maintenance profile.
      return op.localOnly !== true && op.mutating !== true && scope === 'read'
        ? [op]
        : [];
    }
    return [op];
  });

  const includeHotMemory = input.includeHotMemory === true;
  const fingerprint = createHash('sha256').update(JSON.stringify({
    profile,
    tools: allowedOperations.map(op => op.name).sort(),
    scopes: [...new Set(allowedOperations.map(operationScope))].sort(),
    includeHotMemory,
  })).digest('hex').slice(0, 16);

  return {
    profile,
    allowedOperations,
    allowedToolNames: new Set(allowedOperations.map(op => op.name)),
    includeHotMemory,
    fingerprint,
  };
}

/** Parse an explicit launcher environment into the policy input. */
export function stdioMcpPolicyFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): StdioMcpPolicyInput {
  const rawProfile = env.GBRAIN_MCP_STDIO_PROFILE?.trim();
  if (rawProfile && !(STDIO_MCP_PROFILES as readonly string[]).includes(rawProfile)) {
    throw new Error(
      `GBRAIN_MCP_STDIO_PROFILE must be one of: ${STDIO_MCP_PROFILES.join(', ')}`,
    );
  }

  const parseCsv = (raw: string): string[] => normalizeNames(raw.split(','));
  const rawScopes = env.GBRAIN_MCP_STDIO_ALLOWED_SCOPES;
  const allowedScopes = rawScopes === undefined
    ? undefined
    : parseCsv(rawScopes) as StdioMcpScope[];
  if (allowedScopes) {
    for (const scope of allowedScopes) {
      if (!KNOWN_SCOPES.has(scope)) {
        throw new Error(`Unknown stdio MCP scope in GBRAIN_MCP_STDIO_ALLOWED_SCOPES: ${scope}`);
      }
    }
  }

  const rawTools = env.GBRAIN_MCP_STDIO_ALLOWED_TOOLS;
  const rawHotMemory = env.GBRAIN_MCP_STDIO_HOT_MEMORY?.trim().toLowerCase();
  if (rawHotMemory !== undefined && !['1', 'true', '0', 'false'].includes(rawHotMemory)) {
    throw new Error('GBRAIN_MCP_STDIO_HOT_MEMORY must be one of: 1, true, 0, false');
  }
  return {
    ...(rawProfile ? { profile: rawProfile as StdioMcpProfile } : {}),
    ...(rawTools !== undefined ? { allowedTools: parseCsv(rawTools) } : {}),
    ...(allowedScopes !== undefined ? { allowedScopes } : {}),
    ...(rawHotMemory !== undefined
      ? { includeHotMemory: rawHotMemory === '1' || rawHotMemory === 'true' }
      : {}),
  };
}

/**
 * Bind the unauthenticated local pipe to exactly one configured source. The
 * synthetic principal makes the normal remote source-grant resolver reject a
 * caller-supplied source_id outside that source instead of trusting the scalar
 * default as an override floor.
 */
export function stdioAuthForPolicy(
  sourceId: string,
  policy: ResolvedStdioMcpPolicy,
): AuthInfo {
  return {
    token: 'stdio-local-pipe',
    clientId: `stdio:${policy.profile}`,
    clientName: 'GBrain stdio agent',
    scopes: [...new Set(policy.allowedOperations.map(operationScope))].sort(),
    sourceId,
    allowedSources: [sourceId],
    allowedTools: [...policy.allowedToolNames].sort(),
  };
}

function deniedToolResult(name: string, policy: ResolvedStdioMcpPolicy): ToolResult {
  return {
    content: [{
      type: 'text',
      text: JSON.stringify({
        error: 'permission_denied',
        message: `Tool '${name}' is not allowed by the active stdio MCP profile`,
        profile: policy.profile,
      }, null, 2),
    }],
    isError: true,
  };
}

/**
 * Invocation gate paired with tools/list filtering. Known-but-denied tools are
 * rejected before validation, context construction, or handler execution.
 */
export async function dispatchStdioToolCall(
  engine: BrainEngine,
  name: string,
  params: Record<string, unknown> | undefined,
  policy: ResolvedStdioMcpPolicy,
  opts: Omit<DispatchOpts, 'remote'> = {},
): Promise<ToolResult> {
  const known = operations.some(op => op.name === name);
  if (known && !policy.allowedToolNames.has(name)) {
    return deniedToolResult(name, policy);
  }
  return dispatchToolCall(engine, name, params, { ...opts, remote: true });
}
