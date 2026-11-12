import { announced } from "@vibevalley/home";
import { t } from "@vibevalley/i18n";

import { exit, Failure, jsonText, type Next, printBody } from "#/base/output.ts";
import { command } from "#/infra/command.ts";
import { appStatus, ask, farmHome } from "#/infra/farm.ts";

interface Check {
  readonly check: string;
  readonly ok: boolean;
  readonly [field: string]: unknown;
}

const failed = (check: string, why: string, next: readonly Next[], more: Record<string, unknown> = {}): Check => ({ check, ok: false, why, next, ...more });

const whyOf = (e: unknown) => (e instanceof Failure ? e.text : String(e));

export const doctorCommand = command("doctor", {
  about: t("cli.command.doctor"),
  examples: [{ command: "vibevalley doctor", description: t("cli.example.doctor.about") }],
  run: async (_, ctx) => {
    const base = ctx.flags.server;
    const home = farmHome(ctx);
    const checks: Check[] = [{ check: "farm", ok: true, home, server: base, from: announced(home) === base ? "server.json" : "default" }];

    let health: Check;
    try {
      const h = await ask(ctx, (api) => api.server.health.get());
      health = { check: "server", ok: h.ok, version: h.version };
    } catch (e) {
      health = failed("server", whyOf(e), [{ say: t("cli.next.openApp"), run: ["app", "open"] }, { say: t("cli.next.startServer") }]);
    }
    checks.push(health);
    if ("why" in health) {
      printBody(ctx, jsonText(checks));
      throw new Failure({ code: exit.unreachable, tag: "Doctor", text: t("cli.doctor.unreachable", { base }) });
    }

    // The desktop app not being open is fine: a farm runs without it too (vp run start).
    try {
      checks.push({ check: "app", ok: true, open: true, ...(await appStatus(ctx)) });
    } catch {
      // Not open (or not answering): said as such in the check itself.
      checks.push({ check: "app", ok: true, open: false });
    }

    const runtimes = await ask(ctx, (api) => api.runtime.list());
    const installed = runtimes.flatMap((r) => (r.installation.status === "available" ? [r.id] : []));
    checks.push(
      installed.length > 0
        ? { check: "runtimes", ok: true, installed }
        : failed("runtimes", t("cli.doctor.noRuntime"), [{ say: t("cli.doctor.installRuntime"), run: ["runtime", "list"] }]),
    );

    const settings = await ask(ctx, (api) => api.setting.get());
    checks.push(
      settings.deepseekApiKey.source !== undefined
        ? { check: "model", ok: true, from: settings.deepseekApiKey.source }
        : failed("model", t("cli.doctor.noModelKey"), [{ say: t("cli.doctor.setModelKey"), run: ["app", "open", "/settings/models"] }]),
    );

    const lan = await ask(ctx, (api) => api.lan.get());
    checks.push(
      lan.problem === ""
        ? { check: "lan", ok: true, open: lan.open }
        : failed("lan", lan.problem, [{ say: t("cli.doctor.lanSettings"), run: ["app", "open", "/settings/devices"] }]),
    );

    printBody(ctx, jsonText(checks));
    const wrong = checks.filter((c) => !c.ok).map((c) => c.check);
    if (wrong.length > 0) throw new Failure({ code: exit.other, tag: "Doctor", text: t("cli.doctor.wrong", { checks: wrong.join(", ") }) });
  },
});
