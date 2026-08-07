#!/usr/bin/env bash
# Runs every end-to-end smoke script against a running backend and reports a
# single verdict. Usage: bash scripts/smoke-all.sh [base-url]
#
# These scripts hit real Postgres and real Redis on purpose: the bugs they
# have actually caught (an empty JSON body 400ing, a bigint the driver could
# not serialise, a primary key that collided on duplicate usernames) were all
# invisible to unit tests.
set -uo pipefail

BASE="${1:-http://localhost:8787}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if ! curl -s -m 5 -o /dev/null "$BASE/health"; then
    echo "backend is not answering on $BASE"
    echo "start it with: cd backend && npx tsx src/main.ts"
    exit 1
fi

total_failed=0
declare -a summary=()

for script in "$HERE"/smoke-*.sh; do
    name="$(basename "$script")"
    # Skip self.
    [ "$name" = "smoke-all.sh" ] && continue

    echo
    echo "═══ $name ═══"
    output="$(bash "$script" "$BASE" 2>&1)"
    status=$?
    echo "$output"

    # Scripts report either "passed N, failed M" or "passed: N   failed: M".
    # Accept both rather than making every author match one house style, and
    # fall back to the exit code for anything that reports neither.
    line="$(echo "$output" | grep -E '^passed:? [0-9]+' | tail -1)"
    if [ -n "$line" ]; then
        summary+=("$name — $line")
        failed="$(echo "$line" | grep -oE 'failed:? *[0-9]+' | grep -oE '[0-9]+')"
        failed="${failed:-0}"
        total_failed=$((total_failed + failed))
    else
        summary+=("$name — exit $status (no summary line)")
        [ "$status" -eq 0 ] || total_failed=$((total_failed + 1))
    fi
done

echo
echo "═══ summary ═══"
for line in "${summary[@]}"; do
    echo "  $line"
done

echo
if [ "$total_failed" -eq 0 ]; then
    echo "all smoke suites passed"
else
    echo "$total_failed check(s) failed"
fi
[ "$total_failed" -eq 0 ]
