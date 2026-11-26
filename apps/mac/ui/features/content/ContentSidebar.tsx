import { Scroll, signal, Text, View, type JSX } from "nsh";
import { z } from "zod";

import { t } from "@vibevalley/i18n";
import { ARTIFACT_TYPES, type LibraryFileKind, LibraryFileKindValues } from "@vibevalley/protocol";

import { Button } from "../../design/Button";
import { Icon } from "../../design/Icon";
import { IconButton } from "../../design/IconButton";
import type { IconName } from "../../design/icons";
import { ActiveBar, Kbd } from "../../design/layout";
import { Bubble } from "../../design/Tip";
import { currentHost } from "../../infra/host";
import { ready, useQuery } from "../../infra/query";
import { useLocation, useRouter } from "../../infra/router";
import { createMemo } from "../../infra/solid";
import {
  activeArtifactType,
  type ContentBucket,
  contentBrowseBucket,
  contentSidebarOpen,
  countContentHub,
  countForBucket,
  openContentSearch,
  openTemplatePicker,
  pinnedKeys,
  templatePickerContextFor,
} from "../../infra/state/contentNav";
import { defineStored } from "../../infra/state/stored";
import { artifactTypeIcon, artifactTypeLabel, useArtifacts, useInstalledApplets } from "../artifact";
import { libraryQuery } from "../media";

const artifactsSectionOpen = defineStored("content.sidebar.artifacts", z.boolean(), true);
const mediaSectionOpen = defineStored("content.sidebar.media", z.boolean(), true);

const artifactFacets = ARTIFACT_TYPES.map((type) => ({
  type,
  icon: () => artifactTypeIcon[type],
  label: () => artifactTypeLabel(type),
}));

const mediaKinds: readonly LibraryFileKind[] = LibraryFileKindValues;

const mediaKindIcons: Record<LibraryFileKind, IconName> = {
  image: "image",
  audio: "audio",
  video: "video",
  other: "file",
};

const rowClass = (active: boolean, indent = false) =>
  [
    "relative h-7 flex-row items-center gap-2 rounded-md pr-2 focus-visible:outline-2 focus-visible:outline-focus",
    indent ? "pl-6" : "pl-2",
    active ? "bg-selected" : "hover:bg-hover",
  ].join(" ");

