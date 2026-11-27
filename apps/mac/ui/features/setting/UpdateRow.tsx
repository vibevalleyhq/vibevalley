import { computed, effect, signal, Text, untracked, View } from "nsh";

import { t } from "@vibevalley/i18n";
import type { CommandLineState, UpdateState } from "@vibevalley/protocol/host";

import { Button } from "../../design/Button";
import { SettingRow } from "../../design/domain/settings";
import { Icon } from "../../design/Icon";
import { OutLink } from "../../design/IconButton";
import { toast } from "../../design/toasts";
import { reasonOf } from "../../infra/api";
import { useNow, variant } from "../../infra/base/dom";
import { ago } from "../../infra/base/format";
import { useSessionsSlice } from "../../infra/frame";
import { clampUpdatePercent, currentHost } from "../../infra/host";
import { type Accessor, createSignal, onSettled } from "../../infra/solid";
import { failedUpdateMessage, UpdateDialog } from "./UpdateDialog";

function updateWords(state: UpdateState): string {
  switch (state._tag) {
    case "disabled":
      return t("web.setting.about.disabled");
    case "idle":
      return t("web.setting.about.upToDate");
    case "checking":
      return t("web.setting.about.checking");
    case "downloading":
      return t("web.setting.about.downloading", { next: state.next, percent: clampUpdatePercent(state.percent) });
    case "verifying":
      return t("web.setting.about.verifying", { next: state.next });
    case "ready":
      return state.newFarm ? t("web.setting.about.readyNewFarm", { next: state.next }) : t("web.setting.about.ready", { next: state.next });
    case "installing":
      return t("web.setting.about.installing", { next: state.next });
    case "manual":
      return t(`web.setting.about.manual.${state.why}`, { next: state.next });
    case "failed":
      return failedUpdateMessage(state.kind ?? "unknown");
  }
}

