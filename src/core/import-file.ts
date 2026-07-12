import { readFileSync, statSync, lstatSync } from 'fs';
import { basename, extname } from 'path';
import { createHash } from 'crypto';
import { marked } from 'marked';
import type { BrainEngine, FileSpec } from './engine.ts';
import { parseMarkdown } from './markdown.ts';
import { chunkText } from './chunkers/recursive.ts';
import { chunkCodeText, chunkCodeTextFull, detectCodeLanguage, CHUNKER_VERSION } from './chunkers/code.ts';
import { findChunkForOffset } from './chunkers/edge-extractor.ts';
import { extractCodeRefs, imageOfCandidates } from './link-extraction.ts';
import { embedBatch, embedMultimodal, currentEmbeddingSignature } from './embedding.ts';
import { slugifyPath, slugifyCodePath, isCodeFilePath } from './sync.ts';
import type { ChunkInput, Page, PageInput, PageKind, PageType } from './types.ts';
import { computeEffectiveDate } from './effective-date.ts';
import { MARKDOWN_CHUNKER_VERSION } from './chunkers/recursive.ts';
import { logSlugFallback } from './audit-slug-fallback.ts';
import { resolveContextualRetrievalMode } from './contextual-retrieval-resolver.ts';
import { assessContentSanity, ContentSanityBlockError } from './content-sanity.ts';
import { loadOperatorLiterals } from './content-sanity-literals.ts';
import { logContentSanityAssessment } from './audit/content-sanity-audit.ts';
import { isEmbedSkipped, buildEmbedSkipMarker, EMBED_SKIP_KEY } from './embed-skip.ts';
import {
  QUARANTINE_KEY,
  CONTENT_FLAG_KEY,
  buildQuarantineMarker,
  buildContentFlagMarker,
  isQuarantined,
} from './quarantine.ts';
import { loadConfig, loadConfigWithEngine } from './config.ts';
import {
  buildContextualPrefix,
  modeRequiresHaiku,
  modeRequiresWrapper,
  sanitizeTitle,
  wrapChunkForEmbedding,
} from './embedding-context.ts';
import { loadSearchModeConfig, resolveSearchMode } from './search/mode.ts';
import { normalizeAliasList } from './search/alias-normalize.ts';
import { computeCorpusGeneration } from './contextual-retrieval-service.ts';
import { runGuardrails } from './guardrails.ts';
import {
  openGitCommitSnapshot,
  type GitCommitSnapshot,
  type GitCommitBlob,
} from './sync-delta.ts';
import {
  assertSourceWriterLease,
  assertSourceWriterLeaseAtCommit,
  withSourceWriterLease,
  type SourceWriterLease,
} from './source-writer-lease.ts';

/**
 * v0.20.0 Cathedral II Layer 8 D2 — markdown fence extraction helper.
 *
 * Roughly 40% of gbrain's brain is docs/guides/architecture notes with
 * substantial inline code. In v0.19.0 those fenced code blocks chunk as
 * prose, so querying "how do we import from engine" ranks paragraphs
 * ABOUT the import above the actual import example. D2 walks the marked
 * lexer tokens, extracts each `{type:'code', lang, text}` fence with a
 * known language tag, chunks the content via the code chunker (so TS
 * fence gets TS-aware chunking), and persists those as extra chunks on
 * the parent markdown page with `chunk_source='fenced_code'`.
 *
 * Fence tag → pseudo-extension map. We don't need a full file extension
 * because chunkCodeText only calls detectCodeLanguage to pick a grammar;
 * a recognized extension gets the right grammar loaded, that's all.
 * Unknown tags return null → fence is skipped (no synthetic chunk).
 */
const FENCE_TAG_TO_PSEUDO_PATH: Record<string, string> = {
  ts: 'fence.ts', typescript: 'fence.ts',
  tsx: 'fence.tsx',
  js: 'fence.js', javascript: 'fence.js',
  jsx: 'fence.jsx',
  py: 'fence.py', python: 'fence.py',
  rb: 'fence.rb', ruby: 'fence.rb',
  go: 'fence.go', golang: 'fence.go',
  rs: 'fence.rs', rust: 'fence.rs',
  java: 'fence.java',
  'c#': 'fence.cs', cs: 'fence.cs', csharp: 'fence.cs',
  cpp: 'fence.cpp', 'c++': 'fence.cpp',
  c: 'fence.c',
  php: 'fence.php',
  swift: 'fence.swift',
  kt: 'fence.kt', kotlin: 'fence.kt',
  scala: 'fence.scala',
  lua: 'fence.lua',
  ex: 'fence.ex', elixir: 'fence.ex',
  elm: 'fence.elm',
  ml: 'fence.ml', ocaml: 'fence.ml',
  dart: 'fence.dart',
  zig: 'fence.zig',
  sol: 'fence.sol', solidity: 'fence.sol',
  sh: 'fence.sh', bash: 'fence.sh', shell: 'fence.sh', zsh: 'fence.sh',
  css: 'fence.css',
  html: 'fence.html',
  vue: 'fence.vue',
  json: 'fence.json',
  yaml: 'fence.yaml', yml: 'fence.yaml',
  toml: 'fence.toml',
};

function fenceTagToPseudoPath(lang: string | undefined): string | null {
  if (!lang) return null;
  return FENCE_TAG_TO_PSEUDO_PATH[lang.toLowerCase().trim()] ?? null;
}

/**
 * Maximum code fences we'll extract from a single markdown page. Fence-bomb
 * DOS defense — a malicious markdown file with 10K ```ts blocks could
 * generate 10K chunks × embedding API calls. Override per-page via the
 * `GBRAIN_MAX_FENCES_PER_PAGE` env var if docs-heavy brains legitimately
 * exceed 100 fences on a single page.
 */
const MAX_FENCES_PER_PAGE = Number.parseInt(process.env.GBRAIN_MAX_FENCES_PER_PAGE || '100', 10);

/**
 * Walk the marked lexer output and extract recognizable code fences.
 * Returns one ChunkInput per fence whose language tag maps to a grammar
 * the chunker understands. Unknown tags + empty fences are skipped.
 * Per-fence try/catch: one malformed fence doesn't abort the page import.
 */
