# Multi-source brains

**A single gbrain database can hold multiple knowledge repos.** Each one
is a `source`: a logical brain-within-the-brain with its own slug
namespace, its own sync state, and its own federation policy. The rest
of this guide walks the three canonical scenarios.

## The three scenarios

### 1. Unified knowledge recall (wiki + gstack)

You have a personal wiki and a `gstack` checkout. Both belong to you,
both are knowledge you want your agent to recall across. When you ask
"what did I learn about X?" you want the best hit whether it lives in
the wiki or in a gstack plan.

```bash
# Register the gstack source, federate so it joins cross-source search
gbrain sources add gstack --path ~/.gstack --federated

# Pin the directory so `gbrain sync` knows which source it's walking
cd ~/.gstack && gbrain sources attach gstack

# Initial sync
gbrain sync --source gstack

# Now `gbrain search "retry budgets"` returns hits from BOTH wiki and
# gstack. Each result includes source_id so the agent can cite properly.
```

Result: wiki pages and gstack plans are separate (different source_ids,
different slug namespaces) but share the search surface.

### 2. Purpose-separated brains (yc-media + garrys-list)

You run two completely different content pipelines on the same backend.
YC Media covers portfolio news and founder profiles. Garry's List is
personal writing. You explicitly DON'T want them mixed in search — YC
portfolio content leaking into essay searches is a bug, not a feature.

```bash
# Two sources, both isolated (federated=false)
gbrain sources add yc-media --path ~/yc-media --no-federated
gbrain sources add garrys-list --path ~/writing --no-federated

# Pin each checkout directory
(cd ~/yc-media && gbrain sources attach yc-media)
(cd ~/writing && gbrain sources attach garrys-list)

# Sync each independently
gbrain sync --source yc-media
gbrain sync --source garrys-list
```

Result: searching from neither directory returns the `default` source
(your main brain). Searching from inside `~/yc-media` returns only yc-
media hits. Searching from inside `~/writing` returns only garrys-list.
Federation is opt-in, not leaked.

To search across them explicitly on demand:

```bash
gbrain search "tech layoffs" --source yc-media,garrys-list
```

### 3. Mixed (wiki federated + sessions isolated)

Your main wiki is federated with a few trusted sources. Your session
transcripts (coming in v0.18) land in a separate isolated source so
they don't dominate every search result.

```bash
# Federated sources
gbrain sources add gstack --path ~/.gstack --federated

# Isolated source (future v0.18 — sessions use this shape today for ingest)
gbrain sources add sessions --path ~/.claude/sessions --no-federated
```

## Resolution priority

When any command needs to pick a source, gbrain walks this list (highest
first):

1. Explicit `--source <id>` flag.
2. `GBRAIN_SOURCE` environment variable.
3. `.gbrain-source` dotfile in CWD or any ancestor directory.
4. A registered source whose `local_path` contains the CWD (longest
   prefix wins for nested checkouts).
5. The brain-level default set via `gbrain sources default <id>`.
6. The seeded `default` source.

So inside `~/.gstack/plans/` on a brain that pinned `gstack` to
`~/.gstack` via `.gbrain-source`, `gbrain put-page` implicitly writes to
the `gstack` source. Outside any registered directory with no env/dotfile
set, it writes to the default.

## Federation flag

Every source row stores `config.federated: boolean` in its JSONB config.

| Value | Meaning |
|-------|---------|
| `true` | Source participates in unqualified `gbrain search "X"` results. |
| `false` (default for new sources) | Source only searched when explicitly named via `--source <id>` or qualified citation. |

The seeded `default` source is `federated=true` so pre-v0.17 brains
behave exactly as before — every page appears in search.

Flip later with `gbrain sources federate <id>` / `unfederate <id>`.

## Commands

Full subcommand reference:

```
gbrain sources add <id> --path <p> [--name <n>] [--federated|--no-federated]
                               Register a source. id: [a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?
gbrain sources list [--json]   List all sources with page counts + federation state.
gbrain sources remove <id> [--yes] [--dry-run] [--keep-storage]
                               Cascade-delete a source (pages, chunks, timeline).
gbrain sources rename <id> <new-name>
                               Change display name only; id is immutable.
gbrain sources default <id>    Set the brain-level default.
gbrain sources attach <id>     Write .gbrain-source in CWD (like kubectl context).
gbrain sources detach          Remove .gbrain-source from CWD.
gbrain sources federate <id>
gbrain sources unfederate <id>
```

## Citation format for agents

