import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import { join } from "node:path";

import type { FullConfig } from "@playwright/test";

import { artifactsFor } from "./projects";

const web = join(import.meta.dirname, "..");

export default function setup(config: FullConfig) {
  const out = join(web, ".test", `run-${process.pid}`);
  process.env.VIBEVALLEY_TEST_OUT = out;
  const dev = process.env.VIBEVALLEY_WEB_DEV === "1";
  const clean = () => rmSync(out, { recursive: true, force: true });
  try {
    for (const artifact of artifactsFor(config.projects.map((project) => project.name))) {
      console.log(`[browser build] ${artifact} (${dev ? "development" : "production"})`);
      execFileSync(
        "vp",
        [
          "build",
          ...(artifact === "stories" ? ["--config", "vite.stories.config.ts"] : []),
          ...(dev ? ["--mode", "development", "--minify", "false"] : []),
          "--outDir",
          join(out, artifact === "app" ? "dist" : "stories"),
          "--emptyOutDir",
          "--logLevel",
          "warn",
        ],
        { cwd: web, stdio: "inherit", env: { ...process.env, NODE_ENV: dev ? "development" : "production" } },
      );
    }
  } catch (error) {
    clean();
    throw error;
  }
  return clean;
}
