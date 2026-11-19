"""Capture the public Go/Web and GPUI farm routes with one saved business frame on macOS."""

import argparse
import re
from contextlib import contextmanager
from hashlib import file_digest, sha256
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
from math import ceil, floor
import select
import shutil
import signal
import struct
import subprocess
import sys
import tempfile
from threading import Event, Thread
from time import monotonic
from urllib.error import HTTPError
from urllib.parse import quote, urlsplit
from urllib.request import urlopen


from farm_motion import instrument_web

HERE = Path(__file__).resolve().parent
CASES = [
    {"name": "day", "width": 1280, "height": 800, "tod": 0.5, "clock": "12:00", "world": [190, 160, 860, 440]},
    {"name": "night", "width": 1280, "height": 800, "tod": 0.95, "clock": "22:45", "world": [190, 160, 860, 440]},
    {"name": "narrow", "width": 640, "height": 720, "tod": 0.5, "clock": "12:00", "world": [100, 170, 460, 300]},
]


def dump(path, data):
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n")


def digest(path):
    with path.open("rb") as file:
        return file_digest(file, "sha256").hexdigest()


def directory_digest(directory):
    entries = sha256()
    for path in sorted(p for p in directory.rglob("*") if p.is_file()):
        entries.update(os.fsencode(path.relative_to(directory)) + b"\0" + digest(path).encode() + b"\n")
    return entries.hexdigest()


def source(root, declared):
    if declared and not re.fullmatch(r"[0-9a-f]{40}|[0-9a-f]{64}", declared):
        raise ValueError("Use the full producer Git commit ID")
    if not root:
        if not declared:
            raise ValueError("An artifact without a source checkout needs its producer commit (--web-commit or --native-commit).")
        return {"producer_commit": declared, "source": "supplied"}
    def git(*args):
        return subprocess.check_output(["git", "-C", root, *args])
    commit = git("rev-parse", "HEAD").decode().strip()
    if declared and declared != commit:
        raise ValueError(f"Producer commit {declared} differs from {root} at {commit}")
    new_files = sha256()
    for name in sorted(filter(None, git("ls-files", "--others", "--exclude-standard", "-z").split(b"\0"))):
        path = root / os.fsdecode(name)
        if path.is_symlink():
            content = sha256(os.fsencode(os.readlink(path))).hexdigest()
        elif path.is_file():
            content = digest(path)
        else:
            raise ValueError(f"Cannot fingerprint untracked input: {path}")
        new_files.update(name + b"\0" + content.encode() + b"\n")
    return {"root": str(root), "commit": commit, "dirty": bool(git("status", "--porcelain")),
            "tracked_patch_sha256": sha256(git("diff", "--no-ext-diff", "--binary", "HEAD")).hexdigest(),
            "untracked_files_sha256": new_files.hexdigest()}


def run(command, cwd, log, **kwargs):
    with log.open("ab") as file:
        subprocess.run(command, cwd=cwd, stdout=file, stderr=subprocess.STDOUT, check=True, **kwargs)


def builds(args, out):
    log = out / "build.log"
    if not args.web_dist:
        if not args.web_root:
            raise ValueError("Pass --web-root to build or provide --web-dist")
        run(["vp", "run", "packages:build"], args.web_root, log)
        run(["vp", "run", "--filter", "@vibevalley/web", "build"], args.web_root, log)
        args.web_dist = args.web_root / "apps/web/dist"
    if not args.go_binary:
        if not args.web_root:
            raise ValueError("Pass --web-root or --go-binary")
        args.go_binary = out / "vibe-server"
        env = {k: v for k, v in os.environ.items() if k != "GOROOT"}
        run(["go", "build", "-o", args.go_binary, "./cmd/vibe-server"], args.web_root, log, env={**env, "CGO_ENABLED": "0"})
    if not args.native_bundle:
        if not args.native_root:
            raise ValueError("Pass --native-root to build or provide --native-bundle")
        if not (args.native_root / ".tools/bin/nsh").exists():
            run(["vp", "run", "nsh:install"], args.native_root, log)
        run(["vp", "run", "mac:check"], args.native_root, log)
        args.native_bundle = args.native_root / "apps/mac/ui/build"
    if not args.native_binary:
        if not args.native_root:
            raise ValueError("Pass --native-root or a debug --native-binary built with --features shot")
        run(["cargo", "build", "--locked", "-p", "vibevalley-mac", "--features", "shot"], args.native_root, log)
        metadata = json.loads(subprocess.check_output(["cargo", "metadata", "--no-deps", "--format-version=1"], cwd=args.native_root))
        args.native_binary = out / "vibevalley-mac"
        shutil.copy2(Path(metadata["target_directory"]) / "debug/vibevalley-mac", args.native_binary)
    if not args.native_assets and args.native_root:
        args.native_assets = args.native_root / "assets"
    if not args.native_assets or not args.native_assets.is_dir():
        raise ValueError("Missing --native-assets or native source assets")
    for path in [args.go_binary, args.native_binary, args.web_dist / "index.html", args.native_bundle / "bundle.js"]:
        if not path.is_file():
            raise FileNotFoundError(path)


