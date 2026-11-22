import { Scroll, Text, View } from "nsh";
import { z } from "zod";

import { t } from "@vibevalley/i18n";
import type { ArtifactType, LibraryFileKind, PkmPageSummary } from "@vibevalley/protocol";

import { createAct } from "../../design/act";
import { Button } from "../../design/Button";
import { Icon } from "../../design/Icon";
import { IconButton } from "../../design/IconButton";
import type { IconName } from "../../design/icons";
import { ActiveBar, SidebarSection } from "../../design/layout";
import { motionClass } from "../../design/motion";
import { CountPill } from "../../design/Tag";
import { Bubble } from "../../design/Tip";
import { ready, useQuery, useQueryClient } from "../../infra/query";
import { Link, useLocation, useRouter } from "../../infra/router";
import { createMemo } from "../../infra/solid";
import { defineStored } from "../../infra/state/stored";
import { artifactTypeIcon, useArtifacts } from "../artifact";
import { libraryQuery } from "../media/listing";
import { dayKey, titleFor } from "../pkm/days";
import { pkmHref, usePkmVault } from "../pkm/vault";
import { artifactFacetOf, type ContentBucket, contentBrowseBucket, mediaKindOf, openContentSearch, openTemplatePicker, pinnedKeys } from "./navigation";
import { createQuickBlankNote } from "./templates";

const artifactsSectionOpen = defineStored("content.sidebar.artifacts", z.boolean(), true);
const mediaSectionOpen = defineStored("content.sidebar.media", z.boolean(), true);

type ArtifactFacet = ArtifactType | "html";

const artifactFacets: readonly { readonly type: ArtifactFacet; readonly icon: IconName; readonly label: () => string }[] = [
  { type: "whiteboard", icon: artifactTypeIcon.whiteboard, label: () => t("web.library.content.artifactType.whiteboard") },
  { type: "docs", icon: artifactTypeIcon.docs, label: () => t("web.library.content.artifactType.docs") },
  { type: "slides", icon: artifactTypeIcon.slides, label: () => t("web.library.content.artifactType.slides") },
  { type: "dashboard", icon: artifactTypeIcon.dashboard, label: () => t("web.library.content.artifactType.dashboard") },
  { type: "design", icon: artifactTypeIcon.design, label: () => t("web.library.content.artifactType.design") },
  { type: "design-system", icon: artifactTypeIcon["design-system"], label: () => t("web.library.content.artifactType.designSystem") },
  { type: "motion", icon: artifactTypeIcon.motion, label: () => t("web.library.content.artifactType.motion") },
  { type: "html", icon: "web", label: () => t("web.library.content.artifactType.html") },
];

const mediaKinds: readonly LibraryFileKind[] = ["image", "audio", "video", "other"];

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

function activePkmSlugOf(pathname: string): string | undefined {
  if (!pathname.startsWith("/pkm/")) return undefined;
  const raw = pathname.slice("/pkm/".length);
  return raw ? decodeURIComponent(raw) : undefined;
}

function sortNotes(pages: readonly PkmPageSummary[]): PkmPageSummary[] {
  const today = dayKey(Date.now());
  return pages.toSorted((a, b) => {
    const aToday = a.day === today ? 1 : 0;
    const bToday = b.day === today ? 1 : 0;
    if (aToday !== bToday) return bToday - aToday;
    return b.updated - a.updated;
  });
}