async function extractFencedChunks(
  markdown: string,
  startChunkIndex: number,
): Promise<ChunkInput[]> {
  const out: ChunkInput[] = [];
  let tokens: ReturnType<typeof marked.lexer>;
  try {
    tokens = marked.lexer(markdown);
  } catch {
    // marked's lexer errors on truly malformed input — bail, keep the
    // markdown-level chunks that came from compiled_truth.
    return out;
  }

  let fencesSeen = 0;
  let indexOffset = 0;
  for (const tok of tokens) {
    if (tok.type !== 'code') continue;
    const code = tok as { type: 'code'; lang?: string; text?: string };
    const text = (code.text ?? '').trim();
    if (!text) continue;
    if (fencesSeen >= MAX_FENCES_PER_PAGE) {
      console.warn(
        `[gbrain] markdown fence cap hit (${MAX_FENCES_PER_PAGE} fences/page); skipping additional fences. ` +
        `Override via GBRAIN_MAX_FENCES_PER_PAGE env var.`,
      );
      break;
    }
    fencesSeen++;
    const pseudoPath = fenceTagToPseudoPath(code.lang);
    if (!pseudoPath) continue; // unknown or missing lang tag → prose fallback
    const lang = detectCodeLanguage(pseudoPath);
    if (!lang) continue;
    try {
      const chunks = await chunkCodeText(text, pseudoPath);
      for (const c of chunks) {
        out.push({
          chunk_index: startChunkIndex + indexOffset++,
          chunk_text: c.text,
          chunk_source: 'fenced_code',
          language: c.metadata.language,
          symbol_name: c.metadata.symbolName || undefined,
          symbol_type: c.metadata.symbolType,
          start_line: c.metadata.startLine,
          end_line: c.metadata.endLine,
        });
      }
    } catch (e: unknown) {
      // One fence failing shouldn't sink the page. Log + continue.
      console.warn(
        `[gbrain] fence extraction failed for lang=${code.lang}: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
  return out;
}

/**
 * The parsed page metadata returned by importFromContent. Callers (specifically
 * the put_page operation handler running auto-link post-hook) can reuse this to
 * avoid re-parsing the same content.
 */
export interface ParsedPage {
  type: PageType;
  title: string;
  compiled_truth: string;
  timeline: string;
  frontmatter: Record<string, unknown>;
  tags: string[];
}

export interface ImportResult {
  slug: string;
  status: 'imported' | 'skipped' | 'error';
  chunks: number;
  error?: string;
  /**
   * Parsed page content. Present for status='imported' AND status='skipped'
   * (skip happens when content is identical to existing page; auto-link still
   * needs to run for reconciliation in case links table drifted from page text).
   * Absent only on status='error' (early payload-size rejection).
   */
  parsedPage?: ParsedPage;
  /** Content-quality gate (issue #1699): true when the page landed with a
   *  `quarantine` marker (high-confidence junk, hidden from search). */
  quarantined?: boolean;
  /** True when the page landed with a `content_flag` marker (fuzzy
   *  markup-heavy or oversize — stays searchable, agent warned). */
  flagged?: boolean;
  /** Which flag tier fired, when `flagged`. */
  flag_reason?: 'markup_heavy' | 'oversized';
}

/**
 * Prepare the stable page identity inside an importer's existing final
 * transaction. A rename is collision-checked and versioned before the slug is
 * moved. updateSlug must affect exactly one row; any later importer failure
 * rolls the whole transaction back to the original canonical slug.
 */
interface PriorImportState {
  page: Page;
  pageKind: PageKind;
  sourcePath: string | null;
}

async function readPriorImportState(
  tx: BrainEngine,
  page: Page,
  lock = false,
): Promise<PriorImportState> {
  const rows = await tx.executeRaw<{ page_kind: PageKind; source_path: string | null }>(
    `SELECT page_kind, source_path FROM pages
      WHERE id = $1 AND source_id = $2 AND slug = $3${lock ? ' FOR UPDATE' : ''}`,
    [page.id, page.source_id, page.slug],
  );
  if (rows.length !== 1) {
    throw new Error(`Import identity metadata missing for page_id=${page.id}`);
  }
  return {
    page,
    pageKind: rows[0]!.page_kind,
    sourcePath: rows[0]!.source_path,
  };
}

async function stagePageIdentityForImport(
  tx: BrainEngine,
  targetSlug: string,
  renameFromSlug: string | undefined,
  renameFromSourcePath: string | undefined,
  sourceId: string,
): Promise<PriorImportState | null> {
  const sourceOpts = { sourceId };
  if (renameFromSlug && renameFromSlug !== targetSlug) {
    const origin = await tx.getPage(renameFromSlug, sourceOpts);
    if (!origin) {
      throw new Error(
        `Atomic rename origin missing: ${sourceId}:${renameFromSlug} -> ${targetSlug}`,
      );
    }
    const collision = await tx.getPage(targetSlug, {
      ...sourceOpts,
      includeDeleted: true,
    });
    if (collision) {
      throw new Error(
        `Atomic rename destination collision: ${sourceId}:${targetSlug} already exists`,
      );
    }
    // A slug redirect is semantic ownership even without a pages row. Check
    // at the final write boundary (not only sync's earlier preflight) so a
    // detected collision and the page move commit or roll back together. An
    // alias that already points to the page being moved is safe: updateSlug
    // retires the resulting self-alias atomically.
    const destinationAliases = await tx.executeRaw<{ canonical_slug: string }>(
      `SELECT canonical_slug FROM slug_aliases
        WHERE source_id = $1 AND alias_slug = $2`,
      [sourceId, targetSlug],
    );
    const conflictingAlias = destinationAliases.find(
      row => row.canonical_slug !== renameFromSlug,
    );
    if (conflictingAlias) {
      throw new Error(
        `Atomic rename destination alias collision: ${sourceId}:${targetSlug} ` +
        `already redirects to ${conflictingAlias.canonical_slug}`,
      );
    }
    if (!renameFromSourcePath) {
      throw new Error(
        `Atomic rename requires the expected origin source_path: ${sourceId}:${renameFromSlug}`,
      );
    }
    const prior = await readPriorImportState(tx, origin, true);
    const expectedPath = renameFromSourcePath.replace(/[\\\/]/g, '/');
    const actualPath = prior.sourcePath?.replace(/[\\\/]/g, '/') ?? null;
    if (actualPath !== expectedPath) {
      throw new Error(
        `Atomic rename source_path changed for ${sourceId}:${renameFromSlug}: ` +
        `expected ${expectedPath}, found ${actualPath ?? 'NULL'}`,
      );
    }
    await tx.createVersion(renameFromSlug, sourceOpts);
    await tx.updateSlug(renameFromSlug, targetSlug, sourceOpts);
    const renamed = await tx.getPage(targetSlug, sourceOpts);
    if (!renamed || renamed.id !== origin.id) {
      throw new Error(
        `Atomic rename verification failed: ${sourceId}:${renameFromSlug} -> ${targetSlug}`,
      );
    }
    return prior;
  }

  const existing = await tx.getPage(targetSlug, sourceOpts);
  if (existing) await tx.createVersion(targetSlug, sourceOpts);
  return existing ? readPriorImportState(tx, existing) : null;
}

/**
 * Retire only importer-generated state that cannot survive a kind change.
 * User attachments and manual links are deliberately untouched: the image
 * ledger delete is constrained to the prior source path + page id, and the
 * image_of delete matches the exact provenance shape emitted below.
 */
async function cleanupPriorImportedState(
  tx: BrainEngine,
  prior: PriorImportState | null,
  opts: {
    sourceId: string;
    targetSlug: string;
    targetKind: PageKind;
    targetSourcePath?: string | null;
  },
): Promise<void> {
  if (!prior) return;

  if (prior.pageKind === 'code') {
    const oldChunks = await tx.executeRaw<{ id: number }>(
      `SELECT id FROM content_chunks WHERE page_id = $1`,
      [prior.page.id],
    );
    await tx.deleteCodeEdgesForChunks(oldChunks.map(row => row.id));
  }

  if (prior.pageKind === 'image') {
    const normalizedOldPath = prior.sourcePath?.replace(/[\\\/]/g, '/') ?? null;
    const normalizedTargetPath = opts.targetSourcePath?.replace(/[\\\/]/g, '/') ?? null;
    if (
      normalizedOldPath &&
      (opts.targetKind !== 'image' || normalizedOldPath !== normalizedTargetPath)
    ) {
      await tx.executeRaw(
        `DELETE FROM files
          WHERE source_id = $1 AND page_id = $2 AND storage_path = $3`,
        [opts.sourceId, prior.page.id, normalizedOldPath],
      );
    }
    await tx.executeRaw(
      `DELETE FROM links
        WHERE from_page_id = $1
          AND origin_page_id = $1
          AND link_type = 'image_of'
          AND link_source = 'manual'
          AND origin_field = 'frontmatter'`,
      [prior.page.id],
    );
  }

  if (prior.pageKind === 'markdown') {
    // Markdown importer/reconcile-links owns only this provenance tuple.
    // Retire it on every changed re-import (including markdown -> code/image
    // conversion) so removed citations cannot leave stale doc<->code pairs.
    // Body extractor rows have NULL origin; manual rows have another source.
    await tx.executeRaw(
      `DELETE FROM links
        WHERE origin_page_id = $1
          AND link_source = 'markdown'
          AND origin_field = 'compiled_truth'
          AND link_type IN ('documents', 'documented_by')`,
      [prior.page.id],
    );
  }

  if (opts.targetKind !== 'markdown') {
    await tx.setPageAliases(opts.targetSlug, opts.sourceId, []);
  }
}

/** Maximum bytes accepted by markdown and code import paths. */
export const MAX_IMPORT_TEXT_BYTES = 5_000_000; // 5MB

/**
 * Import content from a string. Core pipeline:
 * parse -> hash -> embed (external) -> transaction(version + putPage + tags + chunks)
 *
 * Used by put_page operation and importFromFile.
 *
 * Size guard: content is rejected if its UTF-8 byte length exceeds
 * MAX_IMPORT_TEXT_BYTES.
 * importFromFile already enforces this against disk size before calling here, but
 * the remote MCP put_page operation passes caller-supplied content straight in,
 * so the guard has to live on this function — otherwise an authenticated caller
 * can spend the owner's OpenAI budget at will by shipping a megabyte-sized page.
 */
export async function importFromContent(
  engine: BrainEngine,
  slug: string,
  content: string,
  opts: {
    noEmbed?: boolean;
    sourceId?: string;
    /**
     * v0.29.1: basename without extension for filename-date precedence on
     * `daily/`, `meetings/` slugs. importFromFile threads this from the
     * disk path; the put_page MCP op derives it from the slug tail.
     */
    filename?: string;
    /**
     * v0.32.7 CJK wave: repo-relative path captured at import. Stored on
     * `pages.source_path` so sync's delete/rename code can look up the
     * page slug by path when the slug isn't derivable (frontmatter
     * fallback). MCP `put_page` callers leave undefined (no file).
     */
    sourcePath?: string;
    /**
     * v0.32.7 CJK wave (codex post-merge F1): bypass the
     * `existing.content_hash === hash` short-circuit and ALWAYS re-chunk +
     * re-embed. Used by `gbrain reindex --markdown` so a chunker version
     * bump actually reaches unchanged-source pages. Without this, the
     * sweep silently no-ops on every page whose markdown body hasn't
     * been edited since the last import — defeating the whole purpose of
     * the version bump.
     */
    forceRechunk?: boolean;
    /** Existing canonical slug moved inside the final write transaction. */
    renameFromSlug?: string;
    /** Previous source path (used by image imports; accepted for shared opts). */
    renameFromSourcePath?: string;
    /**
     * v0.39.0.0 T1.5: active schema pack for type inference. When set, parseMarkdown
     * uses the pack's path_prefixes instead of the hardcoded gbrain-base table.
     * When unset, falls back to pre-v0.39 behavior (parity gate stays green).
     * Callers thread this from `loadActivePack(ctx)` once per command —
     * NEVER per file inside sync (codex perf finding #7).
     */
    activePack?: { page_types: ReadonlyArray<{ name: string; path_prefixes: ReadonlyArray<string> }> };
    /**
     * v0.39.3.0 provenance write-through (WARN-8). When set, threaded to
     * `tx.putPage` so the page's `source_kind`, `source_uri`,
     * `ingested_via` DB columns get populated. The trust gate lives at the
     * `put_page` op layer — by the time importFromContent sees these, the
     * caller is already trusted (capture CLI sets them; remote MCP callers
     * had theirs overridden to `mcp:put_page` upstream). `ingested_at` is
     * NOT a caller-controllable param; the engine's putPage stamps it
     * server-side via now() when any provenance write fires.
     */
    source_kind?: string | null;
    source_uri?: string | null;
    ingested_via?: string | null;
    /**
     * v0.42 (#1699 trust boundary). When `true` (untrusted caller — remote MCP
     * put_page), gate-owned frontmatter markers (`quarantine`, `content_flag`,
     * `embed_skip`) are STRIPPED from the incoming content before the content-
     * sanity gate runs, so only the gate itself can set them. Without this, a
     * write-scoped OAuth client could `put_page` clean content carrying a
     * hand-crafted `quarantine` marker to hide arbitrary pages from search, or
     * a `content_flag.detail` to inject text into the agent-trusted warning
     * channel. `put_page` passes `ctx.remote !== false` (fail-closed: anything
     * not strictly local is untrusted, matching the v0.26.9 F7b posture).
     * Local/trusted callers (sync, capture, dream, `quarantine clear/scan`)
     * leave it unset → markers preserved (the gate + CLI own them).
     */
    remote?: boolean;
    /** Internal fencing proof shared by bulk import/sync worker engines. */
    writerLease?: SourceWriterLease;
  } = {},
): Promise<ImportResult> {
  // v0.18.0+ multi-source: when caller is syncing under a non-default source,
  // every per-page tx call must carry `sourceId` so writes target the right
  // (source_id, slug) row. Pre-fix, putPage relied on the schema DEFAULT and
  // silently fabricated a duplicate at (default, slug) — causing later
  // bare-slug subqueries (getTags, deleteChunks, etc.) to crash with 21000.
  const sourceId = opts.sourceId;
  // Reject oversized payloads before any parsing, chunking, or embedding happens.
  // Uses Buffer.byteLength to count UTF-8 bytes the same way disk size would,
  // so the network path behaves identically to the file path.
  const byteLength = Buffer.byteLength(content, 'utf-8');
  if (byteLength > MAX_IMPORT_TEXT_BYTES) {
    return {
      slug,
      status: 'skipped',
      chunks: 0,
      error: `Content too large (${byteLength} bytes, max ${MAX_IMPORT_TEXT_BYTES}). Split the content into smaller files or remove large embedded assets.`,
    };
  }

  const effectiveSourceId = sourceId ?? 'default';
  if (!opts.writerLease) {
    return withSourceWriterLease(engine, effectiveSourceId, writerLease =>
      importFromContent(engine, slug, content, { ...opts, writerLease }));
  }
  assertSourceWriterLease(opts.writerLease, engine, effectiveSourceId);

  const parsed = parseMarkdown(content, slug + '.md', { activePack: opts.activePack });

  // v0.42 (#1699 trust boundary): strip gate-owned markers from UNTRUSTED
  // input. parseMarkdown preserves every frontmatter key except type/title/
  // tags/slug, so a remote MCP put_page (ctx.remote !== false, threaded as
  // opts.remote) could otherwise plant `quarantine` (hide a page from search +
  // suppress chunks) or `content_flag.detail` (inject text into the agent's
  // trusted "this looks odd" channel) on clean content. Only the content-
  // sanity gate (below) and trusted local CLIs may set these. Fail-closed:
  // strip whenever opts.remote === true.
  if (opts.remote === true && parsed.frontmatter) {
    delete parsed.frontmatter[QUARANTINE_KEY];
    delete parsed.frontmatter[CONTENT_FLAG_KEY];
    delete parsed.frontmatter[EMBED_SKIP_KEY];
  }

  // Vendor-neutral guardrail seam (observe-only, fail-open). Runs AFTER
  // parseMarkdown and the size guard, BEFORE content-sanity, hash compute,
  // chunking, embedding, and DB write — so a registered guardrail sees the
  // full markdown payload at the exact pre-persist moment. The returned
  // verdict is intentionally ignored: this seam cannot block or mutate the
  // ingest. No-op when zero guardrails are registered (OSS default).
  await runGuardrails({
    hook: 'file_storage.markdown',
    content,
    metadata: {
      slug,
      source_id: sourceId ?? 'default',
      source_path: opts.sourcePath ?? null,
      source_kind: opts.source_kind ?? null,
      source_uri: opts.source_uri ?? null,
      ingested_via: opts.ingested_via ?? null,
      content_type: 'markdown',
    },
  });

  // v0.41 content-sanity gate. Runs AFTER parseMarkdown so the assessor
  // sees the parsed body (compiled_truth + timeline), title, and
  // frontmatter; runs BEFORE the hash compute so a soft-block that
  // mutates frontmatter (sets `embed_skip`) reaches the existing hash
  // calculation and the page write doesn't short-circuit on hash equality.
  //
  // Three outcomes:
  //   - kill-switch active (`content_sanity.disabled === true` /
  //     `GBRAIN_NO_SANITY=1`) → assess + audit with bypass flag, emit
  //     loud stderr per offending ingest, but let everything through.
  //   - hard-block (junk pattern OR operator literal) → THROW
  //     ContentSanityBlockError. Existing exception flow at every
  //     wrapper site (import.ts errors counter, put_page MCP envelope,
  //     sync.ts:929 failure record) fires correctly through this single
  //     throw point. classifyErrorCode picks up the PAGE_JUNK_PATTERN
  //     prefix in the error message and groups in sync-failures.jsonl.
  //   - soft-block (oversize WITHOUT junk-pattern hit) → mutate
  //     frontmatter to embed `embed_skip` marker. Existing chunking
  //     block guards on `isEmbedSkipped(frontmatter)` so chunks stays
  //     empty; the existing `tx.deleteChunks` at the empty-chunks
  //     branch fires to purge old chunks (D9 transition invariant).
  //
  // Effective config: env > file > DB > defaults. The DB-plane lift
  // adds ~4 SQL round-trips per import (one per content_sanity.* key);
  // acceptable for the per-page cost since the gate runs at most once
  // per ingest. Power-users with 10K-file syncs who care about this
  // overhead can set the keys via env vars instead and skip the DB read.
  // Content-quality gate disposition flags (issue #1699), threaded onto
  // the ImportResult so callers (sync reporting, tests) see what happened.
  let pageQuarantined = false;
  let pageFlagged = false;
  let pageFlagReason: 'markup_heavy' | 'oversized' | undefined;
  {
    const baseCfg = loadConfig();
    let effectiveCfg = baseCfg;
    try {
      // loadConfigWithEngine merges DB-plane content_sanity.* on top
      // of file/env. Wrapped in try/catch so a transient engine error
      // doesn't kill the import — the gate falls back to file/env
      // values (which include defaults via the assessor itself).
      effectiveCfg = await loadConfigWithEngine(engine, baseCfg);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[gbrain] content-sanity: DB config lift failed (${msg}); falling back to file/env\n`);
    }
    const cs = effectiveCfg?.content_sanity ?? {};
    // GBRAIN_NO_SANITY=1 fast-path: loadConfig() returns null when
    // there's no `~/.gbrain/config.json` AND no DATABASE_URL env var
    // (e.g., fresh PGLite-only setups, hermetic tests). The merged
    // content_sanity block never carries `disabled` in that case. Read
    // the kill-switch env directly so it works regardless of whether
    // any other config plumbing fired. Same direct-env-check pattern
    // applies to the patterns_enabled flip below.
    const sanityDisabled =
      cs.disabled === true || process.env.GBRAIN_NO_SANITY === '1';
    const extra_literals =
      cs.junk_patterns_enabled !== false && !sanityDisabled ? loadOperatorLiterals() : [];
    // Disposition for the high-confidence junk path: quarantine (hide) by
    // default, or reject (throw → sync-failure) when the operator opts in.
    const junkDisposition: 'quarantine' | 'reject' =
      cs.junk_disposition === 'reject' ? 'reject' : 'quarantine';
    const sanityResult = assessContentSanity({
      compiled_truth: parsed.compiled_truth,
      timeline: parsed.timeline ?? '',
      title: parsed.title,
      bytes_warn: cs.bytes_warn,
      bytes_block: cs.bytes_block,
      max_markup_ratio: cs.max_markup_ratio,
      prose_check_enabled: cs.prose_check_enabled,
      page_kind: parsed.type,
      extra_literals,
    });

    if (sanityDisabled) {
      // Kill-switch active: loud stderr per offending ingest. Operator
      // explicitly opted into the bypass and gets noisy feedback every
      // time it fires so they remember the gate is off. Audit as a
      // bypass (page lands regardless).
      logContentSanityAssessment(slug, sourceId ?? 'default', sanityResult, {
        bypass: true,
      });
      if (sanityResult.shouldQuarantine || sanityResult.shouldFlag) {
        process.stderr.write(
          `[gbrain] content-sanity bypass (GBRAIN_NO_SANITY=1): ${slug} — ${sanityResult.reason_messages.join('; ')}\n`,
        );
      }
    } else if (sanityResult.shouldQuarantine) {
      // High-confidence junk (Cloudflare/CAPTCHA pattern or operator
      // literal). The detail names which fired.
      const detail = [
        ...sanityResult.junk_pattern_matches,
        ...sanityResult.literal_substring_matches,
      ].join(', ');
      const reason = sanityResult.junk_pattern_matches.length > 0
        ? 'junk_pattern'
        : 'literal_substring';
      if (junkDisposition === 'reject') {
        // Operator opted into hard-block. Throw with PAGE_QUARANTINE so
        // classifyErrorCode bins it. Existing exception flow at every
        // wrapper site (import errors counter, put_page MCP envelope,
        // sync failure record) fires through this single throw point.
        logContentSanityAssessment(slug, sourceId ?? 'default', sanityResult, {
          disposition: 'reject',
        });
        throw new ContentSanityBlockError(sanityResult);
      }
      // Default: quarantine (hide). Page lands with the marker, writes
      // zero chunks (chunking guard below widens to isQuarantined), is
      // excluded from search via QUARANTINE_FILTER_FRAGMENT, reviewable
      // via get_page / `gbrain quarantine list`.
      parsed.frontmatter[QUARANTINE_KEY] = buildQuarantineMarker(reason, detail, {
        bytes: sanityResult.bytes,
      });
      pageQuarantined = true;
      logContentSanityAssessment(slug, sourceId ?? 'default', sanityResult, {
        disposition: 'quarantine',
      });
      process.stderr.write(
        `[gbrain] content-sanity quarantine: ${slug} — ${detail} (hidden from search, reviewable via 'gbrain quarantine list')\n`,
      );
    } else if (sanityResult.shouldFlag) {
      // Fuzzy markup-heavy OR oversize. The page stays usable; the agent
      // gets warned (Garry's paradigm — "this is odd, you decide").
      const flagReason = sanityResult.flag_reason!; // non-null when shouldFlag
      const flagDetail = sanityResult.reason_messages.join('; ');
      parsed.frontmatter[CONTENT_FLAG_KEY] = buildContentFlagMarker(flagReason, flagDetail, {
        ...(sanityResult.markup_ratio !== null ? { markup_ratio: sanityResult.markup_ratio } : {}),
        bytes: sanityResult.bytes,
      });
      pageFlagged = true;
      pageFlagReason = flagReason;
      if (flagReason === 'oversized') {
        // Oversize also skips embedding (existing embed_skip marker). The
        // chunking guard below honors it; tx.deleteChunks purges old chunks.
        parsed.frontmatter[EMBED_SKIP_KEY] = buildEmbedSkipMarker(sanityResult.bytes);
        logContentSanityAssessment(slug, sourceId ?? 'default', sanityResult, {
          disposition: 'soft_block',
        });
        process.stderr.write(
          `[gbrain] content-sanity flag (oversized): ${slug} (${sanityResult.bytes} bytes) — page lands, embedding skipped, agent warned\n`,
        );
      } else {
        // markup_heavy: page ingests NORMALLY (keeps chunks, embeds). The
        // content_flag marker rides along for the agent warning.
        logContentSanityAssessment(slug, sourceId ?? 'default', sanityResult, {
          disposition: 'flag',
        });
        process.stderr.write(
          `[gbrain] content-sanity flag (markup_heavy): ${slug} (ratio ${sanityResult.markup_ratio?.toFixed(2)}) — stays searchable, agent warned\n`,
        );
      }
    } else if (sanityResult.reasons.includes('oversize_warn')) {
      // Warn tier: page lands normally; lint surface picks up too.
      logContentSanityAssessment(slug, sourceId ?? 'default', sanityResult, {
        disposition: 'warn',
      });
      process.stderr.write(
        `[gbrain] content-sanity warn: ${slug} (${sanityResult.bytes} bytes) — exceeds warn threshold, consider splitting\n`,
      );
    }
  }

  // v0.39.3.0 CV8 — DB content_hash excludes timestamp-bearing frontmatter
  // keys so identical body content from `gbrain capture` (which stamps
  // `captured_at` and `ingested_at` per call) produces a stable hash.
  // Pre-fix, every capture-cli invocation produced a fresh hash because
  // the timestamp changed, defeating:
  //   - the existing.content_hash === hash short-circuit below (every
  //     capture re-chunked + re-embedded unchanged content — wasted
  //     embedding spend)
  //   - the daemon's 24h LRU dedup (separate consumer keyed on same hash)
  //
  // We strip ONLY the timestamp keys, not the whole frontmatter object.
  // Stripping all frontmatter would regress sync: a user adding a tag
  // would update the frontmatter without changing the body, the hash
  // would not change, and tag reconciliation would silently no-op
  // (this function returns early on hash-match).
  //
  // v0.42 (#1699): the content-sanity gate runs on EVERY import and stamps
  // GATE-DERIVED markers (quarantine / content_flag / embed_skip) carrying a
  // fresh `assessed_at` timestamp. Those markers are derived from the body,
  // not source content, so they must be EXCLUDED from the hash — otherwise
  // every re-sync of a flagged/quarantined page sees a changed hash and
  // re-chunks + re-embeds forever (a markup-heavy page keeps chunks, so this
  // is real, unbounded embedding spend). Same bug class as the captured_at /
  // ingested_at fix above; the gate re-derives the markers deterministically
  // on the next import, so dropping them from the hash is safe.
  const HASH_EPHEMERAL_FRONTMATTER_KEYS = [
    'captured_at',
    'ingested_at',
    QUARANTINE_KEY,
    CONTENT_FLAG_KEY,
    EMBED_SKIP_KEY,
  ];
  const stableFrontmatter: Record<string, unknown> = { ...parsed.frontmatter };
  for (const k of HASH_EPHEMERAL_FRONTMATTER_KEYS) {
    delete stableFrontmatter[k];
  }
  // Hash includes all meaningful fields for idempotency.
  const hash = createHash('sha256')
    .update(JSON.stringify({
      title: parsed.title,
      type: parsed.type,
      compiled_truth: parsed.compiled_truth,
      timeline: parsed.timeline,
      frontmatter: stableFrontmatter,
      tags: parsed.tags.sort(),
    }))
    .digest('hex');

  const parsedPage: ParsedPage = {
    type: parsed.type,
    title: parsed.title,
    compiled_truth: parsed.compiled_truth,
    timeline: parsed.timeline || '',
    frontmatter: parsed.frontmatter,
    tags: parsed.tags,
  };

  const existingSlug = opts.renameFromSlug ?? slug;
  const existing = await engine.getPage(existingSlug, { sourceId: effectiveSourceId });
  if (!opts.renameFromSlug && existing?.content_hash === hash && !opts.forceRechunk) {
    return { slug, status: 'skipped', chunks: 0, parsedPage };
  }

  // v0.41.13 (#1309) — identity-based cross-slug dedup pre-check.
  //
  // Catches the overlapping-ingest-roots bug class: when a user runs
  // `gbrain import /vault/Subdir/` then later `gbrain import /vault/`,
  // the same file is ingested under two different slugs (e.g.
  // `vault/subdir/note` and `vault/note`). The slug-only check above
  // misses it because the slugs differ; this check identifies the true
  // duplicate by content_hash OR external frontmatter.id (granola UUID,
  // ULID, etc.).
  //
  // Posture (codex review):
  //   - SKIP only when frontmatter.id matches (true external duplicate).
  //   - WARN-ALWAYS when content_hash matches but identity differs (two
  //     intentional pages that happen to share text — templates, daily
  //     logs). User decides whether to investigate.
  //   - FAIL CLOSED on lookup error: a DB throw means we cannot verify
  //     uniqueness, so throw rather than silently allow a duplicate.
  //
  // Soft-deleted rows are excluded at the engine layer (`deleted_at IS NULL`)
  // so a tombstoned page doesn't block a legitimate re-import.
  // Test doubles that don't implement `findDuplicatePage` fall through
  // via the `?.` shape — no failure mode for fake engines.
  const fmId = (parsed.frontmatter as Record<string, unknown> | undefined)?.id;
  const fmIdStr = typeof fmId === 'string' && fmId.length > 0 ? fmId : null;
  if (!opts.forceRechunk && engine.findDuplicatePage) {
    let dup: { slug: string; id: number } | null = null;
    try {
      dup = await engine.findDuplicatePage(sourceId ?? 'default', {
        hash,
        frontmatterId: fmIdStr,
      });
    } catch (err) {
      throw new Error(
        `[import] dedup pre-check failed for ${opts.sourcePath ?? slug}: ` +
        `${(err as Error).message}. Re-run import after DB recovery.`
      );
    }
    if (dup && dup.slug !== slug && dup.slug !== opts.renameFromSlug) {
      // Look up the duplicate page so we can compare frontmatter.id.
      const dupPage = await engine.getPage(dup.slug, { sourceId: effectiveSourceId });
      const dupFmId = (dupPage?.frontmatter as Record<string, unknown> | undefined)?.id;
      const dupFmIdStr = typeof dupFmId === 'string' && dupFmId.length > 0 ? dupFmId : null;
      const sameExternalId = fmIdStr !== null && dupFmIdStr === fmIdStr;
      if (sameExternalId) {
        // True duplicate (same external ID). Skip + log to stderr.
        process.stderr.write(
          `[import] skipping ${opts.sourcePath ?? slug}: identical to ${dup.slug} ` +
          `(frontmatter.id=${fmIdStr}) in source ${sourceId ?? 'default'}. ` +
          `Pass --force-rechunk to override.\n`
        );
        return { slug: dup.slug, status: 'skipped', chunks: 0, parsedPage };
      }
      // Same content_hash, different (or missing) frontmatter.id.
      // Surface a warning but proceed with the insert — they may be
      // legitimate independent pages that happen to share text.
      process.stderr.write(
        `[import] WARNING: ${opts.sourcePath ?? slug} shares content_hash with ${dup.slug} ` +
        `(${hash.slice(0, 8)}) but has different frontmatter.id. Indexing both.\n`
      );
    }
  }

  // Chunk compiled_truth and timeline.
  // v0.41 content-sanity soft-block: if the gate marked this page as
  // embed-skipped (oversize without junk-pattern), skip chunking
  // entirely. The empty-chunks branch in the transaction below
  // triggers tx.deleteChunks(slug) which purges any pre-existing
  // chunks (D9 transition invariant: embed_skip means no live chunks).
  const chunks: ChunkInput[] = [];
  // Skip chunking for embed-skip (oversize) OR quarantine (junk hidden).
  // Both → zero chunks → the empty-chunks branch in the transaction fires
  // tx.deleteChunks(slug) to purge any pre-existing chunks. (Flag/markup_heavy
  // is NOT here — flagged pages chunk + embed normally, they just carry a
  // warning marker.)
  const embedSkipped = isEmbedSkipped(parsed.frontmatter) || isQuarantined(parsed.frontmatter);
  if (!embedSkipped) {
    if (parsed.compiled_truth.trim()) {
      for (const c of chunkText(parsed.compiled_truth)) {
        chunks.push({ chunk_index: chunks.length, chunk_text: c.text, chunk_source: 'compiled_truth' });
      }
    }
    if (parsed.timeline?.trim()) {
      for (const c of chunkText(parsed.timeline)) {
        chunks.push({ chunk_index: chunks.length, chunk_text: c.text, chunk_source: 'timeline' });
      }
    }

    // v0.20.0 Cathedral II Layer 8 D2 — extract fenced code blocks from
    // compiled_truth as first-class code chunks.
    if (parsed.compiled_truth.trim()) {
      const fenceChunks = await extractFencedChunks(parsed.compiled_truth, chunks.length);
      chunks.push(...fenceChunks);
    }
  }

  // Embed BEFORE the transaction (external API call).
  // v0.14+ (Codex C2): embedding failure PROPAGATES. Silent drop accumulates
  // unembedded pages invisibly. Caller can pass opts.noEmbed=true to skip.
  //
  // v0.40.3.0 contextual retrieval wrapper (D20-T1 chunk_text separation):
  // - Resolve effective CR mode via the page/source/global override chain.
  // - For title tier (free): build the title-only prefix and wrap chunks
  //   inline at embed time. Per-chunk Haiku synopsis tier is NOT supported
  //   on the import path — that's an async backfill via the Minion handler
  //   (the cost prompt + 10s grace UX from D3 gates spending; inline import
  //   path takes the cheaper title-only treatment for tokenmax pages here
  //   and defers per-chunk synopsis to the Minion-driven sweep).
  // - Stored chunk_text stays canonical; only the embedding input is wrapped.
  // - Code chunks (chunk_source='fenced_code') bypass wrapping per D20-T4.
  let effectiveCRMode: 'none' | 'title' | 'per_chunk_synopsis' = 'none';
  if (!opts.noEmbed) {
    const searchInput = await loadSearchModeConfig(engine);
    const knobs = resolveSearchMode(searchInput);
    // Look up the source row for this import; default to host trust when
    // the engine's getConfig path doesn't surface a source row (most calls).
    const resolution = resolveContextualRetrievalMode({
      pageFrontmatter: parsed.frontmatter,
      source: {
        id: sourceId ?? 'default',
        contextual_retrieval_mode: null,
        trust_frontmatter_overrides: false,
      },
      globalMode: knobs.contextual_retrieval,
      killSwitchDisabled: knobs.contextual_retrieval_disabled,
    });
    // Inline path: title-tier wrap is free. per_chunk_synopsis is too
    // expensive for the inline import path; the page lands at the
    // title tier on disk and the Minion-driven contextual reindex
    // upgrades it later when the user accepts the cost prompt.
    effectiveCRMode = resolution.mode === 'per_chunk_synopsis' ? 'title' : resolution.mode;
  }

  if (!opts.noEmbed && chunks.length > 0) {
    const safeTitle = sanitizeTitle(parsed.title);
    const prefix =
      modeRequiresWrapper(effectiveCRMode) && !modeRequiresHaiku(effectiveCRMode)
        ? buildContextualPrefix(safeTitle, null)
        : null;
    const wrappedTexts = prefix
      ? chunks.map((c) => wrapChunkForEmbedding(c.chunk_text, prefix, c.chunk_source))
      : chunks.map((c) => c.chunk_text);
    const embeddings = await embedBatch(wrappedTexts);
    for (let i = 0; i < chunks.length; i++) {
      chunks[i].embedding = embeddings[i];
      // token_count tracks the wrapped string length so cost reporting
      // reflects what we actually sent to the embedder.
      chunks[i].token_count = Math.ceil(wrappedTexts[i].length / 4);
    }
  }

  // v0.40.3.0: corpus_generation hash for D27 P1-5 cache invalidation.
  // Only set when we actually applied a wrapper; 'none' tier writes NULL
  // so the column reflects "no CR shape applied" rather than a stale hash.
  const corpusGeneration =
    effectiveCRMode === 'none' || opts.noEmbed
      ? null
      : computeCorpusGeneration({
          crMode: effectiveCRMode,
          haikuModel: 'anthropic:claude-haiku-4-5-20251001',
        });

  // Transaction wraps all DB writes. Every per-page tx call carries the
  // caller's sourceId so writes target (sourceId, slug) rather than the
  // schema DEFAULT — required for multi-source brains; harmless ('default')
  // for single-source callers.
  const txOpts = { sourceId: effectiveSourceId };
  const aliasNorms = normalizeAliasList(
    (parsed.frontmatter as Record<string, unknown>).aliases,
  );
  // Embedding/guardrail work can be long. Re-check the fencing token at the
  // final DB boundary so a failed heartbeat or TTL takeover cannot let stale
  // work commit after a successor acquired the source.
  assertSourceWriterLease(opts.writerLease, engine, effectiveSourceId);
  await engine.transaction(async (tx) => {
    const prior = await stagePageIdentityForImport(
      tx,
      slug,
      opts.renameFromSlug,
      opts.renameFromSourcePath,
      effectiveSourceId,
    );
    await cleanupPriorImportedState(tx, prior, {
      sourceId: effectiveSourceId,
      targetSlug: slug,
      targetKind: 'markdown',
      targetSourcePath: opts.sourcePath,
    });

    // v0.29.1 — compute effective_date from frontmatter precedence chain.
    // Filename comes from importFromFile path (basename) or the slug tail
    // (put_page MCP op fallback). updatedAt/createdAt use the existing
    // page's timestamps when present; otherwise NOW() (the row about to
    // be created). The result drives the recency boost and since/until
    // filters when callers opt in; nothing in the default search path
    // consults it.
    const filenameForChain = opts.filename ?? slug.split('/').pop() ?? slug;
    const nowDate = new Date();
    const { date: effectiveDate, source: effectiveDateSource } = computeEffectiveDate({
      slug,
      frontmatter: parsed.frontmatter,
      filename: filenameForChain,
      updatedAt: existing?.updated_at ?? nowDate,
      createdAt: existing?.created_at ?? nowDate,
    });

    await tx.putPage(slug, {
      type: parsed.type,
      title: parsed.title,
      compiled_truth: parsed.compiled_truth,
      timeline: parsed.timeline || '',
      frontmatter: parsed.frontmatter,
      content_hash: hash,
      effective_date: effectiveDate,
      effective_date_source: effectiveDateSource,
      import_filename: filenameForChain,
      // v0.32.7 CJK wave: stamp the chunker version so the post-upgrade
      // reindex sweep can find pre-bump pages via `chunker_version < 2`.
      // Also capture the repo-relative source path so sync's delete/rename
      // code can resolve frontmatter-fallback slugs back to their files.
      chunker_version: MARKDOWN_CHUNKER_VERSION,
      source_path: opts.sourcePath ?? null,
      // v0.39.3.0 provenance write-through (WARN-8). Engine layer applies
      // COALESCE-preserve UPDATE so omitting these on a later put_page
      // doesn't erase the original ingestion's audit trail.
      source_kind: opts.source_kind ?? null,
      source_uri: opts.source_uri ?? null,
      ingested_via: opts.ingested_via ?? null,
      // ingested_at is server-stamped at the engine layer when any
      // provenance write fires; never client-controlled.
    }, txOpts);

    // v0.40.3.0: stamp the contextual retrieval state columns alongside
    // the page write. updatePageContextualRetrievalState is a narrow
    // UPDATE that runs after putPage's INSERT/UPDATE so the row exists.
    // For opts.noEmbed callers, we skip stamping — the next embed pass
    // (gbrain embed --stale or contextual reindex Minion) will set it.
    if (!opts.noEmbed) {
      await tx.updatePageContextualRetrievalState(
        slug,
        sourceId ?? 'default',
        effectiveCRMode,
        corpusGeneration,
      );
    }

    // Tag reconciliation: ADD-ONLY (v0.41.37.0 #1621).
    //
    // We deliberately do NOT delete existing tags here. The `tags` table has
    // no provenance column, and frontmatter tags are stripped from the stored
    // `pages.frontmatter` (markdown.ts:118) — so at re-import time we cannot
    // distinguish a frontmatter-origin tag from a DB-side enrichment tag
    // (auto-tag / dream synthesize / signal-detector writes to the same
    // table). The pre-v0.41.37.0 "delete every existing tag not in the current
    // frontmatter" logic wiped ALL enrichment tags on every re-import — most
    // visibly under `gbrain reindex --markdown` (#1621), which re-imports every
    // page with forceRechunk. reindex is a re-chunk/re-embed op; it must not
    // destroy tags.
    //
    // Trade-off (accepted): removing a tag from a page's frontmatter no longer
    // removes it from the DB on the next sync. That staleness is minor (tags
    // are additive metadata) and far preferable to silently losing enrichment
    // tags. Frontmatter-tag REMOVAL would require a `tag_source` provenance
    // column (deferred — see TODOS.md #1621-followup). addTag is idempotent
    // (ON CONFLICT DO NOTHING), so re-adding existing tags is a no-op.
    for (const tag of parsed.tags) {
      await tx.addTag(slug, tag, txOpts);
    }

    if (chunks.length > 0) {
      await tx.upsertChunks(slug, chunks, txOpts);
      // v0.41.31: stamp embedding provenance when this import actually
      // embedded (not --no-embed), so a later model/dims swap is detectable
      // as stale via embed --stale. The deferred/backfill + per-slug embed
      // paths stamp too; this covers the inline import/sync path.
      if (!opts.noEmbed) {
        await tx.setPageEmbeddingSignature(slug, {
          sourceId: effectiveSourceId,
          signature: currentEmbeddingSignature(),
        });
      }
    } else {
      // Content is empty — delete stale chunks so they don't ghost in search results
      await tx.deleteChunks(slug, txOpts);
    }

    // v0.19.0 E1 — doc↔impl linking: if this markdown page cites code paths
    // (e.g. 'src/core/sync.ts:42'), create bidirectional edges to the code
    // page. addLink throws when either endpoint is missing (master tightened
    // this in v0.18.x), so we wrap each pair in try/catch — guides imported
    // before their code repo syncs are common, and the missing edges land
    // later via `gbrain reconcile-links` (Layer 8 D3, v0.21.0).
    const codeRefs = extractCodeRefs(parsed.compiled_truth + '\n' + (parsed.timeline || ''));
    // For doc↔impl edges, both endpoints are within the same source as the
    // markdown page being imported. Cross-source edges (markdown in one
    // source, code in another) currently fail with "page not found" — a
    // faster failure mode than the pre-fix cross-product fan-out, which
    // silently wired edges to whichever same-slug page Postgres returned
    // first across sources.
    const linkOpts = sourceId
      ? { fromSourceId: sourceId, toSourceId: sourceId, originSourceId: sourceId }
      : undefined;
    for (const ref of codeRefs) {
      const codeSlug = slugifyCodePath(ref.path);
      // Forward: markdown guide → code page (this guide documents that code)
      try {
        await tx.addLink(
          slug, codeSlug,
          ref.line ? `cited at ${ref.path}:${ref.line}` : ref.path,
          'documents', 'markdown', slug, 'compiled_truth',
          linkOpts,
        );
      } catch { /* code page not yet imported — reconcile-links will catch it */ }
      // Reverse: code page → markdown guide (this code is documented by the guide)
      try {
        await tx.addLink(
          codeSlug, slug,
          ref.path, 'documented_by', 'markdown', slug, 'compiled_truth',
          linkOpts,
        );
      } catch { /* same reason — silent skip */ }
    }

    // Slug-keyed aliases are part of the same commit as the page identity.
    // setPageAliases joins this active transaction (no savepoint).
    await tx.setPageAliases(slug, effectiveSourceId, aliasNorms);

    // Reassert at the real commit boundary. A lease can be lost while the
    // preceding writes run; throwing here rolls the whole page transaction
    // back instead of letting a fenced writer commit stale work.
    await assertSourceWriterLeaseAtCommit(opts.writerLease!, tx, effectiveSourceId);
  });

  return {
    slug,
    status: 'imported',
    chunks: chunks.length,
    parsedPage,
    ...(pageQuarantined ? { quarantined: true } : {}),
    ...(pageFlagged ? { flagged: true, flag_reason: pageFlagReason } : {}),
  };
}

