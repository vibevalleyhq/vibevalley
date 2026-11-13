#!/bin/sh
# Regenerates src/generated/ and golden/ from this repo's zod schemas and
# apps/server's projection (vp run protocol:rust).
set -eu
here=$(cd "$(dirname "$0")" && pwd)
copy=$("$here/prepare.sh")
out=$here/../src/generated
(cd "$copy" && ./node_modules/.bin/vpx "$here/gen.ts" "$copy" "$out")
rustfmt --edition 2024 "$out"/*.rs
(cd "$copy" && ./node_modules/.bin/vpx "$here/golden.ts" "$copy" "$here/../golden")
crates=$(cd "$here/../.." && pwd)
(cd "$copy" && ./node_modules/.bin/vpx "$crates/vibevalley-server/gen/orchestrator.ts" "$copy" "$crates/vibevalley-server/assets/orchestrator")
(cd "$copy" && ./node_modules/.bin/vpx "$crates/vibevalley-artifact/gen/artifact.ts" "$copy" "$crates/vibevalley-artifact")
(cd "$crates/.." && ./node_modules/.bin/vpx crates/vibevalley-pkm/golden/gen.ts crates/vibevalley-pkm/golden && ./node_modules/.bin/vpx crates/vibevalley-pkm/golden/graph.ts crates/vibevalley-pkm/golden)
