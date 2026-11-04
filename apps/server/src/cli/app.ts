// `vibevalley app …`: the desktop app's own abilities, asked of it over its socket in the farm's home
// (desktopControl, apps/desktop src/control.ts), as the page asks them through the window.

import { connect as dial, type Socket } from "node:net";
import { join } from "node:path";

import { Config, Effect, Schedule } from "effect";
import { Argument, Command } from "effect/cli";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { connect } from "@vibevalley/bridge";
import { socketLink } from "@vibevalley/bridge/socket";
import { t } from "@vibevalley/i18n";
import { desktopControl, desktopControlSocket } from "@vibevalley/protocol/host";

import { homeOf } from "@/infra/lease.ts";

import { exit, Failure, printBody } from "./output.ts";

type Calls = ReturnType<typeof connect<typeof desktopControl>>["call"];

/** The farm's home as the command line's environment says (VIBEVALLEY_HOME, the launcher sets it per channel), read
 * through Config so a test gives its own. */
export const farmHome = Config.String("VIBEVALLEY_HOME").pipe(
  Config.withDefault(""),
  Config.map((home) => home || homeOf({})),
);

/** The app the launcher was started from, to open when it is not running; none from the repository. */
const launchedFrom = Config.String("VIBEVALLEY_APP").pipe(Config.withDefault(""));

const notOpen = (home: string, why: string) =>
  new Failure({
    code: exit.unreachable,
    tag: "AppNotOpen",
    text: t("server.cli.failure.appNotOpen", { home, why }),
    next: [{ say: t("server.cli.next.openApp"), run: ["app", "open"] }],
  });

const dialed = Effect.flatMap(farmHome, (home) =>
  Effect.callback<Socket, Failure>((resume) => {
    const socket = dial(join(home, desktopControlSocket));
    socket.once("connect", () => resume(Effect.succeed(socket)));
    socket.once("error", (e) => resume(Effect.fail(notOpen(home, e.message))));
    return Effect.sync(() => socket.destroy());
  }),
);

/** One question to the app, on a connection of its own. */
const ask = <A>(use: (calls: Calls) => Promise<A>) =>
  Effect.scoped(
    Effect.gen(function* () {
      const socket = yield* Effect.acquireRelease(dialed, (s) => Effect.sync(() => s.destroy()));
      const asked = connect(desktopControl, socketLink(socket));
      return yield* Effect.tryPromise({
        try: () => use(asked.call),
        catch: (e) => new Failure({ code: exit.refused, tag: "AppRefused", text: e instanceof Error ? e.message : String(e) }),
      });
    }),
  );

const printed = (value: unknown) => printBody(JSON.stringify(value ?? { ok: true }));

/** Which app answers on this farm's socket; fails AppNotOpen when none does (doctor reads it too). */
export const appStatus = ask((c) => c.status());

const statusCommand = Command.make("status", {}, () => Effect.flatMap(appStatus, printed)).pipe(Command.withDescription(t("server.cli.command.app.status")));

/** Opens the page at path; an app not running is started first (VIBEVALLEY_APP, which its launcher sets) and waited for. */
const openCommand = Command.make("open", { path: Argument.String("path").pipe(Argument.withDefault("/")) }, ({ path }) =>
  Effect.gen(function* () {
    const where = path.startsWith("/") ? path : `/${path}`;
    const open = ask((c) => c.open(where));
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
).pipe(Command.withDescription(t("server.cli.command.app.open")));

const quitCommand = Command.make("quit", {}, () =>
  Effect.flatMap(
    ask((c) => c.quit()),
    printed,
  ),
).pipe(Command.withDescription(t("server.cli.command.app.quit")));

const restartCommand = Command.make("restart", {}, () =>
  Effect.flatMap(
    ask((c) => c.restart()),
    printed,
  ),
).pipe(Command.withDescription(t("server.cli.command.app.restart")));

/** Where the app's update stands; check asks for one now, install puts a downloaded one in place and restarts. */
const updateCommand = Command.make("update", { step: Argument.Literals("step", ["check", "install"]).pipe(Argument.optional) }, ({ step }) =>
  Effect.gen(function* () {
    if (step._tag === "Some" && step.value === "check") yield* ask((c) => c.updateCheck());
    if (step._tag === "Some" && step.value === "install")
      return yield* Effect.flatMap(
        ask((c) => c.updateInstall()),
        printed,
      );
    yield* Effect.flatMap(
      ask((c) => c.updateState()),
      printed,
    );
  }),
).pipe(Command.withDescription(t("server.cli.command.app.update")));

export const appCommand = Command.make("app").pipe(
  Command.withSubcommands([statusCommand, openCommand, quitCommand, restartCommand, updateCommand]),
  Command.withDescription(t("server.cli.command.app.about")),
);
