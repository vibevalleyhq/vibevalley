import { computed, effect, signal, Text, untracked, View } from "nsh";

import { t } from "@vibevalley/i18n";
import type { Artifact } from "@vibevalley/protocol";
import type { ArtifactAppletInfo } from "@vibevalley/protocol/host";

import { createAct } from "../../design/act";
import { Button } from "../../design/Button";
import { Dialog } from "../../design/Dialog";
import { Field, TextInput } from "../../design/Field";
import { Icon } from "../../design/Icon";
import { Banner, Toggle } from "../../design/layout";
import { motionClass } from "../../design/motion";
import { Tag } from "../../design/Tag";
import { Bubble } from "../../design/Tip";
import { toast } from "../../design/toasts";
import { currentHost } from "../../infra/host";
import { defineQuery, ready, useQuery, useQueryClient } from "../../infra/query";
import { artifactIcon, kindLabel } from "./ArtifactCard";

const appletsQuery = defineQuery({
  key: () => ["host", "applets"],
  fetch: () => {
    const applet = currentHost().applet;
    return applet ? applet.list() : Promise.resolve([]);
  },
});

export function useInstalledApplet(artifactId: () => string) {
  const list = useQuery(() => appletsQuery(), { enabled: () => currentHost().applet !== undefined });
  return computed((): ArtifactAppletInfo | undefined => {
    const items = ready(list, []);
    return items.find((item) => item.artifactId === artifactId() && item.installed);
  });
}

export interface InstallAppletModalProps {
  readonly open: boolean;
  readonly artifact: Artifact;
  readonly onClose: () => void;
}

/** Modal to install, update, launch, or uninstall a local macOS artifact applet. */
export function InstallAppletModal(props: InstallAppletModalProps) {
  return (
    <Dialog open={props.open} onClose={props.onClose} title={t("web.artifact.applet.modalTitle")} testid="install-applet-modal">
      <If when={props.open}>
        <InstallAppletModalBody artifact={props.artifact} />
      </If>
    </Dialog>
  );
}