def prepare_fixture(directory, out):
    raw = json.loads((directory / "state.json").read_text())
    responses = json.loads((directory / "responses.json").read_text())
    if not isinstance(raw.get("seq"), int) or not isinstance(raw["state"]["sessions"], list) or not isinstance(responses, dict):
        raise ValueError("The fixture needs a Go StateFrame with seq and sessions, plus a response map keyed by operation")
    native = json.loads(json.dumps(raw))
    for session in native["state"]["sessions"]:
        if (session.get("scope") or {}).get("kind") == "issue":
            session["issue"] = session["scope"]["id"]
        session.setdefault("refining", False)
    fixture = out / "fixture"
    fixture.mkdir()
    (fixture / "native").mkdir()
    dump(fixture / "state.json", raw)
    dump(fixture / "native/state.json", native)
    dump(fixture / "native/responses.json", responses)
    return raw, responses, fixture / "native"


def environment(directory):
    for name in ["home", "work"]:
        (directory / name).mkdir(parents=True)
    env = {key: os.environ[key] for key in ["PATH", "HOME", "USER", "LOGNAME", "TMPDIR"] if key in os.environ}
    return {**env, "LANG": "zh_CN.UTF-8", "VIBEVALLEY_HOME": str(directory / "home"),
            "VIBEVALLEY_WORK_ROOT": str(directory / "work"), "VIBEVALLEY_STORE": str(directory / "state.db"),
            "VIBEVALLEY_TEST_RUNTIMES": "1", "VIBEVALLEY_PORT": "0", "VIBEVALLEY_VOICE_LINE_PORT": "0",
            "VIBEVALLEY_LAN_PORT": "0", "VIBEVALLEY_NO_OPENING": "1", "VIBEVALLEY_UPDATE_FEED": "off",
            "VIBEVALLEY_PATROL_HEARTBEAT_MINUTES": "0", "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": "/dev/null"}


def sandbox(directory, command):
    isolated = ["Library/Application Support/VibeValley", ".vibevalley", "vibevalley-dev", ".codex", ".claude"]
    profile = directory / "sandbox.sb"
    rules = ['(version 1)', '(allow default)', '(deny network-outbound (remote ip "*:*"))',
             '(allow network-outbound (remote ip "localhost:*"))']
    rules += [f"(deny file-read* file-write* (subpath {json.dumps(str(Path.home() / path))}))" for path in isolated]
    profile.write_text("\n".join(rules))
    return ["/usr/bin/sandbox-exec", "-f", profile, *command]


@contextmanager
def process(command, cwd, env, log, stdout=None):
    with log.open("wb") as file:
        child = subprocess.Popen(command, cwd=cwd, env=env, stderr=file, stdout=stdout or file, start_new_session=True)
        try:
            yield child
        finally:
            if child.poll() is None:
                os.killpg(child.pid, signal.SIGTERM)
                try:
                    child.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    os.killpg(child.pid, signal.SIGKILL)
                    child.wait()
            if child.stdout:
                child.stdout.close()


