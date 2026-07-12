# Upgrades and Auto-Update Notifications

## Goal

Users get notified of new GBrain features conversationally, and the agent walks them through upgrading with post-upgrade migrations that make the new version actually work.

## What the User Gets

Without this: GBrain ships updates but nobody knows. The user stays on an old
version with stale skills and missing features. Or worse, someone runs
`gbrain upgrade` but skips the post-upgrade steps, leaving new code with old
agent behavior.

With this: the agent checks for updates daily, explains the useful changes,
waits for explicit permission, then follows the release's verified upgrade
boundary. Inline-safe releases use the normal flow. Supervised releases pause
at one clear operator action before any binary or database change.

## Self-upgrade modes (v0.42)

gbrain now stays current the way gstack does: it rides invocation frequency. A
throttled, cache-read-only check runs at the start of every `gbrain` invocation
(CLI and MCP) and emits an `UPGRADE_AVAILABLE <old> <new>` marker on stderr. No
host cron required — every agent kind (Claude Code, Codex, OpenClaw, Hermes, the
`gbrain serve` host behind a Perplexity thin client) discovers version drift
without another scheduler. Whether it may apply that release is a separate,
fail-closed decision. The behavior is governed by one file-plane config key,
`self_upgrade.mode`:

| Mode | Behavior | Who it's for |
|------|----------|--------------|
| `notify` (default) | Emit the marker + a 4-option prompt; never apply without confirmation. | Interactive installs / anyone with a human in the loop. |
| `auto` (opt-in) | Apply a locally approved inline-safe target silently, but ONLY during quiet hours, ONLY when the brain is idle, doctor-gated, and never re-trying a known-bad version. Supervised or unknown future targets pause. | Headless / always-on installs (autopilot daemon, the `gbrain serve` host). |
| `off` | Never check. | Air-gapped / pinned installs. |

Enable bounded auto-upgrades on an always-on install with one line:

```bash
gbrain config set self_upgrade.mode auto
```

`auto` is deliberately NOT a default anywhere — it's an explicit autonomy grant,
because applying code from GitHub unattended is, by design, remote code
execution. The trust model is TLS + GitHub (same as `gbrain upgrade`);
signature verification is a tracked follow-up. A manual request still follows
the target release's migration boundary.

New binaries carry a machine-readable local policy because a running process
cannot safely discover or trust migration prose that ships only inside a new
release. Binaries containing that policy block silent/inline promotion at
v0.42.59.0 and fail closed for every unknown future target unless they
explicitly allowlist it as inline-safe.

For an inline-safe release, every entry point first resolves one exact version,
checks it against that local policy, passes the same version through the
package/tag/asset swap, and verifies the replacement reports exactly that
version. Direct `bun update`, `clawhub update`, moving-branch checkouts, and
unverified downloads are not supported upgrade paths because they can change
the target after approval.

That local policy is not retroactive: v0.42.58-era binaries do not contain it.
The release workflow therefore publishes v0.42.59.0 and unknown later targets
as prereleases with `make_latest=false`. They must stay out of GitHub's normal
`latest` channel until a safe compatibility bridge is deliberately shipped.
This intentionally trades hands-off availability for recoverability.

## Implementation

### The Check (cron-initiated)

```
check_for_update():
  result = run("gbrain check-update --json")

  if not result.update_available:
    exit_silently()  // do NOT message the user

  // Sell the upgrade — lead with what they can DO, not what changed
  message = compose_upgrade_message(
    current: result.current_version,
    latest: result.latest_version,
    changelog: result.changelog
  )
  send_to_user(message, respect_quiet_hours=true)
```

### The Upgrade Message

Sell the upgrade. The user should feel "hell yeah, I want that." Lead with
what they can DO now that they couldn't before, not what files changed.

```
> **GBrain v0.5.0 is available** (you're on v0.4.0)
>
> What's new:
> - Your brain never falls behind. Live sync keeps the vector DB current
>   automatically, so edits show up in search within minutes
> - New verification runbook catches silent failures before they bite you
> - New installs set up live sync automatically. No more manual setup step
>
> Want me to upgrade? I'll update everything and refresh my playbook.
>
> (Reply **yes** to upgrade, **not now** to skip, **weekly** to check
> less often, or **stop** to turn off update checks)
```

### Handling Responses

| User says | Action |
|-----------|--------|
| yes / y / sure / ok / do it / upgrade | Run the full upgrade flow (below) |
| not now / later / skip / snooze | Acknowledge, check again next cycle |
| weekly | Store preference, switch cron to weekly |
| daily | Store preference, switch cron back to daily |
| stop / unsubscribe / no more | Disable the cron. Tell user how to resume |

**In `notify` mode (the default), never auto-upgrade — always wait for explicit
confirmation.** The `auto` mode (opt-in, see "Self-upgrade modes" above) is the
only path that can apply without a prompt, and only for a locally approved
inline-safe target under its conservative gates (quiet hours + idle +
doctor-gate). This per-cron-prompt flow is the `notify` experience.

### The Full Upgrade Flow (after user says yes)

