import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test } from "vite-plus/test";

import { tempDir } from "@vibevalley/testkit/temp";

import { FileWriter } from "./files.ts";
import { newId } from "./ids.ts";
import { announce, announced, HomeTaken, leaseHome } from "./lease.ts";
import { redact, redactOutput } from "./redact.ts";

test("ids are uuidv7, unique, and sort in the order they were made", () => {
  const ids = Array.from({ length: 1000 }, () => newId());
  expect(new Set(ids).size).toBe(1000);
  for (const id of ids) expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
  expect([...ids].toSorted()).toEqual(ids);
});

test("secrets are taken out of text, and the rest is left", () => {
  for (const [input, want] of [
    ["用 sk-abcdefghijklmnop1234 调 DeepSeek", "用 [redacted] 调 DeepSeek"],
    ["DEEPSEEK_API_KEY=sk-abcdefghijklmnop1234", "DEEPSEEK_API_KEY=[redacted]"],
    ['{"api_key": "abc123def456"}', '{"api_key": "[redacted]"}'],
    ["export GITHUB_TOKEN=ghp_0123456789abcdefghijABCDEFGHIJ", "export GITHUB_TOKEN=[redacted]"],
    ["Authorization: Bearer hb_w1_AAAABBBBCCCCDDDDEEEE", "Authorization: Bearer [redacted]"],
    ["password: hunter2hunter2", "password: [redacted]"],
    ["AKIAABCDEFGHIJKLMNOP 是 AWS 的", "[redacted] 是 AWS 的"],
    ["xoxb-1234567890-abcdefghij", "[redacted]"],
    ["-----BEGIN RSA PRIVATE KEY-----\nMIIE\nabc\n-----END RSA PRIVATE KEY-----", "[redacted]"],
    ["eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U", "[redacted]"],
  ]) {
    expect(redact(input!)).toBe(want);
  }
  for (const kept of [
    "这个项目测试用 pnpm test",
    "登录态统一走 refreshSession()",
    "the token is refreshed every hour",
    "迁移文件放 db/migrations，表名用单数",
    "task-1234567890abcdef 是工单号",
  ]) {
    expect(redact(kept)).toBe(kept);
  }
});

test("what the server writes is redacted", () => {
  const said: unknown[] = [];
  const stream = { write: (chunk: unknown) => said.push(chunk) } as unknown as NodeJS.WriteStream;
  redactOutput(stream);
  stream.write("calling with sk-abcdefghijklmnop1234\n");
  stream.write(Buffer.from("token=abcdef123456\n"));
  expect(said).toEqual(["calling with [redacted]\n", "token=[redacted]\n"]);
});

test("a kept file is written whole, and not after it is finished", () => {
  const path = join(tempDir("vibevalley-files-"), "deep", "state.json");
  const w = new FileWriter(path);
  w.write(() => "one");
  expect(readFileSync(path, "utf8")).toBe("one");
  w.finish(() => "last");
  w.write(() => "late");
  expect(readFileSync(path, "utf8")).toBe("last");
});

test("one server per home; a stale lock is taken over", () => {
  const home = tempDir("vibevalley-lease-");
  const release = leaseHome(home);
  expect(() => leaseHome(home)).toThrow(HomeTaken);
  release();
  const again = leaseHome(home);
  again();
  writeFileSync(join(home, ".vibevalley.lock"), "999999");
  leaseHome(home)();
});

test("a server says where it listens in its home while it runs, and a stopped one's word is not taken", () => {
  const home = tempDir("vv-announce-");
  expect(announced(home)).toBeUndefined();
  const withdraw = announce(home, "http://127.0.0.1:56048");
  expect(announced(home)).toBe("http://127.0.0.1:56048");
  withdraw();
  expect(announced(home)).toBeUndefined();
  // Left behind by a server that died: its pid is not running.
  writeFileSync(join(home, "server.json"), JSON.stringify({ url: "http://127.0.0.1:1", pid: 2 ** 22 + 7 }));
  expect(announced(home)).toBeUndefined();
});
