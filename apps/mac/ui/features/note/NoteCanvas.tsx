import { computed, signal, Text, View } from "nsh";
import { Menu, MenuItem, MenuSeparator } from "nsh/base";

import { t } from "@vibevalley/i18n";
import type { BaseRow, BaseRunAgentColumnRequest, BaseUpsertRowRequest, DocBlock, IssueId, Note, NoteId } from "@vibevalley/protocol";

import { createAct } from "../../design/act";
import { Icon } from "../../design/Icon";
import { IconButton } from "../../design/IconButton";
import { Banner, Empty } from "../../design/layout";
import { motionClass, popupTransition } from "../../design/motion";
import { toast } from "../../design/toasts";
import { api, newSendKey, reasonOf } from "../../infra/api";
import { useBoardSlice } from "../../infra/frame";
import { currentHost } from "../../infra/host";
import { ready, useQuery, useQueryClient } from "../../infra/query";
import { useRouter } from "../../infra/router";
import { BlockDocView } from "./BlockDocView";
import { InstallAppletModal, useInstalledNoteApplet } from "./InstallAppletModal";
import { kindLabel, noteHref, noteIcon, useNote, useNotes } from "./NoteCard";
import { NoteDirectoryView } from "./NoteDirectoryView";
import { presenterHref } from "./slides";
import { createBaseRowPage, noteBaseQuery, noteDocQuery, noteLinksQuery } from "./store";
import { BaseView } from "./views/BaseView";
import { CanvasView } from "./views/CanvasView";
import { MediaView } from "./views/MediaView";

const menuPopupClass = `min-w-44 gap-0.5 rounded-lg border border-line bg-elevated p-1 shadow-float ${motionClass("transition-opacity duration-120 ease-out")}`;
const menuSeparatorClass = "my-1 h-px bg-line";

export function NoteCanvas(props: { readonly id: string; readonly version?: number | undefined; readonly onClose?: (() => void) | undefined }) {
  const router = useRouter();
  const note = useNote(() => props.id);
  const shown = () => ready(note, undefined);
  const pageVersion = () => {
    if (props.version !== undefined) return props.version;
    const v = shown()?.version;
    return v !== undefined && v > 0 ? v : undefined;
  };
  const pageHref = () => `/notes/${encodeURIComponent(props.id)}${(pageVersion() ?? 0) > 0 ? `?v=${pageVersion()}` : ""}`;

  return (
    <View accessibilityLabel={t("web.note.canvas.label")} testID="note-canvas" class="min-h-0 min-w-0 flex-1 border-l border-line bg-page">
      <If when={!shown()}>
        <View class="h-11 shrink-0 flex-row items-center gap-2 border-b border-line bg-page px-3">
          <View class="min-w-0 flex-1" />
          <View class="shrink-0 flex-row items-center gap-1">
            <IconButton icon="open" label={t("web.note.canvas.openPage")} testid="note-canvas-page" onClick={() => router.navigate(pageHref())} />
            <If when={props.onClose}>
              <IconButton icon="close" label={t("web.note.canvas.close")} testid="note-canvas-close" onClick={() => props.onClose?.()} />
            </If>
          </View>
        </View>
      </If>
      <If when={note.error()}>
        <Banner class="m-3">{reasonOf(note.error())}</Banner>
      </If>
      <If when={shown()}>{(n) => <CanvasBody note={n()} version={props.version} pageHref={pageHref()} onClose={props.onClose} />}</If>
      <If when={note.status() === "success" && note.data() === undefined}>
        <Empty icon="notes">{t("web.note.page.gone")}</Empty>
      </If>
    </View>
  );
}

function CanvasBody(props: {
  readonly note: Note;
  readonly version: number | undefined;
  readonly pageHref: string;
  readonly onClose?: (() => void) | undefined;
}) {
  const router = useRouter();
  const queries = useQueryClient();
  const board = useBoardSlice();
  const allNotes = useNotes(() => ({}));
  const installedApplet = useInstalledNoteApplet(() => props.note.id);
  const appletModalOpen = signal(false);
  const showFiles = signal(false);
  const menuOpen = signal(false);
  const savedAt = signal<number | undefined>(undefined);
  const activeSheetId = signal<string | undefined>(undefined);
  const activeViewId = signal<string | undefined>(undefined);
  const act = createAct((msg) => toast(msg, "bad"));

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

  return (
    <>
      <View testID="note-canvas-header" class="h-11 shrink-0 flex-row items-center gap-2 border-b border-line bg-page px-3">
        <View class="size-6 shrink-0 items-center justify-center rounded-md bg-side">
          <Icon name={noteIcon(props.note)} size={14} tone="muted" />
        </View>
        <View class="min-w-0 flex-1 flex-row items-center gap-2 overflow-hidden">
          <Text class="min-w-0 shrink truncate text-sm font-semibold text-ink">{props.note.title}</Text>
          <Text class="shrink-0 truncate text-xs text-muted tabular-nums">
            {[
              kindLabel(props.note),
              ...((props.version ?? props.note.version) > 0 ? [t("web.note.card.version", { version: props.version ?? props.note.version })] : []),
            ].join(" · ")}
          </Text>
        </View>
        <View class="shrink-0 flex-row items-center gap-1">
          <IconButton icon="open" label={t("web.note.canvas.openPage")} testid="note-canvas-page" onClick={() => router.navigate(props.pageHref)} />
          <If when={props.onClose}>
            <IconButton icon="close" label={t("web.note.canvas.close")} testid="note-canvas-close" onClick={() => props.onClose?.()} />
          </If>
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
                testID="note-canvas-more"
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
            <If when={currentHost().applet !== undefined}>
              <>
                <MenuSeparator class={menuSeparatorClass} />
                <If
                  when={installedApplet()}
                  else={
                    <MenuItem
                      testID="note-canvas-install-applet"
                      onSelect={() => appletModalOpen.set(true)}
                      class="h-7 flex-row items-center gap-2 rounded-md px-2 hover:bg-hover focus:bg-hover"
                    >
                      <Icon name="download" size={14} tone="muted" />
                      <Text class="min-w-0 flex-1 truncate text-sm text-ink">{t("web.note.applet.button")}</Text>
                    </MenuItem>
                  }
                >
                  <>
                    <MenuItem
                      testID="note-canvas-open-applet"
                      onSelect={() => {
                        void currentHost()
                          .applet?.open(props.note.id)
                          .catch(() => undefined);
                      }}
                      class="h-7 flex-row items-center gap-2 rounded-md px-2 hover:bg-hover focus:bg-hover"
                    >
                      <Icon name="open" size={14} tone="muted" />
                      <Text class="min-w-0 flex-1 truncate text-sm text-ink">{t("web.note.applet.openApp")}</Text>
                    </MenuItem>
                    <MenuItem
                      testID="note-canvas-install-applet"
                      onSelect={() => appletModalOpen.set(true)}
                      class="h-7 flex-row items-center gap-2 rounded-md px-2 hover:bg-hover focus:bg-hover"
                    >
                      <Icon name="settings" size={14} tone="accent" />
                      <Text class="min-w-0 flex-1 truncate text-sm text-ink">{t("web.note.applet.manageApp")}</Text>
                      <Icon name="check" size={12} tone="accent" />
                    </MenuItem>
                  </>
                </If>
              </>
            </If>
          </Menu>
        </View>
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

      <InstallAppletModal open={appletModalOpen()} note={props.note} onClose={() => appletModalOpen.set(false)} />
    </>
  );
}