@contextmanager
def reference(args, out):
    folder = out / "go"
    env = environment(folder)
    command = [args.go_binary, "--addr", "127.0.0.1:0", "--preview-addr", "127.0.0.1:0",
               "--db", folder / "home/server.db", "--work-root", folder / "work", "--ready-json", "--web", args.web_dist]
    with process(sandbox(folder, command), folder / "work", env, folder / "go.log", subprocess.PIPE) as proc:
        if not select.select([proc.stdout], [], [], 30)[0]:
            raise TimeoutError("Go server did not publish a ready receipt")
        receipt = json.loads(proc.stdout.readline())
        url = receipt["url"]
        if urlsplit(url).hostname != "127.0.0.1":
            raise ValueError(f"Expected a loopback URL: {url}")
        dump(folder / "ready.json", receipt)
        yield url


@contextmanager
def replay(upstream, state, responses, output):
    stopped = Event()
    reads, missing = {}, set()
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass

        def send_bytes(self, code, kind, body):
            self.send_response(code)
            self.send_header("Content-Type", kind)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            path = urlsplit(self.path).path
            if path.startswith("/api/v1/"):
                reads[path] = reads.get(path, 0) + 1
                if path not in ("/api/v1/state", "/api/v1/live", "/api/v1/events") and not path.startswith("/api/v1/subscribe/"):
                    missing.add(path)
                    self.send_error(404)
                    return
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                payload = (b"data: " + json.dumps(state, ensure_ascii=False).encode() + b"\n\n") if path == "/api/v1/state" else b": ready\n\n"
                try:
                    self.wfile.write(payload)
                    self.wfile.flush()
                    while not stopped.wait(2):
                        self.wfile.write(b": ping\n\n")
                        self.wfile.flush()
                except (BrokenPipeError, ConnectionResetError):
                    pass
                return
            try:
                with urlopen(upstream + self.path, timeout=15) as response:
                    self.send_bytes(response.status, response.headers.get("Content-Type", "application/octet-stream"), response.read())
            except HTTPError as error:
                self.send_error(error.code)
            except (BrokenPipeError, ConnectionResetError):
                pass

        def do_POST(self):
            path = urlsplit(self.path).path
            self.rfile.read(int(self.headers.get("content-length", 0)))
            op = path.removeprefix("/api/v1/").replace("/", ".")
            reads[op] = reads.get(op, 0) + 1
            if op not in responses:
                missing.add(op)
                self.send_error(HTTPStatus.NOT_FOUND)
                return
            data = json.dumps({"bizCode": 0, "message": "ok", "data": responses[op]}, ensure_ascii=False).encode()
            self.send_bytes(200, "application/json", data)

    with ThreadingHTTPServer(("127.0.0.1", 0), Handler) as server:
        thread = Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            yield f"http://127.0.0.1:{server.server_port}"
        finally:
            stopped.set()
            server.shutdown()
            thread.join()
            dump(output / "replay.json", {"reads": dict(sorted(reads.items())), "missing": sorted(missing)})
    if missing or "/api/v1/state" not in reads:
        raise ValueError(f"Web frame replay incomplete. See {output}/replay.json")


def farm_workers(frame, repo):
    plots = frame["view"]["plots"]
    return {s["id"] for s in frame["state"]["sessions"] if s.get("repo") == repo and (s.get("scope") or {}).get("id") in plots}


def native_ready(state, case, frame, repo):
    pixel = state.get("pixel") or {}
    scene = pixel.get("scene")
    if pixel.get("kind") != "farm" or not isinstance(scene, dict):
        return False
    placed = pixel.get("placed") or {}
    actors = {a["id"] for a in scene.get("actors", [])}
    ready = (farm_workers(frame, repo).issubset(actors) and state.get("loaded") and not state.get("load_error") and state.get("theme_dark")
            and pixel.get("frames_seen", 0) > 0
            and scene.get("seq") == frame["seq"] and scene.get("clock") == case["clock"]
            and placed.get("w") == case["width"] - 72 and placed.get("h") == case["height"]
            and repo in (pixel.get("draw") or {}).get("texts", [])
            and (state.get("workbench") or {}).get("ready") and not state["workbench"].get("errors"))
    motion = case.get("motion")
    if not ready or not motion:
        return ready
    receipt = scene.get("captureMotion")
    if not receipt or any(receipt.get(k) != motion[k] for k in ("seq", "ticks", "fireflySeed")) or abs(receipt["tod"] - motion["tod"]) > 0.000001:
        raise ValueError("The native shot build did not acknowledge the requested animation inputs")
    return receipt["advanced"] == motion["ticks"]



