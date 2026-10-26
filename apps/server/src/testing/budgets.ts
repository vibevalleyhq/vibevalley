// What a test may take, by its layer (docs/subsystems/foundation.md): a run ends by naming each test that took more than
// twice its layer's budget, slowest first. It does not fail the run: times differ by machine, and a slow test is a design
// to look at (what it waits for, what it builds), not a broken one.

import type { Reporter, TestModule, Vitest } from "vite-plus/test/node";

/** A flow builds the whole farm and runs real git; every other test is a module's, on the farm up to it. */
export const budgetMs = (file: string) => (file.startsWith("src/flows/") ? 2_000 : 300);

export default class Budgets implements Reporter {
  private vitest: Vitest | undefined;

  onInit(vitest: Vitest) {
    this.vitest = vitest;
  }

  onTestRunEnd(modules: ReadonlyArray<TestModule>) {
    const over = modules.flatMap((m) =>
      [...m.children.allTests()].flatMap((t) => {
        const ms = t.diagnostic()?.duration ?? 0;
        return ms > 2 * budgetMs(m.relativeModuleId) ? [{ ms, name: `${m.relativeModuleId} > ${t.fullName}` }] : [];
      }),
    );
    if (over.length === 0) return;
    over.sort((a, b) => b.ms - a.ms);
    const lines = over.map((t) => `  ${String(Math.round(t.ms)).padStart(6)} ms  ${t.name}`);
    this.vitest?.logger.log(`\nOver twice their layer's budget (flows 2 s, the rest 300 ms):\n${lines.join("\n")}\n`);
  }
}
