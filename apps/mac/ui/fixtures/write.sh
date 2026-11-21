#!/bin/sh
# Writes fixtures/workbench/{state,responses}.json from workbench.ts (see
# fixtures.test.ts): the app runs on them with
# VIBEVALLEY_FAKE_SERVER=ui/fixtures/workbench. Needs nsh on PATH (.tools/bin).
set -eu
cd "$(dirname "$0")/.."
out=fixtures/workbench
mkdir -p "$out"
nsh test fixtures/fixtures.test.ts 2>&1 | sed -n 's/^.*@@\([a-z]*\.json\) \(.*\)$/\1 \2/p' | while read -r name json; do
  printf '%s\n' "$json" | python3 -m json.tool --no-ensure-ascii > "$out/$name"
done
ls "$out"
