import { SCHEMA_SQL } from './schema-embedded.ts';
import { applyChunkEmbeddingIndexPolicy } from './vector-index.ts';
import {
  DEFAULT_EMBEDDING_DIMENSIONS,
  DEFAULT_EMBEDDING_MODEL,
} from './ai/defaults.ts';

function escapeSqlStringLiteral(value: string): string {
  return value.replace(/'/g, "''");
}

/** Render the canonical Postgres schema for one embedding authority. */
export function getPostgresSchema(
  dims: number = DEFAULT_EMBEDDING_DIMENSIONS,
  model: string = DEFAULT_EMBEDDING_MODEL,
): string {
  const parsedDims = Number(dims);
  if (!Number.isInteger(parsedDims) || parsedDims <= 0) {
    throw new Error(`Invalid embedding dimensions: ${dims}`);
  }
  const sanitizedModel = escapeSqlStringLiteral(String(model));
  return applyChunkEmbeddingIndexPolicy(SCHEMA_SQL, parsedDims)
    .replace(/vector\(1536\)/g, `vector(${parsedDims})`)
    .replace(/'text-embedding-3-large'/g, `'${sanitizedModel}'`)
    .replace(/\('embedding_dimensions', '1536'\)/g, `('embedding_dimensions', '${parsedDims}')`);
}

/**
 * Resolve the configured gateway when available, otherwise use the canonical
 * defaults. Both Postgres initialization paths call this function so the
 * module singleton and PostgresEngine cannot create different vector widths.
 */
export async function getConfiguredPostgresSchema(): Promise<string> {
  let dims = DEFAULT_EMBEDDING_DIMENSIONS;
  let model = DEFAULT_EMBEDDING_MODEL;
  try {
    const gateway = await import('./ai/gateway.ts');
    dims = gateway.getEmbeddingDimensions();
    model = gateway.getEmbeddingModel() || model;
  } catch {
    // Gateway is not configured during early bootstrap; canonical defaults
    // remain the single source of truth.
  }
  return getPostgresSchema(dims, model);
}