export function ContentSidebar() {
  const router = useRouter();
  const location = useLocation();
  const queries = useQueryClient();
  const act = createAct();

  const vault = usePkmVault();
  const artifacts = useArtifacts(() => ({}));
  const media = useQuery(() => libraryQuery({ text: "", sort: "recent" }), { interval: () => 10_000, keepPrevious: true });

  const notes = createMemo(() => sortNotes(ready(vault, undefined)?.pages ?? []));
  const allArtifacts = () => ready(artifacts, undefined) ?? [];
  const allMedia = () => ready(media, undefined) ?? [];

  const inBrowse = () => location().pathname === "/library" || location().pathname.startsWith("/library/");
  const activeSlug = () => activePkmSlugOf(location().pathname);
  const bucket = () => contentBrowseBucket();
  const allArtifactsActive = () => {
    const b = bucket();
    return inBrowse() && b.kind === "artifacts" && b.artifactType === undefined;
  };
  const allMediaActive = () => {
    const b = bucket();
    return inBrowse() && b.kind === "media" && b.fileKind === undefined;
  };

  const totalCount = () => notes().length + allArtifacts().length + allMedia().length;
  const pinnedCount = createMemo(() => {
    const keys = new Set(pinnedKeys());
    let n = 0;
    for (const p of notes()) if (keys.has(`note:${p.slug}`)) n += 1;
    for (const a of allArtifacts()) if (keys.has(`artifact:${a.id}`)) n += 1;
    for (const m of allMedia()) if (keys.has(`media:${m.attachment.id}`)) n += 1;
    return n;
  });

  const artifactCounts = createMemo(() => {
    const map = new Map<ArtifactFacet, number>();
    for (const a of allArtifacts()) {
      const f = artifactFacetOf(a);
      map.set(f, (map.get(f) ?? 0) + 1);
    }
    return map;
  });

  const mediaCounts = createMemo(() => {
    const map = new Map<LibraryFileKind, number>();
    for (const m of allMedia()) {
      const k = mediaKindOf(m.attachment.type);
      map.set(k, (map.get(k) ?? 0) + 1);
    }
    return map;
  });

  const selectBucket = (next: ContentBucket) => {
    contentBrowseBucket.set(next);
    if (!inBrowse()) router.navigate("/library");
  };

  const newBlankNote = () => {
    if (act.busy()) return;
    const existingNoteTitles = notes().map((p) => p.title);
    void act.run(() => createQuickBlankNote({ queries, router, existingNoteTitles }));
  };

  return (
    <View testID="content-sidebar" accessibilityLabel={t("web.library.content.title")} class="w-58 shrink-0 border-r border-line bg-side">
      <View class="shrink-0 gap-1.5 border-b border-line p-2.5">
        <Button tone="primary" icon="add" testID="content-new-btn" class="h-8 w-full" onPress={() => openTemplatePicker()}>
          {t("web.library.content.new")}
        </Button>
        <View
          role="button"
          testID="content-search-btn"
          accessibilityLabel={t("web.library.content.searchAll")}
          onPress={() => openContentSearch()}
          class="group h-7.5 w-full flex-row items-center gap-2 rounded-md border border-line bg-page px-2 hover:border-faint focus-visible:outline-2 focus-visible:outline-focus"
        >
          <Icon name="search" size={14} tone="faint" />
          <Text class="min-w-0 flex-1 truncate text-xs text-faint group-hover:text-muted">{t("web.library.content.searchAll")}</Text>
        </View>
      </View>

      <Scroll class="min-h-0 flex-1" contentClass="gap-3 p-2 pb-4">
        <View class="gap-0.5">
          <NavRow
            testID="content-nav-recent"
            icon="clock"
            label={t("web.library.content.recent")}
            count={totalCount()}
            active={inBrowse() && bucket().kind === "recent"}
            onPress={() => selectBucket({ kind: "recent" })}
          />
          <NavRow
            testID="content-nav-pinned"
            icon="pin"
            iconTone="wheat"
            label={t("web.library.content.pinned")}
            count={pinnedCount()}
            active={inBrowse() && bucket().kind === "pinned"}
            onPress={() => selectBucket({ kind: "pinned" })}
          />
        </View>

        <View class="gap-0.5">
          <View class="h-7 flex-row items-center gap-1">
            <View
              role="button"
              testID="content-nav-notes"
              accessibilityLabel={t("web.library.content.notesAll")}
              accessibilityState={{ selected: inBrowse() && bucket().kind === "notes" }}
              tooltip={<Bubble text={t("web.library.content.notesAll")} />}
              onPress={() => selectBucket({ kind: "notes" })}
              class={`group relative h-7 min-w-0 flex-1 flex-row items-center gap-1.5 rounded-md px-2 focus-visible:outline-2 focus-visible:outline-focus ${
                inBrowse() && bucket().kind === "notes" ? "bg-selected" : "hover:bg-hover"
              }`}
            >
              <If when={inBrowse() && bucket().kind === "notes"}>
                <ActiveBar />
              </If>
              <Text class="min-w-0 flex-1 truncate text-xs font-semibold text-muted group-hover:text-ink">{t("web.library.content.notes")}</Text>
              <CountPill count={notes().length} hoverBright />
            </View>
            <IconButton
              icon="add"
              size={12}
              label={t("web.library.content.newNote")}
              testid="content-new-note-btn"
              disabled={act.busy()}
              onClick={newBlankNote}
            />
          </View>
          <View testID="pkm-list" class="gap-0.5">
            <Each of={notes()} key={(p) => p.slug}>
              {(p) => {
                const active = () => activeSlug() === p().slug;
                const displayTitle = () => titleFor(p().title, p().day);
                return (
                  <Link
                    href={pkmHref(p().slug)}
                    testID="pkm-row"
                    accessibilityLabel={displayTitle()}
                    accessibilityState={{ selected: active() }}
                    class={rowClass(active())}
                  >
                    <If when={active()}>
                      <ActiveBar />
                    </If>
                    <Icon name={p().day ? "calendar" : "notes"} size={14} tone={active() ? "ink" : "muted"} />
                    <Text class={`min-w-0 flex-1 truncate text-sm ${active() ? "font-semibold text-ink" : "font-medium text-ink"}`}>{displayTitle()}</Text>
                    <If when={p().open > 0}>
                      <Text
                        class="shrink-0 font-mono text-2xs font-medium text-faint tabular-nums"
                        accessibilityHint={t("web.library.content.notesTodoCount", { n: p().open })}
                      >
                        {String(p().open)}
                      </Text>
                    </If>
                  </Link>
                );
              }}
            </Each>
          </View>
        </View>

        <SidebarSection
          testID="content-nav-artifacts-section"
          title={t("web.library.content.artifacts")}
          count={allArtifacts().length}
          open={artifactsSectionOpen.get()}
          onToggle={() => artifactsSectionOpen.update((on) => !on)}
          listClass="gap-0.5"
        >
          <NavRow
            testID="content-nav-artifacts-all"
            icon="artifacts"
            label={t("web.library.content.artifactType.all")}
            count={allArtifacts().length}
            active={allArtifactsActive()}
            onPress={() => selectBucket({ kind: "artifacts" })}
          />
          <Each of={artifactFacets}>
            {(facet) => {
              const active = () => {
                const b = bucket();
                return inBrowse() && b.kind === "artifacts" && b.artifactType === facet().type;
              };
              return (
                <NavRow
                  testID={`content-nav-artifact-${facet().type}`}
                  icon={facet().icon}
                  label={facet().label()}
                  count={artifactCounts().get(facet().type) ?? 0}
                  active={active()}
                  indent
                  onPress={() => selectBucket({ kind: "artifacts", artifactType: facet().type })}
                />
              );
            }}
          </Each>
        </SidebarSection>

        <SidebarSection
          testID="content-nav-media-section"
          title={t("web.library.content.media")}
          count={allMedia().length}
          open={mediaSectionOpen.get()}
          onToggle={() => mediaSectionOpen.update((on) => !on)}
          listClass="gap-0.5"
        >
          <NavRow
            testID="content-nav-media-all"
            icon="media"
            label={t("web.library.kind.all")}
            count={allMedia().length}
            active={allMediaActive()}
            onPress={() => selectBucket({ kind: "media" })}
          />
          <Each of={mediaKinds}>
            {(kind) => {
              const active = () => {
                const b = bucket();
                return inBrowse() && b.kind === "media" && b.fileKind === kind();
              };
              return (
                <NavRow
                  testID={`content-nav-media-${kind()}`}
                  icon={mediaKindIcons[kind()]}
                  label={t(`web.library.kind.${kind()}`)}
                  count={mediaCounts().get(kind()) ?? 0}
                  active={active()}
                  indent
                  onPress={() => selectBucket({ kind: "media", fileKind: kind() })}
                />
              );
            }}
          </Each>
          <View
            role="button"
            testID="content-nav-ai-generate"
            accessibilityLabel={t("web.library.content.aiGenerate")}
            onPress={() => openTemplatePicker("ai")}
            class={`mt-1 h-7 flex-row items-center gap-1.5 rounded-md border border-dashed border-line-strong px-2 ${motionClass("transition-transform duration-120 ease-out")} hover:bg-ok-soft active:translate-y-px focus-visible:outline-2 focus-visible:outline-focus`}
          >
            <Icon name="generate" size={14} tone="accent" />
            <Text class="min-w-0 flex-1 truncate text-xs font-medium text-accent">{t("web.library.content.aiGenerate")}</Text>
          </View>
        </SidebarSection>
      </Scroll>
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
      class={rowClass(props.active, props.indent === true)}
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
      <Text class="shrink-0 font-mono text-2xs text-faint tabular-nums">{String(props.count)}</Text>
    </View>
  );
}
