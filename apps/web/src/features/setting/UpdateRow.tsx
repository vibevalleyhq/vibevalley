import { createSignal, Match, onSettled, Show, Switch } from "solid-js";

import { t } from "@vibevalley/i18n";
import { type UpdateChannel, UpdateChannelValues } from "@vibevalley/protocol/host";
import { isBusy } from "@vibevalley/protocol/rules";

import { variant } from "@/base/dom";
import { reasonOf } from "@/infra/api";
import { useCore } from "@/infra/frame";
import { currentHost } from "@/infra/host";
import { useUpdates } from "@/infra/settings";
import { Button } from "@/ui/Button";
import { ConfirmButton } from "@/ui/ConfirmButton";
import { Segmented } from "@/ui/Segmented";
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

/** Which releases this machine updates to: kept by the desktop (update.ts keptChannel), asked again at once on a change. */
export function ChannelRow() {
  const update = currentHost().update;
  const [channel, setChannel] = createSignal<UpdateChannel>();
  onSettled(() => void update?.channel().then(setChannel, (e: unknown) => toast(reasonOf(e), "bad")));
  const choose = (next: UpdateChannel) => {
    const was = channel();
    setChannel(next);
    void update?.setChannel(next).catch((e: unknown) => {
      setChannel(was);
      toast(reasonOf(e), "bad");
    });
  };
  return (
    <Show when={channel()}>
      {(c) => (
        <SettingRow label={t("web.setting.about.channel")} hint={t(`web.setting.about.channels.${c()}Hint`)}>
          <Segmented
            label={t("web.setting.about.channel")}
            testid="update-channel"
            value={c()}
            options={UpdateChannelValues.map((v) => ({ value: v, label: t(`web.setting.about.channels.${v}`) }))}
            onChange={choose}
          />
        </SettingRow>
      )}
    </Show>
  );
}
