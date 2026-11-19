"""Drive the native farm chat, scheduled work and bundled CLI against a loopback-only model."""
import argparse
import datetime
import hashlib
import json
import subprocess
import tempfile
import threading
import time
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


UTTERANCE = "create a field issue"
TITLE = "Native assistant from field"
CHANNEL_TEXT = "Native CLI receipt"
TOOL_CALL = "offline-field-create"
WINDOW = (1280, 820)
# The farm-chat-input rectangle in window points with the handset open at this viewport.
CHAT_INPUT = (125, 599, 732, 651)


def save(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n")


def manager_area(assets):
    level = json.loads((assets / "village.ldtk").read_text())["levels"][0]
    areas = [entity for layer in level["layerInstances"] for entity in layer["entityInstances"]
             if entity["__identifier"] in ("Prop", "Area") and
             any(f["__identifier"] == "spot" and f["__value"] == "manager" for f in entity["fieldInstances"])]
    if len(areas) != 1:
        raise ValueError(f"Expected one manager in {assets}/village.ldtk, found {len(areas)}")
    area = areas[0]
    x, y = area["px"]
    w, h = area["width"], area["height"]
    ax, ay = area["__pivot"]
    return (x - ax * w, y - ay * h, x + (1 - ax) * w, y + (1 - ay) * h)


def midpoint(bounds):
    x0, y0, x1, y1 = bounds
    return (x0 + x1) / 2, (y0 + y1) / 2


class LocalModel(ThreadingHTTPServer):
    def __init__(self, evidence):
        self.events = []
        self.evidence = evidence
        self.sent = False
        super().__init__(("127.0.0.1", 0), ModelRequest)


class ModelRequest(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        pass

    def do_POST(self):
        if self.path != "/chat/completions" or self.headers.get("Authorization") != "Bearer local-fixture":
            self.send_error(403)
            return
        request = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        messages = request["messages"]
        heard = any(UTTERANCE in str(m.get("content", "")) for m in messages if m["role"] == "user")
        if heard and not self.server.sent:
            assert "issue_create" in [t["function"]["name"] for t in request["tools"]]
            self.server.sent = True
            args = {"title": TITLE, "agent": "docs", "repo": "field-project", "start": True}
            call = {"index": 0, "id": TOOL_CALL, "type": "function",
                    "function": {"name": "issue_create", "arguments": json.dumps(args)}}
            choice = {"delta": {"tool_calls": [call]}, "finish_reason": "tool_calls"}
        else:
            choice = {"delta": {"content": "Local dispatch complete."}, "finish_reason": "stop"}
        self.server.events.append({"heard": heard, "toolResultIds": [m.get("tool_call_id") for m in messages if m["role"] == "tool"], "choice": choice})
        save(self.server.evidence / "local-model.json", self.server.events)
        chunk = {"choices": [choice], "usage": {"prompt_tokens": 9, "completion_tokens": 3}}
        body = f"data: {json.dumps(chunk)}\n\ndata: [DONE]\n\n".encode()
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def verify(app, cli, assets, root):
    home, work, user = (root / name for name in ("home", "work", "user"))
    for path in (home, work, user):
        path.mkdir()
    model = LocalModel(root)
    threading.Thread(target=model.serve_forever, daemon=True).start()
    env = {
        "PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "HOME": str(user), "LANG": "en_US.UTF-8",
        "TZ": "UTC", "TMPDIR": str(root), "GIT_CONFIG_NOSYSTEM": "1",
        "GIT_AUTHOR_NAME": "Acceptance", "GIT_COMMITTER_NAME": "Acceptance",
        "GIT_AUTHOR_EMAIL": "test@example.invalid", "GIT_COMMITTER_EMAIL": "test@example.invalid",
        "VIBEVALLEY_HOME": str(home), "VIBEVALLEY_WORK_ROOT": str(work), "VIBEVALLEY_STORE": str(root / "state.db"),
        "VIBEVALLEY_NO_OPENING": "1", "VIBEVALLEY_PORT": "0", "VIBEVALLEY_VOICE_LINE_PORT": "0",
        "VIBEVALLEY_TEST_RUNTIMES": "1", "VIBEVALLEY_TEST_MODEL_PORT": str(model.server_port),
        "DEEPSEEK_API_KEY": "local-fixture", "VIBEVALLEY_AGENT_STARTERS": "docs", "VIBEVALLEY_UPDATE_FEED": "off",
        "VIBEVALLEY_PATROL_HEARTBEAT_MINUTES": "0", "VIBEVALLEY_DEBUG_DUMP": str(root / "dump.json"),
        "VIBEVALLEY_DEBUG_SCRIPT": str(root / "steps.jsonl"),
    }
    area = manager_area(assets)
    mx, my = midpoint(area)
    ix, iy = midpoint(CHAT_INPUT)
    steps = [f"resize:{WINDOW[0]},{WINDOW[1]}", 'hosted:vv {"route":"/farm"}', "draw", "draw",
             f"pixel_tap:{mx:g},{my:g}", "draw", "draw", f"shot:{root}/chat.png",
             f"mouse:click,{ix:g},{iy:g}", f"type:{UTTERANCE}", f"shot:{root}/typed.png",
             "key:enter", f"shot:{root}/sent.png"]
    (root / "steps.jsonl").write_text("".join(json.dumps({"shell": s}) + "\n" for s in steps))
    policy = '(version 1)(allow default)(deny network-outbound)(allow network-outbound (remote ip "localhost:*"))'
    with (root / "app.log").open("w") as log:
        proc = subprocess.Popen(["/usr/bin/sandbox-exec", "-p", policy, app], cwd=work, env=env, stdout=log, stderr=log)

    def until(label, read, timeout=40):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if proc.poll() is not None:
                raise RuntimeError(f"App exited during {label}: {proc.returncode}")
            value = read()
            if value:
                return value
            time.sleep(0.1)
        raise TimeoutError(label)

    def ready():
        try:
            receipt = json.loads((home / "server.json").read_text())
            return receipt if receipt["pid"] == proc.pid else None
        except (OSError, ValueError):
            return None

    def field_open():
        try:
            state = json.loads((root / "dump.json").read_text())
        except (OSError, ValueError):
            return None
        farm = state.get("pixel") or {}
        if farm.get("kind") != "farm" or not farm.get("taps"):
            return None
        expected = 'Spot { id: "manager", opens: "chat" }'
        assert farm["taps"][0] == expected, ("first farm action", farm["taps"])
        return {"viewport": WINDOW, "managerArea": area, "managerTap": [mx, my], "firstAction": expected,
                "farmViewport": farm["placed"], "inputBounds": CHAT_INPUT, "inputTap": [ix, iy], "submit": "enter"}

    def api(op, args):
        req = urllib.request.Request(address + "/api/v1/" + op.replace(".", "/"), data=json.dumps(args).encode(), headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=8) as response:
            envelope = json.load(response)
        assert envelope["bizCode"] == 0, (op, envelope)
        return envelope.get("data")

    def command(*args):
        result = subprocess.run([cli, *args, "--format", "json"], cwd=work, env=env, text=True, capture_output=True, timeout=35)
        assert result.returncode == 0, (args, result.stdout, result.stderr)
        return json.loads(result.stdout)

    def completed(issue_id):
        def read():
            runs = api("issue.run.list", {"id": issue_id})
            return runs if len(runs) == 1 and runs[0].get("outcome") == "completed" else None
        return until(f"completed run for {issue_id}", read)

    try:
        receipt = until("server startup", ready)
        address = receipt["url"]
        save(root / "server.json", receipt)
        command("repo", "create", "field-project")
        api("runtime.refresh", {"id": "pi"})
        doctor = command("doctor")
        assert all(item["ok"] for item in doctor)
        save(root / "doctor.json", doctor)
        interaction = until("farm manager opened the field chat", field_open)
        save(root / "interaction.json", interaction)
        def submitted():
            hits = api("channel.message.search", {"text": UTTERANCE})
            return next((h["message"] for h in hits if h["message"]["text"] == UTTERANCE), None)
        user_message = until("field textarea submitted the message", submitted)
        assert user_message["sendKey"]
        until("local model received the field message", lambda: any(e["heard"] for e in model.events))
        dispatched = until("issue dispatched by the field chat", lambda: next((i for i in api("issue.list", {}) if i["title"] == TITLE), None))
        field_run = completed(dispatched["id"])
        until("orchestrator received issue_create result", lambda: any(TOOL_CALL in e["toolResultIds"] for e in model.events))
        save(root / "field.json", {"message": user_message, "issue": dispatched, "runs": field_run})

        channel = user_message["channel"]
        command("channel", "message", "send", channel, CHANNEL_TEXT)
        history = command("channel", "message", "list", channel)
        found = command("channel", "message", "search", CHANNEL_TEXT)
        assert sum(m["text"] == CHANNEL_TEXT for m in history) == 1
        cli_msg = next(h["message"] for h in found if h["message"]["text"] == CHANNEL_TEXT)
        save(root / "channel.json", cli_msg)

        due = datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(seconds=4)
        timer = command("cron", "create", "release-check", "Scheduled worker", "--at", due.isoformat(timespec="seconds"), "--agent", "docs", "--repo", "field-project")
        scheduled = until("real clock tick", lambda: next((i for i in api("issue.list", {}) if i.get("cron") == timer["id"]), None), 50)
        scheduled_run = completed(scheduled["id"])
        recorded_timer = next(t for t in command("cron", "list") if t["id"] == timer["id"])
        assert not recorded_timer["enabled"] and recorded_timer["lastRun"] >= timer["when"]["at"]
        save(root / "cron.json", {"scheduled": timer, "fired": recorded_timer, "issue": scheduled, "runs": scheduled_run})
        save(root / "result.json", {
            "ok": True, "appSHA256": hashlib.sha256(app.read_bytes()).hexdigest(), "cliSHA256": hashlib.sha256(cli.read_bytes()).hexdigest(),
            "modelEndpoint": f"http://127.0.0.1:{model.server_port}", "fieldMessage": user_message["id"], "dispatchIssue": dispatched["id"],
            "firstFarmAction": interaction["firstAction"], "workerRun": field_run[0]["id"], "doctor": "passed", "cliMessage": cli_msg["id"],
            "cron": timer["id"], "scheduledIssue": scheduled["id"], "scheduledRun": scheduled_run[0]["id"],
        })
    finally:
        if proc.poll() is None:
            proc.terminate()
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait()
        model.shutdown()
        model.server_close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("app", type=Path, help="VibeValley.app or native debug executable")
    parser.add_argument("--cli", type=Path, help="CLI executable if it is not beside the desktop executable")
    args = parser.parse_args()
    app_path = args.app.resolve(strict=True)
    binary = app_path / "Contents/MacOS/vibevalley-mac" if app_path.is_dir() else app_path
    assets = app_path / "Contents/Resources/assets" if app_path.is_dir() else Path(__file__).resolve().parents[2] / "assets"
    cli_path = args.cli.resolve(strict=True) if args.cli else binary.parent / "vibevalley"
    evidence = Path(tempfile.mkdtemp(prefix="vv-native-dispatch-")).resolve()
    print(evidence, flush=True)
    verify(binary, cli_path, assets, evidence)
    print("Passed native farm chat, scheduled dispatch and CLI diagnostics")