export function ContentSidebar() {
  const router = useRouter();
  const location = useLocation();
  const showEmptyArtifacts = signal(false);
  const showEmptyMedia = signal(false);

  const artifacts = useArtifacts(() => ({}));
  const media = useQuery(() => libraryQuery({ text: "", sort: "recent" }), { interval: () => 10_000, keepPrevious: true });
  const installedApplets = useInstalledApplets();

  const allArtifacts = createMemo(() => ready(artifacts, undefined) ?? []);
  const allMedia = createMemo(() => ready(media, undefined) ?? []);
  const installedIds = createMemo(
    () =>
      new Set(
        installedApplets()
          .filter((item) => item.installed)
          .map((item) => item.artifactId),
      ),
  );

  const inBrowse = createMemo(() => location().pathname === "/library" || location().pathname.startsWith("/library/"));
  const bucket = () => contentBrowseBucket();
  const allArtifactsActive = createMemo(() => {
    const b = contentBrowseBucket();
    return inBrowse() && b.kind === "artifacts" && b.artifactType === undefined;
  });
  const allMediaActive = createMemo(() => {
    const b = contentBrowseBucket();
    return inBrowse() && b.kind === "media" && b.fileKind === undefined;
  });

  const counts = createMemo(() =>
    countContentHub({
      artifacts: allArtifacts(),
      media: allMedia(),
      pinned: new Set(pinnedKeys()),
      installedArtifactIds: installedIds(),
    }),
  );

  const activeArtifactFilter = createMemo(() => {
    const b = bucket();
    return inBrowse() && b.kind === "artifacts" ? b.artifactType : undefined;
  });
  const activeMediaFilter = createMemo(() => {
    const b = bucket();
    return inBrowse() && b.kind === "media" ? b.fileKind : undefined;
  });

  const visibleArtifactFacets = createMemo(() => {
    const c = counts();
    const activeType = activeArtifactFilter();
    const expanded = showEmptyArtifacts();
    return artifactFacets.filter((facet) => expanded || facet.type === activeType || countForBucket(c, { kind: "artifacts", artifactType: facet.type }) > 0);
  });
  const emptyArtifactFacetCount = createMemo(() => {
    const c = counts();
    const activeType = activeArtifactFilter();
    return artifactFacets.filter((facet) => facet.type !== activeType && countForBucket(c, { kind: "artifacts", artifactType: facet.type }) === 0).length;
  });

  const visibleMediaKinds = createMemo(() => {
    const c = counts();
    const activeKind = activeMediaFilter();
    const expanded = showEmptyMedia();
    return mediaKinds.filter((kind) => expanded || kind === activeKind || countForBucket(c, { kind: "media", fileKind: kind }) > 0);
  });
  const emptyMediaKindCount = createMemo(() => {
    const c = counts();
    const activeKind = activeMediaFilter();
    return mediaKinds.filter((kind) => kind !== activeKind && countForBucket(c, { kind: "media", fileKind: kind }) === 0).length;
  });

  const selectBucket = (next: ContentBucket) => {
    contentBrowseBucket.set(next);
    if (!inBrowse()) router.navigate("/library");
  };

  return (
    <View testID="content-sidebar" accessibilityLabel={t("web.library.content.title")} class="h-full w-58 shrink-0 border-r border-line bg-side">
      <View desktop={{ windowDrag: true }} class="h-9 shrink-0 flex-row items-center gap-1.5 border-b border-line px-2.5">
        <IconButton
          icon="sidebar"
          size={16}
          label={t("web.library.content.sidebarToggle")}
          testid="content-sidebar-toggle"
          pressed={contentSidebarOpen.get()}
          onClick={() => contentSidebarOpen.update((open) => !open)}
        />
        <Text role="header" class="min-w-0 flex-1 truncate text-sm font-semibold text-ink">
          {t("web.library.content.title")}
        </Text>
        <Button
          tone="primary"
          size="compact"
          icon="add"
          testID="content-new-btn"
          tooltip={<Bubble text={`${t("web.library.content.new")} (⌘N)`} />}
          onPress={() => openTemplatePicker(templatePickerContextFor(bucket(), inBrowse() ? undefined : activeArtifactType()))}
        >
          {t("web.library.content.new")}
        </Button>
      </View>

      <Scroll class="min-h-0 flex-1" contentClass="gap-2.5 p-2 pb-4">
        <View
          role="button"
          testID="content-search-btn"
          accessibilityLabel={t("web.library.content.searchAll")}
          onPress={() => openContentSearch()}
          class="group h-7.5 w-full flex-row items-center gap-2 rounded-md border border-line bg-page px-2 hover:border-faint focus-visible:outline-2 focus-visible:outline-focus"
        >
          <Icon name="search" size={14} tone="faint" />
          <Text class="min-w-0 flex-1 truncate text-xs text-faint group-hover:text-muted">{t("web.library.content.searchAll")}</Text>
          <Kbd>⌘F</Kbd>
        </View>
        <View class="gap-0.5">
          <NavRow
            testID="content-nav-recent"
            icon="clock"
            label={t("web.library.content.recent")}
            count={countForBucket(counts(), { kind: "recent" })}
            active={inBrowse() && bucket().kind === "recent"}
            onPress={() => selectBucket({ kind: "recent" })}
          />
          <NavRow
            testID="content-nav-pinned"
            icon="pin"
            iconTone="wheat"
            label={t("web.library.content.pinned")}
            count={countForBucket(counts(), { kind: "pinned" })}
            active={inBrowse() && bucket().kind === "pinned"}
            onPress={() => selectBucket({ kind: "pinned" })}
          />
          <If when={currentHost().applet !== undefined}>
            <NavRow
              testID="content-nav-apps"
              icon="devices"
              iconTone="ok-ink"
              label={t("web.library.content.installedApps")}
              count={countForBucket(counts(), { kind: "apps" })}
              active={inBrowse() && bucket().kind === "apps"}
              onPress={() => selectBucket({ kind: "apps" })}
            />
          </If>
        </View>

        <NavSection
          testID="content-nav-artifacts-section"
          navTestID="content-nav-artifacts-all"
          toggleTestID="content-nav-artifacts-toggle"
          title={t("web.library.content.artifacts")}
          count={counts().artifacts}
          active={allArtifactsActive()}
          open={artifactsSectionOpen.get()}
          onSelect={() => selectBucket({ kind: "artifacts" })}
          onToggle={() => artifactsSectionOpen.update((on) => !on)}
        >
          <Each of={visibleArtifactFacets()} key={(facet) => facet.type}>
            {(facet) => {
              const active = () => activeArtifactFilter() === facet().type;
              return (
                <NavRow
                  testID={`content-nav-artifact-${facet().type}`}
                  icon={facet().icon()}
                  label={facet().label()}
                  count={countForBucket(counts(), { kind: "artifacts", artifactType: facet().type })}
                  active={active()}
                  indent
                  onPress={() => selectBucket({ kind: "artifacts", artifactType: facet().type })}
                />
              );
            }}
          </Each>
          <If when={emptyArtifactFacetCount() > 0}>
            <FoldEmptyToggle
              testID="content-nav-artifacts-more"
              expanded={showEmptyArtifacts()}
              hiddenCount={emptyArtifactFacetCount()}
              onToggle={() => showEmptyArtifacts.set(!showEmptyArtifacts())}
            />
          </If>
        </NavSection>

        <NavSection
          testID="content-nav-media-section"
          navTestID="content-nav-media-all"
          toggleTestID="content-nav-media-toggle"
          title={t("web.library.content.media")}
          count={counts().media}
          active={allMediaActive()}
          open={mediaSectionOpen.get()}
          onSelect={() => selectBucket({ kind: "media" })}
          onToggle={() => mediaSectionOpen.update((on) => !on)}
        >
          <Each of={visibleMediaKinds()} key={(kind) => kind}>
            {(kind) => {
              const active = () => activeMediaFilter() === kind();
              return (
                <NavRow
                  testID={`content-nav-media-${kind()}`}
                  icon={mediaKindIcons[kind()]}
                  label={t(`web.library.kind.${kind()}`)}
                  count={countForBucket(counts(), { kind: "media", fileKind: kind() })}
                  active={active()}
                  indent
                  onPress={() => selectBucket({ kind: "media", fileKind: kind() })}
                />
              );
            }}
          </Each>
          <If when={emptyMediaKindCount() > 0}>
            <FoldEmptyToggle
              testID="content-nav-media-more"
              expanded={showEmptyMedia()}
              hiddenCount={emptyMediaKindCount()}
              onToggle={() => showEmptyMedia.set(!showEmptyMedia())}
            />
          </If>
        </NavSection>
      </Scroll>
    </View>
  );
}

