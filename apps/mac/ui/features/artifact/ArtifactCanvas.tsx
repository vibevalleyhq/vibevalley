import { Text, View } from "nsh";

import { t } from "@vibevalley/i18n";

import { Icon } from "../../design/Icon";
import { IconButton } from "../../design/IconButton";
import { Banner, Empty } from "../../design/layout";
import { Bubble } from "../../design/Tip";
import { reasonOf } from "../../infra/api";
import { ready } from "../../infra/query";
import { Link as A } from "../../infra/router";
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
      <View class="h-14 shrink-0 flex-row items-center gap-2.5 border-b border-line bg-page px-3.5">
        <If when={shown()}>
          {(a) => (
            <>
              <View class="size-8 shrink-0 items-center justify-center rounded-md bg-side">
                <Icon name={artifactIcon(a())} size={16} tone="muted" />
              </View>
              <View class="min-w-0 flex-1 gap-0.5">
                <Text class="truncate text-sm font-semibold text-ink">{a().title}</Text>
                <Text class="truncate text-xs text-muted tabular-nums">
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
        <View class="shrink-0 flex-row items-center gap-1">
          <A
            href={pageHref()}
            testID="artifact-canvas-page"
            tooltip={<Bubble text={t("web.artifact.canvas.openPage")} />}
            class="group h-7 shrink-0 flex-row items-center gap-1 rounded-md border border-line bg-page px-2 transition duration-120 ease-out hover:border-faint hover:bg-hover focus-visible:outline-2 focus-visible:outline-focus"
          >
            <Icon name="open" size={12} tone="muted" />
            <Text class="text-xs font-medium text-muted group-hover:text-ink">{t("web.artifact.canvas.openPage")}</Text>
          </A>
          <If when={props.onClose}>
            <IconButton icon="close" label={t("web.artifact.canvas.close")} testid="artifact-canvas-close" onClick={() => props.onClose?.()} />
          </If>
        </View>
      </View>
      <If when={artifact.error()}>
        <Banner class="m-3">{reasonOf(artifact.error())}</Banner>
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
        <Empty icon="artifacts">{t("web.artifact.page.gone")}</Empty>
      </If>
    </View>
  );
}
