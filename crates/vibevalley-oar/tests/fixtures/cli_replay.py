#!/usr/bin/env python3
"""Replay responses captured from the Go replaytest fixture, echoing the current request ID."""
import json
import os
import sys
import subprocess
import socket

with open(os.environ["OAR_REPLAY_FILE"]) as stream:
    responses = json.load(stream)

if path := os.environ.get("OAR_REPLAY_CHILD"):
    child = subprocess.Popen([sys.executable, "-c", "import signal; signal.pause()"])
    with open(path, "w") as out:
        json.dump([os.getpid(), child.pid], out)

for raw in sys.stdin:
    request = json.loads(raw)
    operation = request.get("method") or request.get("request", {}).get("subtype") or request.get("type")
    if request.get("message", {}).get("content") in ("hold", "release"):
        operation = request["message"]["content"]
    if request.get("message", {}).get("content") == "/compact":
        operation = "compact"
    if operation == "user" and "OAR_REPLAY_EXIT" in os.environ:
        sys.exit(int(os.environ["OAR_REPLAY_EXIT"]))
    for index, record in enumerate(responses.get(operation, [])):
        if index == 1 and operation == "thread/compact/start" and "OAR_REPLAY_GATE" in os.environ:
            with socket.socket(socket.AF_UNIX) as gate:
                gate.connect(os.environ["OAR_REPLAY_GATE"])
                gate.sendall(b"held")
                gate.recv(1)
        row = dict(record)
        if "id" in row and row["id"] == 9412:
            if "id" not in request:
                continue
            row["id"] = request["id"]
        if "response" in row and "request_id" in row["response"]:
            row["response"] = dict(row["response"], request_id=request["request_id"])
        print(json.dumps(row), flush=True)
