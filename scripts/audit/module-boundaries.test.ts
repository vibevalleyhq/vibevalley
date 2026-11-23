import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { describe, expect, test } from "vite-plus/test";

import { auditFiles, auditWorkspace, classifyServerModule, formatViolations, stripRustNonCode, type RustFile } from "./module-boundaries.ts";

describe("stripRustNonCode", () => {
  test("ignores line comments, nested block comments, strings, raw strings, and #[cfg(test)] items while preserving line numbers", () => {
    const source = [
      "use crate::Hub;",
      "// use crate::modules::work::issue::Board;",
      "/* outer /* inner use crate::modules::collab::channel::Chat; */ use crate::modules::team::tool::Farm; */",
      'const S: &str = "use crate::modules::work::session::Sessions;";',
      'const R: &str = r#"use crate::modules::collab::voice::Voice;"#;',
      "const CH: char = '\"';",
      "#[cfg(test)]",
      "mod tests {",
      "    use crate::modules::work::issue::Board;",
      "    #[allow(dead_code)]",
      "    fn helper() { let _ = crate::modules::collab::voice::Voice::new(); }",
      "}",
      "#[cfg(not(test))]",
      "use crate::modules::infra::setting::Setting;",
    ].join("\n");

    const stripped = stripRustNonCode(source);
    expect(stripped.split("\n")).toHaveLength(source.split("\n").length);
    expect(stripped).not.toContain("Board");
    expect(stripped).not.toContain("Chat");
    expect(stripped).not.toContain("Farm");
    expect(stripped).not.toContain("Sessions");
    expect(stripped).not.toContain("Voice");
    expect(stripped).toContain("crate::modules::infra::setting::Setting");
  });
});

describe("classifyServerModule", () => {
  test("classifies L1, L2 peer domains, and L3 modules accurately", () => {
    expect(classifyServerModule("infra/setting")).toEqual({ layer: "L1" });
    expect(classifyServerModule("infra/text")).toEqual({ layer: "L1" });
    expect(classifyServerModule("content/attachment")).toEqual({ layer: "L1" });
    expect(classifyServerModule("team/agent")).toEqual({ layer: "L1" });

    expect(classifyServerModule("work/ledger")).toEqual({ layer: "L2", peerDomain: "work" });
    expect(classifyServerModule("work/issue")).toEqual({ layer: "L2", peerDomain: "work" });
    expect(classifyServerModule("collab/channel")).toEqual({ layer: "L2", peerDomain: "collab" });
    expect(classifyServerModule("collab/voice")).toEqual({ layer: "L2", peerDomain: "collab" });
    expect(classifyServerModule("content/artifact")).toEqual({ layer: "L2", peerDomain: "content" });
    expect(classifyServerModule("content/media")).toEqual({ layer: "L2", peerDomain: "content" });
    expect(classifyServerModule("team/memory")).toEqual({ layer: "L2", peerDomain: "team/memory" });

    expect(classifyServerModule("team/orchestrator")).toEqual({ layer: "L3" });
    expect(classifyServerModule("team/tool")).toEqual({ layer: "L3" });
    expect(classifyServerModule("team/mcp")).toEqual({ layer: "L3" });
    expect(classifyServerModule("work/cron")).toEqual({ layer: "L3" });
    expect(classifyServerModule("skin/game")).toEqual({ layer: "L3" });
  });
});

describe("spine-no-module-import", () => {
  test("fails when lib.rs, ports.rs, or transport/** imports or references crate::modules::*", () => {
    const files: RustFile[] = [
      {
        path: "crates/server/src/lib.rs",
        content: "use crate::modules::collab::voice::Voice;\npub struct Hub;",
      },
      {
        path: "crates/server/src/ports.rs",
        content: "pub trait Recall { fn x(&self) -> crate::modules::team::memory::Hit; }",
      },
      {
        path: "crates/server/src/transport/api/mod.rs",
        content: "pub trait Server {\n    fn voice(&self) -> Option<Arc<crate::modules::collab::voice::Voice>>;\n}",
      },
    ];

    const violations = auditFiles(files);
    expect(violations.map((v) => `${v.rule}@${v.file}:${v.line}`)).toEqual([
      "spine-no-module-import@crates/server/src/lib.rs:1",
      "spine-no-module-import@crates/server/src/ports.rs:1",
      "spine-no-module-import@crates/server/src/transport/api/mod.rs:2",
    ]);
    expect(formatViolations(violations)).toContain("docs/architecture-topology.md");
  });

  test("ignores #[cfg(test)] inline modules and external #[cfg(test)] mod tests; files in transport/", () => {
    const files: RustFile[] = [
      {
        path: "crates/server/src/transport/http/mod.rs",
        content: ["use crate::Hub;", "#[cfg(test)]", "mod tests;"].join("\n"),
      },
      {
        path: "crates/server/src/transport/http/tests.rs",
        content: "use crate::modules::content::attachment::Attachments;\n",
      },
      {
        path: "crates/server/src/lib.rs",
        content: ["pub mod ports;", "#[cfg(test)]", "mod tests { use crate::modules::infra::setting::Setting; }"].join("\n"),
      },
    ];

    expect(auditFiles(files)).toEqual([]);
  });
});

