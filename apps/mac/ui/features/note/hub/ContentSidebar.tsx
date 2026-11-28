import { Scroll, Text, untracked, View, type ViewRef } from "nsh";
import { z } from "zod";

import { t } from "@vibevalley/i18n";
import type { NoteId } from "@vibevalley/protocol";
import { noteId } from "@vibevalley/protocol/schema";

import { Button } from "../../../design/Button";
import { Icon } from "../../../design/Icon";
import { IconButton } from "../../../design/IconButton";
import type { IconName } from "../../../design/icons";
import { ActiveBar } from "../../../design/layout";
import { Bubble } from "../../../design/Tip";
import { libraryQuery } from "../../../infra/libraryQuery";
import { ready, useQuery } from "../../../infra/query";
import { useLocation, useRouter } from "../../../infra/router";
import { createMemo } from "../../../infra/solid";
import {
  activeNoteType,
  type ContentBucket,
  contentBrowseBucket,
  contentSidebarOpen,
  countContentHub,
  openContentSearch,
  openTemplatePicker,
  pinnedKeys,
  templatePickerContextFor,
} from "../../../infra/state/contentNav";
import { defineStored } from "../../../infra/state/stored";
import { isVdpEnabled, useVdpNode } from "../../../infra/vdpProbe";
import { useInstalledApplets } from "../InstallAppletModal";
import { noteHref, noteIcon, useNotes } from "../NoteCard";
import { PageTree } from "../PageTree";

const pinnedSectionOpen = defineStored("content.sidebar.pinned", z.boolean(), true);

const rowClass = (active: boolean) =>
  [
    "relative h-7 flex-row items-center gap-2 rounded-md px-2 focus-visible:outline-2 focus-visible:outline-focus",
    active ? "bg-selected" : "hover:bg-hover",
  ].join(" ");

