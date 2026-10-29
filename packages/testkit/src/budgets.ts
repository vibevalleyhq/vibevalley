// What a test may take, by its layer of the pyramid (pyramid.ts): a run ends with the pyramid's shape (each layer's
// files, tests and time) and each test that took more than twice its layer's budget, slowest first. It does not fail
// the run: times differ by machine, and a slow test is a design to look at (what it waits for, what it builds), not a
// broken one.

import type { Reporter, TestModule, Vitest } from "vite-plus/test/node";
import { budgetMs, type Layer, layers, pyramid } from "./pyramid.ts";

export default class Budgets implements Reporter {
  private vitest: Vitest | undefined;

  onInit(vitest: Vitest) {
    this.vitest = vitest;
  }

  onTestRunEnd(modules: ReadonlyArray<TestModule>) {
    const { layerOf } = pyramid(this.vitest?.config.root ?? process.cwd());
    const zero = () => ({ files: 0, tests: 0, ms: 0 });
    const shape: Record<Layer, { files: number; tests: number; ms: number }> = { rule: zero(), module: zero(), flow: zero() };
    const over: { ms: number; name: string; layer: Layer }[] = [];
    for (const m of modules) {
      const layer = layerOf(m.relativeModuleId);
      const at = shape[layer];
      at.files++;
      for (const t of m.children.allTests()) {
        const ms = t.diagnostic()?.duration ?? 0;
        at.tests++;
        at.ms += ms;
        if (ms > 2 * budgetMs[layer]) over.push({ ms, name: `${m.relativeModuleId} > ${t.fullName}`, layer });
      }
    }
    const rows = layers.map((l) => {
      const s = shape[l];
      return `  ${l.padEnd(6)} ${String(s.files).padStart(4)} files ${String(s.tests).padStart(5)} tests ${(s.ms / 1000).toFixed(1).padStart(7)} s   budget ${budgetMs[l]} ms`;
    });
    const lines = over.sort((a, b) => b.ms - a.ms).map((t) => `  ${String(Math.round(t.ms)).padStart(6)} ms  ${t.layer.padEnd(6)} ${t.name}`);
    this.vitest?.logger.log(
      `\nThe test pyramid:\n${rows.join("\n")}\n` + (lines.length > 0 ? `\nOver twice their layer's budget:\n${lines.join("\n")}\n` : ""),
    );
  }
}