describe("mac-no-server-module-import", () => {
  test("fails on both use statements and inline paths referencing vibevalley_server::modules::*", () => {
    const files: RustFile[] = [
      {
        path: "apps/mac/src/live_voice.rs",
        content: "use vibevalley_server::modules::collab::voice::Voice;\n",
      },
      {
        path: "apps/mac/src/hosted/late.rs",
        content: "impl Server for LateServer {\n    fn voice(&self) -> Option<Arc<vibevalley_server::modules::collab::voice::Voice>> { None }\n}",
      },
    ];

    const violations = auditFiles(files);
    expect(violations.map((v) => `${v.rule}@${v.file}:${v.line}`)).toEqual([
      "mac-no-server-module-import@apps/mac/src/hosted/late.rs:2",
      "mac-no-server-module-import@apps/mac/src/live_voice.rs:1",
    ]);
  });

  test("passes when apps/mac/src consumes vibevalley_server::transport::api::SharedLiveVoice", () => {
    const files: RustFile[] = [
      {
        path: "apps/mac/src/live_voice.rs",
        content: [
          "use vibevalley_server::transport::api::SharedLiveVoice;",
          "// doc comment mentioning vibevalley_server::modules::collab::voice::Voice",
          "pub fn start(_voice: SharedLiveVoice) {}",
        ].join("\n"),
      },
      {
        path: "apps/mac/src/hosted/late.rs",
        content: "fn voice(&self) -> Option<vibevalley_server::transport::api::SharedLiveVoice> { None }",
      },
    ];

    expect(auditFiles(files)).toEqual([]);
  });
});

describe("server-layer-dag", () => {
  test("fails on L1 -> L2, L1 -> L3, L2 -> L3, and L2 <-> L2 cross-domain imports", () => {
    const files: RustFile[] = [
      {
        path: "crates/server/src/modules/team/agent/mod.rs",
        content: "use crate::modules::team::memory::Memory;\n",
      },
      {
        path: "crates/server/src/modules/infra/setting.rs",
        content: "use crate::modules::team::orchestrator::Orchestrator;\n",
      },
      {
        path: "crates/server/src/modules/collab/voice/mod.rs",
        content: "use crate::modules::team::orchestrator::Orchestrator;\n",
      },
      {
        path: "crates/server/src/modules/content/artifact/mod.rs",
        content: "use crate::modules::work::issue::Board;\n",
      },
      {
        path: "crates/server/src/modules/work/issue/board.rs",
        content: "use crate::modules::collab::channel::Chat;\n",
      },
    ];

    const violations = auditFiles(files).filter((v) => v.rule === "server-layer-dag");
    expect(violations.map((v) => `${v.file}:${v.line}`)).toEqual([
      "crates/server/src/modules/collab/voice/mod.rs:1",
      "crates/server/src/modules/content/artifact/mod.rs:1",
      "crates/server/src/modules/infra/setting.rs:1",
      "crates/server/src/modules/team/agent/mod.rs:1",
      "crates/server/src/modules/work/issue/board.rs:1",
    ]);
  });

  test("resolves relative super:: imports and grouped use trees across layers", () => {
    const files: RustFile[] = [
      {
        path: "crates/server/src/modules/work/session/sessions.rs",
        content: "use super::super::cron::Crons;\n",
      },
      {
        path: "crates/server/src/modules/content/attachment/mod.rs",
        content: "use super::{library::Library, media::Media};\n",
      },
    ];

    const violations = auditFiles(files);
    expect(violations).toHaveLength(3);
    expect(violations.every((v) => v.rule === "server-layer-dag")).toBe(true);
  });

  test("passes a valid L0 -> L1 -> L2 -> L3 DAG with intra-domain dependencies and external #[cfg(test)] files", () => {
    const files: RustFile[] = [
      {
        path: "crates/server/src/modules/infra/setting.rs",
        content: "pub struct Setting;\n",
      },
      {
        path: "crates/server/src/modules/infra/text.rs",
        content: "use super::setting::Setting;\n",
      },
      {
        path: "crates/server/src/modules/content/attachment/mod.rs",
        content: "use crate::modules::infra::setting::Setting;\n",
      },
      {
        path: "crates/server/src/modules/team/agent/mod.rs",
        content: "use crate::modules::infra::text;\n",
      },
      {
        path: "crates/server/src/modules/work/ledger.rs",
        content: "use crate::modules::infra::setting::Setting;\n",
      },
      {
        path: "crates/server/src/modules/work/session/sessions.rs",
        content: [
          "use crate::modules::content::attachment::Attachments;",
          "use crate::modules::team::agent::Agents;",
          "use crate::modules::work::ledger::Ledger;",
          "mod inner { use super::Ledger; }",
        ].join("\n"),
      },
      {
        path: "crates/server/src/modules/work/issue/board.rs",
        content: ["use crate::modules::work::{ledger::Ledger, session::Sessions};", "use super::edits::apply;"].join("\n"),
      },
      {
        path: "crates/server/src/modules/work/pull/mod.rs",
        content: "use crate::modules::work::issue::Board;\n",
      },
      {
        path: "crates/server/src/modules/collab/channel/mod.rs",
        content: "use crate::modules::content::attachment::Attachments;\n",
      },
      {
        path: "crates/server/src/modules/collab/connector/store.rs",
        content: ["use crate::modules::collab::channel::Chat;", "#[cfg(test)]", '#[path = "store_test.rs"]', "mod tests;"].join("\n"),
      },
      {
        path: "crates/server/src/modules/collab/connector/store_test.rs",
        content: "use crate::modules::work::issue::Board;\n",
      },
      {
        path: "crates/server/src/modules/team/tool/mod.rs",
        content: "use crate::modules::team::agent::Agents;\n",
      },
      {
        path: "crates/server/src/modules/team/orchestrator/mod.rs",
        content: "use crate::modules::team::tool::Tools;\n",
      },
      {
        path: "crates/server/src/modules/team/mcp/mod.rs",
        content: "use crate::modules::team::tool::Tools;\n",
      },
      {
        path: "crates/server/src/modules/skin/game.rs",
        content: "use crate::modules::infra::setting::Setting;\n",
      },
      {
        path: "crates/server/src/modules/work/cron/mod.rs",
        content: "use crate::modules::work::issue::Board;\n",
      },
    ];

    expect(auditFiles(files)).toEqual([]);
  });
});