/**
 * Import from a file path. Validates size, reads content, delegates to importFromContent.
 *
 * Slug authority: the path on disk is the source of truth. `frontmatter.slug`
 * is only accepted when it matches `slugifyPath(relativePath)`. A mismatch is
 * rejected rather than silently honored — otherwise a file at `notes/random.md`
 * could declare `slug: people/elon` in frontmatter and overwrite the legitimate
 * `people/elon` page on the next `gbrain sync` or `gbrain import`. In shared
 * brains where PRs are mergeable, this is a silent page-hijack primitive.
 */
export interface ImportFileOptions {
  noEmbed?: boolean;
  inferFrontmatter?: boolean;
  sourceId?: string;
  forceRechunk?: boolean;
  /** Existing canonical slug to move inside the importer's final DB tx. */
  renameFromSlug?: string;
  /** Previous source path (needed to retire an image's old file ledger row). */
  renameFromSourcePath?: string;
  /**
   * v0.39 T1.5: active schema pack threaded through to importFromContent so
   * `parseMarkdown` uses pack-driven type inference. Load ONCE per command;
   * never per file (codex perf finding #7).
   */
  activePack?: { page_types: ReadonlyArray<{ name: string; path_prefixes: ReadonlyArray<string> }> };
  /** Internal source-writer fencing proof. */
  writerLease?: SourceWriterLease;
}