def native_capture(args, case, frame, fixture, out, captures):
    folder = out / ("native-" + case["name"])
    env = environment(folder)
    script, state, log = (folder / n for n in ["steps.jsonl", "state.json", "app.log"])
    with tempfile.TemporaryDirectory(prefix="farm-shots-", dir=folder) as scratch:
        samples = Path(scratch)
        commands = [f'resize:{case["width"]},{case["height"]}', "hosted:vv " + json.dumps({"route": args.route}),
                    f'pixel_clock:{case["tod"]},0', "draw", "draw"]
        # Current and earlier shot builds consume a script once. Admit frames only after the native state receipt.
        for i in range(80):
            if i % 4 == 0:
                commands.extend([f'pixel_clock:{case["tod"]},0', "draw"])
            commands.append("shot:" + str(samples / f"{i:02}.png"))
        commands.append("quit")
        script.write_text("".join(json.dumps({"shell": value}) + "\n" for value in commands))
        if motion := case.get("motion"):
            env["VIBEVALLEY_FARM_CAPTURE_MOTION"] = json.dumps(motion)
        env.update(VIBEVALLEY_FAKE_SERVER=str(fixture), VIBEVALLEY_ASSETS=str(args.native_assets),
                   VIBEVALLEY_UI_BUNDLE=str(args.native_bundle), VIBEVALLEY_DEBUG_SCRIPT=str(script),
                   VIBEVALLEY_DEBUG_DUMP=str(state))
        with process(sandbox(folder, [args.native_binary]), folder / "work", env, log) as proc:
            cutoff = None
            deadline = monotonic() + 90
            while monotonic() < deadline:
                messages = log.read_text(errors="replace")
                if "build with --features shot" in messages:
                    raise ValueError("The supplied native binary needs a debug build with --features shot")
                if cutoff is None and state.exists():
                    current = json.loads(state.read_text())
                    if native_ready(current, case, frame, args.repo):
                        dump(folder / "ready.json", current)
                        # Skip every shot already scheduled, including one whose PNG is being written.
                        cutoff = sum(line.startswith("debug script: {") and "shot:" in line for line in messages.splitlines())
                if cutoff is not None:
                    ids = [cutoff, cutoff + 1]
                    complete = [f"debug script: shot {samples / f'{i:02}.png'} " in messages for i in ids]
                    if all(complete):
                        for i, suffix in zip(ids, ["", "-repeat"]):
                            shutil.copyfile(samples / f"{i:02}.png", captures / f'native-{case["name"]}{suffix}.png')
                        dump(folder / "selection.json", {"scheduled_before_ready": cutoff, "accepted_indices": ids,
                                                          "ready_sha256": digest(folder / "ready.json")})
                        return
                if proc.poll() is not None:
                    break
                try:
                    proc.wait(timeout=0.1)
                except subprocess.TimeoutExpired:
                    pass
            raise RuntimeError(f"No pair of native frames after the readiness receipt. See {log} and {state}")


def size(path):
    with path.open("rb") as file:
        header = file.read(24)
    if header[:8] != b"\x89PNG\r\n\x1a\n" or header[12:16] != b"IHDR":
        raise ValueError(f"Expected PNG: {path}")
    return list(struct.unpack(">II", header[16:24]))


