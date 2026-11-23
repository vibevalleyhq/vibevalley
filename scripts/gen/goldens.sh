#!/bin/sh
set -eu

# Rust (crates/core/src/artifact) is the single source of truth;
# the committed JSON fixtures under tests/golden remain as Rust regression suites.
case "${1-}" in
    ''|--check)
        cargo test -p vibevalley-core --test artifact_golden
        ;;
    *) echo "Usage: vp run goldens [--check]" >&2; exit 2 ;;
esac
