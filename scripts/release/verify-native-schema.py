"""Audit native sqlc inputs against the schemas actually opened by a native app."""

import argparse
import json
import re
import shutil
import sqlite3
import subprocess
import tempfile
from contextlib import closing
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
GO_BASE = "a2c1851ab"


def yaml_file(path):
    command = [
        "node",
        "--input-type=module",
        "-e",
        "import{parse}from'yaml';import{readFileSync}from'node:fs';process.stdout.write(JSON.stringify(parse(readFileSync(0,'utf8'))))",
    ]
    return json.loads(subprocess.check_output(command, cwd=ROOT, input=path.read_bytes()))


def source_files(spec, root):
    if isinstance(spec, str):
        spec = [spec]
    paths = []
    for path in spec:
        source = root / path
        paths.extend(sorted(source.rglob("*.sql")) if source.is_dir() else [source])
    return [p.resolve() for p in paths]


def prepare_queries(config, sqlc, root):
    with tempfile.TemporaryDirectory(prefix="sqlc-prepare-") as tmp:
        folder = Path(tmp)
        (folder / "source").symlink_to(root, target_is_directory=True)

        def paths(spec):
            return [str(Path("source") / p) for p in ([spec] if isinstance(spec, str) else spec)]

        groups = [
            dict(engine=s["engine"], schema=paths(s["schema"]), queries=paths(s["queries"]),
                 gen={"json": {"out": str(i)}})
            for i, s in enumerate(config["sql"])
        ]
        (folder / "sqlc.yaml").write_text(json.dumps({"version": "2", "sql": groups}))
        subprocess.run([sqlc, "generate"], cwd=folder, check=True)
        count = 0
        for group in groups:
            ir = json.loads((folder / group["gen"]["json"]["out"] / "codegen_request.json").read_text())
            with closing(sqlite3.connect(":memory:")) as db:
                for ddl in source_files(group["schema"], folder):
                    db.executescript(ddl.read_text())
                for query in ir["queries"]:
                    try:
                        db.execute("EXPLAIN " + query["text"], [None] * len(query["params"] or []))
                    except sqlite3.Error as e:
                        raise ValueError(f"{query['filename']} {query['name']}: {e}") from e
                    count += 1
        return {"queriesPrepared": count, "sqliteVersion": sqlite3.sqlite_version}


def normalized_ddl(db):
    # Keep quoted literals intact. Formatting and keyword case vary across released DDL.
    tokens = re.compile(r"""'(?:''|[^'])*'|"(?:""|[^"])*"|/\*.*?\*/|--[^\n]*|\w+|[^\s]""", re.S)
    result = {}
    for kind, name, sql in db.execute("SELECT type,name,sql FROM sqlite_master WHERE sql IS NOT NULL"):
        if name.startswith("sqlite_"):
            continue
        parts = (p for p in tokens.findall(sql) if not p.startswith(("--", "/*")))
        result[(kind, name)] = [p if p.startswith(("'", '"')) else p.lower() for p in parts]
    return result


def schema_shape(db):
    tables = {}
    for _, name, kind, _, _, _ in db.execute("PRAGMA main.table_list"):
        if name.startswith("sqlite_") or kind not in ("table", "virtual"):
            continue
        table = name.replace('"', '""')
        columns = [tuple(r[1:]) for r in db.execute(f'PRAGMA main.table_xinfo("{table}")')]
        indices = {}
        for _, index, unique, origin, partial in db.execute(f'PRAGMA main.index_list("{table}")'):
            quoted = index.replace('"', '""')
            parts = [tuple(r[1:]) for r in db.execute(f'PRAGMA main.index_xinfo("{quoted}")')]
            indices[index] = (unique, origin, partial, parts)
        tables[name] = {
            "columns": columns,
            "indices": indices,
            "foreignKeys": db.execute(f'PRAGMA main.foreign_key_list("{table}")').fetchall(),
        }
    return tables


