import { computed, effect, Text, View } from "nsh";

import { t } from "@vibevalley/i18n";
import type { CommandLineState, UpdateFailureKind, UpdateState } from "@vibevalley/protocol/host";

import { Button } from "../../design/Button";
import { ConfirmButton } from "../../design/ConfirmButton";
import { SettingRow } from "../../design/domain/settings";
import { Icon } from "../../design/Icon";
import { OutLink } from "../../design/IconButton";
import { Bubble } from "../../design/Tip";
import { toast } from "../../design/toasts";
import { reasonOf } from "../../infra/api";
import { useNow, variant } from "../../infra/base/dom";
import { ago } from "../../infra/base/format";
import { useSessionsSlice } from "../../infra/frame";
import { clampUpdatePercent, currentHost, formatUpdateTransfer } from "../../infra/host";
import { type Accessor, createSignal, onSettled } from "../../infra/solid";

function failedMessage(kind: UpdateFailureKind): string {
  switch (kind) {
    case "network":
      return t("web.setting.about.failedKind.network");
    case "rateLimit":
      return t("web.setting.about.failedKind.rateLimit");
    case "integrity":
      return t("web.setting.about.failedKind.integrity");
    case "signature":
      return t("web.setting.about.failedKind.signature");
    case "permission":
      return t("web.setting.about.failedKind.permission");
    case "install":
      return t("web.setting.about.failedKind.install");
    case "unknown":
      return t("web.setting.about.failedKind.unknown");
  }
}

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
      return failedMessage(state.kind ?? "unknown");
  }
}

export function UpdateRow(props: { state: Accessor<UpdateState | undefined>; last?: boolean }) {
  const update = currentHost().update;
  const sessions = useSessionsSlice();
  const now = useNow(30_000);
  const [requesting, setRequesting] = createSignal(false);
  const working = computed(() => (sessions()?.sessions ?? []).filter((s) => s.phase._tag === "working").length);

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

  const install = () => void update?.install().catch((e: unknown) => toast(reasonOf(e), "bad"));

  const hasDetail = computed(() => {
    const s = props.state();
    if (!s) return false;
    switch (s._tag) {
      case "downloading":
        return true;
      case "ready":
        return s.notes.length > 0;
      case "failed":
        return s.why.trim().length > 0;
      case "disabled":
      case "idle":
      case "checking":
      case "verifying":
      case "installing":
      case "manual":
        return false;
    }
  });

  return (
    <If when={props.state()}>
      {(s) => {
        const idleState = computed(() => variant(s(), "_tag", "idle"));
        const downloadingState = computed(() => variant(s(), "_tag", "downloading"));
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
            <SettingRow label={t("web.setting.about.update")} hint={t("web.setting.about.updateHint")} last={hasDetail() ? true : props.last}>
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
            <If when={hasDetail()}>
              <View class={`gap-2 px-4 pb-3.5 ${props.last === true ? "" : "border-b border-line"}`}>
                <If when={downloadingState()}>
                  {(d) => {
                    const transfer = () => formatUpdateTransfer(d());
                    return (
                      <View class="gap-1.5">
                        <View testID="update-progress" class="h-1.5 w-full overflow-hidden rounded-full bg-hover">
                          <View class="h-full rounded-full bg-accent" style={{ width: `${clampUpdatePercent(d().percent)}%` }} />
                        </View>
                        <If when={transfer()}>
                          {(detail) => (
                            <Text testID="update-transfer" class="font-mono text-xs text-faint tabular-nums">
                              {detail()}
                            </Text>
                          )}
                        </If>
                      </View>
                    );
                  }}
                </If>
                <If when={readyState()}>
                  {(r) => (
                    <If when={r().notes.length > 0}>
                      <View testID="update-notes" class="gap-1.5 rounded-md border border-line bg-page px-3 py-2.5">
                        <Text class="text-xs font-medium text-muted">{t("web.base.updateNotesTitle")}</Text>
                        <Each of={r().notes} key={(_, i) => String(i)}>
                          {(note) => (
                            <View class="flex-row items-start gap-2">
                              <View class="mt-1.5 size-1.5 shrink-0 rounded-full bg-accent" />
                              <Text class="min-w-0 flex-1 text-xs leading-relaxed text-ink">{note()}</Text>
                            </View>
                          )}
                        </Each>
                      </View>
                    </If>
                  )}
                </If>
                <If when={failedState()}>
                  {(f) => (
                    <If when={f().why.trim()}>
                      {(why) => (
                        <View tooltip={<Bubble text={why()} />} class="min-w-0">
                          <Text testID="update-failed-detail" class="truncate font-mono text-2xs text-faint">
                            {why()}
                          </Text>
                        </View>
                      )}
                    </If>
                  )}
                </If>
              </View>
            </If>
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
