#!/usr/bin/env bash
# Redraws sheets at the game's pixel density, several at once (gen.sh hd-<name>, from the plain sheet), skipping the
# ones already drawn; then `python3 process.py <name>...` cuts them into the game.
# Usage: ./hd_batch.sh <list file of sheet names> [how many at once, default 6]
cd "$(dirname "$0")"
list="$1"; at_once="${2:-6}"
grep -v '^\s*$' "$list" | while read -r name; do [ -f "raw/hd-$name.png" ] || echo "$name"; done |
  xargs -P "$at_once" -I{} sh -c './gen.sh "hd-{}" > "logs/hd-{}.run.txt" 2>&1; echo "hd-{}: $(tail -2 logs/hd-{}.run.txt | head -1)"'
echo "batch done"
