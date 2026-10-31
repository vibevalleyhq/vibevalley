import { Effect } from "effect";

import { Channel, type Spoken } from "@/channel/chat.ts";
import { inboxLines } from "@/channel/prompts.ts";

import { type Who, type Orchestrator, type SessionInput, refuse, said, callerOf, participant, tool, sessionSchemaTool } from "./definition.ts";
import { answers, channelLine } from "./prompts.ts";

export const channelTools = Effect.gen(function* () {
  const chat = yield* Channel;

  const channelList = tool(
    "channel.list",
    Effect.fn("Tool.channelList")(function* () {
      return (yield* chat.channels()).map((c) => "- " + channelLine(c)).join("\n");
    }),
  );

  const spokenText = (s: Spoken): string => {
    switch (s.kind) {
      case "held": {
        const shown = s.shown ?? [];
        const more = s.more ?? 0;
        return answers.spoken.held(s.target, shown.length, more, inboxLines(shown));
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
    sessionSchemaTool(
      "channel.message.send",
      Effect.fn("Tool.messageSend")(function* (p: SessionInput<"channel.message.send">) {
        const c = yield* callerOf(who);
        return spokenText(
          yield* chat.speak(participant(c), p.text, {
            ...(p.id ? { target: p.id } : {}),
            ...(p.anyway === true ? { anyway: true } : {}),
            ...(p.confirm === true ? { confirm: true } : {}),
            ...(p.replyTo !== undefined ? { reply: p.replyTo } : {}),
          }),
        );
      }),
    );

  const messageList = (who: Who) =>
    tool(
      "channel.message.list",
      Effect.fn("Tool.messageList")(function* (p: Orchestrator<"channel.message.list">) {
        const c = yield* callerOf(who);
        let where = p.id ?? "";
        // A session's default is its own thread, which the channel service fills in.
        if (where === "" && c.session === "") where = (yield* chat.addressOf(c.here)).target;
        const read = yield* Effect.result(
          chat.read(participant(c), {
            target: where,
            ...(p.unread === true ? { unread: true } : {}),
            ...(p.before != null && p.before !== 0 ? { before: Math.trunc(p.before) } : {}),
            ...(p.limit != null && p.limit !== 0 ? { limit: Math.trunc(p.limit) } : {}),
          }),
        );
        if (read._tag === "Failure") return answers.readChat.failed(said(read.failure));
        const r = read.success;
        if (r.messages.length === 0) return p.unread === true ? answers.readChat.noUnread(r.target) : answers.readChat.empty(r.target);
        const older = r.older ? answers.readChat.olderNote(r.messages[0]!.number) : "";
        return answers.readChat.head(r.target, older) + inboxLines(r.messages);
      }),
    );

  const unreadList = (who: Who) =>
    sessionSchemaTool(
      "channel.unread.list",
      Effect.fn("Tool.unreadList")(function* () {
        const c = yield* callerOf(who);
        const rows = yield* chat.unread(participant(c));
        if (rows.length === 0) return answers.channelInbox.empty;
        const lines = rows.map((r) => answers.channelInbox.row(r.channel, r.unread, r.mentionsYou, r.latest ?? ""));
        lines.push(answers.channelInbox.nextStep(rows[0]!.channel));
        return lines.join("\n");
      }),
    );

  const channelCreate = tool(
    "channel.create",
    Effect.fn("Tool.channelCreate")(function* (p: Orchestrator<"channel.create">) {
      const c = yield* chat.openChannel(p.name, p.description ?? "", p.project ?? "");
      return answers.openChannel.opened(c.name, c.project);
    }),
  );

  const channelUpdate = tool(
    "channel.update",
    Effect.fn("Tool.channelUpdate")(function* (p: Orchestrator<"channel.update">) {
      const c = (yield* chat.channelByName(p.id)) ?? (yield* chat.channels()).find((x) => x.id === p.id);
      if (!c) return yield* refuse(answers.channelSettings.noChannel(p.id));
      yield* chat.updateChannel(c.id, {
        ...(p.description !== undefined ? { description: p.description } : {}),
        ...(p.project !== undefined ? { project: p.project } : {}),
      });
      return answers.channelSettings.updated(c.name);
    }),
  );
  return { channelList, messageSend, messageList, unreadList, channelCreate, channelUpdate };
});
