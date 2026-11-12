import type { Spoken } from "#/modules/channel/channel.ts";
import { envelopeLines } from "#/modules/session/prompts.ts";

import { answers, channelLine } from "./prompts.ts";
import { callerOf, participant, refuse, said, sessionSchemaTool, tool, type Orchestrator, type SessionInput, type Who } from "./schemas.ts";
import type { ToolDeps } from "./tool.ts";

export function channelTools(deps: Pick<ToolDeps, "channel">) {
  const chat = deps.channel;

  const channelList = tool("channel.list", async () => (await chat.channels()).map((c) => "- " + channelLine(c)).join("\n"));

  const spokenText = (s: Spoken): string => {
    switch (s.kind) {
      case "held": {
        const shown = s.shown ?? [];
        const more = s.more ?? 0;
        return answers.spoken.held(s.target, shown.length, more, envelopeLines(shown));
      }
      case "confirm":
        return answers.spoken.confirm(s.target, s.lastRead);
      default: {
        const absent = s.absent && s.absent.length > 0 ? answers.spoken.absentNote(s.absent) : "";
        return answers.spoken.sent(s.target, s.message?.number ?? 0, absent);
      }
    }
  };

  const messageSend = (who: Who) =>
    sessionSchemaTool("channel.message.send", async (p: SessionInput<"channel.message.send">) => {
      const c = callerOf(who);
      const spoken = await chat.post({
        _tag: "Agent",
        from: participant(c),
        text: p.text,
        ...(p.id ? { target: p.id } : {}),
        ...(p.anyway === true ? { anyway: true } : {}),
        ...(p.confirm === true ? { confirm: true } : {}),
        ...(p.replyTo !== undefined ? { reply: p.replyTo } : {}),
      });
      return spokenText(spoken);
    });

  const messageList = (who: Who) =>
    tool("channel.message.list", async (p: Orchestrator<"channel.message.list">) => {
      try {
        const c = callerOf(who);
        let where = p.id ?? "";
        // A session's default is its own thread, which the channel service fills in.
        if (where === "" && c.session === "") where = (await chat.addressOf(c.here)).target;
        const r = await chat.read(participant(c), {
          target: where,
          ...(p.unread === true ? { unread: true } : {}),
          ...(p.before != null && p.before !== 0 ? { before: Math.trunc(p.before) } : {}),
          ...(p.limit != null && p.limit !== 0 ? { limit: Math.trunc(p.limit) } : {}),
        });
        const [first] = r.messages;
        if (!first) return p.unread === true ? answers.readChat.noUnread(r.target) : answers.readChat.empty(r.target);
        const older = r.older ? answers.readChat.olderNote(first.number) : "";
        return answers.readChat.head(r.target, older) + envelopeLines(r.messages);
      } catch (e) {
        return answers.readChat.failed(said(e));
      }
    });

  const unreadList = (who: Who) =>
    sessionSchemaTool("channel.unread.list", async () => {
      const c = callerOf(who);
      const rows = await chat.unread(participant(c));
      const [first] = rows;
      if (!first) return answers.channelInbox.empty;
      const lines = rows.map((r) => answers.channelInbox.row(r.channel, r.unread, r.mentionsYou, r.latest ?? ""));
      lines.push(answers.channelInbox.nextStep(first.channel));
      return lines.join("\n");
    });

  const channelCreate = tool("channel.create", async (p: Orchestrator<"channel.create">) => {
    const c = await chat.openChannel(p.name, p.description ?? "", p.repo ?? "");
    return answers.openChannel.opened(c.name, c.repo);
  });

  const channelUpdate = tool("channel.update", async (p: Orchestrator<"channel.update">) => {
    const c = (await chat.channelByName(p.id)) ?? (await chat.channels()).find((x) => x.id === p.id);
    if (!c) throw refuse(answers.channelSettings.noChannel(p.id));
    await chat.updateChannel(c.id, {
      ...(p.description !== undefined ? { description: p.description } : {}),
      ...(p.repo !== undefined ? { repo: p.repo } : {}),
    });
    return answers.channelSettings.updated(c.name);
  });
  return { channelList, messageSend, messageList, unreadList, channelCreate, channelUpdate };
}