def runtime_includes(root):
    inputs = set()
    for path in (root / "crates").glob("*/src/**/*.rs"):
        for name in re.findall(r'include_str!\s*\(\s*"([^"]+\.sql)"\s*\)', path.read_text()):
            inputs.add((path.parent / name).resolve())
    return inputs


def go_migrations(root):
    tree = subprocess.check_output(
        ["git", "ls-tree", "--name-only", f"{GO_BASE}:pkg/db/migrations"], cwd=root, text=True
    ).splitlines()
    owned = {}
    declaration = re.compile(r"^\s*CREATE\s+(?:VIRTUAL\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)", re.M | re.I)
    for path in sorted(name for name in tree if name.endswith(".up.sql")):
        ddl = subprocess.check_output(["git", "show", f"{GO_BASE}:pkg/db/migrations/{path}"], cwd=root, text=True)
        owned[path] = declaration.findall(ddl)
        assert owned[path] and path.replace(".up.sql", ".down.sql") in tree, path
    declarations = [t for names in owned.values() for t in names]
    assert len(set(declarations)) == len(declarations), "Duplicate Go table owner"
    return owned


def generation_gate(config, sqlc, root):
    ci = yaml_file(root / ".github/workflows/ci.yml")
    ci_versions = []
    for job in ci["jobs"].values():
        steps = job.get("steps", [])
        if any(s.get("run") == "vp run sql:check" for s in steps):
            ci_versions.extend(
                s["with"]["sqlc-version"] for s in steps if s.get("uses", "").startswith("sqlc-dev/setup-sqlc@")
            )
    version = subprocess.check_output([sqlc, "version"], cwd=root, text=True).strip().removeprefix("v")
    assert ci_versions == [version], (ci_versions, version)
    subprocess.run([sqlc, "diff"], cwd=root, check=True)
    sample = next(s for s in config["sql"] if s["queries"].startswith("crates/vibevalley-store/"))
    with tempfile.TemporaryDirectory(prefix="sqlc-stale-") as tmp:
        folder = Path(tmp)
        shutil.copytree(root / sample["schema"], folder / "schema")
        shutil.copyfile(root / sample["queries"], folder / "queries.sql")
        step = dict(
            sample, schema="schema", queries="queries.sql", codegen=[dict(sample["codegen"][0], out="generated")]
        )
        plugin = config["plugins"][0]
        local = dict(plugin, process=dict(plugin["process"], cmd=str(root / plugin["process"]["cmd"])))
        (folder / "sqlc.yaml").write_text(json.dumps({"version": "2", "plugins": [local], "sql": [step]}))
        subprocess.run([sqlc, "generate"], cwd=folder, check=True)
        out = folder / "generated/queries.rs"
        assert out.read_bytes() == (root / sample["codegen"][0]["out"] / "queries.rs").read_bytes()
        with out.open("a") as file:
            file.write("// stale test output\n")
        result = subprocess.run([sqlc, "diff"], cwd=folder, capture_output=True, text=True)
        assert result.returncode != 0 and "stale test output" in result.stdout + result.stderr, result
    return {"ci": version, "checkedInMatches": True, "staleSampleRejected": True}


def drivers(source):
    def dependencies(*args):
        lines = subprocess.check_output(
            ["cargo", "tree", "--locked", "--offline", "--prefix", "none", "--format", "{p}", *args],
            cwd=source,
            text=True,
        ).splitlines()
        return sorted(
            {
                line.removesuffix(" (*)")
                for line in lines
                if line.startswith(("sqlx-sqlite v", "libsqlite3-sys v", "rusqlite v"))
            }
        )

    normal = dependencies("-e", "normal", "-p", "vibevalley-mac")
    dev = dependencies("-e", "normal,dev", "--workspace")
    assert not any(x.startswith("rusqlite ") for x in normal), normal
    return {"macProduction": normal, "workspaceIncludingDev": dev}


