import {
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';
import { renameSync, unlinkSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';

import { gbrainPath } from './config.ts';
import {
  readOwnedStateFile,
  withOwnedStateReadPolicy,
  writeOwnedStateFileAtomic,
} from './owned-state-file.ts';
import { VERSION } from '../version.ts';

export const UPGRADE_CHILD_CAPABILITY_FILE_ENV = 'GBRAIN_UPGRADE_CHILD_CAPABILITY_FILE';
export const UPGRADE_CHILD_CAPABILITY_TOKEN_ENV = 'GBRAIN_UPGRADE_CHILD_CAPABILITY_TOKEN';
export const UPGRADE_CHILD_CAPABILITY_TTL_MS = 2 * 60 * 1_000;

const MAX_CAPABILITY_BYTES = 64 * 1024;
const MAX_CLOCK_SKEW_MS = 5_000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const BRAIN_ID_RE = /^db:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const TOKEN_HASH_RE = /^[0-9a-f]{64}$/;
const CAPABILITY_BASENAME_RE = /^upgrade-child-capability-([0-9a-f-]{36})\.json$/i;

export interface UpgradeChildTransition {
  transitionId: string;
  brainId: string | null;
  fromVersion: string;
  toVersion: string;
}

export interface UpgradeChildRuntime {
  execPath: string;
  main: string;
  parentPid: number;
}

interface UpgradeChildCapabilityRecord {
  schema_version: 1;
  capability_id: string;
  token_sha256: string;
  binding_hmac_sha256: string;
  transition_id: string;
  brain_id: string | null;
  from_version: string;
  to_version: string;
  release_version: string;
  executable: string;
  main: string | null;
  raw_argv: string[];
  parent_pid: number;
  issued_at_ms: number;
  expires_at_ms: number;
}

type UnsignedUpgradeChildCapabilityRecord = Omit<
  UpgradeChildCapabilityRecord,
  'binding_hmac_sha256'
>;

export interface MintUpgradeChildCapabilityOptions {
  configDir: string;
  rawArgs: readonly string[];
  invocation: readonly string[];
  transition: UpgradeChildTransition;
  snapshotBrainId: string;
  nowMs?: number;
  parentPid?: number;
}

export interface MintedUpgradeChildCapability {
  path: string;
  token: string;
  env: Record<string, string>;
}

export interface ConsumeUpgradeChildCapabilityOptions {
  env?: NodeJS.ProcessEnv;
  runtime?: UpgradeChildRuntime;
  nowMs?: number;
}

export class UpgradeChildCapabilityError extends Error {
  constructor() {
    // Capability paths and bearer material are intentionally absent from the
    // error. Child stderr can be persisted as migration evidence.
    super('Invalid or expired post-upgrade child capability.');
    this.name = 'UpgradeChildCapabilityError';
  }
}

function fail(): never {
  throw new UpgradeChildCapabilityError();
}

function isBunExecutable(path: string): boolean {
  return /^bun(?:\.exe)?$/i.test(basename(path));
}

/** Single invocation resolver shared by the minting parent and child gate. */
export function resolveUpgradeChildInvocation(
  args: readonly string[],
  runtime: Pick<UpgradeChildRuntime, 'execPath' | 'main'> = {
    execPath: process.execPath,
    main: Bun.main,
  },
): string[] {
  const executable = runtime.execPath.trim();
  if (!executable) throw new Error('Cannot resolve the running gbrain executable');
  if (!isBunExecutable(executable)) return [executable, ...args];

  const main = runtime.main.trim();
  if (!main || /(?:^|[\\/])bun:test$/i.test(main)) {
    throw new Error('Cannot resolve the running gbrain source entrypoint');
  }
  return [executable, main, ...args];
}

function exactArray(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function validTransition(transition: UpgradeChildTransition, snapshotBrainId: string): boolean {
  return UUID_RE.test(transition.transitionId)
    && BRAIN_ID_RE.test(snapshotBrainId)
    && transition.brainId === snapshotBrainId
    && transition.fromVersion.length > 0
    && transition.fromVersion.length <= 128
    && transition.toVersion === VERSION;
}

/**
 * Mint a narrowly bound bearer for one same-release migration child.
 * Only the bound post-upgrade call chain supplies UpgradeChildTransition.
 */
export function mintUpgradeChildCapability(
  options: MintUpgradeChildCapabilityOptions,
): MintedUpgradeChildCapability {
  if (!validTransition(options.transition, options.snapshotBrainId)) fail();
  const configDir = resolve(options.configDir);
  if (configDir !== options.configDir || basename(configDir) !== '.gbrain') fail();

  const rawArgs = [...options.rawArgs];
  if (!rawArgs.every(value => typeof value === 'string')) fail();
  const invocation = [...options.invocation];
  if (invocation.length === 0 || !invocation.every(value => typeof value === 'string')) fail();

  const executable = invocation[0]!;
  const bun = isBunExecutable(executable);
  const main = bun ? invocation[1] : null;
  const invocationArgs = invocation.slice(bun ? 2 : 1);
  if ((bun && (!main || main.trim().length === 0)) || !exactArray(invocationArgs, rawArgs)) fail();

  const nowMs = options.nowMs ?? Date.now();
  const parentPid = options.parentPid ?? process.pid;
  if (!Number.isSafeInteger(nowMs) || nowMs <= 0 || !Number.isSafeInteger(parentPid) || parentPid <= 0) fail();

  const capabilityId = randomUUID();
  const token = randomBytes(32).toString('base64url');
  const unsignedRecord: UnsignedUpgradeChildCapabilityRecord = {
    schema_version: 1,
    capability_id: capabilityId,
    token_sha256: createHash('sha256').update(token).digest('hex'),
    transition_id: options.transition.transitionId,
    brain_id: options.transition.brainId,
    from_version: options.transition.fromVersion,
    to_version: options.transition.toVersion,
    release_version: VERSION,
    executable,
    main,
    raw_argv: rawArgs,
    parent_pid: parentPid,
    issued_at_ms: nowMs,
    expires_at_ms: nowMs + UPGRADE_CHILD_CAPABILITY_TTL_MS,
  };
  const record: UpgradeChildCapabilityRecord = {
    ...unsignedRecord,
    binding_hmac_sha256: createHmac('sha256', token)
      .update(JSON.stringify(unsignedRecord))
      .digest('hex'),
  };
  const path = resolve(configDir, `upgrade-child-capability-${capabilityId}.json`);
  writeOwnedStateFileAtomic(path, `${JSON.stringify(record)}\n`, MAX_CAPABILITY_BYTES, configDir);
  return {
    path,
    token,
    env: {
      [UPGRADE_CHILD_CAPABILITY_FILE_ENV]: path,
      [UPGRADE_CHILD_CAPABILITY_TOKEN_ENV]: token,
    },
  };
}

function parseRecord(raw: string): UpgradeChildCapabilityRecord {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { fail(); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail();
  const record = value as Partial<UpgradeChildCapabilityRecord>;
  if (record.schema_version !== 1
    || typeof record.capability_id !== 'string' || !UUID_RE.test(record.capability_id)
    || typeof record.token_sha256 !== 'string' || !TOKEN_HASH_RE.test(record.token_sha256)
    || typeof record.binding_hmac_sha256 !== 'string' || !TOKEN_HASH_RE.test(record.binding_hmac_sha256)
    || typeof record.transition_id !== 'string' || !UUID_RE.test(record.transition_id)
    || typeof record.brain_id !== 'string' || !BRAIN_ID_RE.test(record.brain_id)
    || typeof record.from_version !== 'string' || record.from_version.length === 0 || record.from_version.length > 128
    || record.to_version !== VERSION
    || record.release_version !== VERSION
    || typeof record.executable !== 'string' || record.executable.length === 0
    || !(record.main === null || typeof record.main === 'string')
    || !Array.isArray(record.raw_argv) || !record.raw_argv.every(arg => typeof arg === 'string')
    || !Number.isSafeInteger(record.parent_pid) || Number(record.parent_pid) <= 0
    || !Number.isSafeInteger(record.issued_at_ms) || Number(record.issued_at_ms) <= 0
    || !Number.isSafeInteger(record.expires_at_ms)) fail();
  return record as UpgradeChildCapabilityRecord;
}

function unsignedRecordFrom(
  record: UpgradeChildCapabilityRecord,
): UnsignedUpgradeChildCapabilityRecord {
  return {
    schema_version: record.schema_version,
    capability_id: record.capability_id,
    token_sha256: record.token_sha256,
    transition_id: record.transition_id,
    brain_id: record.brain_id,
    from_version: record.from_version,
    to_version: record.to_version,
    release_version: record.release_version,
    executable: record.executable,
    main: record.main,
    raw_argv: record.raw_argv,
    parent_pid: record.parent_pid,
    issued_at_ms: record.issued_at_ms,
    expires_at_ms: record.expires_at_ms,
  };
}

function consumeClaimedCapability(
  rawArgs: readonly string[],
  token: string,
  claimedPath: string,
  originalBasename: string,
  runtime: UpgradeChildRuntime,
  nowMs: number,
): void {
  const raw = withOwnedStateReadPolicy(false, () =>
    readOwnedStateFile(claimedPath, MAX_CAPABILITY_BYTES, gbrainPath()));
  const record = parseRecord(raw);
  const basenameMatch = CAPABILITY_BASENAME_RE.exec(originalBasename);
  if (!basenameMatch || basenameMatch[1]?.toLowerCase() !== record.capability_id.toLowerCase()) fail();

  const expectedInvocation = resolveUpgradeChildInvocation(rawArgs, runtime);
  const executable = expectedInvocation[0]!;
  const bun = isBunExecutable(executable);
  const main = bun ? expectedInvocation[1] : null;
  if (record.executable !== executable
    || record.main !== main
    || !exactArray(record.raw_argv, rawArgs)
    || record.parent_pid !== runtime.parentPid
    || record.issued_at_ms > nowMs + MAX_CLOCK_SKEW_MS
    || record.expires_at_ms <= nowMs
    || record.expires_at_ms <= record.issued_at_ms
    || record.expires_at_ms - record.issued_at_ms > UPGRADE_CHILD_CAPABILITY_TTL_MS) fail();

  if (!TOKEN_RE.test(token)) fail();
  const actualHash = createHash('sha256').update(token).digest();
  const expectedHash = Buffer.from(record.token_sha256, 'hex');
  if (expectedHash.length !== actualHash.length || !timingSafeEqual(actualHash, expectedHash)) fail();
  const actualBinding = createHmac('sha256', token)
    .update(JSON.stringify(unsignedRecordFrom(record)))
    .digest();
  const expectedBinding = Buffer.from(record.binding_hmac_sha256, 'hex');
  if (expectedBinding.length !== actualBinding.length
    || !timingSafeEqual(actualBinding, expectedBinding)) fail();
}

/**
 * Atomically claim, validate, and consume a one-shot migration-child bearer.
 * Absence means ordinary CLI gating. Partial or invalid ambient capability
 * state is always fatal, even if the ordinary upgrade state is healthy.
 */
export function consumeUpgradeChildCapability(
  rawArgs: readonly string[],
  options: ConsumeUpgradeChildCapabilityOptions = {},
): boolean {
  const env = options.env ?? process.env;
  const pathValue = env[UPGRADE_CHILD_CAPABILITY_FILE_ENV];
  const token = env[UPGRADE_CHILD_CAPABILITY_TOKEN_ENV];
  if (pathValue === undefined && token === undefined) return false;
  if (!pathValue || !token) fail();

  let configDir: string;
  let capabilityPath: string;
  try {
    configDir = resolve(gbrainPath());
    capabilityPath = resolve(pathValue);
  } catch {
    fail();
  }
  const originalBasename = basename(capabilityPath);
  if (capabilityPath !== pathValue
    || dirname(capabilityPath) !== configDir
    || !CAPABILITY_BASENAME_RE.test(originalBasename)) fail();

  // rename is the single-use claim: concurrent/replayed consumers cannot both
  // read the bearer. Validation follows under no-repair owned-state policy.
  const claimedPath = resolve(configDir, `.upgrade-child-consuming-${process.pid}-${randomUUID()}.json`);
  try {
    renameSync(capabilityPath, claimedPath);
  } catch {
    fail();
  }
  try {
    const runtime = options.runtime ?? {
      execPath: process.execPath,
      main: Bun.main,
      parentPid: process.ppid,
    };
    consumeClaimedCapability(
      rawArgs,
      token,
      claimedPath,
      originalBasename,
      runtime,
      options.nowMs ?? Date.now(),
    );
  } catch {
    // Owned-state diagnostics contain the local capability path. Collapse all
    // validation failures before child stderr can become durable evidence.
    fail();
  } finally {
    try { unlinkSync(claimedPath); } catch { /* one-shot even on rejection */ }
  }

  delete env[UPGRADE_CHILD_CAPABILITY_FILE_ENV];
  delete env[UPGRADE_CHILD_CAPABILITY_TOKEN_ENV];
  return true;
}