export type ImportFilePreflightResult =
  | {
      ok: true;
      slug: string;
      content: string;
      kind: 'code' | 'markdown';
      usedFrontmatterFallback: boolean;
    }
  | { ok: false; result: ImportResult };

/**
 * Parse and validate a text import without touching the database or embedding
 * provider. Sync rename uses this to identify the committed destination before
 * it considers retiring the old canonical page.
 */
export async function preflightImportFileContent(
  content: string,
  relativePath: string,
  opts: ImportFileOptions = {},
): Promise<ImportFilePreflightResult> {
  if (isCodeFilePath(relativePath)) {
    return {
      ok: true,
      slug: slugifyCodePath(relativePath),
      content,
      kind: 'code',
      usedFrontmatterFallback: false,
    };
  }

  if (opts.inferFrontmatter !== false) {
    const { applyInference } = await import('./frontmatter-inference.ts');
    const { content: inferred, inferred: meta } = applyInference(relativePath, content);
    if (!meta.skipped) content = inferred;
  }

  const parsed = parseMarkdown(content, relativePath, { activePack: opts.activePack });
  const expectedSlug = slugifyPath(relativePath);
  let resolvedSlug = expectedSlug;
  let usedFrontmatterFallback = false;

  if (expectedSlug === '') {
    if (parsed.slug && parsed.slug.length > 0) {
      resolvedSlug = parsed.slug;
      usedFrontmatterFallback = true;
    } else {
      return {
        ok: false,
        result: {
          slug: '',
          status: 'skipped',
          chunks: 0,
          error:
            `Filename "${relativePath}" produces no usable slug. ` +
            `Add a "slug:" to the frontmatter, or rename the file to use ` +
            `ASCII / Chinese / Japanese / Korean characters.`,
        },
      };
    }
  } else if (parsed.slug !== expectedSlug) {
    return {
      ok: false,
      result: {
        slug: expectedSlug,
        status: 'skipped',
        chunks: 0,
        error:
          `Frontmatter slug "${parsed.slug}" does not match path-derived slug "${expectedSlug}" ` +
          `(from ${relativePath}). Remove the frontmatter "slug:" line or move the file.`,
      },
    };
  }

  return {
    ok: true,
    slug: resolvedSlug,
    content,
    kind: 'markdown',
    usedFrontmatterFallback,
  };
}

