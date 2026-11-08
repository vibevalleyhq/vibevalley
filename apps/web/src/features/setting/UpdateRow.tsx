import * as stylex from "@stylexjs/stylex";
import { createSignal, Match, onSettled, Show, Switch } from "solid-js";

import { t } from "@vibevalley/i18n";
import type { CommandLineState } from "@vibevalley/protocol/host";
import { isBusy } from "@vibevalley/protocol/rules";

import { variant } from "#/base/dom.tsx";
import { reasonOf } from "#/infra/api.ts";
import { useCore } from "#/infra/frame.ts";
import { currentHost } from "#/infra/host.ts";
import { useUpdates } from "#/infra/settings.ts";
import { Button } from "#/ui/Button.tsx";
import { ConfirmButton } from "#/ui/ConfirmButton.tsx";
import { SettingRow } from "#/ui/settings.tsx";
import { toast } from "#/ui/toasts.ts";

const viewStyles = stylex.create({
  updateState: {
    fontSize: "var(--text-sm)",
    lineHeight: "var(--text-sm--line-height)",
    color: "var(--wb-muted)",
  },
  updateRowA: {
    fontSize: "var(--text-sm)",
    lineHeight: "var(--text-sm--line-height)",
    textDecorationLine: "underline",
  },
  cliState: {
    fontFamily: "var(--font-mono)",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--text-xs--line-height)",
    color: "var(--wb-muted)",
  },
});

export function UpdateRow() {
  const update = currentHost().update;
  const state = useUpdates();
  const core = useCore();
  const working = () => (core()?.sessions ?? []).filter(isBusy).length;
  const check = () => void update?.check().catch((e: unknown) => toast(reasonOf(e), "bad"));
  const install = () => void update?.install().catch((e: unknown) => toast(reasonOf(e), "bad"));
  return (
    <Show when={state()}>
      {(s) => (
        <SettingRow label={t("web.setting.about.update")} hint={t("web.setting.about.updateHint")}>
          <span data-testid="update-state" data-state={s()._tag} {...stylex.attrs(viewStyles.updateState)}>
            <Switch>
              <Match when={s()._tag === "idle"}>{t("web.setting.about.upToDate")}</Match>
              <Match when={s()._tag === "checking"}>{t("web.setting.about.checking")}</Match>
              <Match when={variant(s(), "_tag", "downloading")}>{(d) => t("web.setting.about.downloading", { next: d().next, percent: d().percent })}</Match>
              <Match when={variant(s(), "_tag", "ready")}>
                {(r) => (r().newFarm ? t("web.setting.about.readyNewFarm", { next: r().next }) : t("web.setting.about.ready", { next: r().next }))}
              </Match>
              <Match when={variant(s(), "_tag", "manual")}>{(m) => t(`web.setting.about.manual.${m().why}`, { next: m().next })}</Match>
              <Match when={variant(s(), "_tag", "failed")}>{(f) => t("web.setting.about.failed", { why: f().why })}</Match>
            </Switch>
          </span>
          <Switch>
            <Match when={s()._tag === "idle" || s()._tag === "failed"}>
              <Button icon="refresh" data-testid="update-check" onClick={check}>
                {t("web.setting.about.check")}
              </Button>
            </Match>
            <Match when={variant(s(), "_tag", "ready")}>
              {(r) => (
                <ConfirmButton
                  icon="update"
                  tone="primary"
                  label={t("web.setting.about.restart")}
                  question={
                    r().newFarm
                      ? t("web.setting.about.newFarmQuestion")
                      : working() > 0
                        ? t("web.setting.about.workingQuestion", { n: working() })
                        : t("web.setting.about.restartQuestion")
                  }
                  testid="update-install"
                  onConfirm={install}
                />
              )}
            </Match>
            <Match when={variant(s(), "_tag", "manual")}>
              {(m) => (
                <a href={m().page} target="_blank" rel="noreferrer" {...stylex.attrs(viewStyles.updateRowA)}>
                  {t("web.setting.about.download")}
                </a>
              )}
            </Match>
          </Switch>
        </SettingRow>
      )}
    </Show>
  );
}

/** Install CLI: the app's command line linked into ~/.local/bin (apps/desktop src/commandLine.ts); nothing where the
 * host has none to install. */
export function CommandLineRow() {
  const cli = currentHost().commandLine;
  const [state, setState] = createSignal<CommandLineState>();
  // The app run from the repository has none: it answers so, and the row stays away.
  onSettled(() => void cli?.state().then(setState, () => undefined));
  const act = (step: () => Promise<CommandLineState> | undefined) => void step()?.then(setState, (e: unknown) => toast(reasonOf(e), "bad"));
  const hint = (s: CommandLineState) =>
    s.taken
      ? t("web.setting.about.cliTaken", { link: s.link })
      : !s.installed
        ? t("web.setting.about.cliHint", { command: s.command })
        : s.onPath
          ? t("web.setting.about.cliReady", { command: s.command })
          : t("web.setting.about.cliNotOnPath", { link: s.link });
  return (
    <Show when={state()}>
      {(s) => (
        <SettingRow label={t("web.setting.about.cli")} hint={hint(s())}>
          <span data-testid="cli-state" data-installed={String(s().installed)} {...stylex.attrs(viewStyles.cliState)}>
            {s().command}
          </span>
          <Show
            when={s().installed}
            fallback={
              <Button icon="terminal" data-testid="cli-install" disabled={s().taken} onClick={() => act(() => cli?.install())}>
                {t("web.setting.about.cliInstall")}
              </Button>
            }
          >
            <Button data-testid="cli-remove" onClick={() => act(() => cli?.remove())}>
              {t("web.setting.about.cliRemove")}
            </Button>
          </Show>
        </SettingRow>
      )}
    </Show>
  );
}
