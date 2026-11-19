#!/bin/sh
set -eu
here=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
probe=$(mktemp -d)
trap 'rm -rf "$probe"' EXIT
mkdir "$probe/src"
cd "$probe"
ln -s "$here/generate.ts" generate.ts
cp "$here/schema.sql" "$here/queries.sql" "$here/sqlc.yaml" .
sqlc generate
cp src/queries.rs first.rs
sqlc generate
cmp first.rs src/queries.rs
cp "$here/smoke.rs" src/lib.rs
cat > Cargo.toml <<'TOML'
[package]
name = "vv-sqlc-example"
version = "0.0.0"
edition = "2024"

[dependencies]
sqlx = { version = "=0.9.1", default-features = false, features = ["sqlite", "runtime-tokio", "derive"] }
tokio = { version = "1", features = ["rt", "macros"] }
TOML
cargo clippy --quiet --all-targets -- -D warnings
cargo test --quiet
cat > src/main.rs <<'RUST'
use vv_sqlc_example::queries::GetProjectParams;
fn main() {
    let _ = GetProjectParams { id: "wrong type" };
}
RUST
if cargo check --quiet --bin vv-sqlc-example 2>type.err; then
  echo "Expected rustc to reject a text project ID" >&2
  exit 1
fi
grep -q 'expected `i64`' type.err
cp queries.sql valid.sql
cat >> queries.sql <<'SQL'

-- name: OrderByMacro :many
SELECT id FROM projects ORDER BY CASE WHEN sqlc.arg(sort) = 'name' THEN name END, id;
SQL
if python3 "$here/../../release/verify-native-schema.py" --queries-only --source "$probe" >prepare.log 2>&1; then
  echo "Expected SQLite to reject the sort argument left unexpanded by sqlc 1.31.1" >&2
  exit 1
fi
grep -q 'OrderByMacro: ' prepare.log
mv valid.sql queries.sql
printf '\n-- name: Broken :one\nSELECT missing_column FROM projects;\n' >> queries.sql
if sqlc generate 2>generate.err; then
  echo "Expected sqlc to reject a missing column" >&2
  exit 1
fi
grep -q 'missing_column' generate.err
