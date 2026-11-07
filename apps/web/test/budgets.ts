import type { Reporter, TestCase, TestResult, TestStep } from "@playwright/test/reporter";

const budgetMs = 3_000;
const isAudit = (step: TestStep) => step.category === "test.step" && step.title.startsWith("audit: ");

export default class Budgets implements Reporter {
  private readonly suites = new Map<string, { tests: number; ms: number }>();
  private readonly over: { ms: number; name: string }[] = [];

  private record(test: TestCase, ms: number, step = "") {
    if (ms > 2 * budgetMs) this.over.push({ ms, name: [...test.titlePath().filter(Boolean), ...(step ? [step] : [])].join(" > ") });
  }

  onStepEnd(test: TestCase, _result: TestResult, step: TestStep) {
    if (isAudit(step)) this.record(test, step.duration, step.title);
  }

  onTestEnd(test: TestCase, result: TestResult) {
    const name = test.parent.project()?.name ?? "unknown";
    const suite = this.suites.get(name) ?? { tests: 0, ms: 0 };
    suite.tests++;
    suite.ms += result.duration;
    this.suites.set(name, suite);
    if (!result.steps.some(isAudit)) this.record(test, result.duration);
  }

  onEnd() {
    const suites = [...this.suites].map(([name, row]) => `  ${name}: ${row.tests} attempts, ${(row.ms / 1000).toFixed(1)} s cumulative`);
    const over = this.over.toSorted((a, b) => b.ms - a.ms).map((row) => `  ${String(Math.round(row.ms)).padStart(6)} ms  ${row.name}`);
    console.log(
      `\nBrowser suites (not wall time), budget ${budgetMs} ms per behavior or audit scene:\n${suites.join("\n")}\n` +
        (over.length > 0 ? `Over twice the budget:\n${over.join("\n")}\n` : ""),
    );
  }
}
