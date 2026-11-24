import { computed, Text } from "nsh";

import { t } from "@vibevalley/i18n";
import type { CommandLineState, UpdateState } from "@vibevalley/protocol/host";

import { Button } from "../../design/Button";
import { ConfirmButton } from "../../design/ConfirmButton";
import { SettingRow } from "../../design/domain/settings";
import { OutLink } from "../../design/IconButton";
import { toast } from "../../design/toasts";
import { reasonOf } from "../../infra/api";
import { variant } from "../../infra/base/dom";
import { useSessionsSlice } from "../../infra/frame";
import { currentHost } from "../../infra/host";
import { type Accessor, createSignal, onSettled } from "../../infra/solid";

function updateWords(state: UpdateState): string {
  switch (state._tag) {
    case "idle":
      return t("web.setting.about.upToDate");
    case "checking":
      return t("web.setting.about.checking");
    case "downloading":
      return t("web.setting.about.downloading", { next: state.next, percent: state.percent });
    case "ready":
      return state.newFarm ? t("web.setting.about.readyNewFarm", { next: state.next }) : t("web.setting.about.ready", { next: state.next });
    case "manual":
      return t(`web.setting.about.manual.${state.why}`, { next: state.next });
    case "failed":
      return t("web.setting.about.failed", { why: state.why });
  }
}

export function UpdateRow(props: { state: Accessor<UpdateState | undefined>; last?: boolean }) {
  const update = currentHost().update;
  const sessions = useSessionsSlice();
  const working = computed(() => (sessions()?.sessions ?? []).filter((s) => s.phase._tag === "working").length);
  const check = () => void update?.check().catch((e: unknown) => toast(reasonOf(e), "bad"));
  const install = () => void update?.install().catch((e: unknown) => toast(reasonOf(e), "bad"));
  return (
    <If when={props.state()}>
      {(s) => (
        <SettingRow label={t("web.setting.about.update")} hint={t("web.setting.about.updateHint")} last={props.last}>
          <Text testID="update-state" class="text-sm tabular-nums text-muted">
            {updateWords(s())}
          </Text>
          <If when={s()._tag === "idle" || s()._tag === "failed"}>
            <Button icon="refresh" testID="update-check" onPress={check}>
              {t("web.setting.about.check")}
            </Button>
          </If>
          <If when={variant(s(), "_tag", "ready")}>
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
          </If>
          <If when={variant(s(), "_tag", "manual")?.page}>{(page) => <OutLink href={page()} label={t("web.setting.about.download")} />}</If>
        </SettingRow>
      )}
    </If>
  );
}

export function useCommandLine() {
  const cli = currentHost().commandLine;
  const [state, setState] = createSignal<CommandLineState | undefined>(undefined);
  onSettled(() => {
    void cli?.state().then(
      (s) => setState(() => s),
      () => undefined,
    );
  });
  const act = (step: () => Promise<CommandLineState> | undefined) =>
    void step()?.then(
      (s) => setState(() => s),
      (e: unknown) => toast(reasonOf(e), "bad"),
    );
  return { state, install: () => act(() => cli?.install()), remove: () => act(() => cli?.remove()) };
}

export function CommandLineRow(props: { state: Accessor<CommandLineState | undefined>; onInstall: () => void; onRemove: () => void; last?: boolean }) {
  const hint = (s: CommandLineState) =>
    s.taken
      ? t("web.setting.about.cliTaken", { link: s.link })
      : !s.installed
        ? t("web.setting.about.cliHint", { command: s.command })
        : s.onPath
          ? t("web.setting.about.cliReady", { command: s.command })
          : t("web.setting.about.cliNotOnPath", { link: s.link });
  return (
    <If when={props.state()}>
      {(s) => (
        <SettingRow label={t("web.setting.about.cli")} hint={hint(s())} last={props.last}>
          <Text testID="cli-state" class="font-mono text-xs text-muted">
            {s().command}
          </Text>
          <If
            when={s().installed}
            else={
              <Button icon="terminal" testID="cli-install" disabled={s().taken} onPress={props.onInstall}>
                {t("web.setting.about.cliInstall")}
              </Button>
            }
          >
            <Button testID="cli-remove" onPress={props.onRemove}>
              {t("web.setting.about.cliRemove")}
            </Button>
          </If>
        </SettingRow>
      )}
    </If>
  );
}
