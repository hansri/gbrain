import { isScope } from './scope.ts';

/**
 * Derive a legacy bearer token's source scope from its stored
 * `access_tokens.permissions.source_id` grant.
 *
 * ARRAY = federated read grant, exposed through `allowedSources` with the
 * first granted source as the scalar write floor. STRING = scalar source.
 * Missing, empty, or garbage values fail closed to the historical `default`
 * floor and NEVER widen to all sources.
 */
export function parseLegacyTokenScope(rawSource: unknown): { sourceId: string; allowedSources?: string[] } {
  if (Array.isArray(rawSource)) {
    const allowedSources = (rawSource as unknown[]).filter(s => typeof s === 'string' && s.length > 0) as string[];
    if (allowedSources.length > 0) {
      return { sourceId: allowedSources[0], allowedSources };
    }
    return { sourceId: 'default' };
  }
  if (typeof rawSource === 'string' && rawSource.length > 0) {
    return { sourceId: rawSource };
  }
  return { sourceId: 'default' };
}

export interface LegacyTokenCapabilities {
  /** OAuth-style operation scopes. Missing preserves the legacy full-access contract. */
  scopes: string[];
  /** Exact remote MCP tool allow-list. Undefined preserves the legacy all-tools contract. */
  allowedTools?: string[];
}

/**
 * Parse optional least-privilege capabilities from a legacy token's JSONB
 * permissions object.
 *
 * Backwards compatibility is explicit: rows created before capability fields
 * existed have neither key and retain the historical full-access behavior.
 * Once an operator writes either key, malformed or empty values fail closed
 * for that axis instead of silently widening access.
 */
export function parseLegacyTokenCapabilities(rawPermissions: unknown): LegacyTokenCapabilities {
  // NULL / absent is the only non-object shape that represents a genuine
  // pre-capability row. Any other malformed top-level value was explicitly
  // stored and must not be allowed to widen a token back to full access.
  if (rawPermissions === undefined || rawPermissions === null) {
    return { scopes: ['read', 'write', 'admin'] };
  }

  let permissions = rawPermissions;
  if (typeof permissions === 'string') {
    try {
      permissions = JSON.parse(permissions);
    } catch {
      return { scopes: [], allowedTools: [] };
    }
  }

  if (!permissions || typeof permissions !== 'object' || Array.isArray(permissions)) {
    return { scopes: [], allowedTools: [] };
  }

  const record = permissions as Record<string, unknown>;
  const scopes = Object.prototype.hasOwnProperty.call(record, 'scopes')
    ? strictUniqueStrings(record.scopes, isScope)
    : ['read', 'write', 'admin'];
  const allowedTools = Object.prototype.hasOwnProperty.call(record, 'allowed_tools')
    ? strictUniqueStrings(record.allowed_tools, value => /^[A-Za-z][A-Za-z0-9_-]*$/.test(value))
    : undefined;

  return { scopes, ...(allowedTools !== undefined ? { allowedTools } : {}) };
}

function strictUniqueStrings(value: unknown, validate: (value: string) => boolean): string[] {
  if (!Array.isArray(value)) return [];
  if (value.some(item => typeof item !== 'string' || item.trim().length === 0)) return [];
  const cleaned = value.map(item => (item as string).trim());
  if (cleaned.some(item => !validate(item))) return [];
  return [...new Set(cleaned)];
}