function FoldEmptyToggle(props: { testID: string; expanded: boolean; hiddenCount: number; onToggle: () => void }) {
  const label = () => (props.expanded ? t("web.library.content.fewerTypes") : t("web.library.content.moreTypes", { n: props.hiddenCount }));
  return (
    <View
      role="button"
      testID={props.testID}
      accessibilityLabel={label()}
      accessibilityState={{ expanded: props.expanded }}
      onPress={() => props.onToggle()}
      class="h-7 flex-row items-center gap-2 rounded-md pr-2 pl-6 hover:bg-hover focus-visible:outline-2 focus-visible:outline-focus"
    >
      <Icon name={props.expanded ? "choose" : "expand"} size={12} tone="faint" />
      <Text class="min-w-0 flex-1 truncate text-xs text-faint">{label()}</Text>
    </View>
  );
}

function NavSection(props: {
  testID: string;
  navTestID: string;
  toggleTestID: string;
  title: string;
  count: number;
  active: boolean;
  open: boolean;
  onSelect: () => void;
  onToggle: () => void;
  action?: JSX.Element | undefined;
  children: JSX.Element;
}) {
  return (
    <View testID={props.testID} accessibilityLabel={props.title} class="gap-0.5">
      <View class="h-7 flex-row items-center gap-1">
        <View class={`relative h-7 min-w-0 flex-1 flex-row items-center gap-2 rounded-md px-2 ${props.active ? "bg-selected" : "hover:bg-hover"}`}>
          <If when={props.active}>
            <ActiveBar />
          </If>
          <View
            role="button"
            testID={props.toggleTestID}
            accessibilityLabel={
              props.open ? t("web.shell.sidebar.collapseItem", { name: props.title }) : t("web.shell.sidebar.expandItem", { name: props.title })
            }
            accessibilityState={{ expanded: props.open }}
            onPress={() => props.onToggle()}
            class="h-4 w-4 shrink-0 items-center justify-center rounded-sm hover:bg-selected focus-visible:outline-2 focus-visible:outline-focus"
          >
            <Icon name={props.open ? "choose" : "expand"} size={14} tone="muted" />
          </View>
          <View
            role="button"
            testID={props.navTestID}
            accessibilityLabel={props.title}
            accessibilityState={{ selected: props.active }}
            onPress={() => props.onSelect()}
            class="h-7 min-w-0 flex-1 flex-row items-center gap-2 rounded-sm focus-visible:outline-2 focus-visible:outline-focus"
          >
            <Text class={`min-w-0 flex-1 truncate text-sm font-medium ${props.active ? "text-ink" : "text-muted"}`}>{props.title}</Text>
            <Text class={`shrink-0 font-mono text-2xs tabular-nums ${props.active ? "text-muted" : "text-faint"}`}>{String(props.count)}</Text>
          </View>
        </View>
        {props.action}
      </View>
      <If when={props.open}>
        <View class="gap-0.5">{props.children}</View>
      </If>
    </View>
  );
}

function NavRow(props: {
  testID: string;
  icon: IconName;
  iconTone?: string | undefined;
  label: string;
  count: number;
  active: boolean;
  indent?: boolean;
  onPress: () => void;
}) {
  return (
    <View
      role="button"
      testID={props.testID}
      accessibilityLabel={props.label}
      accessibilityState={{ selected: props.active }}
      onPress={() => props.onPress()}
      class={`${rowClass(props.active, props.indent === true)} ${!props.active && props.indent === true && props.count === 0 ? "opacity-60" : ""}`}
    >
      <If when={props.active}>
        <ActiveBar />
      </If>
      <Icon name={props.icon} size={14} tone={props.iconTone ?? (props.active ? "ink" : "muted")} />
      <Text
        class={`min-w-0 flex-1 truncate ${props.indent === true ? "text-xs" : "text-sm"} ${props.active ? "font-semibold text-ink" : "font-medium text-muted"}`}
      >
        {props.label}
      </Text>
      <If when={props.count > 0}>
        <Text class="shrink-0 font-mono text-2xs text-faint tabular-nums">{String(props.count)}</Text>
      </If>
    </View>
  );
}
