import { computed, signal, Text, View } from "nsh";
import { Menu, MenuItem } from "nsh/base";

import { t } from "@vibevalley/i18n";
import type { BaseRow, BaseRunAgentColumnRequest, BaseUpsertRowRequest, DocBlock, IssueId, Note, NoteId } from "@vibevalley/protocol";

import { createAct } from "../../design/act";
import { Icon } from "../../design/Icon";
import { Banner, Empty } from "../../design/layout";
import { motionClass, popupTransition } from "../../design/motion";
import { SkeletonBar, SkeletonLines, useDelayedBusy } from "../../design/Skeleton";
import { toast } from "../../design/toasts";
import { api, newSendKey, reasonOf } from "../../infra/api";
import { useBoardSlice } from "../../infra/frame";
import { ready, useQuery, useQueryClient } from "../../infra/query";
import { useRouter, useSearch } from "../../infra/router";
import { BlockDocView } from "./BlockDocView";
import { kindLabel, noteHref, noteIcon, useNote, useNotes } from "./NoteCard";
import { NoteDirectoryView } from "./NoteDirectoryView";
import { presenterHref } from "./slides";
import { createBaseRowPage, noteBaseQuery, noteDocQuery, noteLinksQuery } from "./store";
import { BaseView } from "./views/BaseView";
import { CanvasView } from "./views/CanvasView";
import { MediaView } from "./views/MediaView";

const menuPopupClass = `min-w-44 gap-0.5 rounded-lg border border-line bg-elevated p-1 shadow-float ${motionClass("transition-opacity duration-120 ease-out")}`;

function StandaloneNoteSkeleton() {
  return (
    <View testID="standalone-note-skeleton" accessibilityState={{ busy: true }} class="min-h-0 flex-1 bg-page">
      <View class="mx-auto w-full max-w-3xl gap-4 px-6 py-7">
        <SkeletonBar class="h-7 w-64 rounded-md" />
        <SkeletonLines rows={["92%", "78%", "85%", "60%", "88%", "45%"]} gap="md" />
      </View>
    </View>
  );
}

/** Chromeless standalone note surface rendered at `/standalone/note/:id` for local macOS applets. */
export function StandaloneNotePage(props: { id: string }) {
  const note = useNote(() => props.id);
  const search = useSearch();
  const askedVersion = () => {
    const raw = search().get("v");
    const parsed = raw ? Number(raw) : Number.NaN;
    return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
  };
  const shown = () => ready(note, undefined);
  const displayVersion = () => askedVersion() ?? shown()?.version;
  const showSkeleton = useDelayedBusy(() => shown() === undefined && note.status() !== "error" && note.status() !== "success");

  return (
    <View testID="standalone-note-page" class="h-full min-h-0 min-w-0 flex-1 bg-page">
      <If when={!shown()}>
        <View
          testID="standalone-note-header"
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

      <If when={note.error()}>
        <Banner testID="standalone-note-error" class="m-3">
          {reasonOf(note.error())}
        </Banner>
      </If>

      <If
        when={shown()}
        else={
          <If
            when={note.status() === "error" || (note.status() === "success" && note.data() === undefined)}
            else={
              <If when={showSkeleton()}>
                <StandaloneNoteSkeleton />
              </If>
            }
          >
            <Empty testid="standalone-note-empty" icon="notes">
              {t("web.note.standalone.missing")}
            </Empty>
          </If>
        }
      >
        {(n) => <StandaloneBody note={n()} version={askedVersion()} displayVersion={displayVersion()} />}
      </If>
    </View>
  );
}

