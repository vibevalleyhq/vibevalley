import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { Result, Schema } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { pyramid } from "./pyramid.ts";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "vibevalley-pyramid-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
function write(files: Readonly<Record<string, string>>) {
  for (const [file, source] of Object.entries(files)) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), source);
  }
}

describe("test layer classification", () => {
  it("ignores erased imports but follows inline type specifiers which still load a module", () => {
    write({
      "src/pure.test.ts": 'import type { Server } from "node:http"; export type { DatabaseSync } from "node:sqlite"; export const value = 1;',
      "src/inline.test.ts": 'import { type Server } from "node:http";',
    });
    const { layerOf, reach } = pyramid(root);
    expect(layerOf("src/pure.test.ts")).toBe("rule");
    expect(reach("src/pure.test.ts")).toBeUndefined();
    expect(layerOf("src/inline.test.ts")).toBe("module");
    expect(reach("src/inline.test.ts")).toEqual(["src/inline.test.ts", "node:http"]);
  });

  it("reports the whole chain through aliases, re-exports and dynamic imports", () => {
    write({
      "src/read.test.ts": 'import "#/reader.ts";',
      "src/reader.ts": 'export * from "#db/record.ts";',
      "db/generated/record.ts": 'export const open = () => import("node:sqlite");',
    });
    const { layerOf, reach } = pyramid(root);
    expect(layerOf("src/read.test.ts")).toBe("module");
    expect(reach("src/read.test.ts")).toEqual(["src/read.test.ts", "src/reader.ts", "db/generated/record.ts", "node:sqlite"]);
  });

  it("classifies the whole-farm entry as a flow rather than a module", () => {
    write({ "src/flows/work.test.ts": 'import "node:child_process";', "src/work.test.ts": 'import "node:child_process";' });
    const { layerOf } = pyramid(root);
    expect(layerOf("src/flows/work.test.ts")).toBe("flow");
    expect(layerOf("src/work.test.ts")).toBe("module");
  });

  it("follows runtime package exports and patterns, not declaration files", () => {
    write({
      "pnpm-workspace.yaml": "packages: [apps/*, packages/*]",
      "packages/port/package.json": Result.getOrThrow(
        Schema.encodeResult(Schema.fromJsonString(Schema.Unknown))({
          name: "@vibevalley/port",
          exports: {
            ".": { types: "./dist/index.d.ts", default: "./src/index.ts" },
            "./*": "./src/*.ts",
          },
        }),
      ),
      "packages/port/dist/index.d.ts": "export declare const value: number;",
      "packages/port/src/index.ts": 'export * from "./network.ts";',
      "packages/port/src/network.ts": 'import "node:net";',
      "packages/port/src/pure.ts": "export const value = 1;",
      "apps/example/src/net.test.ts": 'import "@vibevalley/port";',
      "apps/example/src/pure.test.ts": 'import "@vibevalley/port/pure";',
    });
    const { layerOf, reach } = pyramid(join(root, "apps/example"));
    expect(layerOf("src/net.test.ts")).toBe("module");
    expect(layerOf("src/pure.test.ts")).toBe("rule");
    expect(reach("src/net.test.ts")).toEqual(["src/net.test.ts", "../../packages/port/src/index.ts", "../../packages/port/src/network.ts", "node:net"]);
  });

  it("regression: cycles do not hide a later external edge or poison the next root", () => {
    write({
      "src/a.ts": 'import "./b.ts"; import "node:child_process";',
      "src/b.ts": 'import "./a.ts";',
      "src/c.ts": 'import "./d.ts";',
      "src/d.ts": 'import "./c.ts";',
    });
    const { reach } = pyramid(root);
    expect(reach("src/a.ts")).toEqual(["src/a.ts", "node:child_process"]);
    expect(reach("src/b.ts")).toEqual(["src/b.ts", "src/a.ts", "node:child_process"]);
    expect(reach("src/c.ts")).toBeUndefined();
    expect(reach("src/d.ts")).toBeUndefined();
  });
});
