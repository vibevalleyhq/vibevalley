import { Effect } from "effect";
import { Flag, GlobalFlag } from "effect/cli";

import { homeOf, savedLocale } from "@vibevalley/home";
import { setLocale, t } from "@vibevalley/i18n";

import { jsonText, out, printBody } from "./output.ts";

setLocale(savedLocale(homeOf()));

export const DryRunFlag = GlobalFlag.Setting("dry-run")({
  flag: Flag.Boolean("dry-run").pipe(Flag.withDefault(false), Flag.withDescription(t("cli.flag.dryRun"))),
});

export const FormatFlag = GlobalFlag.Setting("format")({
  flag: Flag.Literals("format", ["text", "json"]).pipe(Flag.withDefault("text" as const), Flag.withDescription(t("cli.flag.format"))),
});

export const show = <A>(value: A, text: (value: A) => string) =>
  Effect.flatMap(FormatFlag, (format) => (format === "json" ? Effect.flatMap(jsonText(value ?? null), printBody) : out(text(value))));
