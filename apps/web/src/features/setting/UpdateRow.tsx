import { Match, Show, Switch } from "solid-js";

import { t } from "@vibevalley/i18n";
import { isBusy } from "@vibevalley/protocol/rules";

import { reasonOf } from "@/base/api";
import { useCore } from "@/base/frame";
import { currentHost } from "@/base/host";
import { useUpdates } from "@/base/updates";
import { variant } from "@/base/util";
import { Button } from "@/ui/Button";
import { ConfirmButton } from "@/ui/ConfirmButton";
import { SettingRow } from "@/ui/settings";
import { toast } from "@/ui/toasts";

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
          <span data-testid="update-state" data-state={s()._tag} class="text-sm text-muted">
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
                <a href={m().page} target="_blank" rel="noreferrer" class="text-sm underline">
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
