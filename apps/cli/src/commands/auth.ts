import { hostname } from "node:os";

import { forgetSignIn, keepSignIn, signedIn } from "@vibevalley/home";
import { t } from "@vibevalley/i18n";

import { show } from "#/base/format.ts";
import { err, Failure, type Io } from "#/base/output.ts";
import { arg, command, group } from "#/infra/command.ts";
import { askAt, farmHome, serverOf } from "#/infra/farm.ts";
import { exitCodeOf } from "#/infra/spawn.ts";

/** What the server lists this computer as: its host name, without .local. */
const deviceName = () => hostname().replace(/\.local$/u, "");

/** Opens the link in the browser where someone is at the terminal; said, not failed, when it cannot. */
const openInBrowser = async (io: Io, link: string) => {
  if (process.stdout.isTTY !== true) return;
  const [command, args] =
    process.platform === "darwin" ? ["open", [link]] : process.platform === "win32" ? ["cmd", ["/c", "start", "", link]] : ["xdg-open", [link]];
  try {
    await exitCodeOf(command, args);
  } catch {
    // No browser to open it in: the link printed above is the way.
    err(io, t("cli.auth.noBrowser"));
  }
};

/** Like gh auth login: a code shown here, approved on a page that already holds a key, and this computer's own key
 * collected and kept in the home (auth.json); every command after sends it to that server. */
const loginCommand = command("login", {
  about: t("cli.command.auth.login"),
  examples: [{ command: "vibevalley auth login https://farm.example.com", description: t("cli.example.authLogin.about") }],
  params: { server: arg.optional("server", "cli.arg.authServer") },
  run: async ({ server }, ctx) => {
    const base = serverOf(server ?? ctx.flags.server);
    const asking = askAt(ctx, base);
    // The server says whether this request came from its own computer, past no gate: then it is the user already.
    if ((await asking((api) => api.user.get())).here) return show(ctx, { server: base, here: true }, () => t("cli.auth.here", { server: base }));
    const asked = await asking((api) => api.user.approval.create({ name: deviceName() }));
    const link = `${base}/approve?code=${encodeURIComponent(asked.code)}`;
    err(ctx, t("cli.auth.approve", { code: asked.code, link }));
    await openInBrowser(ctx, link);
    // Asked until approved; refused (expired, or turned down) ends it with the server's reason.
    // The server may ask for longer waits (slow_down); from then on it waits that long.
    let every = asked.every;
    let collected = await asking((api) => api.user.approval.collect({ claim: asked.claim }));
    while (collected.login === undefined) {
      every = collected.every ?? every;
      await ctx.clock.sleep(every * 1000, ctx.signal);
      collected = await asking((api) => api.user.approval.collect({ claim: asked.claim }));
    }
    const login = collected.login;
    keepSignIn({ home: farmHome(ctx), server: base, key: login.key, device: login.device });
    const me = await asking((api) => api.user.get());
    const device = me.device?.name ?? deviceName();
    show(ctx, { server: base, device: login.device, name: me.name }, () => t("cli.auth.signedIn", { server: base, device }));
  },
});

const statusCommand = command("status", {
  about: t("cli.command.auth.status"),
  examples: [{ command: "vibevalley auth status", description: t("cli.example.authStatus.about") }],
  run: async (_, ctx) => {
    const saved = signedIn(farmHome(ctx));
    if (saved === undefined) {
      const base = ctx.flags.server;
      return show(ctx, { signedIn: false, server: base }, () => t("cli.auth.notSignedIn", { server: base }));
    }
    const me = await askAt(ctx, saved.server)((api) => api.user.get());
    // A key taken back on a page still answers user.get, as a caller with no key.
    if (me.device === undefined)
      return show(ctx, { signedIn: false, server: saved.server, revoked: true }, () => t("cli.auth.revoked", { server: saved.server }));
    show(ctx, { signedIn: true, server: saved.server, device: me.device, name: me.name }, () =>
      t("cli.auth.status", { server: saved.server, device: me.device?.name ?? "", name: me.name }),
    );
  },
});

const logoutCommand = command("logout", {
  about: t("cli.command.auth.logout"),
  examples: [{ command: "vibevalley auth logout", description: t("cli.example.authLogout.about") }],
  run: async (_, ctx) => {
    const home = farmHome(ctx);
    const saved = signedIn(home);
    if (saved === undefined) {
      const base = ctx.flags.server;
      return show(ctx, { signedIn: false, server: base }, () => t("cli.auth.notSignedIn", { server: base }));
    }
    // The key is taken back on the server when it can be reached; this computer forgets it either way.
    try {
      await askAt(ctx, saved.server)((api) => api.user.logout());
    } catch (e) {
      if (!(e instanceof Failure)) throw e;
      err(ctx, t("cli.auth.logoutUnsaid", { why: e.text }));
    }
    forgetSignIn(home);
    show(ctx, { signedIn: false, server: saved.server }, () => t("cli.auth.signedOut", { server: saved.server }));
  },
});

export const authCommand = group("auth", t("cli.command.auth.about"), [loginCommand, statusCommand, logoutCommand]);
