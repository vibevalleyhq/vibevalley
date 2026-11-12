import { t } from "@vibevalley/i18n";
import type * as T from "@vibevalley/protocol";

import { show } from "#/base/format.ts";
import { arg, command, group, opt } from "#/infra/command.ts";
import { ask, change } from "#/infra/farm.ts";

const nameOf = (c: T.Channel) => c.name ?? c.title;

const channelLine = (c: T.Channel) =>
  [`#${nameOf(c)}`, c.type, c.default ? "default" : "", c.unread !== undefined && c.unread > 0 ? `unread ${c.unread}` : ""].filter((p) => p !== "").join("  ");

const messageLine = (m: T.ChatMessage) => `#${m.number}  ${m.name}: ${m.text.replace(/\s+/gu, " ").trim()}`;

const channelArg = arg.text("channel", "cli.arg.channel");

const listCommand = command("list", {
  about: t("cli.command.channel.list"),
  examples: [{ command: "vibevalley channel list", description: t("cli.example.channelList.about") }],
  run: async (_, ctx) => show(ctx, await ask(ctx, (api) => api.channel.list()), (cs) => cs.map(channelLine).join("\n")),
});

const messageList = command("list", {
  about: t("cli.command.channel.messageList"),
  examples: [{ command: "vibevalley channel message list general --limit 10", description: t("cli.example.channelMessageList.about") }],
  params: {
    channel: channelArg,
    limit: opt.intOr("limit", 20, "cli.flag.limit"),
    before: opt.int("before", "cli.flag.before"),
  },
  run: async (o, ctx) => {
    const before = o.before;
    const messages = await ask(ctx, (api) => api.channel.message.list({ id: o.channel, limit: o.limit, ...(before === undefined ? {} : { before }) }));
    show(ctx, messages, (ms) => {
      const first = ms[0];
      return [...ms.map(messageLine), ...(first && first.number > 1 ? [t("cli.more", { flag: `--before ${first.number}` })] : [])].join("\n");
    });
  },
});

const messageSend = command("send", {
  about: t("cli.command.channel.messageSend"),
  examples: [{ command: t("cli.example.channelMessageSend.run"), description: t("cli.example.channelMessageSend.about") }],
  params: { channel: channelArg, words: arg.words("cli.arg.message"), reply: opt.int("reply", "cli.flag.reply") },
  run: (o, ctx) => {
    const replyTo = o.reply;
    return change(ctx, {
      name: "channel message send",
      does: (api) => api.channel.message.send({ id: o.channel, text: o.words.join(" "), ...(replyTo === undefined ? {} : { replyTo }) }),
      said: () => t("cli.channel.sent", { channel: o.channel }),
    });
  },
});

const messageSearch = command("search", {
  about: t("cli.command.channel.messageSearch"),
  examples: [{ command: t("cli.example.channelMessageSearch.run"), description: t("cli.example.channelMessageSearch.about") }],
  params: { words: arg.words("cli.arg.search") },
  run: async (o, ctx) =>
    show(ctx, await ask(ctx, (api) => api.channel.message.search({ text: o.words.join(" ") })), (hs) =>
      hs.map((h) => `${h.channel}  ${messageLine(h.message)}`).join("\n"),
    ),
});

const messageGroup = group("message", t("cli.group.channel.message.about"), [messageList, messageSend, messageSearch]);

export const channelCommand = group("channel", t("cli.group.channel.about"), [listCommand, messageGroup]);