export function UpdateRow(props: { state: Accessor<UpdateState | undefined>; last?: boolean }) {
  const update = currentHost().update;
  const sessions = useSessionsSlice();
  const now = useNow(30_000);
  const [requesting, setRequesting] = createSignal(false);
  const dialogOpen = signal(false);
  const installing = signal(false);
  const working = computed(() => (sessions()?.sessions ?? []).filter((s) => s.phase._tag === "working").length);

  effect(() => {
    const tag = props.state()?._tag;
    if (tag !== "ready" && tag !== "installing") installing.set(false);
  });

  let pendingToast = false;
  let sawChecking = false;

  effect(() => {
    const tag = props.state()?._tag;
    if (!pendingToast) return;
    if (tag === "checking") {
      sawChecking = true;
      return;
    }
    if (sawChecking) {
      pendingToast = false;
      sawChecking = false;
      if (tag === "idle") toast(t("web.setting.about.upToDate"));
    }
  });

  const check = () => {
    if (!update || requesting()) return;
    setRequesting(() => true);
    pendingToast = true;
    sawChecking = props.state()?._tag === "checking";
    void update
      .check()
      .then(
        () => {
          const tag = props.state()?._tag;
          if (tag === "checking") {
            sawChecking = true;
            return;
          }
          if (pendingToast) {
            pendingToast = false;
            sawChecking = false;
            if (tag === "idle") toast(t("web.setting.about.upToDate"));
          }
        },
        (e: unknown) => {
          pendingToast = false;
          sawChecking = false;
          toast(reasonOf(e), "bad");
        },
      )
      .finally(() => setRequesting(() => false));
  };

  const install = () => {
    if (!update || untracked(installing)) return;
    installing.set(true);
    void update.install().catch((e: unknown) => {
      installing.set(false);
      toast(reasonOf(e), "bad");
    });
  };

  const hasDetail = computed(() => {
    const s = props.state();
    if (!s) return false;
    switch (s._tag) {
      case "downloading":
        return true;
      case "failed":
        return s.why.trim().length > 0;
      case "disabled":
      case "idle":
      case "checking":
      case "verifying":
      case "ready":
      case "installing":
      case "manual":
        return false;
    }
  });

  return (
    <If when={props.state()}>
      {(s) => {
        const idleState = computed(() => variant(s(), "_tag", "idle"));
        const readyState = computed(() => variant(s(), "_tag", "ready"));
        const manualState = computed(() => variant(s(), "_tag", "manual"));
        const failedState = computed(() => variant(s(), "_tag", "failed"));
        const busyIcon = computed(() => {
          const tag = s()._tag;
          return tag === "checking" || tag === "verifying" || tag === "installing" || (requesting() && tag === "idle");
        });
        const statusToneClass = () => {
          const tag = s()._tag;
          if (tag === "disabled") return "text-faint";
          if (tag === "failed") return "text-berry";
          if (tag === "ready") return "font-medium text-ink";
          return "text-muted";
        };
        return (
          <View>
            <SettingRow label={t("web.setting.about.update")} hint={t("web.setting.about.updateHint")} last={props.last}>
              <View class="flex-row items-center gap-1.5">
                <If when={busyIcon()}>
                  <Icon name="wait" size={14} tone="water" />
                </If>
                <If when={s()._tag === "failed"}>
                  <Icon name="warn" size={14} tone="berry" />
                </If>
                <Text testID="update-state" class={`text-sm tabular-nums ${statusToneClass()}`}>
                  {requesting() && s()._tag === "idle" ? t("web.setting.about.checking") : updateWords(s())}
                </Text>
              </View>
              <If when={idleState()?.checkedAt}>
                {(checkedAt) => (
                  <Text testID="update-last-checked" class="text-xs text-faint">
                    {t("web.setting.about.lastChecked", { time: ago(checkedAt(), now()) })}
                  </Text>
                )}
              </If>
              <If when={s()._tag === "idle"}>
                <Button icon="refresh" testID="update-check" disabled={requesting()} onPress={check}>
                  {requesting() ? t("web.setting.about.checking") : t("web.setting.about.check")}
                </Button>
              </If>
              <If when={hasDetail()}>
                <Button size="compact" tone="quiet" testID="update-details" onPress={() => dialogOpen.set(true)}>
                  {t("web.setting.about.details")}
                </Button>
              </If>
              <If when={failedState()}>
                {(f) => (
                  <>
                    <Button icon="retry" testID="update-retry" disabled={requesting()} onPress={check}>
                      {requesting() ? t("web.setting.about.checking") : t("web.setting.about.retry")}
                    </Button>
                    <If when={f().page?.trim()}>{(page) => <OutLink href={page()} label={t("web.setting.about.manualDownload")} />}</If>
                  </>
                )}
              </If>
              <If when={readyState()}>
                {(r) => (
                  <>
                    <If when={r().page.trim()}>{(page) => <OutLink href={page()} label={t("web.setting.about.releaseNotesLink")} />}</If>
                    <Button icon="update" tone="primary" testID="update-install" disabled={installing()} onPress={() => dialogOpen.set(true)}>
                      {installing() ? t("web.base.updateInstalling") : t("web.setting.about.restart")}
                    </Button>
                  </>
                )}
              </If>
              <If when={s()._tag === "installing"}>
                <Button icon="wait" testID="update-installing-btn" disabled>
                  {t("web.base.updateInstalling")}
                </Button>
              </If>
              <If when={manualState()?.page.trim()}>{(page) => <OutLink href={page()} label={t("web.setting.about.download")} />}</If>
            </SettingRow>
            <UpdateDialog
              open={dialogOpen()}
              onClose={() => dialogOpen.set(false)}
              state={props.state()}
              working={working()}
              installing={installing()}
              requesting={requesting()}
              onInstall={install}
              onCheck={check}
              testidPrefix="update"
            />
          </View>
        );
      }}
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
