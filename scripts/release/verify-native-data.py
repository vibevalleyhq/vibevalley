"""Exercise a cold, paired backup across two native app versions. Only loopback connections are allowed."""

import argparse
import base64
from contextlib import contextmanager
import datetime
import hashlib
import json
import os
import plistlib
from pathlib import Path
import shutil
import sqlite3
import subprocess
import tempfile
import time
import urllib.request
import zlib


def wait(label, read, timeout=50):
    until = time.monotonic() + timeout
    while time.monotonic() < until:
        value = read()
        if value:
            return value
        time.sleep(0.05)
    raise RuntimeError(f"timed out waiting for {label}")


def digest(path):
    total = hashlib.sha256()
    with path.open("rb") as stream:
        for piece in iter(lambda: stream.read(1 << 20), b""):
            total.update(piece)
    return total.hexdigest()


def manifest(root):
    return {
        str(p.relative_to(root)): ("link " + os.readlink(p) if p.is_symlink() else digest(p))
        for p in root.rglob("*")
        if p.is_symlink() or p.is_file()
    }


def read_db(path, query, params=()):
    with sqlite3.connect(path.as_uri() + "?mode=ro", uri=True) as db:
        return db.execute(query, params).fetchall()


def sample_png():
    def chunk(kind, data):
        return len(data).to_bytes(4, "big") + kind + data + zlib.crc32(kind + data).to_bytes(4, "big")

    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", b"\0\0\1\0" * 2 + bytes((8, 2, 0, 0, 0)))
        + chunk(b"IDAT", zlib.compress(bytes((1 + 256 * 3) * 256)))
        + chunk(b"IEND", b"")
    )


def git(path, *args):
    return subprocess.check_output(["/usr/bin/git", "-C", path, *args], text=True).strip()


class Client:
    def __init__(self, url, executable, env):
        self.url, self.exe, self.env = url, executable, env

    def call(self, op, payload=None):
        query = urllib.request.Request(
            self.url + "/api/v1/" + op.replace(".", "/"),
            json.dumps(payload).encode(),
            {"Content-Type": "application/json"},
        )
        with urllib.request.urlopen(query, timeout=12) as response:
            envelope = json.load(response)
        if envelope["bizCode"]:
            raise RuntimeError(f"{op} refused: {envelope['message']}")
        return envelope.get("data")

    def cli(self, *args):
        run = subprocess.run(
            [self.exe, "--json", *args],
            capture_output=True,
            text=True,
            timeout=30,
            env=self.env | {"VIBEVALLEY_SERVER": self.url},
        )
        if run.returncode:
            raise RuntimeError(f"{args}: {run.stderr}")
        return json.loads(run.stdout)


