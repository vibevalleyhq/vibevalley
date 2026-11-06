import type { Reporter, TestCase, TestResult } from "@playwright/test/reporter";

const budgetMs = 3_000;

export default class Budgets implements Reporter {
  private tests = 0;
  private ms = 0;
  private readonly over: { ms: number; name: string }[] = [];

  onTestEnd(test: TestCase, result: TestResult) {
    this.tests++;
    this.ms += result.duration;
    if (result.duration > 2 * budgetMs)
      this.over.push({
        ms: result.duration,
        name: test
          .titlePath()
          .filter((p) => p !== "")
          .join(" > "),
      });
  }

  onEnd() {
    const lines = this.over.toSorted((a, b) => b.ms - a.ms).map((t) => `  ${String(Math.round(t.ms)).padStart(6)} ms  ${t.name}`);
    console.log(
      `\nThe page layer: ${this.tests} tests, ${(this.ms / 1000).toFixed(1)} s, budget ${budgetMs} ms\n` +
        (lines.length > 0 ? `Over twice the budget:\n${lines.join("\n")}\n` : ""),
    );
  }
}
