#!/bin/sh
# A copy of this repo's packages/, apps/server and apps/web for gen.ts and
# golden.ts to import from, with every top-level schema const exported so
# gen.ts can name each one. node_modules are symlinked from the checkout.
#   crates/vibevalley-protocol/gen/prepare.sh [out dir]
set -eu
here=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$here/../../.." && pwd)
out=${1:-$repo/target/protocol-gen}
rm -rf "$out"
mkdir -p "$out"
(cd "$repo" && tar -c --exclude node_modules --exclude dist package.json tsconfig.base.json tsconfig.json packages apps/server apps/web) | tar -x -C "$out"
ln -s "$repo/node_modules" "$out/node_modules"
for d in "$repo"/packages/* "$repo"/apps/server "$repo"/apps/web; do
  rel=${d#"$repo"/}
  if [ -d "$d/node_modules" ] && [ -d "$out/$rel" ]; then ln -s "$d/node_modules" "$out/$rel/node_modules"; fi
done
find "$out/packages/protocol/src" -name '*schema.ts' -exec sed -i '' -E 's/^const ([A-Za-z_][A-Za-z0-9_]*)/export const \1/' {} +
echo "$out"
