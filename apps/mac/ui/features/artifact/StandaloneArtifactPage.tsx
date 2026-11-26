import { Text, View } from "nsh";

import { t } from "@vibevalley/i18n";

import { Icon } from "../../design/Icon";
import { Banner, Empty } from "../../design/layout";
import { SkeletonBar, SkeletonLines, useDelayedBusy } from "../../design/Skeleton";
import { reasonOf } from "../../infra/api";
import { ready } from "../../infra/query";
import { useSearch } from "../../infra/router";
import { artifactIcon, kindLabel, useArtifact } from "./ArtifactCard";
import { ArtifactDirectoryView } from "./ArtifactDirectoryView";

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
  const askedVersion = () => {
    const raw = search().get("v");
    const parsed = raw ? Number(raw) : Number.NaN;
    return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
  };
  const shown = () => ready(artifact, undefined);
  const displayVersion = () => askedVersion() ?? shown()?.version;
  const showSkeleton = useDelayedBusy(() => shown() === undefined && artifact.status() !== "error" && artifact.status() !== "success");

  return (
    <View testID="standalone-artifact-page" class="h-full min-h-0 min-w-0 flex-1 bg-page">
      <If when={!shown()}>
        <View
          testID="standalone-artifact-header"
          desktop={{ windowDrag: true }}
          class="h-11 shrink-0 flex-row items-center gap-2 border-b border-line bg-page pr-3 pl-20"
        >
          <If when={showSkeleton()}>
            <View class="min-w-0 flex-1 flex-row items-center gap-2">
              <SkeletonBar class="size-5 rounded-sm" />
              <SkeletonBar class="h-4 w-40 rounded-sm" />
              <SkeletonBar class="h-4 w-16 rounded-sm" />
            </View>
          </If>
        </View>
      </If>

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
            headerTestID="standalone-artifact-header"
            headerClass="h-11 shrink-0 flex-row items-center gap-2 border-b border-line bg-page pr-3 pl-20"
            headerWindowDrag
            menuTestID="standalone-artifact-more"
            headerLeft={
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
              </>
            }
          />
        )}
      </If>
    </View>
  );
}
