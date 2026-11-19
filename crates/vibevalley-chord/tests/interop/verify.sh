#!/bin/sh
set -eu
root=$(git rev-parse --show-toplevel)
ref=$(mktemp -d)
trap 'rm -rf "$ref"' EXIT
cd "$root"
reference=a2c1851abd67116582d89302533377d802108d54
git archive "$reference" go.mod go.sum pkg/chord > "$ref/reference.tar"
tar -xf "$ref/reference.tar" -C "$ref"
VIBEVALLEY_GO_SOURCE="$ref" cargo test --locked --offline -p vibevalley-chord --test go_link -- --ignored
if [ "${1:-}" = "--app" ]; then
    cargo build --locked --offline -p vibevalley-cli -p vibevalley-server
    git archive "$reference" cmd/vibe-server internal pkg > "$ref/server.tar"
    tar -xf "$ref/server.tar" -C "$ref"
    (cd "$ref" && env -u GOROOT CGO_ENABLED=0 go build -o "$ref/control" ./cmd/vibe-server)
    VIBEVALLEY_GO_SERVER="$ref/control" cargo test --locked --offline -p vibevalley-chord --test go_product -- --ignored
    (cd "$ref" && env -u GOROOT CGO_ENABLED=0 go build -o "$ref/peer" "$root"/crates/vibevalley-chord/tests/interop/*.go)
    vpx scripts/release/verify-server.ts --scripted-helper -- "$ref/peer" product
    VIBEVALLEY_GO_CHORD_PEER="$ref/peer" cargo test --locked --offline -p vibevalley-server --test suite orchestrator::go_client_approves_native_tool -- --ignored --nocapture
fi
