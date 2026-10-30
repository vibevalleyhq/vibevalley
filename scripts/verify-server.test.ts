import { expect, test } from "vite-plus/test";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { runVerification, readyAddress } from "./verify-server";
import { pathOf } from "../packages/protocol/src/shapes.ts";

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
    const issue = await created.json();
    const cli = spawnSync(process.env.VIBEVALLEY_VERIFY_CLI, ['state'], {env:process.env, encoding:'utf8'});
    if (cli.status !== 0) throw new Error('state failed');
    const frame = JSON.parse(cli.stdout);
    if (!frame.state.issues.some(i => i.id === issue.id)) throw new Error('fixture absent from state');
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
}, 60_000);

test("with the scripted helper, an issue goes out, comes back and is completed through the command line alone", async () => {
  const result = await runVerification(
    [
      "sh",
      "-c",
      `set -e
      vv() { "$VIBEVALLEY_VERIFY_CLI" "$@"; }
      vv issue create --json '{"title":"写打卡并提交","project":"clock","assignee":"docs"}' > /dev/null
      vv issue work 1
      vv issue status update 1 --dry-run --json '{"status":"done"}'
      vv issue status update 1 --json '{"status":"done"}'
      project=$(vv project list | node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(0, "utf8"))[0].path)')
      git -C "$project" ls-tree --name-only main clock.ts`,
    ],
    { scriptedHelper: true },
  );
  try {
    expect(result.code).toBe(0);
    const [changes, preview, done, merged] = readFileSync(join(result.evidence, "command.stdout.log"), "utf8").trim().split("\n");
    expect((JSON.parse(changes!) as { files: { path: string }[] }).files.map((f) => f.path)).toEqual(["clock.ts"]);
    expect((JSON.parse(preview!) as { does: string[] }).does.at(-1)).toContain("合进 main");
    expect(JSON.parse(done!)).toMatchObject({ status: "done", delivered: "merged" });
    expect(merged).toBe("clock.ts");
  } finally {
    rmSync(result.evidence, { recursive: true, force: true });
  }
}, 120_000);
