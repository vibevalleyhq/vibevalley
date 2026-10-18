#!/bin/sh
set -eu
HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
BIN=$(mktemp -d "${TMPDIR:-/tmp}/vibevalley-lock.XXXXXX")
trap 'rm -rf "$BIN"' EXIT
trap 'exit 130' HUP INT TERM
(cd "$HERE/../../server" && env -u GOOS -u GOARCH go build -o "$BIN/locked" "$HERE/locked.go")
"$BIN/locked" "$@"
