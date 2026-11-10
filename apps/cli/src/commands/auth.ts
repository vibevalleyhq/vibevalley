import { hostname } from "node:os";

import { Duration, Effect, Option, String as Str } from "effect";
import { Argument, Command } from "effect/cli";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { forgetSignIn, keepSignIn, signedIn } from "@vibevalley/home";
import { t } from "@vibevalley/i18n";

import { askAt, farmHome, ServerFlag, serverOf } from "#/farm.ts";
import { show } from "#/format.ts";
import { err } from "#/output.ts";

/** What the server lists this computer as: its host name, without .local. */
const deviceName = () => Str.replace(/\.local$/u, "")(hostname());

/** Opens the link in the browser where someone is at the terminal; said, not failed, when it cannot. */
const openInBrowser = (link: string) =>
  Effect.gen(function* () {
    if (process.stdout.isTTY !== true) return;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const command =
      process.platform === "darwin"
        ? ChildProcess.make("open", [link])
        : process.platform === "win32"
          ? ChildProcess.make("cmd", ["/c", "start", "", link])
          : ChildProcess.make("xdg-open", [link]);
    yield* spawner.exitCode(command).pipe(Effect.catch(() => err(t("cli.auth.noBrowser"))));
  });

const serverArg = Argument.String("server").pipe(Argument.optional, Argument.withDescription(t("cli.arg.authServer")));

/** Like gh auth login: a code shown here, approved on a page that already holds a key, and this computer's own key
 * collected and kept in the home (auth.json); every command after sends it to that server. */
const loginCommand = Command.make("login", { server: serverArg }, ({ server }) =>
  Effect.gen(function* () {
    const base = serverOf(Option.getOrUndefined(server) ?? (yield* ServerFlag));
    // The server says whether this request came from its own computer, past no gate: then it is the user already.
    if ((yield* askAt(base)((api) => api.user.get())).here) return yield* show({ server: base, here: true }, () => t("cli.auth.here", { server: base }));
    const asked = yield* askAt(base)((api) => api.user.approval.create({ name: deviceName() }));
    const link = `${base}/approve?code=${encodeURIComponent(asked.code)}`;
    yield* err(t("cli.auth.approve", { code: asked.code, link }));
    yield* openInBrowser(link);
    // Asked until approved; refused (expired, or turned down) ends it with the server's reason.
    let login = (yield* askAt(base)((api) => api.user.approval.collect({ claim: asked.claim }))).login;
    while (login === undefined) {
      yield* Effect.sleep(Duration.seconds(asked.every));
      login = (yield* askAt(base)((api) => api.user.approval.collect({ claim: asked.claim }))).login;
    }
    const home = yield* farmHome;
    keepSignIn({ home, server: base, key: login.key, device: login.device });
    const me = yield* askAt(base)((api) => api.user.get());
    const device = me.device?.name ?? deviceName();
    return yield* show({ server: base, device: login.device, name: me.name }, () => t("cli.auth.signedIn", { server: base, device }));
  }),
).pipe(
  Command.withDescription(t("cli.command.auth.login")),
  Command.withExamples([{ command: "vibevalley auth login https://farm.example.com", description: t("cli.example.authLogin.about") }]),
);

const statusCommand = Command.make("status", {}, () =>
  Effect.gen(function* () {
    const home = yield* farmHome;
    const saved = signedIn(home);
    if (saved === undefined) {
      const base = yield* ServerFlag;
      return yield* show({ signedIn: false, server: base }, () => t("cli.auth.notSignedIn", { server: base }));
    }
    const me = yield* askAt(saved.server)((api) => api.user.get());
    // A key taken back on a page still answers user.get, as a caller with no key.
    if (me.device === undefined)
      return yield* show({ signedIn: false, server: saved.server, revoked: true }, () => t("cli.auth.revoked", { server: saved.server }));
    return yield* show({ signedIn: true, server: saved.server, device: me.device, name: me.name }, () =>
      t("cli.auth.status", { server: saved.server, device: me.device?.name ?? "", name: me.name }),
    );
  }),
).pipe(
  Command.withDescription(t("cli.command.auth.status")),
  Command.withExamples([{ command: "vibevalley auth status", description: t("cli.example.authStatus.about") }]),
);

const logoutCommand = Command.make("logout", {}, () =>
  Effect.gen(function* () {
    const home = yield* farmHome;
    const saved = signedIn(home);
    if (saved === undefined) {
      const base = yield* ServerFlag;
      return yield* show({ signedIn: false, server: base }, () => t("cli.auth.notSignedIn", { server: base }));
    }
    // The key is taken back on the server when it can be reached; this computer forgets it either way.
    yield* askAt(saved.server)((api) => api.user.logout()).pipe(Effect.catchTag("Failure", (f) => err(t("cli.auth.logoutUnsaid", { why: f.text }))));
    forgetSignIn(home);
    return yield* show({ signedIn: false, server: saved.server }, () => t("cli.auth.signedOut", { server: saved.server }));
  }),
).pipe(
  Command.withDescription(t("cli.command.auth.logout")),
  Command.withExamples([{ command: "vibevalley auth logout", description: t("cli.example.authLogout.about") }]),
);

export const authCommand = Command.make("auth").pipe(
  Command.withSubcommands([loginCommand, statusCommand, logoutCommand]),
  Command.withDescription(t("cli.command.auth.about")),
);
