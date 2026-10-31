import { Effect } from "effect";

import type * as T from "@vibevalley/protocol";

import { Channel } from "@/channel/chat.ts";
import { Cron } from "@/cron/cron.ts";

import { type Who, type Orchestrator, refuse, callerOf, answered, tool } from "./definition.ts";
import { answers, parseTime, cronLine } from "./prompts.ts";

export const cronTools = Effect.gen(function* () {
  const chat = yield* Channel;
  const cron = yield* Cron;

  const cronCreate = (who: Who) =>
    tool(
      "cron.create",
      Effect.fn("Tool.cronCreate")(
        function* (p: Orchestrator<"cron.create">) {
          const c = yield* callerOf(who);
          let channel = yield* chat.topOf(c.here);
          if (p.channel) {
            const byName = yield* chat.channelByName(p.channel);
            if (!byName) return yield* refuse(answers.cron.noChannelShort(p.channel));
            channel = byName;
          }
          const w = p.when;
          let when: T.CronWhen;
          switch (w.kind) {
            case "once": {
              const at = parseTime(w.at ?? "");
              if (at === undefined) return yield* refuse(answers.cron.badTime(w.at ?? ""));
              when = { kind: "once", at };
              break;
            }
            case "every":
              when = { kind: "every", minutes: w.minutes ?? 0 };
              break;
            case "daily":
              when = { kind: "daily", time: w.time ?? "" };
              break;
            case "cron":
              when = { kind: "cron", expr: w.expr ?? "" };
              break;
            case "weekly":
              when = { kind: "weekly", days: (w.days ?? []).map((d) => Math.trunc(d)), time: w.time ?? "" };
          }
          const made = yield* cron.add(
            {
              name: p.name,
              text: p.text,
              channel: channel.id,
              when,
              ...(p.agent ? { agent: p.agent } : {}),
              ...(p.project ? { project: p.project } : {}),
              ...(p.tz ? { tz: p.tz } : {}),
            },
            c.actor,
          );
          if (made.pending) return answers.cron.pending(cronLine(made, channel.name));
          return answers.cron.confirmed(cronLine(made, channel.name));
        },
        (e) => answered(e),
      ),
    );

  const cronList = tool(
    "cron.list",
    Effect.fn("Tool.cronList")(function* () {
      const all = cron.list();
      if (all.length === 0) return answers.listCrons.none;
      const names = new Map((yield* chat.channels()).map((c) => [c.id, c.name]));
      return all.map((s) => cronLine(s, names.get(s.channel) ?? "?")).join("\n");
    }),
  );

  const cronDelete = tool("cron.delete", (p: Orchestrator<"cron.delete">) =>
    answered(Effect.map(cron.remove(p.id), (s) => answers.cancelCron.canceled(s.name))),
  );
  return { cronCreate, cronList, cronDelete };
});
