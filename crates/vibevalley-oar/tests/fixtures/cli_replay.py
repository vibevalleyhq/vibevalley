#!/usr/bin/env python3
"""Replay responses captured from the Go replaytest fixture, echoing the current request ID."""
import json
import os
import sys

with open(os.environ["OAR_REPLAY_FILE"]) as stream:
    responses = json.load(stream)

for raw in sys.stdin:
    request = json.loads(raw)
    operation = request.get("method") or request.get("request", {}).get("subtype") or request.get("type")
    if request.get("message", {}).get("content") in ("hold", "release"):
        operation = request["message"]["content"]
    if request.get("message", {}).get("content") == "/compact":
        operation = "compact"
    for record in responses.get(operation, []):
        row = dict(record)
        if "id" in row and row["id"] == 9412:
            if "id" not in request:
                continue
            row["id"] = request["id"]
        if "response" in row and "request_id" in row["response"]:
            row["response"] = dict(row["response"], request_id=request["request_id"])
        print(json.dumps(row), flush=True)