/**
 * Import already-captured text bytes under a repo-relative path.
 *
 * The content is an explicit argument so Git-backed sync can pass an immutable
 * commit blob without round-tripping through a mutable checkout. Filesystem
 * callers retain their lstat/stat checks in `importFromFile` before entering
 * this shared parser.
 */
export async function importFileContent(
  engine: BrainEngine,
  content: string,
  relativePath: string,
  opts: ImportFileOptions = {},
): Promise<ImportResult> {
  const preflight = await preflightImportFileContent(content, relativePath, opts);
  if (!preflight.ok) return preflight.result;
  content = preflight.content;

  // Route code files through the code import path.
  if (preflight.kind === 'code') {
    return importCodeFile(engine, relativePath, content, {
      noEmbed: opts.noEmbed,
      sourceId: opts.sourceId,
      force: opts.forceRechunk,
      renameFromSlug: opts.renameFromSlug,
      renameFromSourcePath: opts.renameFromSourcePath,
      writerLease: opts.writerLease,
    });
  }

  // Emit the dual-channel audit entry AFTER we know we're not going to
  // short-circuit, so we don't log noise for failed imports.
  if (preflight.usedFrontmatterFallback) {
    logSlugFallback(preflight.slug, relativePath);
  }

  // Pass the resolved slug explicitly so that any future change to
  // parseMarkdown's precedence rules cannot re-introduce this bug.
  // v0.29.1: thread the basename (without extension) for filename-date
  // precedence in computeEffectiveDate. e.g. `daily/2024-03-15.md` →
  // filename `2024-03-15`.
  const fileBasename = basename(relativePath, '.md');
  return importFromContent(engine, preflight.slug, content, {
    ...opts,
    filename: fileBasename,
    sourcePath: relativePath,
  });
}

