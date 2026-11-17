import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import { expect, test } from "vite-plus/test";

import { pathOf } from "@vibevalley/protocol";

import { runVerification, readyAddress } from "./verify-server";

test("only a machine receipt from the owned process announces readiness", () => {
  expect(readyAddress("listening on http://127.0.0.1:9999", 17)).toBeUndefined();
  expect(readyAddress('{"note":"other stdout"}', 17)).toBeUndefined();
  expect(readyAddress('{"pid":18,"url":"http://127.0.0.1:9999"}', 17)).toBeUndefined();
  expect(readyAddress('{"pid":17,"url":"http://0.0.0.0:9999"}', 17)).toBeUndefined();
  expect(readyAddress('{"pid":17,"url":"http://127.0.0.1:0"}', 17)).toBeUndefined();
  expect(readyAddress('{"pid":17,"url":"http://127.0.0.1:9999"}', 17)).toBe("http://127.0.0.1:9999");
});

test("sandbox owns isolation, readiness, validation failure and cleanup", async () => {
  const result = await runVerification([
    "node",
    "--input-type=module",
    "-e",
    `
    import { spawn, spawnSync } from "node:child_process";
    const server = process.env.VIBEVALLEY_SERVER;
    const created = await fetch(server + '/api/v1/issue/create', {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({title:'sandbox fixture'})});
    if (!created.ok) throw new Error('create failed: ' + await created.text());
    const issue = (await created.json()).data;
    const cli = spawnSync(process.env.VIBEVALLEY_VERIFY_CLI, ['issue', 'list', '--json'], {env:process.env, encoding:'utf8'});
    if (cli.status !== 0) throw new Error('issue list failed');
    const issues = JSON.parse(cli.stdout);
    if (!issues.some(i => i.id === issue.id)) throw new Error('fixture absent from issue list');
    const descendant = spawn('sh', ['-c', 'sleep 30 & wait'], {stdio:'ignore'});
    console.log(JSON.stringify({issue:issue.id,title:issue.title,address:server,descendant:descendant.pid}));
    process.exit(23);
  `,
  ]);
  try {
    expect(result.code).toBe(23);
    expect(result.address).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/u);
    expect(JSON.parse(readFileSync(join(result.evidence, "health.json"), "utf8")).ok).toBe(true);
    const ready = JSON.parse(readFileSync(join(result.evidence, "ready.json"), "utf8"));
    expect(ready.url).toBe(result.address);
    expect(ready.pid).toBeGreaterThan(0);
    expect(readFileSync(join(result.evidence, "server.stdout.log"), "utf8")).toContain(JSON.stringify(ready));
    const output = JSON.parse(readFileSync(join(result.evidence, "command.stdout.log"), "utf8"));
    expect(output.title).toBe("sandbox fixture");
    let descendantAlive = true;
    try {
      process.kill(output.descendant, 0);
    } catch {
      descendantAlive = false;
    }
    expect(descendantAlive).toBe(false);
    for (const path of ["home", "work", "bin"]) expect(existsSync(join(result.evidence, path))).toBe(false);
    expect(
      await fetch(result.address + pathOf("server.health.get"), { method: "POST", signal: AbortSignal.timeout(500) }).then(
        () => true,
        () => false,
      ),
    ).toBe(false);
  } finally {
    rmSync(result.evidence, { recursive: true, force: true });
  }
}, 120_000);

test("with the scripted helper, an issue goes out, comes back and is completed through the command line alone", async () => {
  const result = await runVerification(
    [
      "node",
      "--input-type=module",
      "-e",
      `
      import { execFileSync } from "node:child_process";
      const server = process.env.VIBEVALLEY_SERVER;
      const cli = process.env.VIBEVALLEY_VERIFY_CLI;
      const post = async (path, body) => {
        const res = await fetch(server + path, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        const json = await res.json();
        if (!res.ok || json.bizCode !== 0) throw new Error(path + " failed: " + JSON.stringify(json));
        return json.data;
      };
      const vibe = (...args) => JSON.parse(execFileSync(cli, [...args, "--json"], { env: process.env, encoding: "utf8" }));
      const repo = await post("/api/v1/repo/create", { name: "clock" });
      const created = vibe("issue", "create", "写打卡并提交", "--repo", "clock", "--agent", "docs");
      vibe("issue", "status", created.id, "todo");
      let shown = vibe("issue", "get", created.id);
      const deadline = Date.now() + 30_000;
      while (shown.status !== "in_review" && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 100));
        shown = vibe("issue", "get", created.id);
      }
      if (shown.status !== "in_review") throw new Error("expected in_review, got " + shown.status);
      const changes = await post("/api/v1/issue/diff/get", { id: created.id });
      const preview = await post("/api/v1/issue/status/previewUpdate", { id: created.id, status: "done" });
      const done = vibe("issue", "status", created.id, "done");
      const merged = execFileSync("git", ["-C", repo.path, "ls-tree", "--name-only", "main", "clock.ts"], { encoding: "utf8" }).trim();
      console.log(JSON.stringify({ changes, preview, done, merged }));
      `,
    ],
    { scriptedHelper: true },
  );
  try {
    expect(result.code).toBe(0);
    const { changes, preview, done, merged } = JSON.parse(readFileSync(join(result.evidence, "command.stdout.log"), "utf8")) as {
      changes: { files: { path: string }[] };
      preview: { does: string[] };
      done: { status: string; delivered: string };
      merged: string;
    };
    expect(changes.files.map((f) => f.path)).toEqual(["clock.ts"]);
    expect(preview.does.at(-1)).toContain("done");
    expect(done).toMatchObject({ status: "done", delivered: "merged" });
    expect(merged).toBe("clock.ts");
  } finally {
    rmSync(result.evidence, { recursive: true, force: true });
  }
}, 120_000);
