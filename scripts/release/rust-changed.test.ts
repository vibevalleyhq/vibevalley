import { describe, expect, test } from "vite-plus/test";

import { type CargoMetadata, parseArgs, parseChangedPackages } from "./rust-changed.ts";

const ROOT = "/repo";

const workspaceMetadata: CargoMetadata = {
  workspace_root: ROOT,
  workspace_members: [
    "vibevalley-protocol 0.1.0",
    "vibevalley-core 0.1.0",
    "vibevalley-server 0.1.0",
    "vibevalley-cli 0.1.0",
    "vibevalley-pixel 0.1.0",
    "vibevalley-terminal 0.1.0",
    "vibevalley-mac 0.1.0",
  ],
  packages: [
    {
      id: "vibevalley-protocol 0.1.0",
      name: "vibevalley-protocol",
      manifest_path: `${ROOT}/crates/protocol/Cargo.toml`,
      dependencies: [{ name: "serde" }],
    },
    {
      id: "vibevalley-core 0.1.0",
      name: "vibevalley-core",
      manifest_path: `${ROOT}/crates/core/Cargo.toml`,
      dependencies: [{ name: "vibevalley-protocol" }],
    },
    {
      id: "vibevalley-server 0.1.0",
      name: "vibevalley-server",
      manifest_path: `${ROOT}/crates/server/Cargo.toml`,
      dependencies: [{ name: "vibevalley-core" }, { name: "vibevalley-protocol" }],
    },
    {
      id: "vibevalley-cli 0.1.0",
      name: "vibevalley-cli",
      manifest_path: `${ROOT}/crates/cli/Cargo.toml`,
      dependencies: [{ name: "vibevalley-protocol" }],
    },
    {
      id: "vibevalley-pixel 0.1.0",
      name: "vibevalley-pixel",
      manifest_path: `${ROOT}/apps/mac/crates/pixel/Cargo.toml`,
      dependencies: [],
    },
    {
      id: "vibevalley-terminal 0.1.0",
      name: "vibevalley-terminal",
      manifest_path: `${ROOT}/apps/mac/crates/terminal/Cargo.toml`,
      dependencies: [],
    },
    {
      id: "vibevalley-mac 0.1.0",
      name: "vibevalley-mac",
      manifest_path: `${ROOT}/apps/mac/Cargo.toml`,
      dependencies: [{ name: "vibevalley-server" }, { name: "vibevalley-pixel" }, { name: "vibevalley-terminal" }],
    },
  ],
};

describe("parseChangedPackages", () => {
  test("returns empty when no Rust crates are touched", () => {
    expect(parseChangedPackages(workspaceMetadata, ["docs/README.md", "packages/protocol/src/api.ts", "apps/mac/ui/App.tsx", ""], ROOT)).toEqual({
      all: false,
      packages: [],
    });
  });

  test("selects all workspace crates when root Cargo or nextest config changes", () => {
    for (const trigger of ["Cargo.toml", "Cargo.lock", "rust-toolchain.toml", ".config/nextest.toml"]) {
      const result = parseChangedPackages(workspaceMetadata, [trigger], ROOT);
      expect(result).toEqual({
        all: true,
        packages: [
          "vibevalley-cli",
          "vibevalley-core",
          "vibevalley-mac",
          "vibevalley-pixel",
          "vibevalley-protocol",
          "vibevalley-server",
          "vibevalley-terminal",
        ],
      });
    }
  });

  test("keeps a leaf crate change scoped to itself", () => {
    expect(parseChangedPackages(workspaceMetadata, ["crates/cli/src/main.rs"], ROOT)).toEqual({
      all: false,
      packages: ["vibevalley-cli"],
    });
  });

  test("walks transitive reverse dependencies across workspace members", () => {
    expect(parseChangedPackages(workspaceMetadata, ["crates/core/src/reduce.rs"], ROOT)).toEqual({
      all: false,
      packages: ["vibevalley-core", "vibevalley-mac", "vibevalley-server"],
    });

    expect(parseChangedPackages(workspaceMetadata, ["crates/protocol/src/contract/slice.rs"], ROOT)).toEqual({
      all: false,
      packages: ["vibevalley-cli", "vibevalley-core", "vibevalley-mac", "vibevalley-protocol", "vibevalley-server"],
    });
  });

  test("matches nested crate directories before enclosing crates and includes non-rs crate assets", () => {
    expect(parseChangedPackages(workspaceMetadata, ["apps/mac/crates/pixel/src/lib.rs"], ROOT)).toEqual({
      all: false,
      packages: ["vibevalley-mac", "vibevalley-pixel"],
    });

    expect(parseChangedPackages(workspaceMetadata, ["crates/server/assets/tools/helper.json"], ROOT)).toEqual({
      all: false,
      packages: ["vibevalley-mac", "vibevalley-server"],
    });

    expect(parseChangedPackages(workspaceMetadata, ["apps/mac/src/shell/mod.rs"], ROOT)).toEqual({
      all: false,
      packages: ["vibevalley-mac"],
    });
  });
});

describe("parseArgs", () => {
  test("parses default options, --base, --dry-run, and --help", () => {
    expect(parseArgs([])).toEqual({ base: "origin/main", dryRun: false, help: false });
    expect(parseArgs(["--base", "main", "--dry-run"])).toEqual({ base: "main", dryRun: true, help: false });
    expect(parseArgs(["--base=HEAD~2"])).toEqual({ base: "HEAD~2", dryRun: false, help: false });
    expect(parseArgs(["--help"])).toEqual({ base: "origin/main", dryRun: false, help: true });
  });

  test("rejects unknown options and empty --base values", () => {
    expect(() => parseArgs(["--unknown"])).toThrow(/unknown option/u);
    expect(() => parseArgs(["--base"])).toThrow(/requires a git ref/u);
    expect(() => parseArgs(["--base="])).toThrow(/requires a git ref/u);
  });
});