def compare(case, captures, out):
    name = case["name"]
    layout = json.loads((captures / f"web-{name}.json").read_text())
    if layout["dpr"] != case["dpr"] or layout["viewport"] != [case["width"], case["height"]]:
        raise ValueError(f"Wrong Web DPR or viewport for {name}: {layout}")
    x, y, width, _ = layout["canvas"]
    scale = width / 384
    def art_box(left, top, w, h):
        return [floor(x + left * scale), floor(y + top * scale), ceil(w * scale), ceil(h * scale)]
    regions = {"world": case["world"], "repo-sign-art": art_box(32, 84, 23, 22),
               "first-plot": art_box(119, 99, 18, 11), **layout["regions"]}
    pairs = [("pair", f"web-{name}", f"native-{name}"),
             ("web-noise", f"web-{name}", f"web-{name}-repeat"),
             ("native-noise", f"native-{name}", f"native-{name}-repeat")]
    verdict = {}
    for label, first, second in pairs:
        paths = [captures / (image + ".png") for image in (first, second)]
        expected = [case["dpr"] * case["width"], case["dpr"] * case["height"]]
        for path in paths:
            if size(path) != expected:
                raise ValueError(f"{path} is {size(path)}, expected {expected}; use the same display DPR on both sides")
        dst = out / "metrics" / name / label
        cmd = ["uv", "run", "--script", HERE / "compare-farm-frames.py", *paths, "--out", dst,
               "--reference-dpr", str(case["dpr"]), "--candidate-dpr", str(case["dpr"])]
        for part, bounds in regions.items():
            cmd.extend(["--region", part + "=" + ",".join(map(str, bounds))])
        result = subprocess.run(cmd, capture_output=True, text=True)
        report = dst / "metrics.json"
        if result.returncode not in (0, 1) or not report.is_file():
            raise RuntimeError(f"Image comparison failed for {name}/{label}: {result.stderr}")
        metrics = json.loads(report.read_text())
        verdict[label] = {"pass": metrics["pixels_pass"], "report": str(report.relative_to(out)),
                          "reference": str(paths[0].relative_to(out)), "reference_sha256": metrics["reference_sha256"],
                          "candidate": str(paths[1].relative_to(out)), "candidate_sha256": metrics["candidate_sha256"],
                          "full": metrics["regions"]["full"], "regions": metrics["regions"]}
    return verdict


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ["web-root", "native-root", "web-dist", "go-binary", "native-binary", "native-assets", "native-bundle"]:
        parser.add_argument("--" + name, type=lambda p: Path(p).resolve())
    parser.add_argument("--web-commit")
    parser.add_argument("--native-commit")
    parser.add_argument("--fixture", type=Path, default=HERE / "fixtures/farm-parity")
    parser.add_argument("--repo", default="parity")
    parser.add_argument("--out", required=True, type=lambda p: Path(p).resolve())
    parser.add_argument("--dpr", choices=[1, 2], default=2, type=int)
    parser.add_argument("--ticks", type=int, help="controlled capture: run this many 1/60 s simulation steps")
    parser.add_argument("--firefly-seed", type=int, help="controlled capture: shared firefly RNG input (uint32)")
    args = parser.parse_args()
    controlled = args.firefly_seed is not None or args.ticks is not None
    if controlled and (args.ticks is None or not 1 <= args.ticks < 2**32 or args.firefly_seed is None or not 0 <= args.firefly_seed < 2**32 or not args.web_root or args.web_dist):
        parser.error("Controlled capture requires positive --ticks, uint32 --firefly-seed and --web-root to build the pinned reference")
    if sys.platform != "darwin":
        raise ValueError("Live GPUI capture requires macOS")
    out = args.out
    out.mkdir(parents=True, exist_ok=True)
    if any(out.iterdir()):
        raise ValueError("Use a new or empty evidence directory")
    captures = out / "captures"
    captures.mkdir()
    args.route = "/farm/" + quote(args.repo, safe="")
    source_info = {"web": source(args.web_root, args.web_commit), "native": source(args.native_root, args.native_commit)}
    prebuilt = {"web": bool(args.web_dist), "go": bool(args.go_binary), "native": bool(args.native_binary), "ui": bool(args.native_bundle)}
    if controlled:
        args.web_dist = instrument_web(args.web_root, out, run)
    builds(args, out)
    state, responses, fixture = prepare_fixture(args.fixture, out)
    if args.repo not in [r.get("name") for r in responses.get("repo.list", [])]:
        raise ValueError(f"{args.repo} is missing from repo.list in the supplied fixture")
    cases = [{**case, "dpr": args.dpr} for case in CASES]
    if controlled:
        for case in cases:
            case["motion"] = {"ticks": args.ticks, "fireflySeed": args.firefly_seed, "seq": state["seq"], "tod": case["tod"]}
    mode = "fixed_ticks_firefly_seed" if controlled else "natural"
    dump(out / "cases.json", cases)
    manifest = {"comparison_mode": mode, "sources": source_info, "supplied_artifacts": prebuilt, "route": args.route,
                "frame_seq": state["seq"], "web_frame_sha256": digest(out / "fixture/state.json"),
                "native_frame_sha256": digest(fixture / "state.json"), "responses_sha256": digest(fixture / "responses.json"),
                "go_binary_sha256": digest(args.go_binary), "native_binary_sha256": digest(args.native_binary),
                "web_dist_sha256": directory_digest(args.web_dist), "native_bundle_sha256": directory_digest(args.native_bundle),
                "native_assets_sha256": directory_digest(args.native_assets)}
    if shutil.which("go"):
        info = subprocess.run(["go", "version", "-m", args.go_binary], capture_output=True, text=True)
        if info.returncode == 0:
            (out / "go-build-info.txt").write_text(info.stdout)
            rev = re.search(r"vcs\.revision=([a-f0-9]+)", info.stdout)
            expected = source_info["web"].get("commit") or source_info["web"].get("producer_commit")
            if rev and rev.group(1) != expected:
                raise ValueError(f"Go binary is from {rev.group(1)}, expected {expected}")
    manifest["tools"] = {p.name: digest(p) for p in [Path(__file__), HERE / "capture-farm-web.mjs", HERE / "compare-farm-frames.py"]}
    if controlled:
        manifest["tools"]["farm_motion.py"] = digest(HERE / "farm_motion.py")
        manifest["web_motion_patch_sha256"] = digest(out / "web-motion-inputs.patch")
    after = {"web": source(args.web_root, args.web_commit), "native": source(args.native_root, args.native_commit)}
    if after != source_info:
        manifest["sources_after_build"] = after
    manifest["workers"] = sorted(farm_workers(state, args.repo))
    manifest["issues"] = {issue["id"]: issue["stage"]["state"] for issue in state["state"]["issues"] if issue.get("repo") == args.repo}
    dump(out / "manifest.json", manifest)
    with reference(args, out) as go_url, replay(go_url, state, responses, out) as url:
        run(["node", HERE / "capture-farm-web.mjs", url, args.route, out / "cases.json", captures],
            out, out / "browser.log", timeout=145)
    for case in cases:
        native_capture(args, case, state, fixture, out, captures)
    scores = {case["name"]: compare(case, captures, out) for case in cases}
    if controlled:
        for case in cases:
            name = case["name"]
            web = json.loads((captures / f"web-{name}.json").read_text())["motion"]["fireflyLights"]
            pixel = json.loads((out / f"native-{name}/ready.json").read_text())["pixel"]
            native = pixel.get("sampledFireflies")
            if native is not None:
                deviation = max((abs(a - b) for left, right in zip(sorted(web), sorted(native)) for a, b in zip(left, right)), default=0.0) if len(native) == len(web) else None
                scores[name]["firefly_observation"] = {"web_count": len(web), "native_count": len(native), "max_component_difference": deviation}
    pair = all(s["pair"]["pass"] for s in scores.values())
    noise = all(s["web-noise"]["pass"] and s["native-noise"]["pass"] for s in scores.values())
    dump(out / "result.json", {"comparison_mode": mode, "paired_pass": pair, "noise_within_thresholds": noise, "cases": scores})
    print(f"{out}/result.json: paired_pass={pair}, noise_within_thresholds={noise}")
    return 0 if pair and noise else 1


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (ValueError, TypeError, RuntimeError, OSError, subprocess.SubprocessError, KeyError) as error:
        print(f"Farm capture failed: {error}", file=sys.stderr)
        sys.exit(2)