```
full_upgrade():
  // Step 1: Resolve the exact version range and read migration guides FIRST
  migrations = read_local_verified_migration_guides(old_version, new_version)

  // Step 2: Respect release-specific cutover boundaries
  if migrations.require_supervised_staged_release:
    stop_services_and_writers()
    backup_database_and_canonical_plus_legacy_state_together()
    staged = operator_verified_immutable_new_binary()
    run(staged, "upgrade-preflight --json")
    repair_only_with_explicit_operator_choice()
    run(staged, "apply-migrations --yes --non-interactive")
    run(staged, "doctor")
    promote_and_restart_only_when_green()
  else:
    target = resolve_exact_latest_release_before_mutation()
    run("gbrain upgrade", "--target", target)

  // Step 3: Re-read all updated skills
  for skill in find("skills/*/SKILL.md"):
    read_and_internalize(skill)  // updated skills = better agent behavior

  // Step 4: Re-read production reference docs
  read("docs/GBRAIN_SKILLPACK.md")
  read("docs/GBRAIN_RECOMMENDED_SCHEMA.md")

  // Step 5: Execute remaining non-schema migration directives
  for version in range(old_version, new_version):
    migration = find(f"skills/migrations/v{version}.md")
    if migration exists:
      read_and_execute(migration)  // in order, don't skip

  // Step 6: Schema sync — suggest new, respect declined
  state = read("~/.gbrain/update-state.json")
  for recommendation in new_schema_recommendations:
    if recommendation not in state.declined:
      suggest_to_user(recommendation)
  update(state, new_choices)

  // Step 7: Report what changed
  summarize_to_user(actions_taken)
```

### Migration Files

Migration files live at `skills/migrations/vX.Y.Z.md`. They contain agent
instructions (not scripts) for post-upgrade actions that make the new version
work for existing users. Example: v0.5.0 migration sets up live sync and
runs the verification runbook.

The agent reads migration files in version order and executes them step by
step. Without migrations, the agent has new code but the user's environment
hasn't changed.

### Cron Registration

```
Name: gbrain-update-check
Default schedule: 0 9 * * * (daily 9 AM)
Weekly schedule: 0 9 * * 1 (Monday 9 AM)
Prompt: "Run gbrain check-update --json. If update_available is true,
  summarize the changelog and message me asking if I'd like to upgrade.
  If false, stay silent."
```

### Frequency Preferences

Default: daily. Store in agent memory as `gbrain_update_frequency: daily|weekly|off`.
Also persist in `~/.gbrain/update-state.json` so it survives agent context resets.

### Standalone Skillpack Users

If you loaded this SKILLPACK directly (copied or read from GitHub) without
installing gbrain, you can still stay current. Both GBRAIN_SKILLPACK.md and
GBRAIN_RECOMMENDED_SCHEMA.md have version markers:

```bash
curl -s https://raw.githubusercontent.com/garrytan/gbrain/master/docs/GBRAIN_SKILLPACK.md | head -1
# Returns: <!-- skillpack-version: X.Y.Z -->
```

If the remote version is newer, fetch the full file and replace your local
copy. Set up a weekly cron to check automatically.

## Tricky Spots

1. **In `notify` mode, never auto-install.** The upgrade waits for the user's
   explicit "yes." Even if the check detects an update and the changelog looks
   great, the agent messages the user and waits. The `auto` mode (opt-in) exists
   for headless/always-on installs where there's no human to prompt — it applies
   only during quiet hours, only when idle, doctor-gated, never retrying a
   known-bad version. Don't enable `auto` on an interactive workstation; the
   prompt-first `notify` flow is the right default there.

   The running binary's local release policy blocks supervised and unknown
   future targets before the inline updater runs. Stop at one operator
   intervention; do not silently replace a matched database/state backup or
   new-binary preflight with an inline update.

2. **Migration files are agent instructions, not scripts.** They tell the agent
   what to do step by step in plain language. They are NOT bash scripts to
   execute blindly. The agent reads them, understands the context, and adapts
   to the user's specific environment (e.g., skip a step if the user already
   has live sync configured).

3. **check-update should run on a daily cron.** Don't rely on the user
   remembering to check for updates. The cron runs `gbrain check-update --json`
   daily at 9 AM (respecting quiet hours). If there's nothing new, it stays
   completely silent. The user only hears about updates when there IS something
   worth upgrading to.

## How to Verify

1. **Run check-update and verify detection.** Execute
   `gbrain check-update --json`. Verify it returns the current version and
   correctly reports whether an update is available. If `update_available`
   is false, verify the version matches the latest release on GitHub.

2. **Verify migration files are readable.** List `skills/migrations/` and
   check that each file follows the naming convention `vX.Y.Z.md`. Open one
   and verify it contains step-by-step agent instructions, not raw scripts.
   The agent should be able to read and execute each step.

3. **Test the full upgrade flow end-to-end.** If an update is available, say
   "yes" and watch the agent execute the full flow: upgrade, re-read skills,
   run migrations, sync schema, report. Verify each step completes and the
   agent reports what changed.

---

*Part of the [GBrain Skillpack](../GBRAIN_SKILLPACK.md).*
