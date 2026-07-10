import { realpathSync } from 'node:fs';
import { normalize, resolve } from 'node:path';

/**
 * Canonical filesystem identity for a registered source checkout.
 *
 * Existing paths resolve symlinks through realpath. Missing clone targets are
 * still made absolute and normalized so registration can happen before clone
 * creation. Relative legacy rows resolve against the caller working directory,
 * matching the historical CLI interpretation of `--path .`.
 */
export function canonicalSourcePath(input: string, baseDir: string = process.cwd()): string {
  const absolute = normalize(resolve(baseDir, input));
  try {
    return realpathSync.native(absolute);
  } catch {
    return absolute;
  }
}
