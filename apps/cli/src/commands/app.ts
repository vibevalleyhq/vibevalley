import { Effect, Schedule } from "effect";
import { Argument, Command } from "effect/cli";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { t } from "@vibevalley/i18n";

import { appStatus, askApp, farmHome, launchedFrom, notOpen } from "#/farm.ts";
import { jsonText, printBody } from "#/output.ts";

const printed = (value: unknown) => Effect.flatMap(jsonText(value ?? { ok: true }), printBody);

const statusCommand = Command.make("status", {}, () => Effect.flatMap(appStatus, printed)).pipe(
  Command.withDescription(t("cli.command.app.status")),
  Command.withExamples([{ command: "vibevalley app status", description: t("cli.example.appStatus.about") }]),
);

/** Opens the page at path; an app not running is started first (VIBEVALLEY_APP, which its launcher sets) and waited for. */
const openCommand = Command.make(
  "open",
  { path: Argument.String("path").pipe(Argument.withDefault("/"), Argument.withDescription(t("cli.arg.appPath"))) },
  ({ path }) =>
    Effect.gen(function* () {
      const where = path.startsWith("/") ? path : `/${path}`;
      const open = askApp((c) => c.open(where));
      const app = yield* launchedFrom;
      yield* open.pipe(
        Effect.catchTag("Failure", (f) => {
          if (f.tag !== "AppNotOpen" || !app) return Effect.fail(f);
          return Effect.gen(function* () {
            const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
            const home = yield* farmHome;
            yield* spawner.exitCode(ChildProcess.make("open", [app])).pipe(Effect.mapError((e) => notOpen(home, e.message)));
            // Its socket comes up as it starts: asked again until then, for half a minute.
            return yield* open.pipe(
              Effect.retry({ schedule: Schedule.spaced("500 millis"), times: 60, while: (e) => e._tag === "Failure" && e.tag === "AppNotOpen" }),
            );
          });
        }),
      );
      yield* printed({ opened: where });
    }),
).pipe(
  Command.withDescription(t("cli.command.app.open")),
  Command.withExamples([{ command: "vibevalley app open /issues/12", description: t("cli.example.appOpen.about") }]),
);

const quitCommand = Command.make("quit", {}, () =>
  Effect.flatMap(
    askApp((c) => c.quit()),
    printed,
  ),
).pipe(
  Command.withDescription(t("cli.command.app.quit")),
  Command.withExamples([{ command: "vibevalley app quit", description: t("cli.example.appQuit.about") }]),
);

const restartCommand = Command.make("restart", {}, () =>
  Effect.flatMap(
    askApp((c) => c.restart()),
    printed,
  ),
).pipe(
  Command.withDescription(t("cli.command.app.restart")),
  Command.withExamples([{ command: "vibevalley app restart", description: t("cli.example.appRestart.about") }]),
);

/** Where the app's update stands; check asks for one now, install puts a downloaded one in place and restarts. */
const updateCommand = Command.make(
  "update",
  { step: Argument.Literals("step", ["check", "install"]).pipe(Argument.optional, Argument.withDescription(t("cli.arg.updateStep"))) },
  ({ step }) =>
    Effect.gen(function* () {
      if (step._tag === "Some" && step.value === "check") yield* askApp((c) => c.updateCheck());
      if (step._tag === "Some" && step.value === "install")
        return yield* Effect.flatMap(
          askApp((c) => c.updateInstall()),
          printed,
        );
      yield* Effect.flatMap(
        askApp((c) => c.updateState()),
        printed,
      );
    }),
).pipe(
  Command.withDescription(t("cli.command.app.update")),
  Command.withExamples([{ command: "vibevalley app update check", description: t("cli.example.appUpdate.about") }]),
);

export const appCommand = Command.make("app").pipe(
  Command.withSubcommands([statusCommand, openCommand, quitCommand, restartCommand, updateCommand]),
  Command.withDescription(t("cli.command.app.about")),
);
