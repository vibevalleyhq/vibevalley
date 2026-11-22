"""Exercise three delegated issues in an isolated native app, including a real process interruption."""
import argparse
import json
import os
from pathlib import Path
import platform
import plistlib
import shlex
import subprocess
import tempfile
import time
import urllib.request


def wait_for(label, read):
    deadline = time.monotonic() + 40
    while time.monotonic() < deadline:
        value = read()
        if value:
            return value
        time.sleep(0.04)
    raise RuntimeError(f"timed out waiting for {label}")


def verify(app, cli, root, prepare_trial):
    home = root / "home"
    work = root / "work"
    user = root / "user"
    for path in (home, work, user):
        path.mkdir()
    env = {
        "PATH": "/usr/bin:/bin:/usr/sbin:/sbin",
        "HOME": str(user),
        "TMPDIR": str(root),
        "LANG": "en_US.UTF-8",
        "GIT_CONFIG_NOSYSTEM": "1",
        "GIT_AUTHOR_NAME": "Native acceptance",
        "GIT_COMMITTER_NAME": "Native acceptance",
        "GIT_AUTHOR_EMAIL": "local@example.invalid",
        "GIT_COMMITTER_EMAIL": "local@example.invalid",
        "VIBEVALLEY_HOME": str(home),
        "VIBEVALLEY_WORK_ROOT": str(work),
        "VIBEVALLEY_STORE": str(root / "state.db"),
        "VIBEVALLEY_PORT": "0",
        "VIBEVALLEY_NO_OPENING": "1",
        "VIBEVALLEY_TEST_RUNTIMES": "1",
        "VIBEVALLEY_AGENT_STARTERS": "docs",
    }

    def save(name, value):
        (root / f"{name}.json").write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n")

    def launch():
        with (root / "app.log").open("ab") as log:
            proc = subprocess.Popen([app], cwd=work, env=env, stdout=log, stderr=log)

        def ready():
            if proc.poll() is not None:
                raise RuntimeError(f"app exited with {proc.returncode}")
            try:
                announced = json.loads((home / "server.json").read_text())
                return announced["url"] if announced["pid"] == proc.pid else None
            except (FileNotFoundError, ValueError):
                return None

        try:
            return proc, wait_for("app service", ready)
        except BaseException:
            stop(proc)
            raise

    def stop(proc):
        if proc.poll() is None:
            proc.terminate()
            try:
                proc.wait(timeout=10)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait()

    def command(*args):
        r = subprocess.run([cli, "--json", *args], env={**env, "VIBEVALLEY_SERVER": address}, capture_output=True, text=True, timeout=30)
        if r.returncode:
            raise RuntimeError(f"{args}: {r.stderr}")
        return json.loads(r.stdout)

    def call(op, payload):
        req = urllib.request.Request(f"{address}/api/v1/{op.replace('.', '/')}", json.dumps(payload).encode(), {"Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=8) as response:
            reply = json.load(response)
        if reply["bizCode"] != 0:
            raise RuntimeError(f"{op}: {reply}")
        return reply["data"]

    def issue(title):
        return command("issue", "create", title, "--repo", "demo", "--agent", "docs")["id"]

    def stage(issue_id, expected):
        def read():
            item = command("issue", "show", issue_id)
            return item if item["stage"]["state"] == expected else None
        return wait_for(expected, read)

    def git(directory, *args):
        return subprocess.check_output(["git", "-C", directory, *args], text=True, env=env).strip()

    proc, address = launch()
    try:
        command("repo", "create", "demo")
        question = issue("先问清楚，给选项")
        review = issue("写打卡并提交")
        interrupted = issue("写版本B 发呆")
        for issue_id in (question, review):
            command("issue", "status", issue_id, "todo")
        save("asking", stage(question, "asking"))
        save("reviewing", stage(review, "reviewing"))
        command("issue", "status", interrupted, "todo")

        def written():
            sessions = command("session", "list")
            worker = next((s for s in sessions if s.get("issue") == interrupted and s["phase"]["_tag"] == "working"), None)
            if worker and git(worker["worktree"], "log", "-1", "--format=%s") == "版本 B":
                return worker["worktree"]
            return None
        worktree = wait_for("third issue to commit before its round ends", written)
        pending_commit = git(worktree, "rev-parse", "HEAD")
        proc.kill()
        proc.wait(timeout=10)
    finally:
        stop(proc)

    proc, address = launch()
    try:
        runs = call("issue.run.list", {"id": interrupted})
        assert len(runs) == 1 and runs[0]["outcome"] == "interrupted" and runs[0].get("needsReconciliation"), runs
        assert git(worktree, "rev-parse", "HEAD") == pending_commit
        if prepare_trial:
            stage(question, "asking")
            stage(review, "reviewing")
            save("trial-start", {"question": question, "review": review, "interrupted": interrupted, "retainedCommit": pending_commit})
            launcher = root / "open-trial.command"
            launch_args = ["env", "-i", *(f"{key}={value}" for key, value in env.items()), str(app)]
            launcher.write_text("#!/bin/sh\ncd " + shlex.quote(str(work)) + " || exit 1\nexec " + shlex.join(launch_args) + "\n")
            launcher.chmod(0o700)
            info = app.parent.parent / "Info.plist"
            version = "开发构建"
            if info.is_file():
                with info.open("rb") as f:
                    version = plistlib.load(f).get("VibeValleyVersion", "未标记")
            template = Path(__file__).with_name("fixtures") / "native-trial-card.txt"
            card = root / "trial-card.txt"
            card.write_text(template.read_text(encoding="utf-8").format(
                device=f"macOS {platform.mac_ver()[0]} / {platform.machine()}",
                version=version,
                cli_version=subprocess.check_output([cli, "--version"], env=env, text=True, timeout=10).strip(),
            ), encoding="utf-8")
            card.chmod(0o600)
            print(f"试用卡（可用文本编辑填写）：{card}")
            print(f"打开三张工单：{launcher}")
            return
        command("issue", "comment", question, "用 8797")
        save("answered", stage(question, "reviewing"))
        diff = command("issue", "diff", review)
        assert any(f["path"] == "clock.ts" for f in diff["files"])
        rev = diff["revision"]
        command("issue", "review", review, "--pass", "--base-commit", rev["baseCommit"], "--tree", rev["tree"])
        done = command("issue", "status", review, "done")
        assert done["status"] == "done" and done["delivered"] == "merged", done
        receipt = done["deliveryEvidence"]
        repo = command("repo", "list")[0]["path"]
        assert git(repo, "rev-parse", "HEAD") == receipt["mergedCommit"]
        assert git(repo, "show", "HEAD:clock.ts")
        assert git(worktree, "log", "--format=%s").splitlines().count("版本 B") == 1
        save("result", {"question": question, "review": review, "interrupted": interrupted, "reconciliation": runs[0], "retainedCommit": pending_commit, "delivery": receipt, "ok": True})
    finally:
        stop(proc)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("app", type=Path, help="VibeValley.app, or the native debug binary")
    parser.add_argument("--cli", type=Path, help="CLI binary when testing a debug build")
    parser.add_argument("--prepare-trial", action="store_true", help="leave the three decisions for a human tester in an isolated workspace")
    args = parser.parse_args()
    app = args.app.resolve(strict=True)
    binaries = app / "Contents/MacOS" if app.is_dir() else app.parent
    cli = args.cli.resolve(strict=True) if args.cli else binaries / "vibevalley"
    evidence = Path(tempfile.mkdtemp(prefix="vv-native-three-issues-")).resolve()
    print(evidence, flush=True)
    verify(binaries / "vibevalley-mac" if app.is_dir() else app, cli, evidence, args.prepare_trial)
    if not args.prepare_trial:
        print("Passed question, reviewed Git delivery and interrupted work recovery")
