// `vibevalley guide`: the common things an agent does with the farm, each with its commands, in the farm's language
// (cli/guide/<locale>.md, carried beside the packaged app's bundle: assets.ts).

import { Effect, FileSystem } from "effect";
import { Command } from "effect/cli";

import { currentLocale, t } from "@vibevalley/i18n";

import { serverFile } from "@/assets.ts";

import { exit, Failure, out } from "./output.ts";

export const guideCommand = Command.make("guide", {}, () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const text = yield* fs
      .readFileString(serverFile(`src/cli/guide/${currentLocale()}.md`))
      .pipe(Effect.mapError((e) => new Failure({ code: exit.other, tag: "File", text: e.message })));
    yield* out(text.replace(/\n+$/u, ""));
  }),
).pipe(
  Command.withDescription(t("server.cli.command.guide")),
  Command.withExamples([{ command: "vibevalley guide", description: t("server.cli.example.guide.about") }]),
);
