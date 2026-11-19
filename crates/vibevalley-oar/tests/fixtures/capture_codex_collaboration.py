"""macOS: python3 capture_codex_collaboration.py /path/to/codex > captured.json

Runs the installed app-server with a synthetic Responses provider on loopback.
Raw thread metadata stays inside the temporary directory.
"""
import contextlib
import http.server
import json
import os
from pathlib import Path
import queue
import re
import subprocess
import sys
import tempfile
import threading
import time


class Responses(http.server.BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_POST(self):
        if self.path != "/v1/responses" or self.headers.get("Authorization"):
            self.send_error(403)
            return
        request = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.end_headers()
        items = request.get("input", [])
        calls = {i.get("name") for i in items if i.get("type") == "function_call"}
        prompt = json.dumps(items)
        response_id = "r_" + str(time.monotonic_ns())
        self.event("response.created", response={"id": response_id, "status": "in_progress", "output": []})
        if "spawn_agent" in calls and "wait_agent" not in calls:
            self.tool("wait_agent", {"timeout_ms": 10000}, 0)
            self.server.wait_requested.set()
        elif "wait_agent" not in calls and "Delegate two fixture checks." in prompt:
            for i, name in enumerate(["audit", "verify"]):
                self.tool("spawn_agent", {"task_name": name, "message": f"Fixture task {name}.", "fork_turns": "none"}, i)
        else:
            self.server.wait_requested.wait(5)
            if "Fixture task verify." in prompt and not calls:
                self.event("response.failed", response={"id": response_id, "status": "failed", "error": {"code": "invalid_prompt", "message": "Fixture failure"}})
                return
            item = {"type": "message", "role": "assistant", "id": "message_" + response_id, "status": "completed",
                    "content": [{"type": "output_text", "text": "Done.", "annotations": []}]}
            self.event("response.output_item.added", output_index=0, item={**item, "status": "in_progress", "content": []})
            self.event("response.output_text.delta", item_id=item["id"], output_index=0, content_index=0, delta="Done.")
            self.event("response.output_item.done", output_index=0, item=item)
        self.event("response.completed", response={"id": response_id, "status": "completed", "output": [],
                                                  "usage": {"input_tokens": 1, "output_tokens": 1, "total_tokens": 2}})

    def event(self, kind, **fields):
        self.wfile.write(f"event: {kind}\ndata: {json.dumps({'type': kind, **fields})}\n\n".encode())
        self.wfile.flush()

    def tool(self, name, args, index):
        call_id = name + str(index)
        item = {"id": "item_" + call_id, "call_id": call_id, "type": "function_call", "namespace": "collaboration",
                "name": name, "status": "completed", "arguments": json.dumps(args)}
        self.event("response.output_item.added", output_index=index, item=item)
        self.event("response.output_item.done", output_index=index, item=item)


class Rpc:
    def __init__(self, process):
        self.process = process
        self.messages = queue.Queue()
        self.notifications = []
        self.next_id = 0
        threading.Thread(target=self.read, daemon=True).start()

    def read(self):
        for line in self.process.stdout:
            self.messages.put(json.loads(line))
        self.messages.put(None)

    def next(self):
        message = self.messages.get(timeout=20)
        if message is None:
            raise RuntimeError("app-server closed stdout")
        if "method" in message:
            self.notifications.append(message)
        return message

    def send(self, message):
        self.process.stdin.write((json.dumps({"jsonrpc": "2.0", **message}) + "\n").encode())
        self.process.stdin.flush()

    def call(self, method, params):
        self.next_id += 1
        self.send({"id": self.next_id, "method": method, "params": params})
        while True:
            message = self.next()
            if message.get("id") == self.next_id:
                if "error" in message:
                    raise RuntimeError(message["error"])
                return message["result"]


@contextlib.contextmanager
def app_server(binary, temp, port=None):
    # A fresh credentials file store and the kernel network filter isolate both
    # the provider and all incidental client traffic.
    rules = "(version 1) (allow default) (deny network-outbound)"
    if port:
        rules += f' (allow network-outbound (remote ip "localhost:{port}"))'
    for path in [Path.home() / ".codex", Path.home() / "Library/Keychains"]:
        rules += f" (deny file-read* file-write* (subpath {json.dumps(str(path))}))"
    env = {"PATH": os.defpath, "CODEX_HOME": str(temp / "config"), "TMPDIR": str(temp), "NO_PROXY": "localhost,127.0.0.1", "no_proxy": "localhost,127.0.0.1"}
    with subprocess.Popen(["/usr/bin/sandbox-exec", "-p", rules, binary, "app-server", "--listen", "stdio://"],
                          cwd=temp / "work", env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL) as process:
        try:
            rpc = Rpc(process)
            rpc.call("initialize", {"clientInfo": {"name": "vibevalley", "version": "1"}, "capabilities": {"experimentalApi": True}})
            rpc.send({"method": "initialized"})
            yield rpc
        finally:
            process.terminate()
            try:
                process.wait(timeout=4)
            except subprocess.TimeoutExpired:
                process.kill()


def capture(binary, temp):
    work, config = temp / "work", temp / "config"
    work.mkdir()
    config.mkdir()
    with http.server.ThreadingHTTPServer(("127.0.0.1", 0), Responses) as server:
        port = server.server_port
        server.wait_requested = threading.Event()
        (config / "config.toml").write_text(f'''model_provider = "probe"
model = "gpt-5.5"
approval_policy = "never"
sandbox_mode = "read-only"
cli_auth_credentials_store = "file"
check_for_update_on_startup = false
[analytics]
enabled = false
[features]
multi_agent_v2 = true
[model_providers.probe]
name = "Loopback"
base_url = "http://127.0.0.1:{port}/v1"
wire_api = "responses"
requires_openai_auth = false
supports_websockets = false
request_max_retries = 0
stream_max_retries = 0
''')
        threading.Thread(target=server.serve_forever, daemon=True).start()
        try:
            with app_server(binary, temp, port) as rpc:
                root = rpc.call("thread/start", {"cwd": str(work), "approvalPolicy": "never", "sandbox": "read-only"})["thread"]["id"]
                rpc.call("turn/start", {"threadId": root, "input": [{"type": "text", "text": "Delegate two fixture checks."}]})
                deadline = time.monotonic() + 45
                while len({m["params"]["threadId"] for m in rpc.notifications if m["method"] == "turn/completed"}) < 3:
                    if time.monotonic() > deadline:
                        raise RuntimeError("expected the parent and both child turns to finish")
                    rpc.next()
                frames = rpc.notifications
        finally:
            server.shutdown()
    children = {i["agentThreadId"]: i["agentPath"] for m in frames for i in [m["params"].get("item", {})] if i.get("type") == "subAgentActivity"}
    with app_server(binary, temp) as reader:
        resumed = reader.call("thread/resume", {"threadId": root, "excludeTurns": True})
        assert resumed["thread"]["turns"] == []
        reads = [reader.call("thread/read", {"threadId": child, "includeTurns": True})["thread"] for child in sorted(children, key=children.get)]
    return root, children, frames, reads


def redact(root, children, frames, reads):
    ids = {root: "root-thread", **{child: path.rsplit("/", 1)[-1] + "-thread" for child, path in children.items()}}
    for frame in frames:
        p = frame["params"]
        if frame["method"] == "turn/started":
            ids[p["turn"]["id"]] = ids[p["threadId"]].removesuffix("-thread") + "-turn"
    def pick(obj, keys):
        return {key: obj[key] for key in keys.split() if key in obj}
    notifications = []
    for frame in frames:
        method, p = frame["method"], frame["params"]
        if method not in ("turn/started", "turn/completed", "item/started", "item/completed", "item/agentMessage/delta", "error"):
            continue
        keep = pick(p, "threadId turnId error delta willRetry itemId")
        if item := p.get("item"):
            if item.get("type") == "userMessage":
                continue
            keep["item"] = pick(item, "type kind id tool status agentThreadId agentPath senderThreadId receiverThreadIds prompt agentsStates text")
        if "turn" in p:
            keep["turn"] = pick(p["turn"], "id status error")
        notifications.append({"method": method, "params": keep})
    snapshots = []
    for thread in reads:
        record = pick(thread, "id parentThreadId preview source")
        record["turns"] = [pick(turn, "id status error") | {"items": [pick(item, "type text") for item in turn["items"]]} for turn in thread["turns"]]
        snapshots.append({"thread": record})
    data = json.dumps({"notifications": notifications, "reads": snapshots}, indent=2)
    for original, stable in ids.items():
        data = data.replace(original, stable)
    if re.search(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-", data) or str(Path.home()) in data:
        raise ValueError("unredacted identity in selected fields")
    return json.loads(data)


if __name__ == "__main__":
    binary = str(Path(sys.argv[1]).resolve(strict=True))
    version = subprocess.check_output([binary, "--version"], text=True).strip()
    with tempfile.TemporaryDirectory() as directory:
        result = redact(*capture(binary, Path(directory)))
    result["capture"] = {"cli": version, "features": {"multi_agent_v2": True}, "transport": "stdio",
                         "origin": "Isolated macOS app-server with scripted Responses on loopback, with credentials omitted and external connections denied.",
                         "reread": "Fresh app-server process with networking denied; thread/resume excluded turns before thread/read of known child ids.",
                         "redaction": "Preserves notification order and selected fields, substitutes thread/turn ids, omits disk paths, timestamps and token counts.",
                         "reproducer": Path(__file__).name}
    print(json.dumps(result, indent=2))
