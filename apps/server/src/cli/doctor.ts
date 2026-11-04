// `vibevalley doctor`: how this machine's farm is, in one answer, a check a line: which farm the command line found, whether
// it answers, the desktop app, the runtimes, the model's key, the LAN listener. Each says ok, and when not, why and what
// to do next, in the words a failure uses; a farm that does not answer ends the run with its exit code.

import { Effect, Schema } from "effect";
import { Command } from "effect/cli";

import { announced } from "@vibevalley/home";
import { t } from "@vibevalley/i18n";

import { ServerFlag } from "./api.ts";
import { appStatus, farmHome } from "./app.ts";
import { ask } from "./farm.ts";
import { exit, Failure, type Next, printBody } from "./output.ts";

interface Check {
  readonly check: string;
  readonly ok: boolean;
  readonly [field: string]: unknown;
}

const failed = (check: string, why: string, next: readonly Next[], more: Record<string, unknown> = {}): Check => ({ check, ok: false, why, next, ...more });

const whyOf = (e: unknown) => (Schema.is(Failure)(e) ? e.text : String(e));

export const doctorCommand = Command.make("doctor", {}, () =>
  Effect.gen(function* () {
    const base = yield* ServerFlag;
    const home = yield* farmHome;
    const checks: Check[] = [{ check: "farm", ok: true, home, server: base, from: announced(home) === base ? "server.json" : "default" }];

    const health = yield* ask((api) => api.server.health.get()).pipe(
      Effect.match({
        onSuccess: (h): Check => ({ check: "server", ok: h.ok, version: h.version }),
        onFailure: (e) => failed("server", whyOf(e), [{ say: t("server.cli.next.openApp"), run: ["app", "open"] }, { say: t("server.cli.next.startServer") }]),
      }),
    );
    checks.push(health);
    if ("why" in health) {
      yield* printBody(JSON.stringify(checks));
      return yield* new Failure({ code: exit.unreachable, tag: "Doctor", text: t("server.cli.doctor.unreachable", { base }) });
    }

    // The desktop app not being open is fine: a farm runs without it too (vp run start).
    checks.push(
      yield* appStatus.pipe(
        Effect.match({
          onSuccess: (s): Check => ({ check: "app", ok: true, open: true, ...s }),
          onFailure: (): Check => ({ check: "app", ok: true, open: false }),
        }),
      ),
    );

    const runtimes = yield* ask((api) => api.runtime.list());
    const installed = runtimes.flatMap((r) => (r.installation.status === "available" ? [r.id] : []));
    checks.push(
      installed.length > 0
        ? { check: "runtimes", ok: true, installed }
        : failed("runtimes", t("server.cli.doctor.noRuntime"), [{ say: t("server.cli.doctor.installRuntime"), run: ["runtime", "refresh"] }]),
    );

    const settings = yield* ask((api) => api.setting.get());
    checks.push(
      settings.deepseekApiKey.source !== undefined
        ? { check: "model", ok: true, from: settings.deepseekApiKey.source }
        : failed("model", t("server.cli.doctor.noModelKey"), [{ say: t("server.cli.doctor.setModelKey"), run: ["app", "open", "/settings/models"] }]),
    );

    const lan = yield* ask((api) => api.lan.get());
    checks.push(
      lan.problem === ""
        ? { check: "lan", ok: true, open: lan.open }
        : failed("lan", lan.problem, [{ say: t("server.cli.doctor.lanSettings"), run: ["app", "open", "/settings/devices"] }]),
    );

    yield* printBody(JSON.stringify(checks));
    const wrong = checks.filter((c) => !c.ok).map((c) => c.check);
    if (wrong.length > 0) return yield* new Failure({ code: exit.other, tag: "Doctor", text: t("server.cli.doctor.wrong", { checks: wrong.join(", ") }) });
  }),
).pipe(
  Command.withDescription(t("server.cli.command.doctor")),
  Command.withExamples([{ command: "vibevalley doctor", description: t("server.cli.example.doctor.about") }]),
);
