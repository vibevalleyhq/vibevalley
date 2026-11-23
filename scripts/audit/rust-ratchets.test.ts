import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { describe, expect, test } from "vite-plus/test";

import { SERVER_BLOCK_ON_CEILING, auditRustRatchets, auditWorkspaceRatchets, formatRatchetViolations, type SourceFile } from "./rust-ratchets.ts";

describe("no-pollster", () => {
  test("forbids pollster in Cargo.toml and .rs files under crates/ and apps/mac/", () => {
    const files: SourceFile[] = [
      {
        path: "crates/server/Cargo.toml",
        text: '[dependencies]\npollster = "0.4"\n',
      },
      {
        path: "apps/mac/Cargo.toml",
        text: "[dependencies]\npollster.workspace = true\n",
      },
      {
        path: "crates/runtime/src/lib.rs",
        text: "pub fn run() { pollster::block_on(async {}); }\n",
      },
      {
        path: "apps/mac/src/shell/mod.rs",
        text: "#[cfg(test)]\nmod tests { fn t() { let _ = pollster::block_on(async { 1 }); } }\n",
      },
    ];

    const violations = auditRustRatchets(files);
    expect(violations.map((v) => `${v.rule}@${v.file}:${v.line}`)).toEqual([
      "no-pollster@apps/mac/Cargo.toml:2",
      "no-pollster@apps/mac/src/shell/mod.rs:2",
      "no-pollster@crates/runtime/src/lib.rs:1",
      "no-pollster@crates/server/Cargo.toml:2",
    ]);
    const formatted = formatRatchetViolations(violations);
    expect(formatted).toContain("Fix:");
    expect(formatted).toContain("See: docs/style/rust-async-concurrency.md");
  });

  test("ignores pollster in comments and Rust string literals", () => {
    const files: SourceFile[] = [
      {
        path: "crates/server/Cargo.toml",
        text: '# Keep pollster out of dependencies.\n[dependencies]\ntokio = "1"\n',
      },
      {
        path: "crates/server/src/lib.rs",
        text: '// Never call pollster::block_on.\nconst MSG: &str = "pollster is banned";\n',
      },
    ];

    expect(auditRustRatchets(files)).toEqual([]);
  });
});

describe("no-thread-sleep-in-zeroed-zones", () => {
  test("forbids std::thread::sleep and thread::sleep in crates/server/tests/ and apps/mac/src/", () => {
    const files: SourceFile[] = [
      {
        path: "crates/server/tests/issue.rs",
        text: "fn wait() { std::thread::sleep(std::time::Duration::from_millis(10)); }\n",
      },
      {
        path: "apps/mac/src/hosted/mod.rs",
        text: "use std::thread;\nfn pause() { thread::sleep(std::time::Duration::from_millis(5)); }\n",
      },
    ];

    const violations = auditRustRatchets(files);
    expect(violations.map((v) => `${v.rule}@${v.file}:${v.line}`)).toEqual([
      "no-thread-sleep-in-zeroed-zones@apps/mac/src/hosted/mod.rs:2",
      "no-thread-sleep-in-zeroed-zones@crates/server/tests/issue.rs:1",
    ]);
    const formatted = formatRatchetViolations(violations);
    expect(formatted).toContain("tokio::time::advance");
    expect(formatted).toContain("Fix:");
    expect(formatted).toContain("See: docs/style/rust-async-concurrency.md");
  });

  test("permits documented // ratchet-allow: no-thread-sleep and rejects bare undocumented allowances", () => {
    const files: SourceFile[] = [
      {
        path: "apps/mac/src/speech_audio.rs",
        text: [
          "// ratchet-allow: no-thread-sleep -- CoreAudio ring buffer drain waits for hardware callback",
          "std::thread::sleep(std::time::Duration::from_millis(2));",
        ].join("\n"),
      },
      {
        path: "crates/server/tests/watch.rs",
        text: ["// ratchet-allow: no-thread-sleep", "std::thread::sleep(std::time::Duration::from_millis(2));"].join("\n"),
      },
      {
        path: "crates/server/tests/clean.rs",
        text: "tokio::time::sleep(std::time::Duration::from_millis(2)).await;\n",
      },
    ];

    const violations = auditRustRatchets(files);
    expect(violations.map((v) => `${v.rule}@${v.file}:${v.line}`)).toEqual(["no-thread-sleep-in-zeroed-zones@crates/server/tests/watch.rs:2"]);
  });
});

