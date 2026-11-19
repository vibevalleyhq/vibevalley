"""Check that a pending SQLite write cannot stall project navigation in GPUI."""

import argparse
import json
import os
from pathlib import Path
import sqlite3
import subprocess
from tempfile import TemporaryDirectory
from threading import Timer


def regression_open_project_while_another_connection_holds_the_store(binary, root, action):
    root = root.resolve()
    project = root / "project"
    project.mkdir(parents=True)
    home = root / "home"
    home.mkdir()
    db = root / "state.db"
    steps = root / "steps.jsonl"
    commands = [
        {"shell": "draw"},
        {"type": action, "path": str(project)},
        {"shell": "draw"},
        {"shell": "save"},
        {"shell": "quit"},
    ]
    steps.write_text("".join(json.dumps(command) + "\n" for command in commands))
    env = {
        key: value for key, value in os.environ.items()
        if not key.startswith("VIBEVALLEY_") and not any(part in key for part in ("API_KEY", "TOKEN", "PASSWORD", "SECRET"))
    }
    env.update(
        HOME=str(home), SHELL="/bin/sh", VIBEVALLEY_HOME=str(home),
        VIBEVALLEY_STORE=str(db), VIBEVALLEY_WORK_ROOT=str(root),
        VIBEVALLEY_PORT="0", VIBEVALLEY_NO_OPENING="1",
        VIBEVALLEY_TEST_RUNTIMES="1", VIBEVALLEY_DEBUG_SCRIPT=str(steps),
    )
    # The first debug step runs after the host has opened and migrated state.db.
    with sqlite3.connect(db) as writer, subprocess.Popen(
        [binary], cwd=root, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True
    ) as app:
        timeout = Timer(60, app.kill)
        timeout.start()
        acquired = released = False
        try:
            for line in app.stderr:
                if not line.startswith("debug script:"):
                    continue
                if json.dumps(commands[0]) in line and not acquired:
                    writer.execute("BEGIN IMMEDIATE")
                    acquired = True
                elif json.dumps(commands[2]) in line and not released:
                    writer.rollback()
                    released = True
            if app.wait() or not (acquired and released):
                raise RuntimeError(f"{action}: host did not paint while another writer held state.db")
            # A synchronous load reaches its busy timeout and falls back to a
            # transient project before the second draw can release the lock.
            row = writer.execute("SELECT id FROM projects WHERE path = ?", (str(project.resolve()),)).fetchone()
            if row is None:
                raise RuntimeError(f"{action}: project was not persisted after releasing the lock")
            print(f"{action}: next draw released the competing writer and project {row[0]} persisted")
        finally:
            timeout.cancel()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("binary", type=Path)
    binary = parser.parse_args().binary.resolve(strict=True)
    with TemporaryDirectory(prefix="vv-host-store-") as temp:
        for action in ("activate_path", "new_terminal_at"):
            regression_open_project_while_another_connection_holds_the_store(binary, Path(temp) / action, action)