export async function importFromFile(
  engine: BrainEngine,
  filePath: string,
  relativePath: string,
  opts: ImportFileOptions = {},
): Promise<ImportResult> {
  // Defense-in-depth: reject symlinks before reading content.
  const lstat = lstatSync(filePath);
  if (lstat.isSymbolicLink()) {
    return { slug: relativePath, status: 'skipped', chunks: 0, error: `Skipping symlink: ${filePath}` };
  }

  const stat = statSync(filePath);
  if (stat.size > MAX_IMPORT_TEXT_BYTES) {
    return { slug: relativePath, status: 'skipped', chunks: 0, error: `File too large (${stat.size} bytes)` };
  }

  return importFileContent(engine, readFileSync(filePath, 'utf-8'), relativePath, opts);
}

export type ImportGitBlobOptions = ImportFileOptions & ImportImageOptions;

export type ImportGitBlobPreflightResult =
  | { ok: true; slug: string }
  | { ok: false; result: ImportResult };

/**
 * Resolve and validate an immutable Git target without side effects. The blob
 * is read here so a missing/corrupt object cannot be discovered only after a
 * rename transaction has begun. The later import reads the same immutable
 * object again and performs the full quality/embedding checks.
 */
export async function preflightImportGitBlob(
  snapshot: GitCommitSnapshot,
  blob: GitCommitBlob,
  opts: ImportGitBlobOptions = {},
): Promise<ImportGitBlobPreflightResult> {
  if (isImageFilePath(blob.path)) {
    if (blob.size > MAX_IMPORT_IMAGE_BYTES) {
      return {
        ok: false,
        result: {
          slug: slugifyPath(blob.path),
          status: 'skipped',
          chunks: 0,
          error: `Image too large (${blob.size} bytes, max ${MAX_IMPORT_IMAGE_BYTES}). Voyage multimodal caps at 20MB per input.`,
        },
      };
    }
    await snapshot.read(blob.path, MAX_IMPORT_IMAGE_BYTES);
    return { ok: true, slug: blob.path.replace(/[\\\/]/g, '/').toLowerCase() };
  }

  if (blob.size > MAX_IMPORT_TEXT_BYTES) {
    return {
      ok: false,
      result: {
        slug: blob.path,
        status: 'skipped',
        chunks: 0,
        error: `File too large (${blob.size} bytes)`,
      },
    };
  }
  const bytes = await snapshot.read(blob.path, MAX_IMPORT_TEXT_BYTES);
  const text = await preflightImportFileContent(bytes.toString('utf8'), blob.path, opts);
  if (!text.ok) return text;
  return { ok: true, slug: text.slug };
}

/** Import a blob reference that was already resolved from one commit tree. */
export async function importGitBlob(
  engine: BrainEngine,
  snapshot: GitCommitSnapshot,
  blob: GitCommitBlob,
  opts: ImportGitBlobOptions = {},
): Promise<ImportResult> {
  if (isImageFilePath(blob.path)) {
    if (blob.size > MAX_IMPORT_IMAGE_BYTES) {
      return {
        slug: slugifyPath(blob.path),
        status: 'skipped',
        chunks: 0,
        error: `Image too large (${blob.size} bytes, max ${MAX_IMPORT_IMAGE_BYTES}). Voyage multimodal caps at 20MB per input.`,
      };
    }
    const bytes = await snapshot.read(blob.path, MAX_IMPORT_IMAGE_BYTES);
    return importImageBuffer(engine, bytes, blob.path, opts);
  }
  if (blob.size > MAX_IMPORT_TEXT_BYTES) {
    return {
      slug: blob.path,
      status: 'skipped',
      chunks: 0,
      error: `File too large (${blob.size} bytes)`,
    };
  }
  const bytes = await snapshot.read(blob.path, MAX_IMPORT_TEXT_BYTES);
  return importFileContent(engine, bytes.toString('utf8'), blob.path, opts);
}

/** Resolve and import one path from the exact bytes at `commit`. */
export async function importGitCommitFile(
  engine: BrainEngine,
  repoPath: string,
  commit: string,
  relativePath: string,
  opts: ImportGitBlobOptions = {},
): Promise<ImportResult> {
  const snapshot = openGitCommitSnapshot(repoPath, commit);
  try {
    const blob = snapshot.getBlob(relativePath);
    if (!blob) {
      throw new Error(
        `Path is not a regular file in Git snapshot ${commit.slice(0, 12)}: ${relativePath}`,
      );
    }
    return await importGitBlob(engine, snapshot, blob, opts);
  } finally {
    await snapshot.close();
  }
}

/**
 * Import a code file. Bypasses markdown parsing entirely.
 * Uses tree-sitter code chunker for semantic splitting.
 * Page type is 'code', slug includes file extension.
 */
/**
 * v0.31.2 (PR1 commit 10): facts backstop wiring decision.
 *
 * Code pages have `type: 'code'` which the `isFactsBackstopEligible`
 * predicate (src/core/facts/eligibility.ts) rejects with `kind:code`.
 * Wiring `runFactsBackstop` here would always produce a no-op envelope.
 * The wiring is intentionally omitted — when README extraction or
 * doc-comment extraction is added in a future release, the eligibility
 * predicate is the single place to update.
 *
 * Sibling decisions: `file_upload` doesn't write a page (uploads to
 * storage; the page itself is written via separate put_page); `gbrain
 * import` (bulk markdown import) intentionally skips the backstop to
 * avoid a cost spike on first-time imports of large brain repos. The
 * user runs `gbrain dream` or the consolidate phase to backfill facts
 * from bulk-imported pages.
 */
