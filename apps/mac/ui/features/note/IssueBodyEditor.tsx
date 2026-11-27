import { computed, effect, signal, Text, untracked, View } from "nsh";
import { Input } from "nsh/base";

import { t } from "@vibevalley/i18n";
import type { DocBlock, Issue, IssueId, Note, NoteId, Suggestion, SuggestionId } from "@vibevalley/protocol";
import { issueId, noteId } from "@vibevalley/protocol/schema";

import { createAct } from "../../design/act";
import { Button } from "../../design/Button";
import { Icon } from "../../design/Icon";
import { Markdown } from "../../design/Markdown";
import { SkeletonLines } from "../../design/Skeleton";
import { toast } from "../../design/toasts";
import { api, reasonOf } from "../../infra/api";
import { useBoardSlice } from "../../infra/frame";
import { followNote } from "../../infra/gateway";
import { ready, useQuery, useQueryClient } from "../../infra/query";
import { Link as A, useRouter } from "../../infra/router";
import { BlockDocView } from "./BlockDocView";
import { noteHref, useNote, useNotes } from "./NoteCard";
import { NoteLinkPills, resolveDescriptionNoteLinks } from "./NoteLinkPills";
import { noteDocQuery, noteLinksQuery, useNoteSuggestions } from "./store";

export interface IssueBodyEditorProps {
  readonly issue: Issue;
  readonly editable?: boolean | undefined;
  readonly description?: string | undefined;
  readonly notes?: readonly Note[] | undefined;
  readonly onDraftDescription?: ((next: string) => void) | undefined;
  readonly onOpenNote?: ((id: NoteId) => void) | undefined;
  readonly onOpenIssue?: ((id: IssueId) => void) | undefined;
  readonly sectionTitle?: string | undefined;
  readonly emptyLabel?: string | undefined;
  readonly placeholder?: string | undefined;
  readonly testid?: string | undefined;
  readonly bordered?: boolean | undefined;
}

