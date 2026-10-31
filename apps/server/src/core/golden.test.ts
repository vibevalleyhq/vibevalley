// The golden files (testdata, first recorded from the server's Go version) hold the core state's rules to their answers:
// runs of facts folded from an empty farm, the shared rules' calls, and the task graphs', crons' and patrol's cases.
// Each is compared as JSON. Times of day are read in Asia/Shanghai (vite.config.ts sets it).

import { readFileSync, writeFileSync } from "node:fs";
import { gunzipSync, gzipSync } from "node:zlib";

import { describe, expect, test } from "vite-plus/test";

import type { Channel, WorkspaceState, Fact, Issue, Cron, CronRequest, Session, TaskGraph } from "@vibevalley/protocol";
import { phaseText, attentionWantsOwner } from "@vibevalley/protocol/rules";
import { jsonDiff } from "@vibevalley/testkit/golden";

import { targetOf } from "@/channel/folded.ts";
import { cronProblem } from "@/cron/due.ts";
import { nextRun, nextText, whenText } from "@/cron/when.ts";
import { effectsOf, viewOf } from "@/game/view.ts";
import { inbox } from "@/inbox/items.ts";
import { attentionOf } from "@/issue/attention.ts";
import { withIssueStatuses } from "@/issue/status.ts";
import { reduce } from "@/projection/reduce.ts";
import { yuan } from "@/runtime/money.ts";
import { graphChanges, graphEventText } from "@/task/changes.ts";
import { asksForYou, blockedBy, graphProblems, graphSpent, layersOf, acceptanceChecks, readyTasks } from "@/task/graph.ts";
import { graphText } from "@/task/prompts.ts";

import { emptyWorkspaceState } from "./core.ts";

const testdata = new URL("./testdata/", import.meta.url);

