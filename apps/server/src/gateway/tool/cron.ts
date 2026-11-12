import type * as T from "@vibevalley/protocol";

import type { Who } from "#/base/actor.ts";

import { answers, cronLine, parseTime } from "./prompts.ts";
import { answered, callerOf, refuse, tool, type Orchestrator } from "./schemas.ts";
import type { ToolDeps } from "./tool.ts";

export function cronTools(deps: Pick<ToolDeps, "channel" | "cron">) {
  const { channel: chat, cron } = deps;

  const cronCreate = (who: Who) =>
    tool("cron.create", (p: Orchestrator<"cron.create">) =>
      answered(async () => {
        const c = callerOf(who);
        let channel = await chat.topOf(c.here);
        if (p.channel) {
          const byName = await chat.channelByName(p.channel);
          if (!byName) throw refuse(answers.cron.noChannelShort(p.channel));
          channel = byName;
        }
        const w = p.when;
        let when: T.CronWhen;
        switch (w.kind) {
          case "once": {
            const at = parseTime(w.at ?? "");
            if (at === undefined) throw refuse(answers.cron.badTime(w.at ?? ""));
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
        const made = await cron.add(
          {
            name: p.name,
            text: p.text,
            channel: channel.id,
            when,
            ...(p.agent ? { agent: p.agent } : {}),
            ...(p.repo ? { repo: p.repo } : {}),
            ...(p.tz ? { tz: p.tz } : {}),
          },
          c.actor,
        );
        if (made.pending) return answers.cron.pending(cronLine(made, channel.name));
        return answers.cron.confirmed(cronLine(made, channel.name));
      }),
    );

  const cronList = tool("cron.list", async () => {
    const all = cron.list();
    if (all.length === 0) return answers.listCrons.none;
    const names = new Map((await chat.channels()).map((c) => [c.id, c.name]));
    return all.map((s) => cronLine(s, names.get(s.channel) ?? "?")).join("\n");
  });

  const cronDelete = tool("cron.delete", (p: Orchestrator<"cron.delete">) => answered(async () => answers.cancelCron.canceled((await cron.remove(p.id)).name)));
  return { cronCreate, cronList, cronDelete };
}