describe("server-modules-acyclic", () => {
  test("detects a 2-node intra-domain cycle and reports the cycle path and file:line evidence", () => {
    const files: RustFile[] = [
      {
        path: "crates/server/src/modules/work/issue/mod.rs",
        content: "use crate::modules::work::session::Sessions;\n",
      },
      {
        path: "crates/server/src/modules/work/session/mod.rs",
        content: "use crate::modules::work::issue::Board;\n",
      },
    ];

    const violations = auditFiles(files);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.rule).toBe("server-modules-acyclic");
    expect(violations[0]?.message).toContain("work/issue -> work/session -> work/issue");
    const formatted = formatViolations(violations);
    expect(formatted).toContain("crates/server/src/modules/work/issue/mod.rs:1");
    expect(formatted).toContain("crates/server/src/modules/work/session/mod.rs:1");
  });

  test("detects a 3-node L3 cycle across orchestrator -> tool -> mcp -> orchestrator", () => {
    const files: RustFile[] = [
      {
        path: "crates/server/src/modules/team/orchestrator/mod.rs",
        content: "use crate::modules::team::tool::Tools;\n",
      },
      {
        path: "crates/server/src/modules/team/tool/mod.rs",
        content: "use crate::modules::team::mcp::Door;\n",
      },
      {
        path: "crates/server/src/modules/team/mcp/mod.rs",
        content: "use crate::modules::team::orchestrator::Orchestrator;\n",
      },
    ];

    const violations = auditFiles(files);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.rule).toBe("server-modules-acyclic");
    expect(violations[0]?.message).toContain("team/mcp -> team/orchestrator -> team/tool -> team/mcp");
  });
});

describe("auditWorkspace", () => {
  test("scans spine, transport, server modules, and mac sources from disk", () => {
    const dir = mkdtempSync(join(tmpdir(), "vv-boundaries-"));
    try {
      const write = (rel: string, content: string) => {
        const full = join(dir, rel);
        mkdirSync(dirname(full), { recursive: true });
        writeFileSync(full, content, "utf8");
      };
      write("crates/server/src/lib.rs", "pub mod ports;\n");
      write("crates/server/src/ports.rs", "pub trait LiveVoicePort {}\n");
      write("crates/server/src/transport/api/mod.rs", "pub trait Server {}\n");
      write("crates/server/src/modules/infra/setting.rs", "pub struct Setting;\n");
      write("crates/server/src/modules/work/ledger.rs", "use crate::modules::infra::setting::Setting;\n");
      write("apps/mac/src/live_voice.rs", "use vibevalley_server::transport::api::SharedLiveVoice;\n");

      const clean = auditWorkspace(dir);
      expect(clean.filesScanned).toBe(6);
      expect(clean.violations).toEqual([]);

      write("apps/mac/src/hosted/late.rs", "fn voice(&self) -> Option<vibevalley_server::modules::collab::voice::Voice> { None }\n");
      const dirty = auditWorkspace(dir);
      expect(dirty.violations.map((v) => v.rule)).toEqual(["mac-no-server-module-import"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
