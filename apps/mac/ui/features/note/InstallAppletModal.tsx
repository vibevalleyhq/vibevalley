import { computed, effect, signal, Text, untracked, View } from "nsh";

import { t } from "@vibevalley/i18n";
import type { Note } from "@vibevalley/protocol";
import type { NoteAppletInfo } from "@vibevalley/protocol/host";

import { createAct } from "../../design/act";
import { Button } from "../../design/Button";
import { Dialog } from "../../design/Dialog";
import { Field, TextInput } from "../../design/Field";
import { Icon } from "../../design/Icon";
import { Banner, Toggle } from "../../design/layout";
import { Tag } from "../../design/Tag";
import { toast } from "../../design/toasts";
import { currentHost } from "../../infra/host";
import { defineQuery, ready, useQuery, useQueryClient } from "../../infra/query";
import { kindLabel, noteIcon } from "./NoteCard";

const appletsQuery = defineQuery({
  key: () => ["host", "applets"],
  fetch: () => {
    const applet = currentHost().applet;
    return applet ? applet.list() : Promise.resolve([]);
  },
});

export function useInstalledApplets() {
  const list = useQuery(() => appletsQuery(), { enabled: () => currentHost().applet !== undefined });
  return computed((): readonly NoteAppletInfo[] => ready(list, []));
}

export function useInstalledNoteApplet(noteId: () => string) {
  const list = useInstalledApplets();
  return computed((): NoteAppletInfo | undefined => list().find((item) => item.noteId === noteId() && item.installed));
}

interface InstallAppletModalProps {
  readonly open: boolean;
  readonly note: Note;
  readonly onClose: () => void;
}

/** Modal to install, update, launch, or uninstall a local macOS note applet. */
export function InstallAppletModal(props: InstallAppletModalProps) {
  return (
    <Dialog open={props.open} onClose={props.onClose} title={t("web.note.applet.modalTitle")} testid="install-applet-modal">
      <If when={props.open}>
        <InstallAppletModalBody note={props.note} />
      </If>
    </Dialog>
  );
}

function InstallAppletModalBody(props: { note: Note }) {
  const queries = useQueryClient();
  const installed = useInstalledNoteApplet(() => props.note.id);
  const appName = signal(untracked(() => installed()?.appName ?? props.note.title));
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
      error.set(t("web.note.applet.unavailable"));
      return;
    }
    const name = appName().trim();
    if (!name) {
      error.set(t("web.note.applet.nameRequired"));
      return;
    }
    error.set(undefined);
    void act.run(async () => {
      const info = await applet.install({
        noteId: props.note.id,
        noteType: props.note.noteType,
        appName: name,
        alwaysOnTop: alwaysOnTop(),
      });
      editedName.set(false);
      editedTop.set(false);
      appName.set(info.appName);
      alwaysOnTop.set(info.alwaysOnTop);
      await queries.invalidate({ prefix: ["host", "applets"] });
      toast(t("web.note.applet.installedToast", { name: info.appName }));
    });
  };

  const handleOpen = () => {
    const applet = currentHost().applet;
    if (!applet) {
      error.set(t("web.note.applet.unavailable"));
      return;
    }
    error.set(undefined);
    const label = installed()?.appName ?? (appName().trim() || props.note.title);
    void act.run(async () => {
      await applet.open(props.note.id);
      toast(t("web.note.applet.openedToast", { name: label }));
    });
  };

  const handleUninstall = () => {
    const applet = currentHost().applet;
    if (!applet) {
      error.set(t("web.note.applet.unavailable"));
      return;
    }
    error.set(undefined);
    const label = installed()?.appName ?? (appName().trim() || props.note.title);
    void act.run(async () => {
      await applet.uninstall(props.note.id);
      editedName.set(false);
      editedTop.set(false);
      appName.set(props.note.title);
      alwaysOnTop.set(false);
      await queries.invalidate({ prefix: ["host", "applets"] });
      toast(t("web.note.applet.uninstalledToast", { name: label }));
    });
  };

  return (
    <View testID="install-applet-body" class="gap-4">
      <View class="flex-row items-center gap-2.5 rounded-md border border-line bg-side px-3 py-2.5">
        <View class="size-7 shrink-0 items-center justify-center rounded-md bg-page">
          <Icon name={noteIcon(props.note)} size={16} tone="muted" />
        </View>
        <View class="min-w-0 flex-1 gap-0.5">
          <Text class="truncate text-sm font-semibold text-ink">{props.note.title}</Text>
          <Text class="truncate text-xs text-muted">{kindLabel(props.note)}</Text>
        </View>
        <Tag
          tone={installed() ? "ok" : "neutral"}
          icon={installed() ? "check" : undefined}
          label={installed() ? t("web.note.applet.statusInstalled") : t("web.note.applet.statusNotInstalled")}
        />
      </View>

      <Text class="text-xs leading-relaxed text-muted">{t("web.note.applet.subtitle")}</Text>

      <If when={error()}>
        <Banner testID="install-applet-error">{error()}</Banner>
      </If>

      <Field label={t("web.note.applet.appNameLabel")}>
        <TextInput
          testID="install-applet-name"
          accessibilityLabel={t("web.note.applet.appNameLabel")}
          value={appName()}
          placeholder={t("web.note.applet.appNamePlaceholder")}
          disabled={act.busy()}
          onInput={(v) => {
            editedName.set(true);
            appName.set(v);
          }}
        />
      </Field>

      <Toggle
        testid="install-applet-always-on-top"
        label={t("web.note.applet.alwaysOnTopLabel")}
        hint={t("web.note.applet.alwaysOnTopHint")}
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
              <Text class="text-xs text-muted">{t("web.note.applet.bundleIdLabel")}</Text>
              <Text testID="install-applet-bundle-id" class="truncate font-mono text-xs text-ink select-text">
                {info().bundleId}
              </Text>
            </View>
            <View class="gap-0.5">
              <Text class="text-xs text-muted">{t("web.note.applet.bundlePathLabel")}</Text>
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
              {t("web.note.applet.uninstall")}
            </Button>
            <Button icon="open" testID="install-applet-open" disabled={act.busy()} onPress={handleOpen}>
              {t("web.note.applet.open")}
            </Button>
          </If>
        </View>
        <Button tone="primary" icon="devices" testID="install-applet-submit" disabled={act.busy()} onPress={handleInstall}>
          {act.busy() ? t("web.note.applet.installing") : installed() ? t("web.note.applet.reinstall") : t("web.note.applet.install")}
        </Button>
      </View>
    </View>
  );
}