function StandaloneBody(props: { note: Note; version: number | undefined; displayVersion: number | undefined }) {
  const router = useRouter();
  const queries = useQueryClient();
  const board = useBoardSlice();
  const allNotes = useNotes(() => ({}));
  const act = createAct((msg) => toast(msg, "bad"));
  const showFiles = signal(false);
  const menuOpen = signal(false);
  const savedAt = signal<number | undefined>(undefined);
  const activeSheetId = signal<string | undefined>(undefined);
  const activeViewId = signal<string | undefined>(undefined);

  const docView = useQuery(() => noteDocQuery(props.note.id), {
    enabled: () => props.note.noteType === "doc",
  });
  const links = useQuery(() => noteLinksQuery(props.note.id), {
    enabled: () => props.note.noteType === "doc",
  });
  const baseSnap = useQuery(() => noteBaseQuery({ id: props.note.id, sheetId: activeSheetId(), viewId: activeViewId() }), {
    enabled: () => props.note.noteType === "base",
  });
  const notesList = computed(() => ready(allNotes, []));
  const issuesList = computed(() => board()?.issues ?? []);

  const saveDoc = async (doc: { readonly version: number; readonly blocks: readonly DocBlock[] }) => {
    await act.run(async () => {
      await api.note.file.write({
        id: props.note.id,
        files: [{ path: "structure/doc.json", content: `${JSON.stringify(doc, null, 2)}\n`, mime: "application/json" }],
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

  const createIssueFromBlock = async (title: string): Promise<IssueId | undefined> => {
    return act.run(async () => {
      const made = await api.issue.create({
        title,
        description: `${kindLabel(props.note)} · ${noteHref(props.note.id)}`,
        requestKey: newSendKey(),
      });
      toast(t("web.library.content.issueCreated"));
      return made.id;
    });
  };

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

  return (
    <View class="min-h-0 min-w-0 flex-1">
      <View
        testID="standalone-note-header"
        desktop={{ windowDrag: true }}
        class="h-11 shrink-0 flex-row items-center gap-2 border-b border-line bg-page pr-3 pl-20"
      >
        <View class="size-5 shrink-0 items-center justify-center rounded-sm bg-side">
          <Icon name={noteIcon(props.note)} size={12} tone="muted" />
        </View>
        <Text testID="standalone-note-title" class="min-w-0 flex-1 truncate text-sm font-semibold text-ink">
          {props.note.title}
        </Text>
        <View testID="standalone-note-type" class="h-5 shrink-0 items-center justify-center rounded-sm bg-selected px-1.5">
          <Text class="text-2xs font-medium text-ink">{kindLabel(props.note)}</Text>
        </View>
        <View testID="standalone-note-version" class="h-5 shrink-0 items-center justify-center rounded-sm border border-line bg-side px-1.5">
          <Text class="font-mono text-2xs font-medium text-muted tabular-nums">
            {(props.displayVersion ?? 0) > 0 ? t("web.note.standalone.version", { version: props.displayVersion ?? 0 }) : t("web.note.standalone.live")}
          </Text>
        </View>
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
              testID="standalone-note-more"
              accessibilityLabel={t("web.note.page.more")}
              class="size-7 shrink-0 items-center justify-center rounded-md hover:bg-hover aria-expanded:bg-selected"
            >
              <Icon name="more" size={16} tone="muted" />
            </View>
          }
        >
          <MenuItem
            testID="note-view-mode"
            onSelect={() => showFiles.set(!showFiles())}
            class="h-7 flex-row items-center gap-2 rounded-md px-2 hover:bg-hover focus:bg-hover"
          >
            <Icon name={showFiles() ? "show" : "folder"} size={14} tone="muted" />
            <Text class="min-w-0 flex-1 truncate text-sm text-ink">{showFiles() ? t("web.note.page.previewTab") : t("web.note.page.filesTab")}</Text>
          </MenuItem>
        </Menu>
      </View>

      <View class="min-h-0 min-w-0 flex-1">
        <If
          when={showFiles()}
          else={
            <>
              <If when={props.note.noteType === "doc"}>
                <BlockDocView
                  note={props.note}
                  docView={ready(docView, undefined)}
                  notes={notesList()}
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
                  onOpenPresenter={() => router.navigate(presenterHref({ id: props.note.id, version: props.version }))}
                />
              </If>
              <If when={props.note.noteType === "base"}>
                <BaseView
                  note={props.note}
                  snapshot={ready(baseSnap, undefined)}
                  notes={notesList()}
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
                <CanvasView note={props.note} onRefresh={() => void queries.invalidate({ prefix: ["notes"] })} />
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
    </View>
  );
}