function InstallAppletModalBody(props: { artifact: Artifact }) {
  const queries = useQueryClient();
  const installed = useInstalledApplet(() => props.artifact.id);
  const appName = signal(untracked(() => installed()?.appName ?? props.artifact.title));
  const alwaysOnTop = signal(untracked(() => installed()?.alwaysOnTop ?? false));
  const editedName = signal(false);
  const editedTop = signal(false);
  const error = signal<string | undefined>(undefined);
  const act = createAct((reason) => error.set(reason));

  effect(() => {
    const info = installed();
    if (!info) return;
    if (!untracked(editedName)) appName.set(info.appName);
    if (!untracked(editedTop)) alwaysOnTop.set(info.alwaysOnTop);
  });

  const handleInstall = () => {
    const applet = currentHost().applet;
    if (!applet) {
      error.set(t("web.artifact.applet.unavailable"));
      return;
    }
    const name = appName().trim();
    if (!name) {
      error.set(t("web.artifact.applet.nameRequired"));
      return;
    }
    error.set(undefined);
    void act.run(async () => {
      const info = await applet.install({
        artifactId: props.artifact.id,
        artifactType: props.artifact.artifactType,
        appName: name,
        alwaysOnTop: alwaysOnTop(),
      });
      editedName.set(false);
      editedTop.set(false);
      appName.set(info.appName);
      alwaysOnTop.set(info.alwaysOnTop);
      await queries.invalidate({ prefix: ["host", "applets"] });
      toast(t("web.artifact.applet.installedToast", { name: info.appName }));
    });
  };

  const handleOpen = () => {
    const applet = currentHost().applet;
    if (!applet) {
      error.set(t("web.artifact.applet.unavailable"));
      return;
    }
    error.set(undefined);
    const label = installed()?.appName ?? (appName().trim() || props.artifact.title);
    void act.run(async () => {
      await applet.open(props.artifact.id);
      toast(t("web.artifact.applet.openedToast", { name: label }));
    });
  };

  const handleUninstall = () => {
    const applet = currentHost().applet;
    if (!applet) {
      error.set(t("web.artifact.applet.unavailable"));
      return;
    }
    error.set(undefined);
    const label = installed()?.appName ?? (appName().trim() || props.artifact.title);
    void act.run(async () => {
      await applet.uninstall(props.artifact.id);
      editedName.set(false);
      editedTop.set(false);
      appName.set(props.artifact.title);
      alwaysOnTop.set(false);
      await queries.invalidate({ prefix: ["host", "applets"] });
      toast(t("web.artifact.applet.uninstalledToast", { name: label }));
    });
  };

  return (
    <View testID="install-applet-body" class="gap-4">
      <View class="flex-row items-center gap-2.5 rounded-md border border-line bg-side px-3 py-2.5">
        <View class="size-7 shrink-0 items-center justify-center rounded-md bg-page">
          <Icon name={artifactIcon(props.artifact)} size={16} tone="muted" />
        </View>
        <View class="min-w-0 flex-1 gap-0.5">
          <Text class="truncate text-sm font-semibold text-ink">{props.artifact.title}</Text>
          <Text class="truncate text-xs text-muted">{kindLabel(props.artifact)}</Text>
        </View>
        <Tag
          tone={installed() ? "ok" : "neutral"}
          icon={installed() ? "check" : undefined}
          label={installed() ? t("web.artifact.applet.statusInstalled") : t("web.artifact.applet.statusNotInstalled")}
        />
      </View>

      <Text class="text-xs leading-relaxed text-muted">{t("web.artifact.applet.subtitle")}</Text>

      <If when={error()}>
        <Banner testID="install-applet-error">{error()}</Banner>
      </If>

      <Field label={t("web.artifact.applet.appNameLabel")}>
        <TextInput
          testID="install-applet-name"
          accessibilityLabel={t("web.artifact.applet.appNameLabel")}
          value={appName()}
          placeholder={t("web.artifact.applet.appNamePlaceholder")}
          disabled={act.busy()}
          onInput={(v) => {
            editedName.set(true);
            appName.set(v);
          }}
        />
      </Field>

      <Toggle
        testid="install-applet-always-on-top"
        label={t("web.artifact.applet.alwaysOnTopLabel")}
        hint={t("web.artifact.applet.alwaysOnTopHint")}
        checked={alwaysOnTop()}
        disabled={act.busy()}
        onChange={(checked) => {
          editedTop.set(true);
          alwaysOnTop.set(checked);
        }}
      />

      <If when={installed()}>
        {(info) => (
          <View testID="install-applet-meta" class="gap-1.5 rounded-md border border-line bg-side px-3 py-2.5">
            <View class="flex-row items-center justify-between gap-2">
              <Text class="text-xs text-muted">{t("web.artifact.applet.bundleIdLabel")}</Text>
              <Text testID="install-applet-bundle-id" class="truncate font-mono text-xs text-ink select-text">
                {info().bundleId}
              </Text>
            </View>
            <View class="gap-0.5">
              <Text class="text-xs text-muted">{t("web.artifact.applet.bundlePathLabel")}</Text>
              <Text testID="install-applet-bundle-path" class="font-mono text-xs text-muted select-text">
                {info().bundlePath}
              </Text>
            </View>
          </View>
        )}
      </If>

      <View class="flex-row flex-wrap items-center justify-between gap-2 pt-1">
        <View class="flex-row items-center gap-2">
          <If when={installed()}>
            <Button tone="danger" icon="delete" testID="install-applet-uninstall" disabled={act.busy()} onPress={handleUninstall}>
              {t("web.artifact.applet.uninstall")}
            </Button>
            <Button icon="open" testID="install-applet-open" disabled={act.busy()} onPress={handleOpen}>
              {t("web.artifact.applet.open")}
            </Button>
          </If>
        </View>
        <Button tone="primary" icon="devices" testID="install-applet-submit" disabled={act.busy()} onPress={handleInstall}>
          {act.busy() ? t("web.artifact.applet.installing") : installed() ? t("web.artifact.applet.reinstall") : t("web.artifact.applet.install")}
        </Button>
      </View>
    </View>
  );
}

/** Toolbar trigger for installing/managing a local macOS applet; hidden when the host has no `applet` capability. */
export function InstallAppletButton(props: { artifact: Artifact; testID?: string | undefined; onOpenChange?: ((open: boolean) => void) | undefined }) {
  const modalOpen = signal(false);
  const installed = useInstalledApplet(() => props.artifact.id);
  const setOpen = (next: boolean) => {
    modalOpen.set(next);
    props.onOpenChange?.(next);
  };
  const label = () => (installed() ? t("web.artifact.applet.buttonInstalled") : t("web.artifact.applet.button"));

  return (
    <If when={currentHost().applet !== undefined}>
      <>
        <View
          role="button"
          testID={props.testID ?? "artifact-install-applet"}
          accessibilityLabel={label()}
          accessibilityState={{ selected: installed() !== undefined }}
          tooltip={<Bubble text={label()} />}
          onPress={() => setOpen(true)}
          class={`h-6 shrink-0 flex-row items-center gap-1 rounded-md border px-2 ${motionClass("transition-transform duration-120 ease-out")} active:translate-y-px focus-visible:outline-2 focus-visible:outline-focus ${
            installed() ? "border-line bg-ok-soft hover:bg-hover" : "border-line bg-page hover:border-faint hover:bg-hover"
          }`}
        >
          <Icon name="devices" size={12} tone={installed() ? "ok-ink" : "muted"} />
          <If when={installed()}>
            <Text testID="artifact-install-applet-badge" class="text-2xs font-medium text-ok-ink">
              {t("web.artifact.applet.badgeInstalled")}
            </Text>
          </If>
        </View>
        <InstallAppletModal open={modalOpen()} artifact={props.artifact} onClose={() => setOpen(false)} />
      </>
    </If>
  );
}
