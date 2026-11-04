// `vibevalley channel …`: reading and saying in the farm's channels, a channel named as a person names it (#general).

import { Effect } from "effect";
import { Argument, Command, Flag } from "effect/cli";

import { t } from "@vibevalley/i18n";
import type * as T from "@vibevalley/protocol";

import { ask, change, given, pick, show } from "./farm.ts";

const nameOf = (c: T.Channel) => c.name ?? c.title;

const channelLine = (c: T.Channel) =>
  [`#${nameOf(c)}`, c.type, c.default ? "default" : "", c.unread !== undefined && c.unread > 0 ? `unread ${c.unread}` : ""].filter((p) => p !== "").join("  ");

const messageLine = (m: T.ChatMessage) => `#${m.number}  ${m.name}: ${m.text.replace(/\s+/gu, " ").trim()}`;

/** The channel a person means: its id, its name with or without #, or a thread's title. */
export const channelNamed = (said: string) =>
  Effect.flatMap(
    ask((api) => api.channel.list()),
    (all) =>
      pick(
        all,
        said,
        (c) => [c.id, c.name, c.title],
        (c) => `#${nameOf(c)}`,
        t("cli.what.channel"),
      ),
  );

const channelArg = Argument.String("channel").pipe(Argument.withDescription(t("cli.arg.channel")));
const words = Argument.String("words").pipe(Argument.variadic(), Argument.withDescription(t("cli.arg.words")));

const listCommand = Command.make("list", {}, () =>
  Effect.flatMap(
    ask((api) => api.channel.list()),
    (all) => show(all, (cs) => cs.map(channelLine).join("\n")),
  ),
).pipe(
  Command.withDescription(t("cli.command.channel.list")),
  Command.withExamples([{ command: "vibevalley channel list", description: t("cli.example.channelList.about") }]),
);

const readCommand = Command.make(
  "read",
  {
    channel: channelArg,
    limit: Flag.Int("limit").pipe(Flag.withDefault(20), Flag.withDescription(t("cli.flag.limit"))),
    before: Flag.Int("before").pipe(Flag.optional, Flag.withDescription(t("cli.flag.before"))),
  },
  (o) =>
    Effect.gen(function* () {
      const channel = yield* channelNamed(o.channel);
      const before = given(o.before);
      const messages = yield* ask((api) => api.channel.message.list({ id: channel.id, limit: o.limit, ...(before === undefined ? {} : { before }) }));
      yield* show(messages, (ms) => {
        const first = ms[0];
        return [...ms.map(messageLine), ...(first && first.number > 1 ? [t("cli.more", { flag: `--before ${first.number}` })] : [])].join("\n");
      });
    }),
).pipe(
  Command.withDescription(t("cli.command.channel.read")),
  Command.withExamples([{ command: "vibevalley channel read general --limit 10", description: t("cli.example.channelRead.about") }]),
);

const sayCommand = Command.make(
  "say",
  { channel: channelArg, words, reply: Flag.Int("reply").pipe(Flag.optional, Flag.withDescription(t("cli.flag.reply"))) },
  (o) =>
    Effect.gen(function* () {
      const channel = yield* channelNamed(o.channel);
      const replyTo = given(o.reply);
      yield* change({
        name: "channel say",
        does: (api) => api.channel.message.send({ id: channel.id, text: o.words.join(" "), ...(replyTo === undefined ? {} : { replyTo }) }),
        said: () => t("cli.channel.said", { channel: `#${nameOf(channel)}` }),
        as: () => ({ channel: channel.id }),
      });
    }),
).pipe(
  Command.withDescription(t("cli.command.channel.say")),
  Command.withExamples([{ command: t("cli.example.channelSay.run"), description: t("cli.example.channelSay.about") }]),
);

const searchCommand = Command.make("search", { words }, (o) =>
  Effect.flatMap(
    ask((api) => api.channel.message.search({ text: o.words.join(" ") })),
    (hits) => show(hits, (hs) => hs.map((h) => `${h.channel}  ${messageLine(h.message)}`).join("\n")),
  ),
).pipe(
  Command.withDescription(t("cli.command.channel.search")),
  Command.withExamples([{ command: t("cli.example.channelSearch.run"), description: t("cli.example.channelSearch.about") }]),
);

export const channelCommand = Command.make("channel").pipe(
  Command.withSubcommands([listCommand, readCommand, sayCommand, searchCommand]),
  Command.withDescription(t("cli.group.channel.about")),
);
