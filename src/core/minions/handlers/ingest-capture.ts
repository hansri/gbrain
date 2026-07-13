/**
 * `ingest_capture` Minion job handler. Receives an IngestionEvent payload
 * from the daemon's dispatcher (or the webhook source's POST /ingest
 * handler) and routes it through `importFromContent` to land as a brain
 * page.
 *
 * Trust posture:
 *   - source_id and evidence provenance are threaded into importFromContent;
 *     the handler never falls back to the process/default source.
 *   - HTTP submitters must carry the exact server-built envelope:
 *     job.data.remote=true, untrusted_payload=true, and matching source ids.
 *   - Local daemon/CLI submissions must carry the queue-stamped local marker.
 *     Missing/legacy envelopes are rejected instead of being treated trusted.
 *
 * Slug resolution (in order):
 *   1. `job.data.slug` if caller provided one
 *   2. `job.data.metadata.slug` if event metadata carried one
 *   3. Generated default: `inbox/YYYY-MM-DD-<hash6>` using the event's
 *      content_hash prefix. Stable for the same content.
 *
 * The default slug deliberately lives under `inbox/` — that's the
 * triage convention the user will discover when reviewing recent
 * captures. A downstream skill (post-capture-triage) can promote inbox
 * pages to canonical homes later.
 */

import type { MinionJobContext } from '../types.ts';
import type { BrainEngine } from '../../engine.ts';
import type { IngestionEvent } from '../../ingestion/types.ts';
import { validateIngestionEvent } from '../../ingestion/types.ts';
import { importFromContent } from '../../import-file.ts';
import { isTrustedLocalIngestJobData } from '../ingest-boundary.ts';

export interface IngestCaptureResult {
  slug: string;
  status: 'imported' | 'skipped' | 'error';
  chunks: number;
  untrusted_payload: boolean;
  source_kind: string;
  source_uri: string;
}

/** Builds the default slug for an event when the caller didn't provide one. */
export function defaultSlugForEvent(event: IngestionEvent, now: Date = new Date()): string {
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, '0');
  const d = String(now.getUTCDate()).padStart(2, '0');
  const hashPrefix = event.content_hash.slice(0, 6);
  return `inbox/${y}-${m}-${d}-${hashPrefix}`;
}

export function makeIngestCaptureHandler(engine: BrainEngine) {
  return async function ingestCaptureHandler(job: MinionJobContext): Promise<IngestCaptureResult> {
    const data = job.data as {
      event?: unknown;
      sourceId?: unknown;
      slug?: unknown;
      remote?: unknown;
      noEmbed?: unknown;
    };
    const event = data.event as IngestionEvent | undefined;
    if (!event) {
      throw new Error('ingest_capture: job.data.event is required');
    }
    const validationErr = validateIngestionEvent(event);
    if (validationErr) {
      throw new Error(`ingest_capture: invalid event payload: ${validationErr.message}`);
    }

    // Slug resolution.
    let slug: string;
    if (typeof data.slug === 'string' && data.slug.length > 0) {
      slug = data.slug;
    } else if (
      event.metadata &&
      typeof (event.metadata as Record<string, unknown>).slug === 'string'
    ) {
      slug = (event.metadata as Record<string, unknown>).slug as string;
    } else {
      slug = defaultSlugForEvent(event);
    }

    if (data.remote !== undefined && typeof data.remote !== 'boolean') {
      throw new Error('ingest_capture: job.data.remote must be boolean when present');
    }
    if (data.sourceId !== undefined && typeof data.sourceId !== 'string') {
      throw new Error('ingest_capture: job.data.sourceId must be string when present');
    }
    const sourceId = typeof data.sourceId === 'string' ? data.sourceId : event.source_id;
    if (sourceId !== event.source_id) {
      throw new Error('ingest_capture: job sourceId does not match event.source_id');
    }

    // Fail closed across the durable queue boundary. A job is accepted only as:
    //   1) a queue-stamped local submission with explicit remote=false, or
    //   2) the exact HTTP envelope built after authentication.
    // Legacy/spoofed rows with remote=false + untrusted_payload=false but no
    // queue marker are rejected, so a pre-fix remote submission cannot be
    // claimed later and silently upgraded to trusted content.
    const trustedLocal = isTrustedLocalIngestJobData(job.data) && data.remote === false;
    const authenticatedRemoteEnvelope =
      !isTrustedLocalIngestJobData(job.data) &&
      data.remote === true &&
      event.untrusted_payload === true &&
      typeof data.sourceId === 'string';
    if (!trustedLocal && !authenticatedRemoteEnvelope) {
      throw new Error(
        'ingest_capture: missing trusted local marker or authenticated remote envelope',
      );
    }
    const untrustedPayload = !trustedLocal || event.untrusted_payload === true;
    const remote = untrustedPayload;

    // For text-typed events, content is the inline markdown/text. For
    // binary types (image/audio/video/pdf), content is a path-or-URI that
    // the content-type processor pipeline transforms. The v1 wave lands
    // the text path; processors arrive in subsequent commits.
    const isText =
      event.content_type === 'text/markdown' ||
      event.content_type === 'text/plain' ||
      event.content_type === 'text/html' ||
      event.content_type === 'application/json' ||
      event.content_type === 'unknown';

    if (!isText) {
      // Binary content without a processor would land as a path-string
      // page, which isn't useful. Surface as job-level error so the
      // operator sees the gap in `gbrain doctor` and can decide whether
      // to install the appropriate skillpack-distributed processor.
      throw new Error(
        `ingest_capture: content_type '${event.content_type}' requires a content-type ` +
          `processor that is not yet installed. Install a processor skillpack ` +
          `(e.g. gbrain-audio-transcribe, gbrain-image-ocr) or pre-extract the ` +
          `content to text/markdown before emitting.`,
      );
    }

    // noEmbed defaults to true. Mirrors the sync handler's pattern:
    // embed runs as a separate Minion job (autopilot's embed phase OR an
    // explicit `gbrain embed --stale`). Callers can opt in to inline embed
    // by passing { noEmbed: false } in job.data.
    const noEmbed = data.noEmbed !== false;

    const result = await importFromContent(engine, slug, event.content, {
      noEmbed,
      sourceId,
      source_kind: event.source_kind,
      source_uri: event.source_uri,
      ingested_via: remote ? 'http:ingest' : `ingestion:${event.source_kind}`,
      remote,
    });

    return {
      slug,
      status: result.status,
      chunks: result.chunks,
      untrusted_payload: untrustedPayload,
      source_kind: event.source_kind,
      source_uri: event.source_uri,
    };
  };
}