function MaterializedIssueBody(props: {
  readonly noteId: NoteId;
  readonly issue: Issue;
  readonly notes: readonly Note[];
  readonly issues: readonly Issue[];
  readonly fallbackDescription: string;
  readonly sectionTitle: string;
  readonly onOpenNote: (id: NoteId) => void;
  readonly onOpenIssue: (id: IssueId) => void;
}) {
  const queries = useQueryClient();
  const act = createAct((msg) => toast(msg, "bad"));
  const savedAt = signal<number | undefined>(undefined);

  const noteRes = useNote(() => props.noteId);
  const docQuery = useQuery(() => noteDocQuery(props.noteId));
  const linksQuery = useQuery(() => noteLinksQuery(props.noteId));
  const suggestions = useNoteSuggestions(() => props.noteId);

  const loadedNote = computed(() => ready(noteRes, undefined));
  const topSuggestion = computed((): Suggestion | undefined => suggestions.open()[0]);

  effect(() => {
    const nid = String(props.noteId);
    const stop = followNote(nid, 0, (ev) => {
      if (ev._tag === "Reset" || ev.files.some((f) => f.path === "structure/doc.json")) {
        void queries.invalidate({ prefix: ["note-doc", props.noteId] });
        void queries.invalidate({ prefix: ["note-links", "note", props.noteId] });
      }
    });
    return stop;
  });

  const saveDoc = async (doc: { readonly version: number; readonly blocks: readonly DocBlock[] }) => {
    await act.run(async () => {
      const payload = `${JSON.stringify(doc, null, 2)}\n`;
      await api.note.file.write({
        id: props.noteId,
        files: [{ path: "structure/doc.json", content: payload, mime: "application/json" }],
        summary: "Edit issue body",
      });
      savedAt.set(Date.now());
      void queries.invalidate({ prefix: ["note-doc", props.noteId] });
      void queries.invalidate({ prefix: ["note-links", "note", props.noteId] });
    });
  };

  const appendBlock = async (block: DocBlock, afterBlockId?: string) => {
    await act.run(async () => {
      await api.note.doc.appendBlock({
        id: props.noteId,
        block,
        ...(afterBlockId !== undefined ? { afterBlockId } : {}),
      });
      savedAt.set(Date.now());
      void queries.invalidate({ prefix: ["note-doc", props.noteId] });
    });
  };

  const acceptSuggestion = async (sid: SuggestionId) => {
    await act.run(async () => {
      await suggestions.accept(sid);
      void queries.invalidate({ prefix: ["note-doc", props.noteId] });
      void queries.invalidate({ prefix: ["note-links", "note", props.noteId] });
    });
  };

  return (
    <View testID="issue-body-collaborative" class="gap-1.5">
      <View class="flex-row items-center justify-between gap-2">
        <Text class="text-xs font-semibold text-muted">{props.sectionTitle}</Text>
        <A
          href={noteHref(props.noteId)}
          testID="issue-open-body-note"
          class="flex-row items-center gap-1 rounded-md px-1.5 py-0.5 hover:bg-hover focus-visible:outline-2 focus-visible:outline-focus"
        >
          <Icon name="notes" size={12} tone="muted" />
          <Text class="text-2xs font-medium text-muted">{t("web.note.canvas.openPage")}</Text>
        </A>
      </View>

      <If when={topSuggestion()}>
        {(sug) => (
          <View testID="issue-body-suggestion" class="mb-1 flex-row items-center justify-between gap-2 rounded-lg border border-line bg-warn-soft px-3 py-1.5">
            <View class="min-w-0 flex-1 flex-row items-center gap-2">
              <Icon name="edit" size={13} tone="warn-ink" />
              <Text class="shrink-0 text-xs font-semibold text-warn-ink">{t("web.note.suggestions.by", { name: sug().author })}</Text>
              <Text class="min-w-0 flex-1 truncate text-xs text-ink">
                {sug().change.summary ?? (sug().change.delete === true ? t("web.note.suggestions.delete") : (sug().change.content ?? sug().change.patch ?? ""))}
              </Text>
            </View>
            <View class="shrink-0 flex-row items-center gap-1.5">
              <Button size="compact" tone="quiet" testID="issue-body-suggestion-reject" onPress={() => void suggestions.reject(sug().id)}>
                {t("web.note.suggestions.reject")}
              </Button>
              <Button size="compact" tone="primary" testID="issue-body-suggestion-accept" onPress={() => void acceptSuggestion(sug().id)}>
                {t("web.note.suggestions.accept")}
              </Button>
            </View>
          </View>
        )}
      </If>

      <If
        when={loadedNote()}
        else={
          <If when={noteRes.error() !== undefined && props.fallbackDescription !== ""} else={<SkeletonLines rows={["88%", "64%"]} gap="sm" />}>
            <View testID="issue-description-preview">
              <Markdown size="sm" text={props.fallbackDescription} />
            </View>
          </If>
        }
      >
        {(note) => (
          <BlockDocView
            embedded
            note={note()}
            docView={ready(docQuery, undefined)}
            notes={props.notes}
            issues={props.issues}
            links={ready(linksQuery, undefined)}
            busy={act.busy()}
            savedAt={savedAt()}
            onSaveDoc={saveDoc}
            onAppendBlock={appendBlock}
            onOpenNote={props.onOpenNote}
            onOpenIssue={props.onOpenIssue}
          />
        )}
      </If>
    </View>
  );
}

/**
 * Shared collaborative Issue Body surface backed lazily by a 24-block Doc note (`issue.bodyNoteId`).
 * Renders Markdown preview + click-to-materialize before first edit, and seamlessly switches to
 * embedded Loro co-editing with reviewable agent suggestions once materialized.
 */
