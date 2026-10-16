#!/usr/bin/env bash
# Links the source images, kept in their own repository (vibevalley-art), into design/: pixel/raw, assets/raw and the
# mockups' two rounds. gen.sh and process.py read and write them there as before; the links are not in this repository.
# The art repository is $VIBEVALLEY_ART, or vibevalley-art beside this repository.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
art="${VIBEVALLEY_ART:-$here/../../vibevalley-art}"
if [ ! -d "$art/pixel/raw" ]; then
  echo "没找到原图仓库：$art" >&2
  echo "把 vibevalley-art 克隆到这个仓库旁边，或者用 VIBEVALLEY_ART 指给它。" >&2
  exit 1
fi
art="$(cd "$art" && pwd)"
for dir in pixel/raw assets/raw mockups/v1 mockups/v2; do
  link="$here/$dir"
  if [ -e "$link" ] && [ ! -L "$link" ]; then
    echo "$dir 是一个真的目录，没动它" >&2
    continue
  fi
  ln -sfn "$art/$dir" "$link"
  echo "design/$dir -> $art/$dir"
done