export async function importCodeFile(
  engine: BrainEngine,
  relativePath: string,
  content: string,
  opts: {
    noEmbed?: boolean;
    force?: boolean;
    sourceId?: string;
    renameFromSlug?: string;
    renameFromSourcePath?: string;
    writerLease?: SourceWriterLease;
  } = {},
): Promise<ImportResult> {
  const slug = slugifyCodePath(relativePath);
  const lang = detectCodeLanguage(relativePath) || 'unknown';
  const title = `${relativePath} (${lang})`;
  const sourceId = opts.sourceId;
  const effectiveSourceId = sourceId ?? 'default';
  const txOpts = { sourceId: effectiveSourceId };

  const byteLength = Buffer.byteLength(content, 'utf-8');
  if (byteLength > MAX_IMPORT_TEXT_BYTES) {
    return { slug, status: 'skipped', chunks: 0, error: `Code file too large (${byteLength} bytes)` };
  }

  if (!opts.writerLease) {
    return withSourceWriterLease(engine, effectiveSourceId, writerLease =>
      importCodeFile(engine, relativePath, content, { ...opts, writerLease }));
  }
  assertSourceWriterLease(opts.writerLease, engine, effectiveSourceId);

  // Vendor-neutral guardrail seam (observe-only, fail-open). Runs AFTER the
  // code size guard, BEFORE hash compute, code-chunking, embedding, and DB
  // write. Verdict ignored by design; no-op when no guardrail is registered.
  await runGuardrails({
    hook: 'file_storage.code',
    content,
    metadata: {
      slug,
      source_id: sourceId ?? 'default',
      source_path: relativePath,
      source_kind: 'code',
      content_type: 'code',
      language: lang,
    },
  });

  // Hash for idempotency. CHUNKER_VERSION is folded in so chunker shape
  // changes across releases force clean re-chunks without sync --force.
  const hash = createHash('sha256')
    .update(JSON.stringify({ title, type: 'code', content, lang, chunker_version: CHUNKER_VERSION }))
    .digest('hex');

  const existingSlug = opts.renameFromSlug ?? slug;
  const existing = await engine.getPage(existingSlug, { sourceId: effectiveSourceId });
  if (!opts.renameFromSlug && !opts.force && existing?.content_hash === hash) {
    return { slug, status: 'skipped', chunks: 0 };
  }

  // Chunk via tree-sitter code chunker. The chunker returns per-chunk
  // metadata (symbol_name, symbol_type, language, start_line, end_line)
  // which we persist as columns so the v0.19.0 query --lang + code-def +
  // code-refs surfaces can filter without parsing chunk_text.
  // v0.20.0 Cathedral II Layer 6 (A3): parent_symbol_path flows through
  // from the chunker (nested methods carry ['ClassName'] etc.) so the
  // chunk-grain FTS trigger picks up scope for ranking and downstream
  // Layer 5 edge resolution can use scope-qualified identity.
  const { chunks: codeChunks, edges: extractedEdges } = await chunkCodeTextFull(content, relativePath);
  const chunks: ChunkInput[] = codeChunks.map((c, i) => ({
    chunk_index: i,
    chunk_text: c.text,
    chunk_source: 'compiled_truth' as const,
    language: c.metadata.language,
    symbol_name: c.metadata.symbolName || undefined,
    symbol_type: c.metadata.symbolType,
    start_line: c.metadata.startLine,
    end_line: c.metadata.endLine,
    parent_symbol_path:
      c.metadata.parentSymbolPath && c.metadata.parentSymbolPath.length > 0
        ? c.metadata.parentSymbolPath
        : undefined,
    symbol_name_qualified: c.metadata.symbolNameQualified || undefined,
  }));

  // v0.19.0 E2 — incremental chunking. Embedding calls dominate the cost
  // of a sync; re-embedding unchanged chunks wastes money without
  // improving retrieval. Look up existing chunks by slug and, for any
  // whose chunk_text exactly matches the new chunk at the same index,
  // reuse the existing embedding. Only truly new/changed chunks hit the
  // OpenAI API. Order matters: our chunk_index is semantic (tree-sitter
  // order), so a matching (chunk_index, text_hash) means a verbatim
  // preserved symbol.
  const existingChunks = existing
    ? await engine.getChunks(existingSlug, { sourceId: effectiveSourceId })
    : [];
  const existingByKey = new Map<string, typeof existingChunks[number]>();
  for (const ec of existingChunks) {
    existingByKey.set(`${ec.chunk_index}:${ec.chunk_text}`, ec);
  }
  const needsEmbedIndexes: number[] = [];
  for (let i = 0; i < chunks.length; i++) {
    const key = `${chunks[i]!.chunk_index}:${chunks[i]!.chunk_text}`;
    const matched = existingByKey.get(key);
    if (matched && matched.embedding) {
      // Reuse the existing embedding verbatim. No API call, no cost.
      chunks[i]!.embedding = matched.embedding as Float32Array;
      chunks[i]!.token_count = matched.token_count ?? undefined;
    } else {
      needsEmbedIndexes.push(i);
    }
  }

  // Embed only the new/changed chunks.
  if (!opts.noEmbed && needsEmbedIndexes.length > 0) {
    try {
      const textsToEmbed = needsEmbedIndexes.map((i) => chunks[i]!.chunk_text);
      const embeddings = await embedBatch(textsToEmbed);
      for (let j = 0; j < needsEmbedIndexes.length; j++) {
        const i = needsEmbedIndexes[j]!;
        chunks[i]!.embedding = embeddings[j]!;
        chunks[i]!.token_count = Math.ceil(chunks[i]!.chunk_text.length / 4);
      }
    } catch (e: unknown) {
      console.warn(`[gbrain] embedding failed for code file ${slug}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // Store. Every per-page tx call carries `txOpts.sourceId` so multi-source
  // brains write to the correct (source_id, slug) row instead of duplicating
  // under the schema DEFAULT.
  assertSourceWriterLease(opts.writerLease, engine, effectiveSourceId);
  await engine.transaction(async (tx) => {
    const prior = await stagePageIdentityForImport(
      tx,
      slug,
      opts.renameFromSlug,
      opts.renameFromSourcePath,
      effectiveSourceId,
    );
    await cleanupPriorImportedState(tx, prior, {
      sourceId: effectiveSourceId,
      targetSlug: slug,
      targetKind: 'code',
      targetSourcePath: relativePath,
    });

    await tx.putPage(slug, {
      type: 'code' as string,
      page_kind: 'code',
      title,
      compiled_truth: content,
      timeline: '',
      frontmatter: { language: lang, file: relativePath },
      content_hash: hash,
      source_path: relativePath,
    }, txOpts);

    await tx.addTag(slug, 'code', txOpts);
    await tx.addTag(slug, lang, txOpts);

    if (chunks.length > 0) {
      await tx.upsertChunks(slug, chunks, txOpts);
      // v0.41.31: stamp embedding provenance ONLY when every chunk was
      // freshly embedded with the current model this call (no reuse-by-hash
      // carrying old-model vectors). Mixed pages stay unstamped rather than
      // falsely marked current; `reindex --code --force` / `embed --stale`
      // handle the swap for those.
      if (!opts.noEmbed && needsEmbedIndexes.length === chunks.length) {
        await tx.setPageEmbeddingSignature(slug, {
          sourceId: effectiveSourceId,
          signature: currentEmbeddingSignature(),
        });
      }
    } else {
      await tx.deleteChunks(slug, txOpts);
    }

    // Code edges are part of the same final commit as page/chunk identity.
    // cleanupPriorImportedState removed every edge touching the prior code
    // chunks before upsert. Any get/add failure below therefore rolls back the
    // page rename and the edge replacement together; replay can safely honor
    // content_hash without inheriting a half-built call graph.
    if (extractedEdges.length > 0 && chunks.length > 0) {
      const persistedChunks = await tx.getChunks(slug, { sourceId: effectiveSourceId });
      const byIndex = new Map<number, { id?: number; symbol_name_qualified?: string | null; start_line?: number | null; end_line?: number | null }>();
      for (const pc of persistedChunks) {
        byIndex.set(pc.chunk_index, pc);
      }

      // Build the chunk-range table for offset → chunk-id resolution.
      const rangeList = chunks.map((ch, i) => {
        const persisted = byIndex.get(i);
        return {
          id: persisted?.id as number | undefined,
          startLine: ch.start_line ?? 1,
          endLine: ch.end_line ?? 1,
          symbol_name_qualified: ch.symbol_name_qualified ?? null,
        };
      });

      const edgeInputs: import('./types.ts').CodeEdgeInput[] = [];
      for (const e of extractedEdges) {
        const idx = findChunkForOffset(e.callSiteByteOffset, content, rangeList);
        if (idx == null) continue;
        const from = rangeList[idx]!;
        if (!from.id || !from.symbol_name_qualified) continue;
        edgeInputs.push({
          from_chunk_id: from.id,
          to_chunk_id: null,
          from_symbol_qualified: from.symbol_name_qualified,
          to_symbol_qualified: e.toSymbol,
          edge_type: e.edgeType,
          source_id: effectiveSourceId,
        });
      }

      if (edgeInputs.length > 0) {
        await tx.addCodeEdges(edgeInputs);
      }
    }

    // Page, chunks and code edges share one fencing point immediately before
    // the transaction callback returns to the engine for commit.
    await assertSourceWriterLeaseAtCommit(opts.writerLease!, tx, effectiveSourceId);
  });

  return { slug, status: 'imported', chunks: chunks.length };
}

// Backward compat
export const importFile = importFromFile;
export type ImportFileResult = ImportResult;

// ============================================================
// v0.27.1 multimodal: image-file ingestion (Phase 8 / Sec5 / F2 / Eng-1C)
// ============================================================

/**
 * v0.27.1: image extension allow-list. PNG/JPG/JPEG/GIF/WEBP are universal
 * codecs that don't need decoding before embedding (we send raw bytes).
 * HEIC/HEIF/AVIF need WASM decode to JPEG before Voyage will accept them.
 *
 * Other variants (BMP, TIFF, etc.) intentionally left out — they're rare in
 * the kinds of brains gbrain serves and adding them would expand the WASM
 * decode surface meaningfully.
 */
export const SUPPORTED_IMAGE_EXTS = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.heic', '.heif', '.avif'] as const;

/** Voyage caps each multimodal input at 20MB. We honor that as the size limit. */
export const MAX_IMPORT_IMAGE_BYTES = 20 * 1024 * 1024;

/** Extensions that need WASM decode before Voyage embedding. */
const NEEDS_DECODE = new Set(['.heic', '.heif', '.avif']);

/**
 * Phase 8 / Sec5 (DRY refactor): shared transaction wrapper for the markdown
 * + image import paths. Idempotent on content_hash (the caller skips when
 * existing.content_hash === hash, before calling here).
 *
 * Does NOT include type-specific work (tag reconciliation for markdown,
 * code-ref edges, EXIF auto-link for images). Callers compose those on top
 * via the optional `after` callback, which runs INSIDE the same transaction.
 */
export interface ImportTransactionSpec {
  slug: string;
  /**
   * Source that owns every row touched by this transaction. Omit for the
   * legacy/default-source path. Multi-source callers must pass it so page
   * versioning, page/chunk replacement, and file metadata stay on the same
   * `(source_id, slug)` identity.
   */
  sourceId?: string;
  renameFromSlug?: string;
  renameFromSourcePath?: string;
  page: PageInput;
  /** When undefined, no chunk write happens. When [], deletes any prior chunks. */
  chunks?: ChunkInput[];
  /** Optional file-row insert (image ingest). Page link injected automatically. */
  file?: FileSpec;
  /** Inside-transaction hook for type-specific work (tags, links). */
  after?: (tx: BrainEngine) => Promise<void>;
  /** Runtime fencing proof for importer-owned transactions. */
  writerLease?: SourceWriterLease;
}

export async function withImportTransaction(
  engine: BrainEngine,
  spec: ImportTransactionSpec,
): Promise<void> {
  await engine.transaction(async (tx) => {
    const sourceId = spec.sourceId ?? 'default';
    if (spec.writerLease) assertSourceWriterLease(spec.writerLease, tx, sourceId);
    const sourceOpts = { sourceId };
    const prior = await stagePageIdentityForImport(
      tx,
      spec.slug,
      spec.renameFromSlug,
      spec.renameFromSourcePath,
      sourceId,
    );
    const targetKind = spec.page.page_kind ?? 'markdown';
    await cleanupPriorImportedState(tx, prior, {
      sourceId,
      targetSlug: spec.slug,
      targetKind,
      targetSourcePath: spec.page.source_path,
    });
    await tx.putPage(spec.slug, spec.page, sourceOpts);
    if (spec.file) {
      // page_id resolution after putPage so the new row's id is available.
      const stored = await tx.getPage(spec.slug, sourceOpts);
      await tx.upsertFile({
        ...spec.file,
        source_id: sourceId,
        page_slug: spec.slug,
        page_id: stored?.id ?? null,
      });
    }
    if (spec.chunks !== undefined) {
      if (spec.chunks.length > 0) {
        await tx.upsertChunks(spec.slug, spec.chunks, sourceOpts);
      } else {
        await tx.deleteChunks(spec.slug, sourceOpts);
      }
    }
    if (spec.after) await spec.after(tx);
    if (spec.writerLease) await assertSourceWriterLeaseAtCommit(spec.writerLease, tx, sourceId);
  });
}

/**
 * Eng-1C: pure-JS p-limit semaphore so OCR calls run with bounded
 * concurrency without pulling in a new dep. Returns a function that, when
 * called, returns a Promise that resolves when the wrapped function resolves
 * AND the semaphore slot has been released.
 *
 * Used by importImageFile to parallelize OCR (typically ~2s/image) at
 * concurrency 8. Without this, 100 images = 200s wall time of sequential OCR.
 * With this, 100 images = ~25s.
 */
export function pLimit(concurrency: number) {
  let active = 0;
  const queue: Array<() => void> = [];
  function next() {
    if (active >= concurrency) return;
    const run = queue.shift();
    if (run) {
      active++;
      run();
    }
  }
  return async <T>(fn: () => Promise<T>): Promise<T> => {
    return new Promise<T>((resolve, reject) => {
      queue.push(() => {
        fn()
          .then(resolve, reject)
          .finally(() => {
            active--;
            next();
          });
      });
      next();
    });
  };
}

/**
 * Decode HEIC/AVIF bytes to a re-encoded JPEG buffer that Voyage accepts.
 * Pre-loads the WASM via the bun-compile-safe pattern proven in Phase 1's
 * scripts/check-image-decoders-embedded.sh. PNG/JPG/JPEG/GIF/WEBP pass
 * through unchanged.
 */
async function decodeIfNeeded(ext: string, buf: Buffer): Promise<{ buf: Buffer; mime: string }> {
  if (ext === '.heic' || ext === '.heif') {
    // heic-decode bundles libheif via base64 — works in bun --compile
    // out of the box. Returns RGBA pixel buffer + dims.
    const heicDecode = (await import('heic-decode')).default;
    const decoded = await heicDecode({ buffer: buf });
    const encodePng = (await import('@jsquash/png/encode.js')).default;
    const pngBytes = await encodePng({
      data: new Uint8ClampedArray(decoded.data),
      width: decoded.width,
      height: decoded.height,
    });
    return { buf: Buffer.from(pngBytes), mime: 'image/png' };
  }
  if (ext === '.avif') {
    // @jsquash/avif loads its WASM relative to its own JS file, which fails
    // inside a bun --compile VFS. Pre-init via the path imported with
    // `with { type: 'file' }` (proven in scripts/check-image-decoders-embedded.sh).
    const avifWasmModule = await import('@jsquash/avif/codec/dec/avif_dec.wasm', { with: { type: 'file' } });
    const avifMod = await import('@jsquash/avif/decode.js');
    const wasmBytes = readFileSync((avifWasmModule as { default: string }).default);
    // WebAssembly.compile expects ArrayBuffer; Buffer.buffer is ArrayBufferLike
    // (Bun typing). Slice gives a fresh ArrayBuffer view.
    const wasmAB = wasmBytes.buffer.slice(wasmBytes.byteOffset, wasmBytes.byteOffset + wasmBytes.byteLength) as ArrayBuffer;
    const wasmModule = await WebAssembly.compile(wasmAB);
    await avifMod.init(wasmModule);
    // @jsquash/avif's decode is typed against ArrayBuffer.
    const inputAB = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
    const decoded = await avifMod.default(inputAB);
    if (!decoded) {
      throw new Error('avif decode returned null');
    }
    const encodePng = (await import('@jsquash/png/encode.js')).default;
    const pngBytes = await encodePng({
      data: new Uint8ClampedArray(decoded.data),
      width: decoded.width,
      height: decoded.height,
    });
    return { buf: Buffer.from(pngBytes), mime: 'image/png' };
  }
  // Universal codecs: pass-through.
  const mimeMap: Record<string, string> = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
  };
  return { buf, mime: mimeMap[ext] ?? 'application/octet-stream' };
}

/** EXIF metadata stamped onto image-page frontmatter (cherry-2). */
async function readExifSafe(buf: Buffer): Promise<Record<string, unknown>> {
  try {
    const exifr = (await import('exifr')).default;
    const data = (await exifr.parse(buf)) as Record<string, unknown> | undefined;
    if (!data) return {};
    const out: Record<string, unknown> = {};
    if (data.DateTimeOriginal instanceof Date) {
      out.captured_at = data.DateTimeOriginal.toISOString();
    } else if (typeof data.CreateDate === 'string') {
      out.captured_at = data.CreateDate;
    }
    if (typeof data.latitude === 'number' && typeof data.longitude === 'number') {
      out.gps = { lat: data.latitude, lon: data.longitude };
    }
    if (typeof data.Make === 'string' || typeof data.Model === 'string') {
      out.camera = `${data.Make ?? ''} ${data.Model ?? ''}`.trim();
    }
    if (typeof data.ExifImageWidth === 'number' && typeof data.ExifImageHeight === 'number') {
      out.dims = { w: data.ExifImageWidth, h: data.ExifImageHeight };
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * Cherry-1 OCR: optional gpt-4o-mini pass extracting visible text from an
 * image. Returns '' when:
 * - the embedding_image_ocr config flag is off (default)
 * - the configured expansion model is unavailable (no API key)
 * - the OCR call itself fails (logged once per session)
 *
 * Eng-1B: per-call result is reflected in counters the doctor `ocr_health`
 * check reads. Counter writes are best-effort; never fail the import.
 *
 * The system prompt explicitly tells the model not to follow instructions
 * embedded in the image (mitigation for the OCR-as-prompt-injection vector).
 */
let _ocrWarnedThisSession = false;
async function maybeOcr(
  engine: BrainEngine,
  imgBuf: Buffer,
  mime: string,
): Promise<string> {
  const opt = process.env.GBRAIN_EMBEDDING_IMAGE_OCR;
  if (opt !== 'true') return '';

  // Counter helpers — quiet failure if config table is unavailable.
  async function bump(key: string) {
    try {
      const cur = parseInt((await engine.getConfig(key)) ?? '0', 10);
      await engine.setConfig(key, String((Number.isFinite(cur) ? cur : 0) + 1));
    } catch { /* non-fatal */ }
  }

  await bump('ocr_attempted');
  try {
    const { isAvailable, generateOcrText } = await import('./ai/gateway.ts');
    if (!isAvailable('expansion')) {
      if (!_ocrWarnedThisSession) {
        console.warn('[gbrain] OCR opt-in is true but expansion model is unavailable; skipping OCR for this session');
        _ocrWarnedThisSession = true;
      }
      await bump('ocr_failed_no_key');
      return '';
    }
    const text = await generateOcrText(imgBuf, mime);
    await bump('ocr_succeeded');
    return text;
  } catch (err) {
    if (!_ocrWarnedThisSession) {
      console.warn(`[gbrain] OCR call failed (continuing without OCR text): ${err instanceof Error ? err.message : String(err)}`);
      _ocrWarnedThisSession = true;
    }
    await bump('ocr_failed_other');
    return '';
  }
}

export interface ImportImageOptions {
  /** Override default OCR concurrency for tests. */
  ocrConcurrency?: number;
  /** Skip the embed call (for tests that want fast metadata-only inserts). */
  noEmbed?: boolean;
  /**
   * v0.30.x follow-up to PR #707: route image-page writes to a named source.
   * Mirrors importFromContent's threading; without this, runImport callers
   * with sourceId would TS-error on the importImageFile branch.
   */
  sourceId?: string;
  /** Existing canonical slug to move inside the final image-write tx. */
  renameFromSlug?: string;
  /** Previous image storage path to remove in that same tx. */
  renameFromSourcePath?: string;
  /** Internal source-writer fencing proof. */
  writerLease?: SourceWriterLease;
}

/** Module-level limiter so concurrent imports across files share the budget. */
const _ocrLimiter = pLimit(8);

/**
 * Phase 8 (cherry-1+2+3 in scope, F2 walker hook): import a single image file
 * by path. Lives alongside importFromFile + importCodeFile in the dispatcher
 * (extended in import.ts to recognize image extensions when
 * embedding_multimodal is on).
 */
export async function importImageBuffer(
  engine: BrainEngine,
  buf: Buffer,
  relativePath: string,
  opts: ImportImageOptions = {},
): Promise<ImportResult> {
  if (buf.byteLength > MAX_IMPORT_IMAGE_BYTES) {
    return {
      slug: slugifyPath(relativePath),
      status: 'skipped',
      chunks: 0,
      error: `Image too large (${buf.byteLength} bytes, max ${MAX_IMPORT_IMAGE_BYTES}). Voyage multimodal caps at 20MB per input.`,
    };
  }

  const sourceId = opts.sourceId ?? 'default';
  if (!opts.writerLease) {
    return withSourceWriterLease(engine, sourceId, writerLease =>
      importImageBuffer(engine, buf, relativePath, { ...opts, writerLease }));
  }
  assertSourceWriterLease(opts.writerLease, engine, sourceId);

  const ext = extname(relativePath).toLowerCase();
  const slug = slugifyPath(relativePath); // strips .md/.mdx; for images ext stays in path
  // Image slug includes the extension (otherwise foo.png and foo.jpg collide
  // and slugifyPath would already preserve it). Recompute with the file
  // extension preserved so the page slug is stable + collision-free.
  const imageSlug = relativePath.replace(/[\\\/]/g, '/').toLowerCase();
  const hash = createHash('sha256').update(buf).digest('hex');

  const sourceOpts = { sourceId };
  const existingSlug = opts.renameFromSlug ?? imageSlug;
  const existing = await engine.getPage(existingSlug, sourceOpts);
  if (!opts.renameFromSlug && existing?.content_hash === hash) {
    return { slug: imageSlug, status: 'skipped', chunks: 0 };
  }

  // Decode HEIC/AVIF; pass-through for universal codecs.
  let decoded: { buf: Buffer; mime: string };
  try {
    decoded = await decodeIfNeeded(ext, buf);
  } catch (err) {
    return {
      slug: imageSlug,
      status: 'error',
      chunks: 0,
      error: `Decode failed for ${relativePath}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // EXIF metadata (cherry-2). Pure JS, sub-ms; no concurrency knob needed.
  const exif = await readExifSafe(buf);

  // OCR opt-in (cherry-1). Runs through the per-process limiter so 100
  // images first-import doesn't serialize into 200s of OCR latency.
  const ocrText: string = opts.noEmbed
    ? ''
    : await _ocrLimiter(() => maybeOcr(engine, decoded.buf, decoded.mime));

  // Multimodal embed.
  let embedding: Float32Array | null = null;
  if (!opts.noEmbed) {
    try {
      const [vec] = await embedMultimodal([
        { kind: 'image_base64', data: decoded.buf.toString('base64'), mime: decoded.mime },
      ]);
      embedding = vec;
    } catch (err) {
      return {
        slug: imageSlug,
        status: 'error',
        chunks: 0,
        error: `embedMultimodal failed for ${relativePath}: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  const filename = basename(relativePath);
  const frontmatter: Record<string, unknown> = {
    type: 'image',
    title: filename,
    mime_type: decoded.mime,
    bytes: buf.byteLength,
    ...exif,
  };

  // Single chunk per image. chunk_text holds OCR text or filename so
  // searchKeyword has something useful to match when image rows are opted in.
  // chunk_source='image_asset' joins the v0.20 chunk_source allowlist.
  const chunk: ChunkInput & { modality?: string; embedding_image?: Float32Array } = {
    chunk_index: 0,
    chunk_text: ocrText || filename,
    chunk_source: 'image_asset',
    modality: 'image',
    ...(embedding ? { embedding_image: embedding } : {}),
  };

  const fileSpec: FileSpec = {
    source_id: sourceId,
    filename,
    storage_path: relativePath.replace(/[\\\/]/g, '/'),
    mime_type: decoded.mime,
    size_bytes: buf.byteLength,
    content_hash: hash,
  };

  assertSourceWriterLease(opts.writerLease, engine, sourceId);
  await withImportTransaction(engine, {
    slug: imageSlug,
    sourceId: opts.sourceId,
    renameFromSlug: opts.renameFromSlug,
    renameFromSourcePath: opts.renameFromSourcePath,
    page: {
      type: 'image',
      page_kind: 'image',
      title: filename,
      compiled_truth: ocrText || '',
      timeline: '',
      frontmatter,
      content_hash: hash,
      source_path: relativePath,
    },
    chunks: [chunk],
    file: fileSpec,
    writerLease: opts.writerLease,
    after: async (tx) => {
      // Cherry-3: path-proximity auto-link to a sibling text page. The first
      // matching candidate gets an image_of edge. Best-effort — addLink
      // throws when the target doesn't exist; we silently skip for now and
      // let `gbrain reconcile-links` pick up later additions.
      for (const candidate of imageOfCandidates(imageSlug)) {
        const sibling = await tx.getPage(candidate, sourceOpts);
        if (sibling) {
          try {
            await tx.addLink(
              imageSlug, candidate,
              filename,
              'image_of', 'manual', imageSlug, 'frontmatter',
              {
                fromSourceId: sourceId,
                toSourceId: sourceId,
                originSourceId: sourceId,
              },
            );
          } catch { /* sibling vanished mid-tx; skip */ }
          break; // one canonical link per image
        }
      }
    },
  });

  return { slug: imageSlug, status: 'imported', chunks: 1 };
}

export async function importImageFile(
  engine: BrainEngine,
  filePath: string,
  relativePath: string,
  opts: ImportImageOptions = {},
): Promise<ImportResult> {
  // Defense-in-depth: reject symlinks before reading bytes.
  const lstat = lstatSync(filePath);
  if (lstat.isSymbolicLink()) {
    return { slug: slugifyPath(relativePath), status: 'skipped', chunks: 0, error: `Skipping symlink: ${filePath}` };
  }
  const stat = statSync(filePath);
  if (stat.size > MAX_IMPORT_IMAGE_BYTES) {
    return {
      slug: slugifyPath(relativePath),
      status: 'skipped',
      chunks: 0,
      error: `Image too large (${stat.size} bytes, max ${MAX_IMPORT_IMAGE_BYTES}). Voyage multimodal caps at 20MB per input.`,
    };
  }
  return importImageBuffer(engine, readFileSync(filePath), relativePath, opts);
}

/** Used by sync.isSyncable + import.ts walker. */
export function isImageFilePath(relativePath: string): boolean {
  const ext = extname(relativePath).toLowerCase();
  return (SUPPORTED_IMAGE_EXTS as readonly string[]).includes(ext);
}
// Re-export for sync.ts consumers (import-file is the single source of truth).
void NEEDS_DECODE;