def audit(live, sqlc, root, go_repo):
    config = yaml_file(root / "sqlc.yaml")
    includes = runtime_includes(root)
    owners = {}
    group = {}
    seen = set()
    queries = {}
    expected = {scope: sqlite3.connect(":memory:") for scope in ("host", "home")}
    for spec in config["sql"]:
        assert spec["engine"] == "sqlite"
        scope = "host" if spec["queries"].startswith("crates/vibevalley-store/") else "home"
        q = source_files(spec["queries"], root)
        queries[spec["codegen"][0]["out"]] = sum(len(re.findall(r"^-- name: ", p.read_text(), re.M)) for p in q)
        for path in source_files(spec["schema"], root):
            if path in seen:
                continue
            seen.add(path)
            assert path in includes, path
            db = expected[scope]
            independent = sqlite3.connect(":memory:")
            independent.executescript(path.read_text())
            tables = set(schema_shape(independent))
            independent.close()
            for name in tables:
                key = (scope, name)
                assert key not in owners, (key, owners.get(key), path)
                owners[key] = str(path.relative_to(root))
            db.executescript(path.read_text())
    assert seen == includes, ("SQL DDL includes missing from sqlc.yaml", sorted(includes - seen))
    for scope, db in expected.items():
        path = live / scope / ("state.db" if scope == "host" else "server.db")
        with sqlite3.connect(path.resolve().as_uri() + "?mode=ro", uri=True) as real:
            actual = schema_shape(real)
            actual_ddl = normalized_ddl(real)
        expected_ddl = normalized_ddl(db)
        shape = schema_shape(db)
        db.close()
        group[scope] = {
            "runtimeTables": len(actual),
            "declaredTables": len(shape),
            "differentDDL": sorted(
                ".".join(name)
                for name in set(actual_ddl) | set(expected_ddl)
                if actual_ddl.get(name) != expected_ddl.get(name)
            ),
            "runtimeOnly": sorted(actual.keys() - shape.keys()),
            "sqlcOnly": sorted(shape.keys() - actual.keys()),
            "differentShape": sorted(t for t in actual.keys() & shape.keys() if actual[t] != shape[t]),
        }
    return {
        "native": group,
        "drivers": drivers(root),
        "sourceHead": subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=root, text=True).strip(),
        "sourceChangedPaths": len(
            subprocess.check_output(["git", "status", "--porcelain", "-z"], cwd=root).split(b"\0")
        )
        - 1,
        "queryCounts": queries,
        "ddlOwners": {f"{scope}.{name}": src for (scope, name), src in sorted(owners.items())},
        "goBase": GO_BASE,
        "goMigrationTables": go_migrations(go_repo),
        "generation": generation_gate(config, sqlc, root),
    }


if __name__ == "__main__":
    p = argparse.ArgumentParser(description=__doc__)
    mode = p.add_mutually_exclusive_group(required=True)
    mode.add_argument("live", type=Path, nargs="?")
    mode.add_argument("--queries-only", action="store_true", help="prepare sqlc output against each declared schema")
    p.add_argument("--sqlc", default="sqlc")
    p.add_argument("--source", type=Path, default=ROOT, help="checkout used to build the candidate")
    p.add_argument("--go-repo", type=Path, default=ROOT, help="repository containing the Go behavior baseline")
    args = p.parse_args()
    if args.queries_only:
        root = args.source.resolve()
        print(json.dumps(prepare_queries(yaml_file(root / "sqlc.yaml"), args.sqlc, root)))
        raise SystemExit(0)
    result = audit(args.live, args.sqlc, args.source.resolve(), args.go_repo.resolve())
    print(json.dumps(result, indent=2, sort_keys=True))
    if any(
        g["runtimeOnly"] or g["sqlcOnly"] or g["differentShape"] or g["differentDDL"]
        for g in result["native"].values()
    ):
        raise SystemExit(1)
