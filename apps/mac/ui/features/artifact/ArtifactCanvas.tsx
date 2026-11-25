import { Text, View } from "nsh";

import { t } from "@vibevalley/i18n";

import { Icon } from "../../design/Icon";
import { IconButton } from "../../design/IconButton";
import { Banner, Empty } from "../../design/layout";
import { reasonOf } from "../../infra/api";
import { ready } from "../../infra/query";
import { useRouter } from "../../infra/router";
import { artifactIcon, kindLabel, useArtifact } from "./ArtifactCard";
import { ArtifactDirectoryView } from "./ArtifactDirectoryView";
import { InstallAppletButton } from "./InstallAppletModal";

export function ArtifactCanvas(props: { id: string; version?: number | undefined; onClose?: () => void }) {
  const router = useRouter();
  const artifact = useArtifact(() => props.id);
  const shown = () => ready(artifact, undefined);
  const pageVersion = () => {
    if (props.version !== undefined) return props.version;
    const v = shown()?.version;
    return v !== undefined && v > 0 ? v : undefined;
  };
  const pageHref = () => `/artifacts/${encodeURIComponent(props.id)}${(pageVersion() ?? 0) > 0 ? `?v=${pageVersion()}` : ""}`;
  return (
    <View accessibilityLabel={t("web.artifact.canvas.label")} testID="artifact-canvas" class="min-h-0 min-w-0 flex-1 border-l border-line bg-page">
      <View class="h-9 shrink-0 flex-row items-center gap-2 border-b border-line bg-page px-3">
        <If when={shown()}>
          {(a) => (
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
          )}
        </If>
        <View class="shrink-0 flex-row items-center gap-1">
          <If when={shown()}>{(a) => <InstallAppletButton artifact={a()} testID="artifact-canvas-install-applet" />}</If>
          <IconButton icon="open" label={t("web.artifact.canvas.openPage")} testid="artifact-canvas-page" onClick={() => router.navigate(pageHref())} />
          <If when={props.onClose}>
            <IconButton icon="close" label={t("web.artifact.canvas.close")} testid="artifact-canvas-close" onClick={() => props.onClose?.()} />
          </If>
        </View>
      </View>
      <If when={artifact.error()}>
        <Banner class="m-3">{reasonOf(artifact.error())}</Banner>
      </If>
      <If when={shown()}>{(a) => <ArtifactDirectoryView artifact={a()} version={props.version} compact />}</If>
      <If when={artifact.status() === "success" && artifact.data() === undefined}>
        <Empty icon="artifacts">{t("web.artifact.page.gone")}</Empty>
      </If>
    </View>
  );
}
