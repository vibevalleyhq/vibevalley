// Ported from VibeValley apps/web/src/features/artifact/ArtifactCanvas.tsx:
// an artifact opened beside the talk (chat's ?artifact=), with a link to its
// own page; a blocks one's blocks can be quoted into the box.
import { Text, View } from "nsh";

import { t } from "@vibevalley/i18n";

import { reasonOf } from "../../infra/api";
import { ready } from "../../infra/query";
import { Link as A } from "../../infra/router";
import { Icon } from "../../ui/Icon";
import { IconButton } from "../../ui/IconButton";
import { artifactIcon, kindLabel, useArtifact } from "./ArtifactCard";
import { BlocksView, type QuoteTarget } from "./BlocksView";
import { HtmlFrame } from "./HtmlFrame";
import { StoreArtifactView } from "./StoreArtifactView";

export function ArtifactCanvas(props: { id: string; version?: number | undefined; onClose?: () => void; onQuote?: (block: QuoteTarget) => void }) {
  const artifact = useArtifact(() => props.id);
  const shown = () => ready(artifact, undefined);
  const pageVersion = () => {
    const a = shown();
    return props.version ?? (a?.body === "html" ? a.version : undefined);
  };
  const pageHref = () => `/artifacts/${encodeURIComponent(props.id)}${(pageVersion() ?? 0) > 0 ? `?v=${pageVersion()}` : ""}`;
  return (
    <View accessibilityLabel={t("web.artifact.canvas.label")} testID="artifact-canvas" class="min-h-0 min-w-0 flex-1 border-l border-line bg-page">
      <View class="h-16.5 shrink-0 flex-row items-center gap-2 border-b border-line px-3">
        <If when={shown()}>
          {(a) => (
            <>
              <View class="size-8 shrink-0 items-center justify-center rounded-md bg-hover">
                <Icon name={artifactIcon(a())} size={16} tone="muted" />
              </View>
              <View class="min-w-0 flex-1">
                <Text class="truncate text-sm font-semibold text-ink">{a().title}</Text>
                <Text class="truncate text-xs text-muted">
                  {[
                    kindLabel(a()),
                    ...(a().isDefault ? [t("web.artifact.types.defaultBadge")] : []),
                    ...(a().body === "html" ? [t("web.artifact.card.version", { version: props.version ?? a().version })] : []),
                  ].join(" · ")}
                </Text>
              </View>
            </>
          )}
        </If>
        <A href={pageHref()} testID="artifact-canvas-page" class="rounded-md px-2 py-1 hover:bg-hover">
          <Text class="text-xs text-muted">{t("web.artifact.canvas.openPage")}</Text>
        </A>
        <If when={props.onClose}>
          <IconButton icon="close" label={t("web.artifact.canvas.close")} testid="artifact-canvas-close" onClick={() => props.onClose?.()} />
        </If>
      </View>
      <If when={artifact.error()}>
        <View class="p-3">
          <Text class="text-sm text-berry">{reasonOf(artifact.error())}</Text>
        </View>
      </If>
      <If when={shown()}>
        {(a) => (
          <>
            <If when={a().body === "blocks"}>
              <View class="min-h-0 flex-1 p-3">
                <BlocksView id={a().id} {...(props.onQuote ? { onQuote: props.onQuote } : {})} />
              </View>
            </If>
            <If when={a().body === "store"}>
              <View class="min-h-0 flex-1 p-2">
                <StoreArtifactView artifact={a()} />
              </View>
            </If>
            <If when={a().body === "html"}>
              <HtmlFrame
                artifact={a()}
                version={props.version ?? a().version}
                title={t("web.artifact.page.frame", { title: a().title, version: props.version ?? a().version })}
                testId="artifact-canvas-frame"
                frameClass="min-h-0 w-full flex-1 bg-page"
              />
            </If>
          </>
        )}
      </If>
      <If when={artifact.status() === "success" && artifact.data() === undefined}>
        <View class="p-3">
          <Text class="text-sm text-muted">{t("web.artifact.page.gone")}</Text>
        </View>
      </If>
    </View>
  );
}