async function lines(name: string): Promise<Record<string, unknown>[]> {
  const body = new TextDecoder().decode(gunzipSync(readFileSync(new URL(name, testdata))));
  return body
    .split("\n")
    .filter((l) => l !== "")
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

/** With VIBEVALLEY_GOLDEN=update, a rule changed on purpose writes its answers back over the recorded ones (look at the
 * diff before keeping it). */
const updating = process.env.VIBEVALLEY_GOLDEN === "update";

/** Collects the first failures, so one run shows a few at once; updating, puts each answer in its place in the rows
 * (holder[key]) and writes the file back once done. */
function failures(name: string, rows: Record<string, unknown>[]) {
  const found: string[] = [];
  let changed = false;
  return {
    check(line: number, what: string, got: unknown, holder: Record<string, unknown>, key: string) {
      const d = jsonDiff(got, holder[key]);
      if (!d) return;
      if (updating) {
        holder[key] = JSON.parse(JSON.stringify(got ?? null));
        changed = true;
      } else if (found.length < 20) found.push(`line ${line} ${what}: ${d}`);
    },
    async done() {
      if (updating && changed) writeFileSync(new URL(name, testdata), gzipSync(rows.map((r) => JSON.stringify(r)).join("\n") + "\n"));
      expect(found).toEqual([]);
    },
  };
}

describe("the golden files", () => {
  test("reduce: runs of facts, each from an empty farm", async () => {
    const rows = await lines("reduce.jsonl.gz");
    expect(rows.length).toBeGreaterThan(1000);
    const f = failures("reduce.jsonl.gz", rows);
    let run = -1;
    let state: WorkspaceState = emptyWorkspaceState();
    rows.forEach((row, i) => {
      const line = i + 1;
      if (row.run !== run) {
        run = row.run as number;
        state = emptyWorkspaceState();
      }
      const fact = row.fact as Fact;
      const effects = effectsOf(state, fact);
      const [next, changed] = reduce(state, fact);
      expect(next).toEqual(withIssueStatuses(next));
      f.check(line, `${fact.type} changed`, changed, row, "changed");
      f.check(line, `${fact.type} state`, next, row, "state");
      f.check(line, `${fact.type} effects`, effects, row, "effects");
      f.check(line, `${fact.type} view`, viewOf(next), row, "view");
      f.check(line, `${fact.type} inbox`, inbox(next), row, "inbox");
      // One source: what the inbox says of an issue's helper is what its attention says, every step of the way.
      const asked = new Set(inbox(next).flatMap((it) => (it.from.kind === "session" ? [it.from.id] : [])));
      for (const t of next.issues) {
        const last = t.sessions.at(-1);
        const h = last === undefined ? undefined : next.sessions.find((s) => s.id === last);
        if (!h || h.graph || t.task || t.graph || t.parent) continue;
        expect({ line, issue: t.id, questions: asked.has(h.id) }).toEqual({ line, issue: t.id, questions: attentionWantsOwner(t.attention.state) });
      }
      state = next;
    });
    await f.done();
  });

  test("rules: targetOf, phaseText, yuan, attentionOf", async () => {
    const rows = await lines("rules.jsonl.gz");
    const f = failures("rules.jsonl.gz", rows);
    rows.forEach((row, i) => {
      const input = row.in as Record<string, unknown>;
      switch (row.fn) {
        case "targetOf":
          return f.check(i + 1, "targetOf", targetOf(input.c as Channel, input.channelName as string), row, "out");
        case "phaseText":
          return f.check(i + 1, "phaseText", phaseText(input.session as Session, input.now as number) || null, row, "out");
        case "yuan":
          return f.check(i + 1, "yuan", yuan(row.in as number), row, "out");
        case "attentionOf":
          return f.check(i + 1, "attentionOf", attentionOf(input.issue as Issue, (input.session as Session | null) ?? undefined), row, "out");
        default:
          throw new Error(`line ${i + 1}: no rule ${String(row.fn)}`);
      }
    });
    await f.done();
  });

  test("play: task graphs, crons and the patrol", async () => {
    const rows = await lines("play.jsonl.gz");
    const f = failures("play.jsonl.gz", rows);
    const seen: Record<string, number> = {};
    rows.forEach((row, i) => {
      const line = i + 1;
      const kind = row.kind as string;
      seen[kind] = (seen[kind] ?? 0) + 1;
      const input = row.input as Record<string, unknown>;
      const want = (row.output ??= {}) as Record<string, unknown>;
      const same = (what: string, got: unknown) => f.check(line, `${kind} ${what}`, got, want, what);
      switch (kind) {
        case "task": {
          const graph = input.task as TaskGraph;
          const tasks = graph.tasks;
          same("problems", graphProblems(graph.tasks));
          same("layers", layersOf(graph.tasks));
          same(
            "ready",
            readyTasks(graph).map((n) => n.id),
          );
          same("questions", asksForYou(graph));
          same("spent", graphSpent(graph));
          same("text", graphText(graph));
          same(
            "blocked",
            tasks.map((n) => blockedBy(graph, n)),
          );
          same(
            "acceptanceChecks",
            tasks.map((n) => acceptanceChecks(graph, n)),
          );
          const changes = graphChanges(input.fresh === true ? undefined : graph, input.after as TaskGraph);
          same("changes", changes);
          const titles = new Map(tasks.map((n) => [n.id, "T" + n.title]));
          same(
            "eventTexts",
            changes.map((c) => [graphEventText(c), graphEventText(c, (id) => titles.get(id) ?? id)]),
          );
          break;
        }
        case "cron": {
          const s = input.s as Cron;
          same("next", nextRun(s) ?? null);
          if (!JSON.stringify(want.nextText).includes('"thrown"')) same("nextText", nextText(s));
          if (!JSON.stringify(want.whenText).includes('"thrown"')) same("whenText", whenText(s.when, s.tz));
          same("problem", cronProblem(input.req as CronRequest, input.now as number) || null);
          break;
        }
        case "patrol":
          same("inbox", inbox(input.state as WorkspaceState));
          break;
        default:
          throw new Error(`line ${line}: no kind ${kind}`);
      }
    });
    for (const kind of ["task", "cron", "patrol"]) expect(seen[kind] ?? 0).toBeGreaterThan(20);
    await f.done();
  });
});
