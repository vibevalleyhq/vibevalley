#!/bin/sh
# Regenerates src/generated/ from this repo's zod schemas, and the artifact
# and pkm goldens from their TS engines (vp run protocol:rust). The
# projection goldens and the orchestrator's words are the Rust server's own.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
copy=$("$here/prepare.sh")
out=$here/../src/generated
(cd "$copy" && ./node_modules/.bin/vpx "$here/gen.ts" "$copy" "$out")
rustfmt --edition 2024 "$out"/*.rs
crates=$(cd "$here/../.." && pwd)
(cd "$copy" && ./node_modules/.bin/vpx "$crates/vibevalley-artifact/gen/artifact.ts" "$copy" "$crates/vibevalley-artifact")
(cd "$crates/.." && ./node_modules/.bin/vpx crates/vibevalley-pkm/golden/gen.ts crates/vibevalley-pkm/golden && ./node_modules/.bin/vpx crates/vibevalley-pkm/golden/graph.ts crates/vibevalley-pkm/golden)
