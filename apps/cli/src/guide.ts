import { Effect, FileSystem } from "effect";
import { Command } from "effect/cli";

import { currentLocale, t } from "@vibevalley/i18n";

import { cliFile } from "./assets.ts";
import { exit, Failure, out } from "./output.ts";

export const guideCommand = Command.make("guide", {}, () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const text = yield* fs
      .readFileString(cliFile(`src/guide/${currentLocale()}.md`))
      .pipe(Effect.mapError((e) => new Failure({ code: exit.other, tag: "File", text: e.message })));
    yield* out(text.replace(/\n+$/u, ""));
  }),
).pipe(Command.withDescription(t("cli.command.guide")), Command.withExamples([{ command: "vibevalley guide", description: t("cli.example.guide.about") }]));