@contextmanager
def launch(bundle, live, evidence, stage, steps):
    binaries = bundle / "Contents/MacOS" if bundle.is_dir() else bundle.parent
    app = binaries / "vibevalley-mac" if bundle.is_dir() else bundle
    host, home, work, user = (live / key for key in ("host", "home", "work", "user"))
    for path in (host, home, work, user):
        path.mkdir(exist_ok=True, parents=True)
    script, dump = evidence / f"{stage}-steps.jsonl", evidence / f"{stage}-window.json"
    script.write_text("".join(json.dumps({"shell": step}) + "\n" for step in steps))
    env = {
        "PATH": "/usr/bin:/bin:/usr/sbin:/sbin",
        "SHELL": "/bin/sh",
        "HOME": str(user),
        "LANG": "en_US.UTF-8",
        "TMPDIR": str(evidence),
        "VIBEVALLEY_HOME": str(home),
        "VIBEVALLEY_WORK_ROOT": str(work),
        "VIBEVALLEY_STORE": str(host / "state.db"),
        "VIBEVALLEY_PORT": "0",
        "VIBEVALLEY_NO_OPENING": "1",
        "VIBEVALLEY_UPDATE_FEED": "off",
        "VIBEVALLEY_VOICE_LINE_PORT": "0",
        "VIBEVALLEY_TEST_RUNTIMES": "1",
        "VIBEVALLEY_AGENT_STARTERS": "docs",
        "VIBEVALLEY_PATROL_HEARTBEAT_MINUTES": "0",
        "VIBEVALLEY_DEBUG_SCRIPT": str(script),
        "VIBEVALLEY_DEBUG_DUMP": str(dump),
        "GIT_CONFIG_NOSYSTEM": "1",
        "GIT_CONFIG_GLOBAL": "/dev/null",
        "GIT_AUTHOR_NAME": "Native compatibility",
        "GIT_COMMITTER_NAME": "Native compatibility",
        "GIT_AUTHOR_EMAIL": "local@example.invalid",
        "GIT_COMMITTER_EMAIL": "local@example.invalid",
    }
    policy = evidence / "isolated.sb"
    real_home = Path.home()
    protected = ("Library/Application Support/VibeValley", ".vibevalley", "vibevalley-dev", ".codex", ".claude")
    policy.write_text(
        '(version 1)(allow default)(deny network-outbound (remote ip "*:*"))(allow network-outbound (remote ip "localhost:*"))'
        + "".join(
            "(deny file-read* file-write* (subpath " + json.dumps(str(real_home / entry)) + "))"
            for entry in protected
        )
    )
    with (evidence / f"{stage}.log").open("w") as log:
        started_ns = time.monotonic_ns()
        proc = subprocess.Popen(
            ["/usr/bin/sandbox-exec", "-f", policy, app],
            env=env,
            stdout=log,
            stderr=log,
            cwd=work / "workspace-project",
        )
        try:

            def ready():
                if proc.poll() is not None:
                    raise RuntimeError(f"{stage}: app exited {proc.returncode}")
                try:
                    ready = json.loads((home / "server.json").read_text())
                    return ready["url"] if ready["pid"] == proc.pid else None
                except (FileNotFoundError, ValueError):
                    return None

            client = Client(wait(stage, ready), binaries / "vibevalley", env)
            service_ms = (time.monotonic_ns() - started_ns) // 1_000_000

            def window_ready():
                try:
                    view = json.loads(dump.read_text())
                    return view.get("loaded") and not view.get("load_error")
                except (FileNotFoundError, ValueError):
                    return False

            wait("loaded native window", window_ready)
            times = {"serviceReadyMs": service_ms, "windowReadyMs": (time.monotonic_ns() - started_ns) // 1_000_000}
            (evidence / f"{stage}-startup.json").write_text(json.dumps(times))
            yield client, dump
        finally:
            if proc.poll() is None:
                proc.terminate()
                try:
                    proc.wait(timeout=12)
                except subprocess.TimeoutExpired:
                    proc.kill()
                    proc.wait()


def window_state(dump):
    try:
        view = json.loads(dump.read_text())
        if not view["loaded"] or view["load_error"]:
            return None
        project = next((p for p in view["projects"] if p["name"] == "workspace-project"), None)
        if project and project["layout"]["root"]["node"] == "split":
            return {"id": project["id"], "layout": project["layout"]}
    except (FileNotFoundError, ValueError):
        return None


def seed_old(c):
    c.cli("repo", "create", "demo")
    issue = c.cli("issue", "create", "写打卡并提交", "--repo", "demo", "--agent", "docs")["id"]
    c.cli("issue", "status", issue, "todo")
    wait("old helper report", lambda: c.cli("issue", "show", issue)["stage"]["state"] == "reviewing")
    general = next(ch["id"] for ch in c.cli("channel", "list") if ch["type"] == "channel")
    c.cli("channel", "message", "send", general, "checkpoint-old", "--send-key", "checkpoint-old")
    profile = c.cli("agent", "list")
    agent = next(p["id"] for p in profile if p["id"] == "docs" or p.get("name") == "docs")
    memory = c.cli("memory", "create", agent, "retain old note", "--key", "legacy-note")
    artifact = c.cli(
        "artifact",
        "create",
        "Checkpoint",
        "--kind",
        "html",
        "--content",
        "<!DOCTYPE html><html><body>old artifact</body></html>",
    )
    png_file = Path(c.env["TMPDIR"]) / "old.png"
    png_file.write_bytes(sample_png())
    attachment = c.cli("attachment", "upload", str(png_file), "--name", "old.png", "--mime", "image/png")
    c.cli("library", "add", "--attachment", attachment["id"])
    media_input = c.call("media.input.adopt", {"attachment": attachment["id"]})
    c.call(
        "provider.update",
        {
            "revision": 0,
            "connections": [
                {
                    "id": "offline",
                    "name": "Offline fixture",
                    "adapter": "moss",
                    "enabled": True,
                    "key": "local-fixture-only",
                }
            ],
            "image": {"connection": "offline", "model": "moss-image-base-1.0"},
            **dict.fromkeys(
                (
                    "speech",
                    "understanding",
                    "live",
                    "speakers",
                    "voiceDesign",
                    "transcription",
                    "vision",
                )
            ),
        },
    )
    due = datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(days=1)
    cron = c.cli(
        "cron",
        "create",
        "checkpoint schedule",
        "Review fixture",
        "--agent",
        "docs",
        "--repo",
        "demo",
        "--at",
        due.isoformat(timespec="seconds"),
    )
    job = c.call(
        "media.image.create",
        {
            "id": "offline-image",
            "prompt": "offline fixture",
            "format": "text",
            "width": 256,
            "height": 256,
            "enhance": False,
            "watermark": True,
        },
    )

    def media_result():
        result = c.cli("media", "job", "show", job["id"])
        return result if result["phase"] not in ("queued", "generating", "downloading") else None

    media = wait("offline media outcome", media_result)
    assert media["phase"] == "ready", media["phase"]
    repo = Path(c.cli("repo", "list")[0]["path"])
    return {
        "issue": issue,
        "run": c.call("issue.run.list", {"id": issue})[0]["id"],
        "repo": str(repo),
        "base": git(repo, "rev-parse", "HEAD"),
        "channel": general,
        "agent": agent,
        "memory": memory["id"],
        "artifact": artifact["id"],
        "attachment": attachment["id"],
        "mediaInput": media_input["id"],
        "mediaJob": job["id"],
        "mediaPhase": media["phase"],
        "generatedAttachment": media["attachment"]["id"],
        "cron": cron["id"],
    }


def verify_old_content(c, ids):
    assert any(i["id"] == ids["issue"] for i in c.cli("state")["state"]["issues"])
    assert c.cli("issue", "show", ids["issue"])["stage"]["state"] == "reviewing"
    assert c.call("issue.run.list", {"id": ids["issue"]})[0]["id"] == ids["run"]
    assert git(ids["repo"], "rev-parse", "HEAD") == ids["base"]
    assert any(f["path"] == "clock.ts" for f in c.cli("issue", "diff", ids["issue"])["files"])
    messages = c.cli("channel", "message", "list", ids["channel"])
    assert sum(m["text"] == "checkpoint-old" for m in messages) == 1
    assert any(m["id"] == ids["memory"] for m in c.cli("memory", "list", ids["agent"])["memories"])
    assert c.cli("artifact", "show", ids["artifact"])["title"] == "Checkpoint"
    assert "old artifact" in c.cli("artifact", "read", ids["artifact"], "--version", "1")["content"]

    assert any(i["attachment"]["id"] == ids["attachment"] for i in c.cli("library", "list"))
    downloaded = base64.b64decode(c.cli("attachment", "get", ids["attachment"])["data"])
    assert hashlib.sha256(downloaded).hexdigest() == ids["attachment"]
    assert c.call("media.input.get", {"id": ids["mediaInput"]})["hash"] == ids["attachment"]
    job = c.cli("media", "job", "show", ids["mediaJob"])
    assert (job["phase"], job["attachment"]["id"]) == (ids["mediaPhase"], ids["generatedAttachment"])
    assert any(item["id"] == ids["cron"] for item in c.cli("cron", "list"))
    rows = c.cli("library", "list", "--origin", "generated")
    assert any(item["attachment"]["id"] == ids["generatedAttachment"] for item in rows)


def seed_connector_fixture(db_path):
    fixture = json.loads((Path(__file__).parent / "fixtures/connector-275732ef1.json").read_text())
    stamp = int(time.time() * 1000)
    with sqlite3.connect(db_path) as db:
        for table in ("connector_account", "connector_inbound", "connector_outbox"):
            for row in fixture["tables"][table]:
                for key in ("connected_at", "created_at", "sent_at"):
                    if row.get(key) is not None:
                        row[key] += stamp
                if row.get("paused_until"):
                    row["paused_until"] = stamp + 86400000
                if table == "connector_outbox" and row["message_id"] == "paused-message":
                    row["message_id"] = db.execute(
                        "SELECT id FROM channel_message WHERE kind='report' ORDER BY created_at LIMIT 1"
                    ).fetchone()[0]
                columns = ", ".join(row)
                binds = ", ".join("?" for _ in row)
                db.execute(f"INSERT INTO {table} ({columns}) VALUES ({binds})", tuple(row.values()))


def verify_connector(c, live):
    qq = next(x for x in c.call("connector.list") if x["id"] == "qq")
    assert qq["state"] == "paused" and qq["pending"] == 1, qq
    path = live / "home/server.db"
    report_id = read_db(path, "SELECT id FROM channel_message WHERE kind='report' ORDER BY created_at LIMIT 1")[0][
        0
    ]
    outbox = read_db(path, "SELECT message_id,state FROM connector_outbox ORDER BY seq")
    assert outbox == [("legacy-sent", "sent"), ("legacy-old", "dropped"), (report_id, "pending")], outbox
    assert read_db(path, "SELECT ext_id,message_id,delivered FROM connector_inbound") == [("old-in", "farm-old", 1)]


def sqlite_versions(c, live, agent, stage):
    path = live / "home/server.db"
    with sqlite3.connect(path) as db:
        db.executescript("""CREATE TABLE compat_engine(version TEXT, source_id TEXT);
            CREATE TRIGGER sample_engine AFTER INSERT ON memory
            BEGIN INSERT INTO compat_engine VALUES(sqlite_version(),sqlite_source_id()); END;""")
    try:
        row = c.cli("memory", "create", agent, "engine probe " + stage)
        version, source = read_db(path, "SELECT version,source_id FROM compat_engine")[0]
        c.cli("memory", "delete", agent, row["id"])
    finally:
        with sqlite3.connect(path) as db:
            db.executescript("DROP TRIGGER sample_engine; DROP TABLE compat_engine;")
    return {
        "sqliteVersion": version,
        "sqliteSourceId": source,
        "hostUserVersion": read_db(live / "host/state.db", "PRAGMA user_version")[0][0],
        "serverUserVersion": read_db(path, "PRAGMA user_version")[0][0],
    }


def identify(bundle):
    macos = bundle / "Contents/MacOS" if bundle.is_dir() else bundle.parent
    version = (
        plistlib.loads((bundle / "Contents/Info.plist").read_bytes())["VibeValleyVersion"]
        if bundle.is_dir()
        else "debug"
    )
    return {
        "path": str(bundle),
        "version": version,
        "appSha256": digest(macos / "vibevalley-mac"),
        "cliSha256": digest(macos / "vibevalley"),
    }


def verify(old, new, root):
    live, backup = root / "live", root / "paired-backup"
    (live / "work/workspace-project").mkdir(parents=True)
    git(live / "work/workspace-project", "init", "-b", "main")

    def save(name, obj):
        (root / (name + ".json")).write_text(json.dumps(obj, indent=2, ensure_ascii=False) + "\n")

    with launch(old, live, root, "old", ["activate:0", "split_right", "save", "draw"]) as (c, dump):
        ids = seed_old(c)
        engines = {"old": sqlite_versions(c, live, ids["agent"], "old")}
        old_window = wait("old split layout", lambda: window_state(dump))
        verify_old_content(c, ids)
    seed_connector_fixture(live / "home/server.db")
    with launch(old, live, root, "old-connector", ["draw"]) as (c, _):
        verify_connector(c, live)
    save("old-records", ids)
    original = manifest(live)
    shutil.copytree(live, backup, symlinks=True)
    assert manifest(backup) == original
    save("backup-files", original)
    with launch(new, live, root, "upgraded", ["draw"]) as (c, dump):
        engines["upgraded"] = sqlite_versions(c, live, ids["agent"], "upgraded")
        assert wait("upgraded layout", lambda: window_state(dump)) == old_window
        verify_old_content(c, ids)
        verify_connector(c, live)
        c.cli("channel", "message", "send", ids["channel"], "checkpoint-old", "--send-key", "checkpoint-old")
        verify_old_content(c, ids)
        marker = c.cli("memory", "create", ids["agent"], "upgraded-only note", "--key", "new-only")
        c.cli("artifact", "update", ids["artifact"], "--title", "New title")
        revision = c.cli("issue", "diff", ids["issue"])["revision"]
        c.cli(
            "issue",
            "review",
            ids["issue"],
            "--pass",
            "--base-commit",
            revision["baseCommit"],
            "--tree",
            revision["tree"],
        )
        result = c.cli("issue", "status", ids["issue"], "done")
        assert result["delivered"] == "merged" and git(ids["repo"], "show", "HEAD:clock.ts")
        upgraded_commit = git(ids["repo"], "rev-parse", "HEAD")
        followup = c.cli("issue", "create", "先问清楚，给选项", "--repo", "demo", "--agent", "docs")["id"]
        c.cli("issue", "status", followup, "todo")
        wait("new helper question", lambda: c.cli("issue", "show", followup)["stage"]["state"] == "asking")
        c.call("issue.comment.create", {"id": followup, "text": "用 8797", "sendKey": "upgrade-followup"})
        wait("new helper response", lambda: c.cli("issue", "show", followup)["stage"]["state"] == "reviewing")

    with launch(new, live, root, "upgraded-reopen", ["draw"]) as (c, _):
        assert c.cli("issue", "show", ids["issue"])["status"] == "done"
        completed_runs = c.call("issue.run.list", {"id": followup})
        request = read_db(
            live / "home/server.db",
            "SELECT id FROM channel_message WHERE sender_id='user' AND body=?",
            ("用 8797",),
        )
        assert len(request) == 1, request
        matches = [r for r in completed_runs if request[0][0] in r["heard"]]
        assert len(matches) == 1 and matches[0]["outcome"] == "completed", matches
        submitted = read_db(
            live / "home/server.db",
            "SELECT request_id,status FROM durable_submission WHERE conversation_id=? AND request_id=?",
            (f"issue:{followup}", request[0][0]),
        )
        assert submitted == [(request[0][0], "done")], submitted

        assert c.cli("artifact", "show", ids["artifact"])["title"] == "New title"
        assert any(m["id"] == marker["id"] for m in c.cli("memory", "list", ids["agent"])["memories"])
    live.rename(root / "upgraded-cohort")
    shutil.copytree(backup, live, symlinks=True)
    assert manifest(live) == original
    with launch(old, live, root, "rollback", ["draw"]) as (c, dump):
        engines["rollback"] = sqlite_versions(c, live, ids["agent"], "rollback")
        assert all(issue["id"] != followup for issue in c.cli("issue", "list"))

        assert wait("rollback layout", lambda: window_state(dump)) == old_window
        verify_old_content(c, ids)
        verify_connector(c, live)
        assert all(m["id"] != marker["id"] for m in c.cli("memory", "list", ids["agent"])["memories"])
    archived_repo = root / "upgraded-cohort" / Path(ids["repo"]).relative_to(live)
    assert git(archived_repo, "rev-parse", "HEAD") == upgraded_commit
    for cohort in (live, backup, root / "upgraded-cohort"):
        for file in (cohort / "home/server.db", cohort / "host/state.db"):
            assert read_db(file, "PRAGMA integrity_check") == [("ok",)], file
    save(
        "result",
        {
            "old": identify(old),
            "new": identify(new),
            "backupFileCount": len(original),
            "sqlite": engines,
            "startup": {
                stage: json.loads((root / f"{stage}-startup.json").read_text())
                for stage in ("old", "upgraded", "upgraded-reopen", "rollback")
            },
            "restoredOldBase": ids["base"],
            "preservedNewCommit": upgraded_commit,
            "restoredWindow": old_window,
            "newNote": marker["id"],
            "newIssue": followup,
            "newDurableSubmission": submitted,
            "seeds": {
                "oldPackage": [
                    "profile",
                    "cron",
                    "repo",
                    "issue",
                    "session",
                    "channel",
                    "memory",
                    "artifact",
                    "attachment",
                    "library",
                    "media_input",
                    "media_job",
                    "layout",
                    "terminals",
                ],
                "oldConnectorStore": ["paused account", "replayed inbox", "sent, dropped and pending outbox"],
                "newPackage": ["review receipt", "Git merge", "durable reply", "new memory", "artifact title"],
            },
            "ok": True,
        },
    )
    print("Old application data, upgraded delivery, and paired old-package rollback passed.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("old", type=Path)
    parser.add_argument("new", type=Path)
    args = parser.parse_args()
    root = Path(tempfile.mkdtemp(prefix="vv-data-rollback-")).resolve()
    print(root, flush=True)
    verify(args.old.resolve(strict=True), args.new.resolve(strict=True), root)
