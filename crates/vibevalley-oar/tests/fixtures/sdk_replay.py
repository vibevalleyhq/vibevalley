#!/usr/bin/env python3
import json
import os
from pathlib import Path
import stat
import sys

observed = Path(os.environ["REPLAY_LOG"])

def record(entry):
    with observed.open("a") as stream:
        print(json.dumps(entry), file=stream)

def emit(entry):
    print(json.dumps(entry), flush=True)

def file_info(flag):
    if flag not in sys.argv:
        return None
    path = Path(sys.argv[sys.argv.index(flag) + 1])
    return [str(path), stat.S_IMODE(path.parent.stat().st_mode), stat.S_IMODE(path.stat().st_mode), path.read_text()]

record({"argv": sys.argv[1:], "usage": os.environ.get("QODER_EXPOSE_TOKEN_USAGE"), "prompt": file_info("--system-prompt-file"), "append": file_info("--append-system-prompt-file"), "mcp": file_info("--mcp-config")})
for line in sys.stdin:
    message = json.loads(line)
    record(message)
    if message["type"] == "control_request":
        emit({"type": "control_response", "response": {"subtype": "success", "request_id": message["request_id"]}})
        if message["request"]["subtype"] == "initialize":
            emit({"type": "system", "subtype": "init", "session_id": "vendor-42"})
    elif message["type"] == "user":
        emit({"type": "assistant", "session_id": "vendor-42", "message": {"content": [{"type": "text", "text": "hello sdk"}]}})
        usage = {"input_tokens": 30, "output_tokens": 12} if "--channel=SDK" in sys.argv else None
        emit({"type": "result", "subtype": "success", "session_id": "vendor-42", "usage": usage})
