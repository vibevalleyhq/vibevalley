import { signal, Text, View } from "nsh";

import { t } from "@vibevalley/i18n";

import { Icon } from "../../design/Icon";
import { IconButton } from "../../design/IconButton";
import { Banner, Empty } from "../../design/layout";
import { reasonOf } from "../../infra/api";
import { currentHost } from "../../infra/host";
import { ready } from "../../infra/query";
import { useRouter } from "../../infra/router";
import { artifactIcon, kindLabel, useArtifact } from "./ArtifactCard";
import { ArtifactDirectoryView, type ArtifactMenuItem } from "./ArtifactDirectoryView";
import { InstallAppletModal, useInstalledApplet } from "./InstallAppletModal";

export function ArtifactCanvas(props: { id: string; version?: number | undefined; onClose?: () => void }) {
  const router = useRouter();
  const artifact = useArtifact(() => props.id);
  const shown = () => ready(artifact, undefined);
  const installedApplet = useInstalledApplet(() => props.id);
  const appletModalOpen = signal(false);
  const pageVersion = () => {
    if (props.version !== undefined) return props.version;
    const v = shown()?.version;
    return v !== undefined && v > 0 ? v : undefined;
  };
  const pageHref = () => `/artifacts/${encodeURIComponent(props.id)}${(pageVersion() ?? 0) > 0 ? `?v=${pageVersion()}` : ""}`;
  return (
    <View accessibilityLabel={t("web.artifact.canvas.label")} testID="artifact-canvas" class="min-h-0 min-w-0 flex-1 border-l border-line bg-page">
      <If when={!shown()}>
        <View class="h-11 shrink-0 flex-row items-center gap-2 border-b border-line bg-page px-3">
          <View class="min-w-0 flex-1" />
          <View class="shrink-0 flex-row items-center gap-1">
            <IconButton icon="open" label={t("web.artifact.canvas.openPage")} testid="artifact-canvas-page" onClick={() => router.navigate(pageHref())} />
            <If when={props.onClose}>
              <IconButton icon="close" label={t("web.artifact.canvas.close")} testid="artifact-canvas-close" onClick={() => props.onClose?.()} />
            </If>
          </View>
        </View>
      </If>
      <If when={artifact.error()}>
        <Banner class="m-3">{reasonOf(artifact.error())}</Banner>
      </If>
      <If when={shown()}>
        {(a) => (
          <>
            <ArtifactDirectoryView
              artifact={a()}
              version={props.version}
              covered={appletModalOpen()}
              headerTestID="artifact-canvas-header"
              menuTestID="artifact-canvas-more"
              headerLeft={
                <>
                  <View class="size-6 shrink-0 items-center justify-center rounded-md bg-side">
                    <Icon name={artifactIcon(a())} size={14} tone="muted" />
                  </View>
                  <View class="min-w-0 flex-1 flex-row items-center gap-2 overflow-hidden">
                    <Text class="min-w-0 shrink truncate text-sm font-semibold text-ink">{a().title}</Text>
                    <Text class="shrink-0 truncate text-xs text-muted tabular-nums">
                      {[
                        kindLabel(a()),
                        ...(a().isDefault ? [t("web.artifact.types.defaultBadge")] : []),
                        ...((props.version ?? a().version) > 0 ? [t("web.artifact.card.version", { version: props.version ?? a().version })] : []),
                      ].join(" · ")}
                    </Text>
                  </View>
                </>
              }
              headerRight={
                <>
                  <IconButton icon="open" label={t("web.artifact.canvas.openPage")} testid="artifact-canvas-page" onClick={() => router.navigate(pageHref())} />
                  <If when={props.onClose}>
                    <IconButton icon="close" label={t("web.artifact.canvas.close")} testid="artifact-canvas-close" onClick={() => props.onClose?.()} />
                  </If>
                </>
              }
              menuItems={() => {
                const applet = currentHost().applet;
                const items: ArtifactMenuItem[] = [];
                if (applet !== undefined) {
                  const info = installedApplet();
                  if (info !== undefined) {
                    items.push(
                      {
                        key: "canvas-open-applet",
                        testID: "artifact-canvas-open-applet",
                        label: t("web.artifact.applet.openApp"),
                        icon: "open",
                        separatorBefore: true,
                        onSelect: () => {
                          void applet.open(props.id).catch(() => undefined);
                        },
                      },
                      {
                        key: "canvas-install-applet",
                        testID: "artifact-canvas-install-applet",
                        label: t("web.artifact.applet.manageApp"),
                        icon: "settings",
                        checked: true,
                        onSelect: () => appletModalOpen.set(true),
                      },
                    );
                  } else {
                    items.push({
                      key: "canvas-install-applet",
                      testID: "artifact-canvas-install-applet",
                      label: t("web.artifact.applet.button"),
                      icon: "download",
                      separatorBefore: true,
                      onSelect: () => appletModalOpen.set(true),
                    });
                  }
                }
                return items;
              }}
            />
            <InstallAppletModal open={appletModalOpen()} artifact={a()} onClose={() => appletModalOpen.set(false)} />
          </>
        )}
      </If>
      <If when={artifact.status() === "success" && artifact.data() === undefined}>
        <Empty icon="artifacts">{t("web.artifact.page.gone")}</Empty>
      </If>
    </View>
  );
}