export function ContentSidebar() {
  const router = useRouter();
  const location = useLocation();

  const notes = useNotes(() => ({}));
  const media = useQuery(() => libraryQuery({ text: "", sort: "recent" }), { interval: () => 10_000, keepPrevious: true });
  const installedApplets = useInstalledApplets();

  const allNotes = createMemo(() => ready(notes, undefined) ?? []);
  const allMedia = createMemo(() => ready(media, undefined) ?? []);
  const installedIds = createMemo(
    () =>
      new Set(
        installedApplets()
          .filter((item) => item.installed)
          .map((item) => item.noteId),
      ),
  );

  const inBrowse = createMemo(() => location().pathname === "/library" || location().pathname.startsWith("/library/"));
  const activeNoteId = createMemo((): NoteId | undefined => {
    const p = location().pathname;
    if (!p.startsWith("/notes/")) return undefined;
    const first = p.slice("/notes/".length).split("/")[0]?.trim();
    return first ? noteId(first) : undefined;
  });
  const bucket = () => contentBrowseBucket();

  const counts = createMemo(() =>
    countContentHub({
      notes: allNotes(),
      media: allMedia(),
      pinned: new Set(pinnedKeys()),
      installedNoteIds: installedIds(),
    }),
  );

  const pinnedNotes = createMemo(() => {
    const pinnedSet = new Set(pinnedKeys());
    return allNotes().filter((n) => pinnedSet.has(`note:${n.id}`));
  });

  const openLibrary = (next: ContentBucket = { kind: "recent" }) => {
    contentBrowseBucket.set(next);
    if (!inBrowse()) router.navigate("/library");
  };

  return (
    <View testID="content-sidebar" accessibilityLabel={t("web.library.content.title")} class="h-full w-60 shrink-0 border-r border-line bg-side">
      <View desktop={{ windowDrag: true }} class="h-11 shrink-0 flex-row items-center gap-1.5 border-b border-line px-2.5">
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
        <IconButton
          icon="search"
          size={16}
          label={`${t("web.library.content.searchAll")} (⌘F)`}
          testid="content-search-btn"
          onClick={() => openContentSearch()}
        />
        <Button
          tone="primary"
          size="compact"
          icon="add"
          testID="content-new-btn"
          tooltip={<Bubble text={`${t("web.library.content.new")} (⌘N)`} />}
          onPress={() => openTemplatePicker(templatePickerContextFor(bucket(), inBrowse() ? undefined : activeNoteType()))}
        >
          {t("web.library.content.new")}
        </Button>
      </View>

      <Scroll class="min-h-0 flex-1" contentClass="gap-2 p-2 pb-4">
        <NavRow
          testID="content-nav-notes-all"
          icon="catalog"
          label={t("web.library.content.recent")}
          count={counts().total}
          active={inBrowse()}
          onPress={() => openLibrary({ kind: "recent" })}
        />

        <If when={pinnedNotes().length > 0}>
          <View testID="content-pinned-section" class="gap-0.5">
            <View
              role="button"
              testID="content-pinned-toggle"
              accessibilityLabel={t("web.library.content.pinned")}
              accessibilityState={{ expanded: pinnedSectionOpen.get() }}
              onPress={() => pinnedSectionOpen.update((open) => !open)}
              class="h-7 flex-row items-center gap-1.5 rounded-md px-2 hover:bg-hover focus-visible:outline-2 focus-visible:outline-focus"
            >
              <Icon name={pinnedSectionOpen.get() ? "choose" : "expand"} size={12} tone="faint" />
              <Icon name="pin" size={12} tone="wheat" />
              <Text class="min-w-0 flex-1 truncate text-xs font-semibold text-muted">{t("web.library.content.pinned")}</Text>
              <Text class="shrink-0 font-mono text-2xs text-faint tabular-nums">{String(pinnedNotes().length)}</Text>
            </View>
            <If when={pinnedSectionOpen.get()}>
              <View class="gap-0.5">
                <Each of={pinnedNotes()} key={(n) => n.id}>
                  {(n) => {
                    const active = () => activeNoteId() === n().id;
                    return (
                      <View
                        role="button"
                        testID={`content-pinned-note-${n().id}`}
                        accessibilityLabel={n().title}
                        accessibilityState={{ selected: active() }}
                        onPress={() => router.navigate(noteHref(n().id))}
                        class={`relative h-7 flex-row items-center gap-1.5 rounded-md pr-2 pl-5 focus-visible:outline-2 focus-visible:outline-focus ${
                          active() ? "bg-selected" : "hover:bg-hover"
                        }`}
                      >
                        <If when={active()}>
                          <ActiveBar />
                        </If>
                        <Icon name={noteIcon(n())} size={13} tone={active() ? "ink" : "muted"} />
                        <Text class={`min-w-0 flex-1 truncate text-xs font-medium ${active() ? "text-ink" : "text-muted"}`}>{n().title}</Text>
                      </View>
                    );
                  }}
                </Each>
              </View>
            </If>
          </View>
        </If>

        <View class="my-0.5 h-px bg-line" />

        <PageTree
          embedded
          notes={allNotes()}
          activeId={activeNoteId()}
          onSelect={(id) => router.navigate(noteHref(id))}
          onCreated={(n) => router.navigate(noteHref(n.id))}
          onMoved={(n) => router.navigate(noteHref(n.id))}
        />
      </Scroll>
    </View>
  );
}

function NavRow(props: { testID: string; icon: IconName; iconTone?: string | undefined; label: string; count: number; active: boolean; onPress: () => void }) {
  let rowRef: ViewRef | undefined;
  const vdpTestId = untracked(() => props.testID);
  useVdpNode({
    testId: vdpTestId,
    role: "button",
    text: () => props.label,
    getRef: () => rowRef,
    onPress: () => props.onPress(),
  });
  return (
    <View
      ref={
        isVdpEnabled()
          ? (el) => {
              rowRef = el;
            }
          : undefined
      }
      role="button"
      testID={props.testID}
      accessibilityLabel={props.label}
      accessibilityState={{ selected: props.active }}
      onPress={() => props.onPress()}
      class={rowClass(props.active)}
    >
      <If when={props.active}>
        <ActiveBar />
      </If>
      <Icon name={props.icon} size={14} tone={props.iconTone ?? (props.active ? "ink" : "muted")} />
      <Text class={`min-w-0 flex-1 truncate text-sm font-medium ${props.active ? "text-ink" : "text-muted"}`}>{props.label}</Text>
      <If when={props.count > 0}>
        <Text class="shrink-0 font-mono text-2xs text-faint tabular-nums">{String(props.count)}</Text>
      </If>
    </View>
  );
}
