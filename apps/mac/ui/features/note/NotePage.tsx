import { computed, effect, keymap, signal, Text, View, type JSX } from "nsh";
import { Menu, MenuItem, MenuSeparator } from "nsh/base";

import { t } from "@vibevalley/i18n";
import {
  type BaseRow,
  type BaseRunAgentColumnRequest,
  type BaseUpsertRowRequest,
  type DocBlock,
  type IssueId,
  type Note,
  NOTE_TYPES,
  type NoteId,
  type NoteType,
  type Suggestion,
  type SuggestionId,
} from "@vibevalley/protocol";
import { noteId } from "@vibevalley/protocol/schema";

import { createAct } from "../../design/act";
import { Button } from "../../design/Button";
import { Dialog } from "../../design/Dialog";
import { Icon } from "../../design/Icon";
import { IconButton } from "../../design/IconButton";
import { Banner, Empty } from "../../design/layout";
import { motionClass, popupTransition } from "../../design/motion";
import { SkeletonBar, SkeletonLines, useDelayedBusy } from "../../design/Skeleton";
import { toast } from "../../design/toasts";
import { api, newSendKey, reasonOf } from "../../infra/api";
import { Keyed } from "../../infra/base/dom";
import { useBoardSlice } from "../../infra/frame";
import { currentHost } from "../../infra/host";
import { ready, useQuery, useQueryClient } from "../../infra/query";
import { useRouter, useSearch } from "../../infra/router";
import { activeNoteType, contentSidebarOpen, isPinned, openTemplatePicker, togglePinned } from "../../infra/state/contentNav";
import { BlockDocView } from "./BlockDocView";
import { CollabToolbar } from "./CollabToolbar";
import { HistoryPanel } from "./HistoryPanel";
import { InstallAppletModal, useInstalledNoteApplet } from "./InstallAppletModal";
import { kindLabel, noteHref, noteIcon, noteTypeIcon, noteTypeLabel, useNote, useNotes } from "./NoteCard";
import { NoteDirectoryView } from "./NoteDirectoryView";
import { PageTree } from "./PageTree";
import { presenterHref } from "./slides";
import {
  createBaseRowPage,
  createTypedNote,
  exportNoteDirectory,
  noteBaseQuery,
  noteDocQuery,
  noteLinksQuery,
  useNotePresence,
  useNoteSuggestions,
  useReportViewContext,
} from "./store";
import { BaseView } from "./views/BaseView";
import { CanvasView } from "./views/CanvasView";
import { MediaView } from "./views/MediaView";

export type NoteChat = (props: {
  channel?: string | undefined;
  issue?: string | undefined;
  point?: number | undefined;
  onClose?: (() => void) | undefined;
}) => JSX.Element;

const menuPopupClass = `min-w-48 gap-0.5 rounded-lg border border-line bg-elevated p-1 shadow-float ${motionClass("transition-opacity duration-120 ease-out")}`;
const menuItemClass = "h-7 flex-row items-center gap-2 rounded-md px-2 hover:bg-hover focus:bg-hover";
const menuSeparatorClass = "my-1 h-px bg-line";

function NoteSkeleton() {
  return (
    <View testID="note-skeleton" accessibilityState={{ busy: true }} class="min-h-0 flex-1 bg-page">
      <View class="h-11 flex-row items-center gap-2 border-b border-line px-4">
        <SkeletonBar class="h-4 w-48 rounded-sm" />
      </View>
      <View class="mx-auto w-full max-w-3xl gap-4 px-6 py-7">
        <SkeletonBar class="h-7 w-64 rounded-md" />
        <SkeletonLines rows={["92%", "78%", "85%", "60%", "88%", "45%"]} gap="md" />
      </View>
    </View>
  );
}