export function IssueBodyEditor(props: IssueBodyEditorProps) {
  const router = useRouter();
  const queries = useQueryClient();
  const board = useBoardSlice();

  const ensuredNoteId = signal<NoteId | undefined>(undefined);
  const ensuring = signal(false);
  const fallbackEditing = signal(false);

  const ownNotes = useNotes(() => ({}));
  const allNotes = computed(() => props.notes ?? ready(ownNotes, []));
  const allIssues = computed(() => board()?.issues ?? []);

  let activeIssueId = untracked(() => props.issue.id);
  effect(() => {
    const nextId = props.issue.id;
    if (nextId !== activeIssueId) {
      activeIssueId = nextId;
      ensuredNoteId.set(undefined);
      fallbackEditing.set(false);
    }
  });

  const effectiveNoteId = computed(() => props.issue.bodyNoteId ?? ensuredNoteId());
  const rawDescription = computed(() => props.description ?? props.issue.description);
  const hasDescription = computed(() => rawDescription().trim() !== "");
  const resolved = computed(() => resolveDescriptionNoteLinks(rawDescription(), allNotes()));
  const sectionTitle = computed(() => props.sectionTitle ?? t("web.issue.todo.description"));

  const openNote = (id: NoteId) => {
    if (props.onOpenNote) props.onOpenNote(id);
    else router.navigate(noteHref(id));
  };
  const openIssue = (id: IssueId) => {
    if (props.onOpenIssue) props.onOpenIssue(id);
    else router.navigate(`/issues/${id}`);
  };

  const handleEditPress = async () => {
    if (props.editable === false || ensuring()) return;
    if (effectiveNoteId() !== undefined) return;
    ensuring.set(true);
    try {
      const res = await api.issue.body.ensure({ id: props.issue.id });
      ensuredNoteId.set(res.note.id);
      void queries.invalidate({ prefix: ["note", res.note.id] });
      void queries.invalidate({ prefix: ["note-doc", res.note.id] });
    } catch (err) {
      if (props.onDraftDescription !== undefined) {
        fallbackEditing.set(true);
      } else {
        toast(reasonOf(err), "bad");
      }
    } finally {
      ensuring.set(false);
    }
  };

  return (
    <View testID={props.testid} class={props.bordered === true ? "mt-5 border-t border-line pt-5" : undefined}>
      <If
        when={effectiveNoteId()}
        else={
          <If
            when={fallbackEditing()}
            else={
              <If
                when={hasDescription()}
                else={
                  <If when={props.editable !== false}>
                    <View
                      role="button"
                      testID="issue-edit-description"
                      onPress={() => void handleEditPress()}
                      class="-mx-2 rounded-md px-2 py-2 hover:bg-hover"
                    >
                      <Text class="text-sm text-faint">{props.emptyLabel ?? t("web.issue.todo.addDescription")}</Text>
                    </View>
                  </If>
                }
              >
                <View class="mb-2 flex-row items-center justify-between gap-2">
                  <Text class="text-xs font-semibold text-muted">{sectionTitle()}</Text>
                  <If when={props.editable !== false}>
                    <Button
                      size="compact"
                      tone="quiet"
                      icon="edit"
                      testID="issue-edit-description"
                      disabled={ensuring()}
                      onPress={() => void handleEditPress()}
                    >
                      {t("web.issue.todo.edit")}
                    </Button>
                  </If>
                </View>
                <View testID="issue-description-preview">
                  <Markdown size="sm" text={resolved().markdown} />
                  <NoteLinkPills links={resolved().links} />
                </View>
              </If>
            }
          >
            <View class="mb-2 flex-row items-center justify-between gap-2">
              <Text class="text-xs font-semibold text-muted">{sectionTitle()}</Text>
              <Button size="compact" tone="quiet" icon="check" testID="issue-edit-description-done" onPress={() => fallbackEditing.set(false)}>
                {t("web.issue.todo.doneEditing")}
              </Button>
            </View>
            <Input
              multiline
              autoFocus
              testID="issue-description"
              value={rawDescription()}
              onChange={(e) => props.onDraftDescription?.(e.value)}
              placeholder={props.placeholder ?? t("web.issue.todo.descriptionHint")}
              accessibilityLabel={sectionTitle()}
              class="min-h-22 w-full rounded-md border border-line bg-page px-2.5 py-2 text-sm text-ink placeholder:text-faint focus:border-focus"
            />
          </If>
        }
      >
        {(nid) => (
          <MaterializedIssueBody
            noteId={noteId(nid())}
            issue={props.issue}
            notes={allNotes()}
            issues={allIssues()}
            fallbackDescription={resolved().markdown}
            sectionTitle={sectionTitle()}
            onOpenNote={openNote}
            onOpenIssue={(id) => openIssue(issueId(id))}
          />
        )}
      </If>
    </View>
  );
}
