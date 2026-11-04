// `vibevalley search 打卡 端口`: everything the farm knows that has these words, from one command: the issues, what was
// said in the channels, the notes and the profiles' memories, each under its own heading. An agent need not know first
// where a thing was written; --in narrows it to some of them.

import { Effect } from "effect";
import { Argument, Command, Flag } from "effect/cli";

import { t } from "@vibevalley/i18n";

import { channelHitLine } from "./channel.ts";
import { ask, show } from "./farm.ts";
import { issueLine } from "./issue.ts";
import { memoryLine } from "./notes.ts";
import { pkmHitLine } from "./pkm.ts";

const placeValues = ["issues", "channels", "notes", "memory"] as const;
type Place = (typeof placeValues)[number];

const searchCommand = Command.make(
  "search",
  {
    words: Argument.String("words").pipe(Argument.variadic({ min: 1 }), Argument.withDescription(t("cli.arg.words"))),
    in: Flag.Literals("in", placeValues).pipe(Flag.atLeast(0), Flag.withDescription(t("cli.flag.searchIn"))),
    limit: Flag.Int("limit").pipe(Flag.withDefault(10), Flag.withDescription(t("cli.flag.searchLimit"))),
  },
  (o) =>
    Effect.gen(function* () {
      const text = o.words.join(" ");
      const wanted = (p: Place) => o.in.length === 0 || o.in.includes(p);
      const none = Effect.succeed(undefined);
      const [issues, channels, notes, memory] = yield* Effect.all(
        [
          wanted("issues") ? ask((api) => api.issue.list({ text, limit: o.limit })) : none,
          wanted("channels") ? ask((api) => api.channel.message.search({ text })) : none,
          wanted("notes") ? ask((api) => api.pkm.search({ text })) : none,
          wanted("memory") ? ask((api) => api.memory.search({ text })) : none,
        ],
        { concurrency: "unbounded" },
      );
      const found = {
        ...(issues ? { issues: issues.slice(0, o.limit) } : {}),
        ...(channels ? { channels: channels.slice(0, o.limit) } : {}),
        ...(notes ? { notes: notes.slice(0, o.limit) } : {}),
        ...(memory ? { memory: memory.found.slice(0, o.limit) } : {}),
      };
      const part = (heading: string, lines: readonly string[]) => (lines.length === 0 ? [] : [`## ${heading}`, ...lines]);
      yield* show(
        found,
        (f) =>
          [
            ...part(t("cli.search.issues"), (f.issues ?? []).map(issueLine)),
            ...part(t("cli.search.channels"), (f.channels ?? []).map(channelHitLine)),
            ...part(t("cli.search.notes"), (f.notes ?? []).map(pkmHitLine)),
            ...part(t("cli.search.memory"), (f.memory ?? []).map(memoryLine)),
          ].join("\n") || t("cli.search.nothing", { words: text }),
      );
    }),
).pipe(
  Command.withDescription(t("cli.command.search")),
  Command.withExamples([
    { command: t("cli.example.search.run"), description: t("cli.example.search.about") },
    { command: t("cli.example.searchIn.run"), description: t("cli.example.searchIn.about") },
  ]),
);

export { searchCommand };
