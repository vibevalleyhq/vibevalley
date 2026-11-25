#!/usr/bin/env bash
# Syncs compiled runtime diorama assets from vibevalley-assets/dist/diorama into assets/diorama/.
# Keeps raw art, preview scenes, compiler source, and scratch outputs in the asset repository.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/.." && pwd)"
assets_repo="${VIBEVALLEY_ASSETS_REPO:-$root/../vibevalley-assets}"

if [ ! -d "$assets_repo" ]; then
  echo "Source asset repository not found: $assets_repo" >&2
  echo "Clone vibevalley-assets beside vibevalley or set VIBEVALLEY_ASSETS_REPO." >&2
  exit 1
fi
assets_repo="$(cd "$assets_repo" && pwd)"

build=0
for arg in "$@"; do
  case "$arg" in
    --build) build=1 ;;
    *)
      echo "Unknown argument: $arg" >&2
      exit 1
      ;;
  esac
done

dist="$assets_repo/dist/diorama"
if [ "$build" -eq 1 ] || [ ! -f "$dist/manifest.json" ] || [ ! -f "$dist/meshes.bin" ]; then
  echo "Compiling diorama assets in $assets_repo..."
  (cd "$assets_repo" && cargo run --release -p diorama-compiler)
fi

for req in manifest.json meshes.bin lights.json foley.json; do
  if [ ! -f "$dist/$req" ]; then
    echo "Missing compiled diorama file: $dist/$req" >&2
    exit 1
  fi
done

target="$root/assets/diorama"
rm -rf "$target"
mkdir -p "$target/print" "$target/stock"

cp "$dist/manifest.json" "$target/manifest.json"
cp "$dist/meshes.bin" "$target/meshes.bin"
cp "$dist/lights.json" "$target/lights.json"
cp "$dist/foley.json" "$target/foley.json"

copy_dir() {
  local sub="$1"
  if [ -d "$dist/$sub" ]; then
    for file in "$dist/$sub"/*.png "$dist/$sub"/*.vvtex; do
      [ -f "$file" ] || continue
      cp "$file" "$target/$sub/$(basename "$file")"
    done
  fi
}

copy_dir "print"
copy_dir "stock"

count="$(find "$target" -type f | wc -l | tr -d ' ')"
size="$(du -sh "$target" | awk '{print $1}')"
echo "Synced $count compiled diorama runtime files ($size) into assets/diorama/"
