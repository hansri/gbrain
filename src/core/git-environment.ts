/**
 * Git subprocess environment boundaries.
 *
 * Git accepts repository/object/config overrides through inherited `GIT_*`
 * variables. That is useful interactively but unsafe for a sync authority: a
 * launcher can otherwise redirect `HEAD`, graft history, inject config, or
 * swap the object database while the process still prints a plausible SHA.
 */

const AUTHORITY_ENV_ALLOWLIST = [
  'PATH',
  'HOME',
  'TMPDIR',
  'TMP',
  'TEMP',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'SYSTEMROOT',
] as const;

/** Remove every inherited Git control variable, then add explicit values. */
export function cleanInheritedGitEnvironment(
  base: NodeJS.ProcessEnv = process.env,
  additions: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  const clean: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(base)) {
    if (!key.startsWith('GIT_') && value !== undefined) clean[key] = value;
  }
  return { ...clean, ...additions };
}

/**
 * Minimal environment for local object/commit authority reads.
 *
 * Local repo config remains available (needed for object-format metadata), but
 * system/global/config-parameter injection and every repository/object override
 * are disabled. Credential and network variables are intentionally absent:
 * authority reads never contact a remote.
 */
export function gitAuthorityEnvironment(
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of AUTHORITY_ENV_ALLOWLIST) {
    const value = base[key];
    if (value !== undefined) env[key] = value;
  }
  env.GIT_NO_REPLACE_OBJECTS = '1';
  env.GIT_CONFIG_NOSYSTEM = '1';
  env.GIT_CONFIG_GLOBAL = '/dev/null';
  env.GIT_TERMINAL_PROMPT = '0';
  env.GIT_OPTIONAL_LOCKS = '0';
  return env;
}
