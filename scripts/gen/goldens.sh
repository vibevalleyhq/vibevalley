#!/bin/sh
set -eu

# Rust (crates/vibevalley-artifact, crates/vibevalley-pkm) is the single source of truth;
# the committed JSON fixtures under tests/golden and golden/ remain as Rust regression suites.
case "${1-}" in
    ''|--check)
        cargo test -p vibevalley-artifact --test golden
        cargo test -p vibevalley-pkm
        ;;
    *) echo "Usage: vp run goldens [--check]" >&2; exit 2 ;;
esac
