import { signal, Text, untracked, View } from "nsh";

import { t } from "@vibevalley/i18n";

import { Icon } from "../../design/Icon";
import { Banner, Empty } from "../../design/layout";
import { Segmented } from "../../design/Segmented";
import { SkeletonBar, SkeletonLines, useDelayedBusy } from "../../design/Skeleton";
import { reasonOf } from "../../infra/api";
import { ready } from "../../infra/query";
import { useSearch } from "../../infra/router";
import { artifactIcon, kindLabel, useArtifact } from "./ArtifactCard";
import { type ArtifactDirectoryMeta, ArtifactDirectoryView, type ArtifactViewTab } from "./ArtifactDirectoryView";

function StandaloneArtifactSkeleton() {
  return (
    <View testID="standalone-artifact-skeleton" accessibilityState={{ busy: true }} class="min-h-0 flex-1 bg-page">
      <View class="mx-auto w-full max-w-3xl gap-4 px-6 py-7">
        <SkeletonBar class="h-7 w-64 rounded-md" />
        <SkeletonLines rows={["92%", "78%", "85%", "60%", "88%", "45%"]} gap="md" />
      </View>
    </View>
  );
}

/** Chromeless standalone artifact surface rendered at `/standalone/artifact/:id` for local macOS applets. */
export function StandaloneArtifactPage(props: { id: string }) {
  const artifact = useArtifact(() => props.id);
  const search = useSearch();
  const viewTab = signal<ArtifactViewTab>("preview");
  const dirMeta = signal<ArtifactDirectoryMeta>({ fileCount: 0, seq: 0, peers: [] });
  const askedVersion = () => {
    const raw = search().get("v");
    const parsed = raw ? Number(raw) : Number.NaN;
    return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
  };
  const shown = () => ready(artifact, undefined);
  const displayVersion = () => askedVersion() ?? shown()?.version;
  const showSkeleton = useDelayedBusy(() => shown() === undefined && artifact.status() !== "error" && artifact.status() !== "success");

  const handleMeta = (next: ArtifactDirectoryMeta) => {
    const prev = untracked(dirMeta);
    if (
      prev.fileCount === next.fileCount &&
      prev.seq === next.seq &&
      prev.peers.length === next.peers.length &&
      prev.peers.every((p, i) => p === next.peers[i])
    ) {
      return;
    }
    dirMeta.set(next);
  };

  return (
    <View testID="standalone-artifact-page" class="h-full min-h-0 min-w-0 flex-1 bg-page">
      <View
        testID="standalone-artifact-header"
        desktop={{ windowDrag: true }}
        class="h-9.5 shrink-0 flex-row items-center gap-2 border-b border-line bg-page pr-3 pl-20"
      >
        <If
          when={shown()}
          else={
            <If when={showSkeleton()}>
              <View class="min-w-0 flex-1 flex-row items-center gap-2">
                <SkeletonBar class="size-5 rounded-sm" />
                <SkeletonBar class="h-4 w-40 rounded-sm" />
                <SkeletonBar class="h-4 w-16 rounded-sm" />
              </View>
            </If>
          }
        >
          {(a) => (
            <>
              <View class="size-5 shrink-0 items-center justify-center rounded-sm bg-side">
                <Icon name={artifactIcon(a())} size={12} tone="muted" />
              </View>
              <Text testID="standalone-artifact-title" class="min-w-0 shrink truncate text-sm font-semibold text-ink">
                {a().title}
              </Text>
              <View testID="standalone-artifact-type" class="h-5 shrink-0 items-center justify-center rounded-sm bg-selected px-1.5">
                <Text class="text-2xs font-medium text-ink">{kindLabel(a())}</Text>
              </View>
              <View testID="standalone-artifact-version" class="h-5 shrink-0 items-center justify-center rounded-sm border border-line bg-side px-1.5">
                <Text class="font-mono text-2xs font-medium text-muted tabular-nums">
                  {(displayVersion() ?? 0) > 0 ? t("web.artifact.standalone.version", { version: displayVersion() ?? 0 }) : t("web.artifact.standalone.live")}
                </Text>
              </View>
              <View class="min-w-0 flex-1" />
              <If when={dirMeta().peers.length > 0}>
                <View testID="artifact-presence-bar" class="shrink-0 flex-row items-center gap-1">
                  <Each of={dirMeta().peers} key={(p) => p.id}>
                    {(peer) => (
                      <View testID="artifact-presence-pill" class="h-5 flex-row items-center gap-1 rounded-full border border-line bg-side px-2">
                        <View class="size-1.5 shrink-0 rounded-full bg-accent" />
                        <Text class="max-w-24 truncate text-2xs font-medium text-ink">{peer().name}</Text>
                      </View>
                    )}
                  </Each>
                </View>
              </If>
              <Segmented
                testid="artifact-view-mode"
                label={t("web.artifact.page.viewMode")}
                value={viewTab()}
                onChange={(v) => viewTab.set(v)}
                options={[
                  { value: "preview" as const, label: t("web.artifact.page.previewTab") },
                  {
                    value: "files" as const,
                    label: dirMeta().fileCount > 0 ? t("web.artifact.page.filesTabCount", { n: dirMeta().fileCount }) : t("web.artifact.page.filesTab"),
                  },
                ]}
              />
            </>
          )}
        </If>
      </View>

      <If when={artifact.error()}>
        <Banner testID="standalone-artifact-error" class="m-3">
          {reasonOf(artifact.error())}
        </Banner>
      </If>

      <If
        when={shown()}
        else={
          <If
            when={artifact.status() === "error" || (artifact.status() === "success" && artifact.data() === undefined)}
            else={
              <If when={showSkeleton()}>
                <StandaloneArtifactSkeleton />
              </If>
            }
          >
            <Empty testid="standalone-artifact-empty" icon="artifacts">
              {t("web.artifact.standalone.missing")}
            </Empty>
          </If>
        }
      >
        {(a) => (
          <ArtifactDirectoryView
            artifact={a()}
            version={askedVersion()}
            compact
            hideToolbar
            tab={viewTab()}
            onTabChange={(v) => viewTab.set(v)}
            onMeta={handleMeta}
          />
        )}
      </If>
    </View>
  );
}
