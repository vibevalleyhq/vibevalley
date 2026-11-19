#!/bin/sh
# Installs nsh's published macOS CLI into .tools (bin/nsh beside the runtime/ it starts), checked against the release's
# sha256. Building nsh-cli from source took CI 5 to 17 minutes; the archive is the same build.
# The version must match the nsh-engine and nsh-platform-gpui crates in apps/mac/Cargo.toml: apps/mac/build.rs bundles
# the views with this CLI.
set -eu

version=${1:?"Usage: install-nsh.sh <version>"}
root=$(cd "$(dirname "$0")/../.." && pwd)
tools=$root/.tools

if [ -x "$tools/bin/nsh" ] && "$tools/bin/nsh" --version 2>/dev/null | grep -q "^nsh $version "; then
    exit 0
fi

[ "$(uname -s)" = Darwin ] || { echo "nsh's CLI is installed for macOS only; this is $(uname -s)." >&2; exit 1; }
case $(uname -m) in
    arm64) arch=arm64 ;;
    x86_64) arch=x86_64 ;;
    *) echo "No nsh release for $(uname -m)." >&2; exit 1 ;;
esac

archive=nsh-macos-$arch.tar.gz
url=https://github.com/longbridge/nsh/releases/download/v$version
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

curl -fsSL --retry 3 -o "$work/$archive" "$url/$archive"
curl -fsSL --retry 3 -o "$work/$archive.sha256" "$url/$archive.sha256"
(cd "$work" && shasum -a 256 -c "$archive.sha256" >/dev/null) || { echo "$archive does not match its published sha256." >&2; exit 1; }

rm -rf "$tools"
mkdir -p "$tools"
tar -xzf "$work/$archive" -C "$tools" --strip-components 1
"$tools/bin/nsh" --version