When agents receive multi-source results they MUST cite pages in
`[source-id:slug]` form. Example:

> You told me about the distillation protocol — see [wiki:topics/ai]
> and [gstack:plans/multi-repo] for where this came from.

The citation key is `sources.id` (immutable). Renaming a source via
`gbrain sources rename` changes the display name only; existing
citations keep working.

## Writing to a specific source

```bash
# Pass --source explicitly
gbrain put-page topics/ai ... --source wiki

# Or rely on the dotfile / env / CWD match
cd ~/.gstack && gbrain put-page plans/multi-repo ...
# → source auto-resolves to gstack
```

Reads span federated sources by default. Writes require a resolved
source (explicit, inferred, or default). The resolver never picks a
source silently when ambiguous — it errors with a clear fix.

## Durability: keep a brain repo in sync (auto-harden)

A long-lived agent that writes to a knowledge-wiki git repo needs three
things to never lose work: pull before it edits, push every write, and not
go stale while it sits idle. `gbrain sources harden` installs all of that,
idempotently. The moment you add a brain repo with a token, it runs
automatically:

```bash
# Clone + register a GitHub repo, then auto-harden it for durability.
# Use a fine-grained PAT scoped to just this repo.
gbrain sources add wiki --url https://github.com/you/brain-wiki.git --pat-file ~/.secrets/wiki-pat
#   → clones, then installs: local auto-push hook, a trusted CLI commit-push path,
#     always-on durability rules in AGENTS.md/RESOLVER.md, a 30-min pull cron,
#     and an owner-only GBrain credential store. Verifies push works before
#     declaring done.

# Run the same audit on an existing source any time (idempotent):
gbrain sources harden wiki --pat-file ~/.secrets/wiki-pat

# Pull on demand (the cron calls the --path form, which never opens the DB):
gbrain sources pull wiki

# Remove the durability scaffolding (also runs automatically on `sources remove`):
gbrain sources unharden wiki
```

What hardening guarantees:

- **Pull-first, conflict-safe.** Every pull is a divergence-safe rebase. A
  dirty working tree is skipped (your in-progress edits are never touched); a
  rebase conflict is aborted cleanly and flagged for attention, never left
  half-applied.
- **Push is never deferred.** The generated resolver instruction calls
  `gbrain sources commit-push` with the exact registered remote. It refuses
  unrelated pre-staged work, commits only explicit paths through an isolated
  index, preserves staging that arrives concurrently, and refuses success
  without a confirmed push. Hardening removes the retired repo executable;
  persistent mutation logic exists only in the installed trusted CLI.
- **No silent staleness.** A 30-minute background pull keeps an idle session
  current. It runs DB-free, so it never contends with a live brain for the
  PGLite single-writer lock.

Flags: `--no-cron` skips the scheduled pull, `--no-verify` skips the push
probe, `--dry-run` reports what would change, `--json` emits a machine
report, `--all` hardens every source with a remote (same-account only).
`--no-harden` on `sources add` opts out of auto-harden.

Security: executed mutation logic lives in the installed CLI, not pulled repo
code. The token lives in an owner-only store keyed by canonical remote path, so
two repositories on the same host cannot consume each other's credential.
Authenticated network operations reset repo/global credential helpers and Git
hooks, then opt into only that validated store. The token never appears in the
repo, the remote URL, logs, or the JSON report. For a self-hosted git server
reachable only over a filesystem path, set `GBRAIN_GIT_ALLOW_FILE_TRANSPORT=1`
(default is HTTPS-only).

## Upgrading an existing brain

The first hop from an older binary into v0.42.59.0 is a supervised cutover.
Stop every GBrain service, sync/import writer, and scheduled migration. Take a
matched recovery snapshot of the database and all GBrain state roots in use:
the canonical `.gbrain` directory plus any legacy `$GBRAIN_HOME` or
`$HOME/.gbrain` copies that still exist.

Stage the new release in an immutable directory without starting it. The old
binary does not contain `upgrade-preflight`, so do not treat its `gbrain
upgrade` wrapper as the safety gate for this first hop. Run the staged **new**
binary directly; replace the example path below with the actual release path:

```bash
/path/to/v0.42.59.0/gbrain upgrade-preflight --json
```

An `ok` result is the normal case. If conflicts are returned, identify the
page genuinely owned by each file path and keep it explicitly:

```bash
/path/to/v0.42.59.0/gbrain upgrade-preflight repair \
  --source <source-id> \
  --path <repo-relative-path> \
  --keep <legitimate-page-slug> \
  --yes
```

