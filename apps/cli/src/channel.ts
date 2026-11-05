import { Effect } from "effect";
import { Argument, Command, Flag } from "effect/cli";

import { t } from "@vibevalley/i18n";
import type * as T from "@vibevalley/protocol";

import { ask, change, given, show } from "./farm.ts";

const nameOf = (c: T.Channel) => c.name ?? c.title;

const channelLine = (c: T.Channel) =>
  [`#${nameOf(c)}`, c.type, c.default ? "default" : "", c.unread !== undefined && c.unread > 0 ? `unread ${c.unread}` : ""].filter((p) => p !== "").join("  ");

const messageLine = (m: T.ChatMessage) => `#${m.number}  ${m.name}: ${m.text.replace(/\s+/gu, " ").trim()}`;

const channelArg = Argument.String("channel").pipe(Argument.withDescription(t("cli.arg.channel")));
const words = (about: Parameters<typeof t>[0]) => Argument.String("words").pipe(Argument.variadic({ min: 1 }), Argument.withDescription(t(about)));

const listCommand = Command.make("list", {}, () =>
  Effect.flatMap(
    ask((api) => api.channel.list()),
    (all) => show(all, (cs) => cs.map(channelLine).join("\n")),
  ),
).pipe(
  Command.withDescription(t("cli.command.channel.list")),
  Command.withExamples([{ command: "vibevalley channel list", description: t("cli.example.channelList.about") }]),
);

const messageList = Command.make(
  "list",
  {
    channel: channelArg,
    limit: Flag.Int("limit").pipe(Flag.withDefault(20), Flag.withDescription(t("cli.flag.limit"))),
    before: Flag.Int("before").pipe(Flag.optional, Flag.withDescription(t("cli.flag.before"))),
  },
  (o) => {
    const before = given(o.before);
    return Effect.flatMap(
      ask((api) => api.channel.message.list({ id: o.channel, limit: o.limit, ...(before === undefined ? {} : { before }) })),
      (messages) =>
        show(messages, (ms) => {
          const first = ms[0];
          return [...ms.map(messageLine), ...(first && first.number > 1 ? [t("cli.more", { flag: `--before ${first.number}` })] : [])].join("\n");
        }),
    );
  },
).pipe(
  Command.withDescription(t("cli.command.channel.messageList")),
  Command.withExamples([{ command: "vibevalley channel message list general --limit 10", description: t("cli.example.channelMessageList.about") }]),
);

const messageSend = Command.make(
  "send",
  { channel: channelArg, words: words("cli.arg.message"), reply: Flag.Int("reply").pipe(Flag.optional, Flag.withDescription(t("cli.flag.reply"))) },
  (o) => {
    const replyTo = given(o.reply);
    return change({
      name: "channel message send",
      does: (api) => api.channel.message.send({ id: o.channel, text: o.words.join(" "), ...(replyTo === undefined ? {} : { replyTo }) }),
      said: () => t("cli.channel.sent", { channel: o.channel }),
    });
  },
).pipe(
  Command.withDescription(t("cli.command.channel.messageSend")),
  Command.withExamples([{ command: t("cli.example.channelMessageSend.run"), description: t("cli.example.channelMessageSend.about") }]),
);

const messageSearch = Command.make("search", { words: words("cli.arg.search") }, (o) =>
  Effect.flatMap(
    ask((api) => api.channel.message.search({ text: o.words.join(" ") })),
    (hits) => show(hits, (hs) => hs.map((h) => `${h.channel}  ${messageLine(h.message)}`).join("\n")),
  ),
).pipe(
  Command.withDescription(t("cli.command.channel.messageSearch")),
  Command.withExamples([{ command: t("cli.example.channelMessageSearch.run"), description: t("cli.example.channelMessageSearch.about") }]),
);

const messageGroup = Command.make("message").pipe(
  Command.withSubcommands([messageList, messageSend, messageSearch]),
  Command.withDescription(t("cli.group.channel.message.about")),
);

export const channelCommand = Command.make("channel").pipe(
  Command.withSubcommands([listCommand, messageGroup]),
  Command.withDescription(t("cli.group.channel.about")),
);
