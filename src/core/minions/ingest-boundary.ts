/**
 * Durable trust marker for locally submitted ingestion jobs.
 *
 * The marker is deliberately stamped by MinionQueue.add() from its separate
 * trusted options argument. It is never accepted from job.data: queue.add()
 * removes a caller-supplied copy before persistence. That makes trust an
 * in-process server decision rather than a JSON payload field that an MCP
 * caller can forge.
 *
 * Direct database writers remain inside the trusted host boundary. They can
 * manufacture any persisted row and therefore must already be treated as
 * equivalent to local code execution/database administration.
 */
export const TRUSTED_LOCAL_INGEST_MARKER = '__gbrain_trusted_local_ingest_v1';

/** Return a copy suitable for durable queue storage. */
export function prepareIngestCaptureJobData(
  data: Record<string, unknown> | undefined,
  trustedLocalIngest: boolean,
): Record<string, unknown> {
  const prepared = { ...(data ?? {}) };
  delete prepared[TRUSTED_LOCAL_INGEST_MARKER];
  if (trustedLocalIngest) {
    prepared[TRUSTED_LOCAL_INGEST_MARKER] = true;
  }
  return prepared;
}

/** Check the server-stamped marker after the queue boundary. */
export function isTrustedLocalIngestJobData(data: Record<string, unknown>): boolean {
  return data[TRUSTED_LOCAL_INGEST_MARKER] === true;
}