describe("no-mac-rt-handle", () => {
  test("forbids vibevalley_runtime::rt::handle and rt::handle( in apps/mac/src/ while allowing current_or_global_handle", () => {
    const files: SourceFile[] = [
      {
        path: "apps/mac/src/island.rs",
        text: "fn spawn_bad() { vibevalley_runtime::rt::handle().spawn(async {}); }\n",
      },
      {
        path: "apps/mac/src/hosted/remote.rs",
        text: "use vibevalley_runtime::rt;\nfn spawn_bad2() { rt::handle().spawn(async {}); }\n",
      },
      {
        path: "apps/mac/src/live_voice.rs",
        text: "fn spawn_ok() { vibevalley_runtime::rt::current_or_global_handle().spawn(async {}); }\n",
      },
    ];

    const violations = auditRustRatchets(files);
    expect(violations.map((v) => `${v.rule}@${v.file}:${v.line}`)).toEqual([
      "no-mac-rt-handle@apps/mac/src/hosted/remote.rs:2",
      "no-mac-rt-handle@apps/mac/src/island.rs:1",
    ]);
    const formatted = formatRatchetViolations(violations);
    expect(formatted).toContain("Server::call_with_async");
    expect(formatted).toContain("Fix:");
    expect(formatted).toContain("See: docs/style/rust-async-concurrency.md");
  });
});

describe("no-rich-sync-try-current", () => {
  test("forbids Handle::try_current() in crates/rich/src/ outside crates/rich/src/highlight.rs", () => {
    const files: SourceFile[] = [
      {
        path: "crates/rich/src/code_block.rs",
        text: "if tokio::runtime::Handle::try_current().is_ok() {}\n",
      },
      {
        path: "crates/rich/src/mermaid.rs",
        text: "use tokio::runtime::Handle;\nlet ok = Handle::try_current().is_ok();\n",
      },
      {
        path: "crates/rich/src/highlight.rs",
        text: "pub fn run_offloaded() { let _ = tokio::runtime::Handle::try_current(); }\n",
      },
    ];

    const violations = auditRustRatchets(files);
    expect(violations.map((v) => `${v.rule}@${v.file}:${v.line}`)).toEqual([
      "no-rich-sync-try-current@crates/rich/src/code_block.rs:1",
      "no-rich-sync-try-current@crates/rich/src/mermaid.rs:2",
    ]);
    const formatted = formatRatchetViolations(violations);
    expect(formatted).toContain("crate::highlight::run_offloaded");
    expect(formatted).toContain("Fix:");
    expect(formatted).toContain("See: docs/style/rust-async-concurrency.md");
  });
});

describe("no-raw-tcp-http-mock", () => {
  test("forbids std::net::TcpListener::bind in crates/server/tests/ while allowing axum + tokio::net::TcpListener and connector serve_ws", () => {
    const files: SourceFile[] = [
      {
        path: "crates/server/tests/ai_mock.rs",
        text: 'use std::net::TcpListener;\nfn mock() { let _ = TcpListener::bind("127.0.0.1:0"); }\n',
      },
      {
        path: "crates/server/tests/qualified_mock.rs",
        text: 'fn mock() { let _ = std::net::TcpListener::bind("127.0.0.1:0"); }\n',
      },
      {
        path: "crates/server/tests/axum_good.rs",
        text: ["use tokio::net::TcpListener;", 'async fn mock() { let _ = TcpListener::bind("127.0.0.1:0").await; }'].join("\n"),
      },
      {
        path: "crates/server/tests/connector.rs",
        text: [
          "use std::net::TcpListener;",
          'async fn serve_http() { let _ = tokio::net::TcpListener::bind("127.0.0.1:0").await; }',
          'fn serve_ws() { let l = TcpListener::bind("127.0.0.1:0").unwrap(); let _ = tungstenite::accept(l.incoming().next().unwrap().unwrap()); }',
        ].join("\n"),
      },
    ];

    const violations = auditRustRatchets(files);
    expect(violations.map((v) => `${v.rule}@${v.file}:${v.line}`)).toEqual([
      "no-raw-tcp-http-mock@crates/server/tests/ai_mock.rs:2",
      "no-raw-tcp-http-mock@crates/server/tests/qualified_mock.rs:1",
    ]);
    const formatted = formatRatchetViolations(violations);
    expect(formatted).toContain("axum::Router");
    expect(formatted).toContain("Fix:");
    expect(formatted).toContain("See: docs/style/rust-async-concurrency.md");
  });

  test("rejects extra raw TcpListener::bind sites even in allowlisted connector.rs", () => {
    const files: SourceFile[] = [
      {
        path: "crates/server/tests/connector.rs",
        text: [
          "use std::net::TcpListener;",
          'fn serve_ws() { let _ = TcpListener::bind("127.0.0.1:0"); let _ = tungstenite::accept; }',
          'fn serve_extra_http() { let _ = TcpListener::bind("127.0.0.1:0"); }',
        ].join("\n"),
      },
    ];

    const violations = auditRustRatchets(files);
    expect(violations.map((v) => `${v.rule}@${v.file}:${v.line}`)).toEqual([
      "no-raw-tcp-http-mock@crates/server/tests/connector.rs:2",
      "no-raw-tcp-http-mock@crates/server/tests/connector.rs:3",
    ]);
  });
});

