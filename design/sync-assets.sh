#!/usr/bin/env bash
# Syncs lean Papertrails outputs from vibevalley-assets/dist/{brand,icons,engines,site,avatars,diorama}
# into vibevalley/assets/ and regenerates macOS app branding in apps/mac/resources/.
# Raw art, generators, and scratch renders stay strictly in vibevalley-assets.
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
with_avatars=0
with_diorama=0
for arg in "$@"; do
  case "$arg" in
    --build) build=1 ;;
    --with-avatars) with_avatars=1 ;;
    --with-diorama) with_diorama=1 ;;
    --all) build=1; with_avatars=1; with_diorama=1 ;;
    *)
      echo "Unknown argument: $arg" >&2
      exit 1
      ;;
  esac
done

if [ "$build" -eq 1 ]; then
  echo "==> Running pack_all.sh in $assets_repo..."
  if [ "$with_diorama" -eq 1 ]; then
    bash "$assets_repo/scripts/pack_all.sh" --all
  else
    bash "$assets_repo/scripts/pack_all.sh"
  fi
fi

sync_clean_dir() {
  local src="$1"
  local dst="$2"
  local label="$3"
  if [ ! -d "$src" ]; then
    echo "Skipping $label (missing $src)"
    return 0
  fi
  rm -rf "$dst"
  mkdir -p "$dst"
  cp -R "$src"/. "$dst"/
  local count size
  count="$(find "$dst" -type f | wc -l | tr -d ' ')"
  size="$(du -sh "$dst" | awk '{print $1}')"
  echo "Synced $count files ($size) into $label"
}

# Sync brand outputs (excluding 1024px raw master app-icon.png which goes into apps/mac/resources via mac-branding.ts)
if [ -d "$assets_repo/dist/brand" ]; then
  mkdir -p "$root/assets/brand"
  for f in "$assets_repo/dist/brand"/opening-*.webp "$assets_repo/dist/brand"/tray-*.png; do
    [ -f "$f" ] || continue
    cp "$f" "$root/assets/brand/$(basename "$f")"
  done
  count="$(find "$root/assets/brand" -maxdepth 1 -type f | wc -l | tr -d ' ')"
  size="$(du -sh "$root/assets/brand" | awk '{print $1}')"
  echo "Synced $count files ($size) into assets/brand/"
fi

sync_clean_dir "$assets_repo/dist/icons" "$root/assets/icons" "assets/icons/"
sync_clean_dir "$assets_repo/dist/engines" "$root/assets/engines" "assets/engines/"
sync_clean_dir "$assets_repo/dist/site" "$root/assets/site" "assets/site/"

if [ "$with_avatars" -eq 1 ] && [ -d "$assets_repo/dist/avatars" ]; then
  sync_clean_dir "$assets_repo/dist/avatars" "$root/assets/avatars" "assets/avatars/"
fi

if [ "$with_diorama" -eq 1 ] && [ -x "$here/diorama.sh" ]; then
  VIBEVALLEY_ASSETS_REPO="$assets_repo" bash "$here/diorama.sh"
fi

# Regenerate macOS 4-channel app icons, .icns bundles, favicons, and Papertrails DMG background
if [ -f "$assets_repo/dist/brand/app-icon.png" ]; then
  echo "==> Running mac-branding.ts from $assets_repo/dist/brand..."
  (cd "$root" && vpx scripts/gen/mac-branding.ts --raw-dir "$assets_repo/dist/brand")
fi