/** Main workspace route for `/notes` and `/notes/:id`. */
export function NotePage(props: { rest: string; chat: NoteChat }) {
  const router = useRouter();
  const search = useSearch();
  const queries = useQueryClient();
  const act = createAct((msg) => toast(msg, "bad"));

  const treeOpen = signal(true);
  const notesRes = useNotes(() => ({}));
  const notesList = computed(() => ready(notesRes, []));

  const selectedId = computed((): NoteId | undefined => {
    const clean = props.rest.replace(/^\/+|\/+$/gu, "");
    const first = clean.split("/")[0]?.trim();
    return first ? noteId(first) : undefined;
  });

  const versionParam = computed((): number | undefined => {
    const raw = Number(search().get("v"));
    return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : undefined;
  });

  const createQuick = async (noteType: NoteType) => {
    const made = await act.run(() => createTypedNote(noteType, noteTypeLabel(noteType)));
    if (!made) return;
    void queries.invalidate({ prefix: ["notes"] });
    router.navigate(noteHref(made.id));
  };

  return (
    <View testID="notes" class="h-full min-h-0 min-w-0 flex-1 flex-row overflow-hidden bg-page">
      <If when={treeOpen()}>
        <PageTree
          notes={notesList()}
          activeId={selectedId()}
          onSelect={(id) => router.navigate(noteHref(id))}
          onCreated={(n) => router.navigate(noteHref(n.id))}
          onMoved={(n) => router.navigate(noteHref(n.id))}
        />
      </If>

      <View class="min-h-0 min-w-0 flex-1">
        <If
          when={selectedId()}
          else={
            <View class="min-h-0 flex-1">
              <View desktop={{ windowDrag: true }} class="h-11 shrink-0 flex-row items-center gap-2 border-b border-line bg-page px-3">
                <If when={!contentSidebarOpen.get()}>
                  <IconButton
                    icon="sidebar"
                    size={16}
                    label={t("web.library.content.sidebarToggle")}
                    testid="content-sidebar-toggle"
                    onClick={() => contentSidebarOpen.set(true)}
                  />
                </If>
                <IconButton
                  icon="folder"
                  size={16}
                  label={t("web.note.tree.title")}
                  testid="note-tree-toggle"
                  pressed={treeOpen()}
                  onClick={() => treeOpen.set(!treeOpen())}
                />
                <Text class="text-sm font-semibold text-ink">{t("web.note.page.all")}</Text>
              </View>
              <View class="flex-1 items-center justify-center p-8">
                <View class="max-w-md items-center gap-4">
                  <Empty icon="notes">{t("web.note.page.none")}</Empty>
                  <View class="flex-row flex-wrap items-center justify-center gap-2">
                    <Each of={NOTE_TYPES} key={(nt) => nt}>
                      {(nt) => (
                        <Button size="compact" icon={noteTypeIcon[nt()]} disabled={act.busy()} onPress={() => void createQuick(nt())}>
                          {noteTypeLabel(nt())}
                        </Button>
                      )}
                    </Each>
                    <Button tone="primary" size="compact" icon="add" onPress={() => openTemplatePicker("recommended")}>
                      {t("web.library.content.templates.title")}
                    </Button>
                  </View>
                </View>
              </View>
            </View>
          }
        >
          {(id) => (
            <Keyed key={id()}>
              {() => (
                <NoteDetailSlot
                  id={id()}
                  versionParam={versionParam()}
                  notes={notesList()}
                  treeOpen={treeOpen()}
                  onToggleTree={() => treeOpen.set(!treeOpen())}
                  chat={props.chat}
                />
              )}
            </Keyed>
          )}
        </If>
      </View>
    </View>
  );
}

