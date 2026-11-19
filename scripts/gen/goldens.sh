#!/bin/sh
set -eu

artifact=crates/vibevalley-artifact
pkm=crates/vibevalley-pkm/golden
case "${1-}" in
    '') out=. ;;
    --check) out=$(mktemp -d); trap 'rm -rf "$out"' EXIT ;;
    *) echo "Usage: vp run goldens [--check]" >&2; exit 2 ;;
esac

mkdir -p "$out/$artifact/assets" "$out/$pkm"
vpx "$artifact/gen/artifact.ts" "$out/$artifact"
vpx "$pkm/gen.ts" "$out/$pkm"
vpx "$pkm/graph.ts" "$out/$pkm"

if [ "$out" != . ]; then
    for generated in "$out/$artifact/assets/shell.json" "$out/$artifact/tests/golden"/*.json "$out/$pkm"/*.json; do
        diff -u "${generated#"$out/"}" "$generated" || { echo "Fix: vp run goldens" >&2; exit 1; }
    done
    for saved in "$artifact/tests/golden"/*.json "$pkm"/*.json; do
        if [ -f "$saved" ] && [ ! -f "$out/$saved" ]; then
            echo "No generator writes $saved. Fix: remove the obsolete fixture." >&2
            exit 1
        fi
    done
fi