This preserves every page and clears `source_path` only on the competing
rows. Repeat the preflight until it exits 0 before applying migrations; the
ownership migration deliberately refuses to guess.

Postgres operators can use the equivalent read-only SQL for independent
verification:

```sql
SELECT source_id,
       source_path,
       array_agg(slug ORDER BY slug) AS owners
FROM pages
WHERE source_path IS NOT NULL
GROUP BY source_id, source_path
HAVING COUNT(*) > 1
ORDER BY source_id, source_path;
```

With services still stopped, apply and verify using only the staged new binary:

```bash
/path/to/v0.42.59.0/gbrain apply-migrations --yes --non-interactive
/path/to/v0.42.59.0/gbrain doctor
```

Promote the immutable release and restart services only after both commands are
green. Then run one `gbrain sync --all` reconciliation with the new binary.
Once a host is already on this hardened upgrade handoff, later releases may use
the normal `gbrain upgrade` flow unless their migration guide says otherwise.
v0.42.59.0 itself remains prerelease-only and outside GitHub's normal `latest`
channel because older updaters cannot consume its new local policy. Private/fork
deployments use the same manual staged sequence above.

The release stages file-object identity safely. Migration v123 adds the
composite `(source_id, storage_path)` index, while source-qualified object keys
prevent one source from overwriting another source's bytes. The legacy global
`storage_path` constraint remains in place during the canary so the immediately
previous binary's `ON CONFLICT(storage_path)` shape remains structurally
available for a deliberate rollback. This is not permission for an old agent
or service to keep serving or writing after promotion; all old processes stay
stopped. The constraint temporarily means two sources cannot create the exact same
logical `storage_path`; the second write fails closed. Retiring the legacy
constraint and enabling that final case is a separate post-canary migration,
after rollback evidence and source-qualified object-key adoption are green.

### Rollback boundary

When all migrations are complete and `gbrain doctor` is green, the legacy
global conflict key provides structural rollback compatibility only. Do not run
mixed versions or leave a previous-binary service online. Stop every writer
before changing binaries, and use the previous binary only during a deliberate
rollback that satisfies the state/database boundary below.

If migration state is `partial`, `wedged`, `ambiguous`, or has an unresolved
inflight fence, binary-only rollback is not supported. Restore the matched
pre-upgrade database and canonical/legacy GBrain state snapshot together with
the previous binary. Restoring only the executable can leave the migration
ledger and database describing different realities.

### Agent-facing stdio MCP profile

`gbrain serve` now starts with a source-bound routine profile. It exposes only
retrieval, chronology, link navigation, and the source-confined
`get_source_health` / `get_source_stats` tools. Whole-brain `get_health`,
`get_stats`, `get_status_snapshot`, and `get_brain_identity` are not present.
Set `GBRAIN_SOURCE` in the launcher to the one source that agent may read. A
caller-supplied `source_id` outside that source is rejected.

Launchers may narrow the routine surface further with comma-separated exact
names and scopes:

```bash
GBRAIN_SOURCE=example-source \
GBRAIN_MCP_STDIO_ALLOWED_TOOLS=query,search,get_page,get_timeline,get_links,get_source_health,get_source_stats \
GBRAIN_MCP_STDIO_ALLOWED_SCOPES=read \
gbrain serve
```

Unknown tool names are a startup error so renamed tools cannot silently remove
an intended capability. Startup logs the active profile, tool count, and a
non-secret policy fingerprint for drift monitoring. Ambient recent-fact
metadata is disabled by default; only explicitly set
`GBRAIN_MCP_STDIO_HOT_MEMORY=true` when that extra context is wanted.

The previous broad local MCP surface is available only through
`GBRAIN_MCP_STDIO_PROFILE=unsafe-local-maintenance`. Do not use that profile in
an always-on Hermes agent. Run destructive maintenance through a supervised
local operator or the direct CLI instead.

To add one:

```bash
gbrain sources add gstack --path ~/.gstack --federated
cd ~/.gstack && gbrain sources attach gstack && gbrain sync
```

Two commands. The existing default source is untouched.

## Not in v0.18.0

- Session transcript ingest (`.jsonl`, raised size cap, session
  PageType) — v0.18.
- Per-source retention/TTL (`gbrain sources prune`) — v0.18.
- ACL enforcement via caller-identity — v0.17.1.
- `gbrain sources import-from-github <url>` one-shot bootstrap — patch
  release after the core plumbing stabilizes.

All of these build on the `sources` primitive shipped here.