describe("no-block-on-in-async-server", () => {
  test("locks shrink-only ceiling at 152 and excludes #[cfg(test)] inline and external submodules", () => {
    expect(SERVER_BLOCK_ON_CEILING).toBe(152);

    const files: SourceFile[] = [
      {
        path: "crates/server/src/base.rs",
        text: [
          "pub fn a() { vibevalley_runtime::rt::block_on(async {}); }",
          "pub fn b() { rt::block_on(async {}); }",
          "// rt::block_on(ignored_comment)",
          "#[cfg(test)]",
          "mod tests { fn c() { vibevalley_runtime::rt::block_on(async {}); } }",
        ].join("\n"),
      },
      {
        path: "crates/server/src/transport/http/mod.rs",
        text: "#[cfg(test)]\nmod tests;\n",
      },
      {
        path: "crates/server/src/transport/http/tests.rs",
        text: "fn test_only() { vibevalley_runtime::rt::block_on(async {}); }\n",
      },
    ];

    expect(auditRustRatchets(files, { serverBlockOnCeiling: 2 })).toEqual([]);

    const violations = auditRustRatchets(files, { serverBlockOnCeiling: 1 });
    expect(violations).toHaveLength(1);
    expect(violations[0]?.rule).toBe("no-block-on-in-async-server");
    expect(violations[0]?.message).toContain("2 non-test `rt::block_on(` call(s), exceeding shrink-only ceiling 1");
    expect(violations[0]?.details).toEqual([
      "crates/server/src/base.rs:1: pub fn a() { vibevalley_runtime::rt::block_on(async {}); }",
      "crates/server/src/base.rs:2: pub fn b() { rt::block_on(async {}); }",
    ]);
    const formatted = formatRatchetViolations(violations);
    expect(formatted).toContain("Fix:");
    expect(formatted).toContain("See: docs/style/rust-async-concurrency.md");
  });
});

describe("auditWorkspaceRatchets", () => {
  test("scans disk workspace and enforces all ratchets together", () => {
    const dir = mkdtempSync(join(tmpdir(), "vv-rust-ratchets-"));
    try {
      const write = (rel: string, text: string) => {
        const full = join(dir, rel);
        mkdirSync(dirname(full), { recursive: true });
        writeFileSync(full, text, "utf8");
      };
      write("crates/server/Cargo.toml", '[package]\nname = "server"\n');
      write("crates/server/src/lib.rs", "pub fn ok() {}\n");
      write("crates/rich/src/highlight.rs", "pub fn run_offloaded() { let _ = tokio::runtime::Handle::try_current(); }\n");
      write("apps/mac/src/main.rs", "fn main() {}\n");

      const clean = auditWorkspaceRatchets(dir);
      expect(clean.filesScanned).toBe(4);
      expect(clean.serverBlockOnCount).toBe(0);
      expect(clean.violations).toEqual([]);

      write("crates/rich/src/code_block.rs", "fn bad() { let _ = tokio::runtime::Handle::try_current(); }\n");
      const dirty = auditWorkspaceRatchets(dir);
      expect(dirty.violations.map((v) => v.rule)).toEqual(["no-rich-sync-try-current"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
