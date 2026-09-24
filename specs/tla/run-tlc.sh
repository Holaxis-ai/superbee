#!/usr/bin/env bash
# Model-check TLA+ configs with TLC and compare each result with the config's first
# `\* expect:` line. "pass" requires a complete run with no error; any other value is the
# counterexample TLC must report, matched against its "Error: <expect>" line.
#
# Usage: TLA2TOOLS=/path/to/tla2tools.jar specs/tla/run-tlc.sh [config.cfg ...]
# With no arguments every *.cfg under specs/tla is checked. A config named <Module>.<variant>.cfg
# runs against MC<Module>.tla when that file exists, otherwise against <Module>.tla.
set -euo pipefail

jar=${TLA2TOOLS:?set TLA2TOOLS to the path of tla2tools.jar}
jar=$(cd "$(dirname "$jar")" && pwd)/$(basename "$jar")
root=$(cd "$(dirname "$0")" && pwd)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

if [ "$#" -eq 0 ]; then
  while IFS= read -r found; do set -- "$@" "$found"; done < <(find "$root" -name '*.cfg' | sort)
fi

failures=0
for cfg in "$@"; do
  dir=$(cd "$(dirname "$cfg")" && pwd)
  name=$(basename "$cfg" .cfg)
  module=${name%%.*}
  spec=$module.tla
  if [ -f "$dir/MC$module.tla" ]; then spec=MC$module.tla; fi
  expect=$(sed -n 's/^\\\* expect: //p' "$cfg" | head -n 1)
  if [ -z "$expect" ]; then
    echo "FAIL $name: no '\\* expect:' line"
    failures=$((failures + 1))
    continue
  fi

  log=$work/$name.log
  started=$(date +%s)
  status=0
  (cd "$dir" && java -XX:+UseParallelGC -cp "$jar" tlc2.TLC -workers auto -deadlock \
    -metadir "$work/$name.states" -config "$name.cfg" "$spec") > "$log" 2>&1 || status=$?
  elapsed=$(( $(date +%s) - started ))
  states=$(grep -E 'distinct states found' "$log" | tail -n 1 | sed -E 's/.* ([0-9]+) distinct states found.*/\1/')

  if [ "$expect" = pass ]; then
    if [ "$status" -eq 0 ] && grep -q '^Model checking completed. No error has been found.' "$log"; then
      echo "ok   $name: no error, ${states:-?} distinct states, ${elapsed}s"
      continue
    fi
  elif [ "$status" -ne 0 ] && grep -qF "Error: $expect" "$log"; then
    echo "ok   $name: expected counterexample ($expect), ${elapsed}s"
    continue
  fi
  echo "FAIL $name: expected '$expect', TLC exited $status after ${elapsed}s"
  tail -n 80 "$log"
  failures=$((failures + 1))
done

if [ "$failures" -ne 0 ]; then
  echo "$failures config(s) did not produce their expected result"
  exit 1
fi