function NoteDetailSlot(props: {
  id: NoteId;
  versionParam: number | undefined;
  notes: readonly Note[];
  treeOpen: boolean;
  onToggleTree: () => void;
  chat: NoteChat;
}) {
  const router = useRouter();
  const noteRes = useNote(() => props.id);
  const busy = useDelayedBusy(() => noteRes.status() === "pending");

  const loaded = computed(() => ready(noteRes, undefined));
  const failedReason = computed(() => (noteRes.error() !== undefined ? reasonOf(noteRes.error()) : undefined));

  effect(() => {
    const n = loaded();
    if (n !== undefined) activeNoteType.set(n.noteType);
  });

  return (
    <If
      when={loaded()}
      else={
        <If
          when={failedReason()}
          else={
            <If when={busy()}>
              <NoteSkeleton />
            </If>
          }
        >
          {() => (
            <View class="min-h-0 flex-1 items-center justify-center bg-page p-6">
              <View class="items-center gap-3">
                <Empty icon="notes">{t("web.note.page.gone")}</Empty>
                <Button testID="note-back-library" size="compact" onPress={() => router.navigate("/library")}>
                  {t("web.note.page.backToLibrary")}
                </Button>
              </View>
            </View>
          )}
        </If>
      }
    >
      {(note) => (
        <NoteDetailView
          note={note()}
          versionParam={props.versionParam}
          notes={props.notes}
          treeOpen={props.treeOpen}
          onToggleTree={props.onToggleTree}
          chat={props.chat}
        />
      )}
    </If>
  );
}

