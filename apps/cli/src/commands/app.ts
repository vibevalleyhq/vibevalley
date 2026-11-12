import { t } from "@vibevalley/i18n";

import { type Io, jsonText, printBody, Failure } from "#/base/output.ts";
import { arg, command, group } from "#/infra/command.ts";
import { appStatus, askApp, farmHome, launchedFrom, notOpen } from "#/infra/farm.ts";
import { exitCodeOf } from "#/infra/spawn.ts";

const printed = (io: Io, value: unknown) => printBody(io, jsonText(value ?? { ok: true }));

const statusCommand = command("status", {
  about: t("cli.command.app.status"),
  examples: [{ command: "vibevalley app status", description: t("cli.example.appStatus.about") }],
  run: async (_, ctx) => printed(ctx, await appStatus(ctx)),
});

const notOpenYet = (e: unknown) => e instanceof Failure && e.tag === "AppNotOpen";

/** Opens the page at path; an app not running is started first (VIBEVALLEY_APP, which its launcher sets) and waited for. */
const openCommand = command("open", {
  about: t("cli.command.app.open"),
  examples: [{ command: "vibevalley app open /issues/12", description: t("cli.example.appOpen.about") }],
  params: { path: arg.textOr("path", "/", "cli.arg.appPath") },
  run: async ({ path }, ctx) => {
    const where = path.startsWith("/") ? path : `/${path}`;
    const open = () => askApp(ctx, (c) => c.open(where));
    const app = launchedFrom(ctx);
    try {
      await open();
    } catch (e) {
      if (!notOpenYet(e) || !app) throw e;
      const home = farmHome(ctx);
      try {
        await exitCodeOf("open", [app]);
      } catch (spawned) {
        throw notOpen(home, spawned instanceof Error ? spawned.message : String(spawned));
      }
      // Its socket comes up as it starts: asked again until then, for half a minute.
      for (let tries = 0; ; tries++) {
        try {
          await open();
          break;
        } catch (again) {
          if (!notOpenYet(again) || tries >= 60) throw again;
          await ctx.clock.sleep(500, ctx.signal);
        }
      }
    }
    printed(ctx, { opened: where });
  },
});

const quitCommand = command("quit", {
  about: t("cli.command.app.quit"),
  examples: [{ command: "vibevalley app quit", description: t("cli.example.appQuit.about") }],
  run: async (_, ctx) => printed(ctx, await askApp(ctx, (c) => c.quit())),
});

const restartCommand = command("restart", {
  about: t("cli.command.app.restart"),
  examples: [{ command: "vibevalley app restart", description: t("cli.example.appRestart.about") }],
  run: async (_, ctx) => printed(ctx, await askApp(ctx, (c) => c.restart())),
});

/** Where the app's update stands; check asks for one now, install puts a downloaded one in place and restarts. */
const updateCommand = command("update", {
  about: t("cli.command.app.update"),
  examples: [{ command: "vibevalley app update check", description: t("cli.example.appUpdate.about") }],
  params: { step: arg.optionalChoice("step", ["check", "install"], "cli.arg.updateStep") },
  run: async ({ step }, ctx) => {
    if (step === "check") await askApp(ctx, (c) => c.updateCheck());
    if (step === "install") return printed(ctx, await askApp(ctx, (c) => c.updateInstall()));
    printed(ctx, await askApp(ctx, (c) => c.updateState()));
  },
});

export const appCommand = group("app", t("cli.command.app.about"), [statusCommand, openCommand, quitCommand, restartCommand, updateCommand]);
