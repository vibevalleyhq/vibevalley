import { computed, Text, View } from "nsh";

import { t } from "@vibevalley/i18n";
import type { UpdateFailureKind, UpdateState } from "@vibevalley/protocol/host";

import { Button } from "../../design/Button";
import { Dialog } from "../../design/Dialog";
import { Icon } from "../../design/Icon";
import { OutLink } from "../../design/IconButton";
import { motionClass } from "../../design/motion";
import { mix } from "../../design/tone";
import { variant } from "../../infra/base/dom";
import { clampUpdatePercent, formatUpdateTransfer } from "../../infra/host";

const stripVersionPrefix = (version: string) => version.replace(/^v/u, "");

export function failedUpdateMessage(kind: UpdateFailureKind): string {
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

export interface UpdateDialogProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly state: UpdateState | undefined;
  readonly working: number;
  readonly installing?: boolean | undefined;
  readonly requesting?: boolean | undefined;
  readonly onInstall: () => void;
  readonly onCheck?: (() => void) | undefined;
  readonly testidPrefix?: string | undefined;
}

/** Shared auto-update modal for viewing release notes, live download progress, failure diagnostics, and confirming restart. */
export function UpdateDialog(props: UpdateDialogProps) {
  const prefix = () => props.testidPrefix ?? "update";
  const isRail = () => prefix() === "rail-update";
  const dialogTestid = () => (isRail() ? "rail-update-confirm-dialog" : "update-dialog");
  const cancelTestid = () => (isRail() ? "rail-update-confirm-cancel" : "update-install-cancel");
  const confirmTestid = () => (isRail() ? "rail-update-confirm-sure" : "update-install-sure");

  const readyState = computed(() => {
    const s = props.state;
    return s ? variant(s, "_tag", "ready") : undefined;
  });
  const downloadingState = computed(() => {
    const s = props.state;
    return s ? variant(s, "_tag", "downloading") : undefined;
  });
  const verifyingState = computed(() => {
    const s = props.state;
    return s ? variant(s, "_tag", "verifying") : undefined;
  });
  const installingState = computed(() => {
    const s = props.state;
    return s ? variant(s, "_tag", "installing") : undefined;
  });
  const failedState = computed(() => {
    const s = props.state;
    return s ? variant(s, "_tag", "failed") : undefined;
  });
  const manualState = computed(() => {
    const s = props.state;
    return s ? variant(s, "_tag", "manual") : undefined;
  });

  const dialogTitle = computed(() => {
    const r = readyState();
    if (r) return t("web.base.updateReadyTitle", { next: stripVersionPrefix(r.next) });
    return t("web.setting.about.dialogTitle");
  });

  return (
    <Dialog open={props.open} onClose={props.onClose} title={dialogTitle()} testid={dialogTestid()}>
      <If when={props.state}>
        {(s) => (
          <View class="gap-3.5">
            <If when={readyState()}>
              {(r) => (
                <>
                  <View class="flex-row flex-wrap items-center justify-between gap-2">
                    <View testID={`${prefix()}-version-badge`} class="rounded-sm border border-line bg-side px-2 py-0.5">
                      <Text class="font-mono text-xs text-muted tabular-nums">{`v${stripVersionPrefix(r().version)} → v${stripVersionPrefix(r().next)}`}</Text>
                    </View>
                    <If when={r().page.trim()}>{(page) => <OutLink href={page()} label={t("web.base.updateReleasePage")} />}</If>
                  </View>
                  <If when={props.working > 0 || r().newFarm} else={<Text class="text-sm text-muted">{t("web.base.updateReadyHint")}</Text>}>
                    <View
                      testID={`${prefix()}-warning`}
                      class="flex-row items-start gap-2 rounded-md border bg-warn-soft px-3 py-2"
                      style={{ borderColor: mix("wheat", 0.4) }}
                    >
                      <Icon name="warn" size={14} tone="wheat" />
                      <Text class="min-w-0 flex-1 text-xs leading-relaxed font-medium text-warn-ink">
                        {r().newFarm ? t("web.setting.about.newFarmQuestion") : t("web.setting.about.workingQuestion", { n: props.working })}
                      </Text>
                    </View>
                  </If>
                  <If when={r().notes.length > 0}>
                    <View testID={`${prefix()}-notes`} class="gap-1.5 rounded-md border border-line bg-side p-3">
                      <Text class="text-xs font-semibold text-muted">{t("web.base.updateNotesTitle")}</Text>
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
                  <View class="flex-row items-center justify-end gap-2">
                    <Button tone="quiet" testID={cancelTestid()} onPress={props.onClose}>
                      {t("web.base.updateLaterOnQuit")}
                    </Button>
                    <Button
                      tone="primary"
                      icon="update"
                      testID={confirmTestid()}
                      disabled={props.installing === true}
                      onPress={() => {
                        props.onClose();
                        props.onInstall();
                      }}
                    >
                      {props.installing === true ? t("web.base.updateInstalling") : t("web.setting.about.restart")}
                    </Button>
                  </View>
                </>
              )}
            </If>

            <If when={downloadingState()}>
              {(d) => {
                const transfer = () => formatUpdateTransfer(d());
                const percent = () => clampUpdatePercent(d().percent);
                return (
                  <View class="gap-2.5">
                    <Text class="text-sm font-medium text-ink tabular-nums">{t("web.setting.about.downloading", { next: d().next, percent: percent() })}</Text>
                    <View testID={`${prefix()}-progress`} class="h-1.5 w-full overflow-hidden rounded-full bg-hover">
                      <View class="h-full rounded-full bg-accent" style={{ width: `${percent()}%` }} />
                    </View>
                    <If when={transfer()}>
                      {(detail) => (
                        <Text testID={`${prefix()}-transfer`} class="font-mono text-xs text-muted tabular-nums">
                          {detail()}
                        </Text>
                      )}
                    </If>
                    <View class="flex-row justify-end">
                      <Button tone="quiet" onPress={props.onClose}>
                        {t("web.base.lightbox.close")}
                      </Button>
                    </View>
                  </View>
                );
              }}
            </If>

            <If when={verifyingState()}>
              {(v) => (
                <View class="flex-row items-center gap-2">
                  <View class={motionClass("animate-pulse")}>
                    <Icon name="wait" size={15} tone="water" />
                  </View>
                  <Text class="min-w-0 flex-1 text-sm text-ink">{t("web.setting.about.verifying", { next: v().next })}</Text>
                </View>
              )}
            </If>

            <If when={installingState()}>
              {(inst) => (
                <View class="flex-row items-center gap-2">
                  <View class={motionClass("animate-pulse")}>
                    <Icon name="wait" size={15} tone="accent" />
                  </View>
                  <Text class="min-w-0 flex-1 text-sm text-ink">{t("web.setting.about.installing", { next: inst().next })}</Text>
                </View>
              )}
            </If>

            <If when={failedState()}>
              {(f) => (
                <View class="gap-3">
                  <View class="flex-row items-center gap-2">
                    <Icon name="warn" size={15} tone="berry" />
                    <Text class="min-w-0 flex-1 text-sm font-medium text-berry">{failedUpdateMessage(f().kind ?? "unknown")}</Text>
                  </View>
                  <If when={f().why.trim()}>
                    {(why) => (
                      <View class="rounded-md border border-line bg-side px-3 py-2">
                        <Text testID={`${prefix()}-failed-detail`} class="font-mono text-xs text-muted">
                          {why()}
                        </Text>
                      </View>
                    )}
                  </If>
                  <View class="flex-row flex-wrap items-center justify-end gap-2">
                    <If when={f().page?.trim()}>{(page) => <OutLink href={page()} label={t("web.setting.about.manualDownload")} />}</If>
                    <If when={props.onCheck !== undefined}>
                      <Button icon="retry" testID={`${prefix()}-dialog-retry`} disabled={props.requesting === true} onPress={() => props.onCheck?.()}>
                        {props.requesting === true ? t("web.setting.about.checking") : t("web.setting.about.retry")}
                      </Button>
                    </If>
                    <Button tone="quiet" onPress={props.onClose}>
                      {t("web.base.lightbox.close")}
                    </Button>
                  </View>
                </View>
              )}
            </If>

            <If when={manualState()}>
              {(m) => (
                <View class="gap-3">
                  <Text class="text-sm text-ink">{t(`web.setting.about.manual.${m().why}`, { next: m().next })}</Text>
                  <View class="flex-row items-center justify-end gap-2">
                    <If when={m().page.trim()}>{(page) => <OutLink href={page()} label={t("web.setting.about.download")} />}</If>
                    <Button tone="quiet" onPress={props.onClose}>
                      {t("web.base.lightbox.close")}
                    </Button>
                  </View>
                </View>
              )}
            </If>

            <If when={s()._tag === "idle" || s()._tag === "checking" || s()._tag === "disabled"}>
              <View class="flex-row items-center justify-between gap-2">
                <Text class="text-sm text-muted">
                  {s()._tag === "disabled"
                    ? t("web.setting.about.disabled")
                    : s()._tag === "checking"
                      ? t("web.setting.about.checking")
                      : t("web.setting.about.upToDate")}
                </Text>
                <Button tone="quiet" onPress={props.onClose}>
                  {t("web.base.lightbox.close")}
                </Button>
              </View>
            </If>
          </View>
        )}
      </If>
    </Dialog>
  );
}
