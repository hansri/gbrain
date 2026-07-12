#!/usr/bin/env bash
# scripts/run-unit-shard.sh
#
# Runs the unit suite for a single shard. Excludes test/e2e/* (those are run
# by scripts/run-e2e.sh in the E2E phase). When SHARD=N/M is set, keeps every
# M-th file starting at index N (1-indexed); otherwise runs the full unit set.
#
# Used by scripts/ci-local.sh to partition the unit set four ways inside the
# runner container, paired with a dedicated postgres shard for the downstream
# E2E phase.
#
# By default, each shard is one `bun test` invocation. Callers with a tight
# memory ceiling can opt into deterministic, sequential process batches with
# `--batch-size=N`; each Bun process exits before the next batch starts.

set -euo pipefail

cd "$(dirname "$0")/.."

# --max-concurrency=N is forwarded to `bun test`. v0.26.4: invoked by
# run-unit-parallel.sh; safe to call without (defaults to bun's default cap).
MAX_CONC=""
BATCH_SIZE=""
BATCH_REQUESTED=0
DRY_RUN=0
while [ $# -gt 0 ]; do
  case "$1" in
    --max-concurrency)
      [ $# -ge 2 ] || { echo "ERROR: --max-concurrency requires a value" >&2; exit 2; }
      MAX_CONC="$2"; shift 2
      ;;
    --max-concurrency=*) MAX_CONC="${1#*=}"; shift ;;
    --batch-size)
      [ $# -ge 2 ] || { echo "ERROR: --batch-size requires a value" >&2; exit 2; }
      BATCH_REQUESTED=1; BATCH_SIZE="$2"; shift 2
      ;;
    --batch-size=*) BATCH_REQUESTED=1; BATCH_SIZE="${1#*=}"; shift ;;
    --dry-run-list) DRY_RUN=1; shift ;;
    *) echo "ERROR: unknown arg: $1" >&2; exit 2 ;;
  esac
done

if [ "$BATCH_REQUESTED" = "1" ]; then
  if ! printf '%s' "$BATCH_SIZE" | grep -qE '^[1-9][0-9]*$' || \
     [ "${#BATCH_SIZE}" -gt 5 ] || [ "$BATCH_SIZE" -gt 10000 ]; then
    echo "ERROR: invalid --batch-size value: $BATCH_SIZE (expected integer 1..10000)" >&2
    exit 2
  fi
fi

# All non-E2E test files, sorted for deterministic shard splits.
# Tier 4: *.slow.test.ts is "always-slow" (cold-path correctness checks);
# *.serial.test.ts is "concurrency-unsafe" (file-wide shared state). Both
# are excluded from the fast loop. Slow runs via `bun run test:slow`; serial
# runs via scripts/run-serial-tests.sh after the parallel pass.
# Use while-read to stay portable to macOS bash 3.2 (no mapfile).
all_files=()
while IFS= read -r f; do
  all_files+=("$f")
done < <(find test -name '*.test.ts' -not -path 'test/e2e/*' -not -name '*.slow.test.ts' -not -name '*.serial.test.ts' | sort)

files=()
if [ -n "${SHARD:-}" ]; then
  shard_n=${SHARD%/*}
  shard_m=${SHARD#*/}
  if ! printf '%s' "$shard_n" | grep -qE '^[0-9]+$' || \
     ! printf '%s' "$shard_m" | grep -qE '^[0-9]+$' || \
     [ "$shard_n" -lt 1 ] || [ "$shard_m" -lt 1 ] || [ "$shard_n" -gt "$shard_m" ]; then
    echo "ERROR: invalid SHARD=$SHARD (expected N/M with 1<=N<=M, both integers)" >&2
    exit 1
  fi
  i=0
  for f in "${all_files[@]}"; do
    if [ $((i % shard_m + 1)) -eq "$shard_n" ]; then
      files+=("$f")
    fi
    i=$((i + 1))
  done
else
  files=("${all_files[@]}")
fi

if [ "${#files[@]}" -eq 0 ]; then
  echo "[unit-shard ${SHARD:-(unsharded)}] no files; exiting clean."
  exit 0
fi

if [ "$DRY_RUN" = "1" ]; then
  printf '%s\n' "${files[@]}"
  exit 0
fi

echo "[unit-shard ${SHARD:-(unsharded)}] running ${#files[@]} files"
if [ "$BATCH_REQUESTED" = "1" ]; then
  total=${#files[@]}
  batch_count=$(( (total + BATCH_SIZE - 1) / BATCH_SIZE ))
  batch_n=1
  offset=0
  echo "[unit-shard ${SHARD:-(unsharded)}] bounded mode: ${batch_count} sequential batches (max ${BATCH_SIZE} files each)"
  while [ "$offset" -lt "$total" ]; do
    batch=("${files[@]:offset:BATCH_SIZE}")
    echo "[unit-shard ${SHARD:-(unsharded)}] batch ${batch_n}/${batch_count}: ${#batch[@]} files"
    if [ -n "$MAX_CONC" ]; then
      bun test --max-concurrency="$MAX_CONC" --timeout=60000 "${batch[@]}"
    else
      bun test --timeout=60000 "${batch[@]}"
    fi
    offset=$((offset + BATCH_SIZE))
    batch_n=$((batch_n + 1))
  done
  exit 0
fi

if [ -n "$MAX_CONC" ]; then
  exec bun test --max-concurrency="$MAX_CONC" --timeout=60000 "${files[@]}"
fi
exec bun test --timeout=60000 "${files[@]}"