function NoteDetailView(props: {
  note: Note;
  versionParam: number | undefined;
  notes: readonly Note[];
  treeOpen: boolean;
  onToggleTree: () => void;
  chat: NoteChat;
}) {
  const queries = useQueryClient();
  const router = useRouter();
  const board = useBoardSlice();
  const act = createAct((msg) => toast(msg, "bad"));

  const showFiles = signal(false);
  const historyOpen = signal(false);
  const railOpen = signal(false);
  const menuOpen = signal(false);
  const appletOpen = signal(false);
  const deleteOpen = signal(false);
  const savedAt = signal<number | undefined>(undefined);
  const activeSheetId = signal<string | undefined>(undefined);
  const activeViewId = signal<string | undefined>(undefined);

  const effectiveVersion = computed((): number | undefined => {
    const v = props.versionParam;
    return v !== undefined && v > 0 && v < props.note.version ? v : undefined;
  });
  const isHistorical = computed(() => effectiveVersion() !== undefined);
  const displayVersion = computed(() => effectiveVersion() ?? props.note.version);
  const historicalBannerText = computed(() => {
    const v = effectiveVersion();
    if (v === undefined) return "";
    const meta = props.note.versions.find((item) => item.version === v);
    const note = meta?.note ? ` — ${meta.note}` : "";
    return t("web.note.timeline.versionBanner", { version: v, note });
  });

  const installedApplet = useInstalledNoteApplet(() => props.note.id);
  const suggestions = useNoteSuggestions(() => props.note.id);
  const presence = useNotePresence(() => props.note.id, { enabled: () => !isHistorical() });
  const topSuggestion = computed((): Suggestion | undefined => (!isHistorical() ? suggestions.open()[0] : undefined));

  effect(() => {
    const sug = topSuggestion();
    if (!sug) return;
    return keymap.bind(
      {
        tab: () => void suggestions.accept(sug.id),
        escape: () => void suggestions.reject(sug.id),
      },
      { when: "notEditing" },
    );
  });

  useReportViewContext(
    () => props.note.id,
    () => ({
      noteType: props.note.noteType,
      title: props.note.title,
      activeTab: showFiles() ? "files" : "preview",
      ...(displayVersion() > 0 ? { version: displayVersion() } : {}),
    }),
  );

  const docView = useQuery(() => noteDocQuery(props.note.id), {
    enabled: () => props.note.noteType === "doc",
  });
  const links = useQuery(() => noteLinksQuery(props.note.id));
  const baseSnap = useQuery(() => noteBaseQuery({ id: props.note.id, sheetId: activeSheetId(), viewId: activeViewId() }), {
    enabled: () => props.note.noteType === "base",
  });

  const issuesList = computed(() => board()?.issues ?? []);
  const pinned = computed(() => isPinned(`note:${props.note.id}`));

  const saveDoc = async (doc: { readonly version: number; readonly blocks: readonly DocBlock[] }) => {
    await act.run(async () => {
      const payload = `${JSON.stringify(doc, null, 2)}\n`;
      await api.note.file.write({
        id: props.note.id,
        files: [{ path: "structure/doc.json", content: payload, mime: "application/json" }],
        summary: "Edit document",
      });
      savedAt.set(Date.now());
      void queries.invalidate({ prefix: ["note-doc", props.note.id] });
      void queries.invalidate({ prefix: ["note-links", "note", props.note.id] });
    });
  };

  const appendBlock = async (block: DocBlock, afterBlockId?: string) => {
    await act.run(async () => {
      await api.note.doc.appendBlock({
        id: props.note.id,
        block,
        ...(afterBlockId !== undefined ? { afterBlockId } : {}),
      });
      savedAt.set(Date.now());
      void queries.invalidate({ prefix: ["note-doc", props.note.id] });
    });
  };

  const createIssueFromBlock = async (title: string): Promise<IssueId | undefined> =>
    act.run(async () => {
      const made = await api.issue.create({
        title,
        description: `${kindLabel(props.note)} · ${noteHref(props.note.id)}`,
        requestKey: newSendKey(),
      });
      toast(t("web.library.content.issueCreated"));
      return made.id;
    });

  const upsertRow = async (req: BaseUpsertRowRequest) => {
    await act.run(async () => {
      await api.note.base.upsertRow(req);
      void queries.invalidate({ prefix: ["note-base", props.note.id] });
    });
  };

  const runAgentColumn = async (req: BaseRunAgentColumnRequest) =>
    act.run(async () => {
      const res = await api.note.base.runAgentColumn(req);
      toast(t("web.note.base.agentRanToast", { n: res.executed }));
      void queries.invalidate({ prefix: ["note-base", props.note.id] });
      return res;
    });

  const createPageForRow = async (row: BaseRow): Promise<NoteId | undefined> =>
    act.run(async () => {
      const createdId = await createBaseRowPage(props.note, row, activeSheetId());
      void queries.invalidate({ prefix: ["notes"] });
      void queries.invalidate({ prefix: ["note-base", props.note.id] });
      return createdId;
    });

  const saveVersion = () => {
    void act.run(async () => {
      const updated = await api.note.version.create({ id: props.note.id });
      toast(t("web.note.edit.saved", { version: updated.version }));
      void queries.invalidate({ prefix: ["notes"] });
      router.navigate(noteHref(props.note.id));
    });
  };

  const createLinkedIssue = () => {
    void act.run(async () => {
      const made = await api.issue.create({
        title: props.note.title,
        description: `${kindLabel(props.note)} · ${noteHref(props.note.id)}`,
        requestKey: newSendKey(),
      });
      await api.note.update({ id: props.note.id, issue: made.id });
      void queries.invalidate({ prefix: ["notes"] });
      toast(t("web.library.content.issueCreated"));
    });
  };

  const confirmDelete = () => {
    void act.run(async () => {
      const title = props.note.title;
      await api.note.delete({ id: props.note.id });
      deleteOpen.set(false);
      void queries.invalidate({ prefix: ["notes"] });
      toast(t("web.note.page.deleted", { title }));
      router.navigate("/library");
    });
  };

  const openStandaloneApplet = () => {
    const applet = currentHost().applet;
    const info = installedApplet();
    if (!applet || !info) return;
    void applet.open(props.note.id).then(
      () => toast(t("web.note.applet.openedToast", { name: info.appName })),
      (e) => toast(reasonOf(e), "bad"),
    );
  };

  return (
    <View class="h-full min-h-0 min-w-0 flex-1 bg-page">
      <View testID="note-header" desktop={{ windowDrag: true }} class="h-11 shrink-0 flex-row items-center gap-2 border-b border-line bg-page px-3">
        <If when={!contentSidebarOpen.get()}>
          <IconButton
            icon="sidebar"
            size={16}
            label={t("web.library.content.sidebarToggle")}
            testid="content-sidebar-toggle"
            onClick={() => contentSidebarOpen.set(true)}
          />
        </If>
        <IconButton
          icon="folder"
          size={16}
          label={t("web.note.tree.title")}
          testid="note-tree-toggle"
          pressed={props.treeOpen}
          onClick={() => props.onToggleTree()}
        />
        <View class="size-6 shrink-0 items-center justify-center rounded-sm bg-side">
          <Icon name={noteIcon(props.note)} size={13} tone="muted" />
        </View>
        <Text testID="note-title" class="min-w-0 flex-1 truncate text-sm font-semibold text-ink">
          {props.note.title}
        </Text>

        <View class="h-5 shrink-0 items-center justify-center rounded-sm bg-selected px-1.5">
          <Text class="text-2xs font-medium text-ink">{kindLabel(props.note)}</Text>
        </View>
        <View testID="note-version-badge" class="h-5 shrink-0 items-center justify-center rounded-sm border border-line bg-side px-1.5">
          <Text class="font-mono text-2xs font-medium text-muted tabular-nums">
            {displayVersion() > 0 ? t("web.note.card.version", { version: displayVersion() }) : t("web.note.page.liveVersion")}
          </Text>
        </View>
        <If when={isHistorical()}>
          <Button testID="note-version-back-live" size="compact" onPress={() => router.navigate(noteHref(props.note.id))}>
            {t("web.note.timeline.backToLive")}
          </Button>
        </If>

        <CollabToolbar
          note={props.note}
          peers={presence.peers()}
          suggestions={suggestions.open()}
          onAcceptSuggestion={(sid: SuggestionId) => void suggestions.accept(sid)}
          onRejectSuggestion={(sid: SuggestionId) => void suggestions.reject(sid)}
          onToggleHistory={() => historyOpen.set(!historyOpen())}
          onToggleFiles={() => showFiles.set(!showFiles())}
        />

        <If when={installedApplet()}>
          {(info) => (
            <Button testID="note-open-applet" size="compact" icon="play" onPress={() => openStandaloneApplet()}>
              {info().appName}
            </Button>
          )}
        </If>
        <If when={currentHost().applet !== undefined && !installedApplet()}>
          <IconButton icon="devices" size={16} label={t("web.note.applet.button")} testid="note-install-applet" onClick={() => appletOpen.set(true)} />
        </If>

        <IconButton
          icon="clock"
          size={16}
          label={t("web.note.timeline.title")}
          testid="note-history-toggle"
          pressed={historyOpen()}
          onClick={() => historyOpen.set(!historyOpen())}
        />
        <IconButton
          icon="chat"
          size={16}
          label={railOpen() ? t("web.note.page.railHide") : t("web.note.page.railShow")}
          testid="note-rail-toggle"
          pressed={railOpen()}
          onClick={() => railOpen.set(!railOpen())}
        />

        <Menu
          open={menuOpen()}
          onOpenChange={(e) => menuOpen.set(e.open)}
          placement="bottom"
          align="end"
          offset={4}
          popupClass={menuPopupClass}
          popupStartingClass={popupTransition("opacity-0")}
          popupEndingClass={popupTransition("opacity-0")}
          trigger={
            <View
              role="button"
              testID="note-more"
              accessibilityLabel={t("web.note.page.more")}
              class="size-7 shrink-0 items-center justify-center rounded-md hover:bg-hover aria-expanded:bg-selected"
            >
              <Icon name="more" size={16} tone="muted" />
            </View>
          }
        >
          <MenuItem testID="note-view-mode" onSelect={() => showFiles.set(!showFiles())} class={menuItemClass}>
            <Icon name={showFiles() ? "show" : "folder"} size={14} tone="muted" />
            <Text class="min-w-0 flex-1 truncate text-sm text-ink">{showFiles() ? t("web.note.page.previewTab") : t("web.note.page.filesTab")}</Text>
          </MenuItem>
          <If when={props.note.noteType === "doc"}>
            <MenuItem
              testID="note-open-presenter"
              onSelect={() => router.navigate(presenterHref({ id: props.note.id, version: effectiveVersion() }))}
              class={menuItemClass}
            >
              <Icon name="present" size={14} tone="muted" />
              <Text class="min-w-0 flex-1 truncate text-sm text-ink">{t("web.note.doc.slidesCount", { n: ready(docView, undefined)?.slideCount ?? 0 })}</Text>
            </MenuItem>
          </If>
          <MenuItem testID="note-save-version" onSelect={() => saveVersion()} class={menuItemClass}>
            <Icon name="check" size={14} tone="muted" />
            <Text class="min-w-0 flex-1 truncate text-sm text-ink">{t("web.note.edit.save")}</Text>
          </MenuItem>
          <MenuItem testID="note-pin" onSelect={() => togglePinned(`note:${props.note.id}`)} class={menuItemClass}>
            <Icon name="pin" size={14} tone={pinned() ? "wheat" : "muted"} />
            <Text class="min-w-0 flex-1 truncate text-sm text-ink">{pinned() ? t("web.library.content.unpin") : t("web.library.content.pin")}</Text>
          </MenuItem>
          <MenuItem
            testID="note-export"
            onSelect={() => void exportNoteDirectory(props.note, effectiveVersion()).catch((e) => toast(reasonOf(e), "bad"))}
            class={menuItemClass}
          >
            <Icon name="download" size={14} tone="muted" />
            <Text class="min-w-0 flex-1 truncate text-sm text-ink">{t("web.library.content.exportArtifact")}</Text>
          </MenuItem>
          <MenuItem testID="note-issue" onSelect={() => createLinkedIssue()} class={menuItemClass}>
            <Icon name="issues" size={14} tone="muted" />
            <Text class="min-w-0 flex-1 truncate text-sm text-ink">{t("web.library.content.turnIntoIssue")}</Text>
          </MenuItem>
          <If when={currentHost().applet !== undefined}>
            <MenuItem testID="note-manage-applet" onSelect={() => appletOpen.set(true)} class={menuItemClass}>
              <Icon name="devices" size={14} tone="muted" />
              <Text class="min-w-0 flex-1 truncate text-sm text-ink">{installedApplet() ? t("web.note.applet.manageApp") : t("web.note.applet.button")}</Text>
            </MenuItem>
          </If>
          <MenuSeparator class={menuSeparatorClass} />
          <MenuItem
            testID="note-delete"
            onSelect={() => deleteOpen.set(true)}
            class="h-7 flex-row items-center gap-2 rounded-md px-2 hover:bg-bad-soft focus:bg-bad-soft"
          >
            <Icon name="delete" size={14} tone="berry" />
            <Text class="min-w-0 flex-1 truncate text-sm text-berry">{t("web.note.page.delete")}</Text>
          </MenuItem>
        </Menu>
      </View>

      <If when={isHistorical()}>
        <Banner testID="note-version-banner" icon="clock">
          {historicalBannerText()}
        </Banner>
      </If>

      <If when={topSuggestion()}>
        {(sug) => (
          <View testID="note-inline-suggestion" class="shrink-0 flex-row items-center justify-between gap-2 border-b border-line bg-warn-soft px-3 py-1.5">
            <View class="min-w-0 flex-1 flex-row items-center gap-2">
              <Icon name="edit" size={13} tone="warn-ink" />
              <Text class="shrink-0 text-xs font-semibold text-warn-ink">{t("web.note.suggestions.by", { name: sug().author })}</Text>
              <Text class="shrink-0 font-mono text-2xs text-muted">{sug().path}</Text>
              <Text class="min-w-0 flex-1 truncate text-xs text-ink">
                {sug().change.summary ?? (sug().change.delete === true ? t("web.note.suggestions.delete") : (sug().change.content ?? sug().change.patch ?? ""))}
              </Text>
            </View>
            <View class="shrink-0 flex-row items-center gap-1.5">
              <Button size="compact" tone="quiet" testID="inline-suggestion-reject" onPress={() => void suggestions.reject(sug().id)}>
                {t("web.note.suggestions.reject")}
              </Button>
              <Button size="compact" tone="primary" testID="inline-suggestion-accept" onPress={() => void suggestions.accept(sug().id)}>
                {t("web.note.suggestions.accept")}
              </Button>
            </View>
          </View>
        )}
      </If>

      <View class="min-h-0 min-w-0 flex-1 flex-row">
        <View class="min-h-0 min-w-0 flex-1">
          <If
            when={showFiles()}
            else={
              <>
                <If when={props.note.noteType === "doc"}>
                  <BlockDocView
                    note={props.note}
                    docView={ready(docView, undefined)}
                    notes={props.notes}
                    issues={issuesList()}
                    links={ready(links, undefined)}
                    busy={act.busy()}
                    savedAt={savedAt()}
                    onSaveDoc={saveDoc}
                    onAppendBlock={appendBlock}
                    onRenameTitle={(title: string) => api.note.update({ id: props.note.id, title }).then(() => void queries.invalidate({ prefix: ["notes"] }))}
                    onCreateIssueFromBlock={createIssueFromBlock}
                    onOpenNote={(nid: NoteId) => router.navigate(noteHref(nid))}
                    onOpenIssue={(iid: IssueId) => router.navigate(`/issues/${encodeURIComponent(iid)}`)}
                    onOpenPresenter={() => router.navigate(presenterHref({ id: props.note.id, version: effectiveVersion() }))}
                  />
                </If>
                <If when={props.note.noteType === "base"}>
                  <BaseView
                    note={props.note}
                    snapshot={ready(baseSnap, undefined)}
                    notes={props.notes}
                    issues={issuesList()}
                    activeSheetId={activeSheetId()}
                    activeViewId={activeViewId()}
                    busy={act.busy()}
                    onSelectView={(sid: string, vid: string | undefined) => {
                      activeSheetId.set(sid);
                      activeViewId.set(vid);
                    }}
                    onUpsertRow={upsertRow}
                    onRunAgentColumn={runAgentColumn}
                    onOpenNote={(nid: NoteId) => router.navigate(noteHref(nid))}
                    onOpenIssue={(iid: IssueId) => router.navigate(`/issues/${encodeURIComponent(iid)}`)}
                    onCreatePageForRow={createPageForRow}
                  />
                </If>
                <If when={props.note.noteType === "canvas"}>
                  <CanvasView note={props.note} onRefresh={() => void queries.invalidate({ prefix: ["notes"] })} onOpenChat={() => railOpen.set(true)} />
                </If>
                <If when={props.note.noteType === "media"}>
                  <MediaView note={props.note} onOpenIssue={(iid: IssueId) => router.navigate(`/issues/${encodeURIComponent(iid)}`)} />
                </If>
              </>
            }
          >
            <NoteDirectoryView noteId={props.note.id} onOpenNote={(nid: NoteId) => router.navigate(noteHref(nid))} />
          </If>
        </View>

        <HistoryPanel
          noteId={props.note.id}
          open={historyOpen()}
          onClose={() => historyOpen.set(false)}
          onChanged={() => {
            void queries.invalidate({ prefix: ["notes"] });
            void queries.invalidate({ prefix: ["note-doc", props.note.id] });
            void queries.invalidate({ prefix: ["note-base", props.note.id] });
          }}
        />

        <If when={railOpen()}>
          <View testID="note-rail" accessibilityLabel={t("web.note.page.rail")} class="h-full w-84 shrink-0 border-l border-line bg-side">
            <props.chat channel={props.note.channel} issue={props.note.issue} point={props.note.said?.number} onClose={() => railOpen.set(false)} />
          </View>
        </If>
      </View>

      <InstallAppletModal open={appletOpen()} note={props.note} onClose={() => appletOpen.set(false)} />

      <Dialog open={deleteOpen()} onClose={() => deleteOpen.set(false)} title={t("web.note.page.delete")} testid="note-delete-dialog">
        <View class="gap-4">
          <Text class="text-sm text-ink">{t("web.note.page.deleteAsk", { title: props.note.title })}</Text>
          <View class="flex-row justify-end gap-2">
            <Button size="compact" onPress={() => deleteOpen.set(false)}>
              {t("web.note.page.discard")}
            </Button>
            <Button testID="note-delete-sure" tone="danger" size="compact" disabled={act.busy()} onPress={() => confirmDelete()}>
              {t("web.note.page.delete")}
            </Button>
          </View>
        </View>
      </Dialog>
    </View>
  );
}
