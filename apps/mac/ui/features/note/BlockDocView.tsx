import { cleanup, computed, effect, Image, keymap, Scroll, signal, Text, untracked, View } from "nsh";
import { Input } from "nsh/base";

import { t } from "@vibevalley/i18n";
import type { DocBlock, DocView, Issue, IssueId, Note, NoteId, NoteLink, NoteLinkListResult } from "@vibevalley/protocol";
import { issueId, noteId } from "@vibevalley/protocol/schema";

import { Button } from "../../design/Button";
import { Icon } from "../../design/Icon";
import { Empty } from "../../design/layout";
import { Lightbox, type Picture } from "../../design/Lightbox";
import { useTimeout } from "../../infra/base/timer";
import { BlockItem } from "./doc/BlockItem";
import {
  computeDocStats,
  computeSlideIndices,
  deleteBlockById,
  duplicateBlockById,
  insertBlockAfter,
  makeBlockId,
  moveBlockById,
  replaceBlockById,
} from "./doc/docOps";

export interface BlockDocViewProps {
  readonly note: Note;
  readonly docView?: DocView | undefined;
  readonly notes: readonly Note[];
  readonly issues: readonly Issue[];
  readonly links?: NoteLinkListResult | undefined;
  readonly busy?: boolean | undefined;
  readonly savedAt?: number | undefined;
  readonly onSaveDoc: (doc: { readonly version: number; readonly blocks: readonly DocBlock[] }) => Promise<void> | void;
  readonly onAppendBlock?: (block: DocBlock, afterBlockId?: string) => Promise<void> | void;
  readonly onRenameTitle?: (title: string) => Promise<void> | void;
  readonly onCreateIssueFromBlock?: (title: string, blockId: string) => Promise<IssueId | undefined>;
  readonly onOpenNote: (id: NoteId) => void;
  readonly onOpenIssue: (id: IssueId) => void;
  readonly onOpenPresenter?: () => void;
}

const SAVE_DEBOUNCE_MS = 350;

function coverUrlOf(note: Note): string | undefined {
  const cover = note.cover;
  if (!cover) return undefined;
  if (cover.path !== "") return `file://${encodeURI(cover.path)}`;
  return cover.url !== "" ? cover.url : undefined;
}

function LinkRowItem(props: {
  readonly link: NoteLink;
  readonly idPrefix: string;
  readonly onOpenNote: (id: NoteId) => void;
  readonly onOpenIssue: (id: IssueId) => void;
}) {
  const isOutgoing = () => props.idPrefix === "outgoing";
  const entityKind = () => (isOutgoing() ? props.link.targetKind : props.link.sourceKind);
  const entityId = () => (isOutgoing() ? props.link.targetId : props.link.sourceId);

  return (
    <View
      role="button"
      testID={`doc-link-${props.idPrefix}-${props.link.id}`}
      onPress={() => {
        if (entityKind() === "note") props.onOpenNote(noteId(entityId()));
        else props.onOpenIssue(issueId(entityId()));
      }}
      class="flex-row items-center gap-2 rounded-md px-2 py-1.5 hover:bg-hover"
    >
      <Icon name={entityKind() === "note" ? "notes" : "issues"} size={13} tone="muted" />
      <Text class="min-w-0 flex-1 truncate text-xs font-medium text-ink">{props.link.title || entityId()}</Text>
      <View class="shrink-0 rounded-xs border border-line bg-page px-1.5 py-px">
        <Text class="font-mono text-2xs text-faint">{props.link.relation}</Text>
      </View>
    </View>
  );
}

export function BlockDocView(props: BlockDocViewProps) {
  const blocks = signal<readonly DocBlock[]>(untracked(() => props.docView?.blocks ?? []));
  const titleDraft = signal(untracked(() => props.note.title));
  const focusedBlockId = signal<string | undefined>(undefined);
  const highlightedBlockId = signal<string | undefined>(undefined);
  const dirty = signal(false);
  const saving = signal(false);
  const linksOpen = signal(true);
  const lightboxPicture = signal<Picture | undefined>(undefined);
  const scheduleSaveTimer = useTimeout();

  let syncedNoteId = untracked(() => props.note.id);
  let syncedDocRef = untracked(() => props.docView?.blocks);

  effect(() => {
    const incomingNoteId = props.note.id;
    const incomingTitle = props.note.title;
    const incomingBlocks = props.docView?.blocks;
    if (incomingNoteId !== syncedNoteId) {
      syncedNoteId = incomingNoteId;
      syncedDocRef = incomingBlocks;
      titleDraft.set(incomingTitle);
      blocks.set(incomingBlocks ?? []);
      dirty.set(false);
      focusedBlockId.set(undefined);
      return;
    }
    if (incomingBlocks !== undefined && incomingBlocks !== syncedDocRef && !untracked(dirty)) {
      syncedDocRef = incomingBlocks;
      blocks.set(incomingBlocks);
    }
  });

  const stats = computed(() => computeDocStats(blocks()));
  const slideIndices = computed(() => computeSlideIndices(blocks()));
  const coverSrc = computed(() => coverUrlOf(props.note));

  const flushSave = async () => {
    if (!untracked(dirty)) return;
    const snapshot = untracked(blocks);
    dirty.set(false);
    saving.set(true);
    try {
      await props.onSaveDoc({ version: 1, blocks: snapshot });
    } finally {
      saving.set(false);
    }
  };

  const commitBlocks = (next: readonly DocBlock[]) => {
    blocks.set(next);
    dirty.set(true);
    scheduleSaveTimer(() => {
      void flushSave();
    }, SAVE_DEBOUNCE_MS);
  };

  cleanup(() => {
    if (untracked(dirty)) {
      void flushSave();
    }
  });

  const canKeymapSave = computed(() => dirty() && !saving());
  effect(() => {
    if (!canKeymapSave()) return;
    return keymap.bind("mod+s", () => void flushSave(), { when: "always" });
  });

  const handleUpdateBlock = (id: string, next: DocBlock) => {
    commitBlocks(replaceBlockById(untracked(blocks), id, () => next));
  };

  const handleInsertAfter = (afterId: string, newBlock: DocBlock) => {
    const next = insertBlockAfter(untracked(blocks), afterId, newBlock);
    focusedBlockId.set(newBlock.id);
    commitBlocks(next);
  };

  const handleAppendTail = () => {
    const cur = untracked(blocks);
    const tailId = cur.at(-1)?.id;
    const newBlock: DocBlock = { id: makeBlockId(), type: "prose", text: "" };
    const next = insertBlockAfter(cur, tailId, newBlock);
    focusedBlockId.set(newBlock.id);
    blocks.set(next);
    if (props.onAppendBlock && !untracked(dirty)) {
      void props.onAppendBlock(newBlock, tailId);
    } else {
      commitBlocks(next);
    }
  };

  const handleMoveBlock = (id: string, direction: "up" | "down") => {
    commitBlocks(moveBlockById(untracked(blocks), id, direction));
  };

  const handleDuplicateBlock = (id: string) => {
    commitBlocks(duplicateBlockById(untracked(blocks), id));
  };

  const handleDeleteBlock = (id: string) => {
    const cur = untracked(blocks);
    const next = deleteBlockById(cur, id);
    if (next.length === 0) {
      const fresh: DocBlock = { id: makeBlockId(), type: "prose", text: "" };
      focusedBlockId.set(fresh.id);
      commitBlocks([fresh]);
      return;
    }
    commitBlocks(next);
  };

  const commitTitleRename = () => {
    const trimmed = untracked(titleDraft).trim();
    if (trimmed && trimmed !== props.note.title) {
      void props.onRenameTitle?.(trimmed);
    }
  };

  const outgoingCount = () => props.links?.outgoing.length ?? 0;
  const backlinksCount = () => props.links?.backlinks.length ?? 0;
  const statusLabel = () => {
    if (props.busy === true || saving()) return t("web.base.reading");
    if (dirty()) return t("web.note.page.unsaved");
    return t("web.note.blocks.saved");
  };
  const lightboxPictures = computed(() => {
    const pic = lightboxPicture();
    return pic !== undefined ? [pic] : [];
  });

  return (
    <View testID="note-block-doc-view" class="min-h-0 flex-1 bg-page">
      <Scroll class="min-h-0 flex-1" contentClass="mx-auto w-full max-w-3xl gap-4 px-6 py-6">
        <If when={coverSrc()}>
          {(src) => (
            <View testID="doc-cover-strip" class="h-36 overflow-hidden rounded-xl border border-line bg-side">
              <Image src={src()} accessibilityLabel={props.note.title} class="h-36 w-full object-cover" />
            </View>
          )}
        </If>

        <View class="gap-2 border-b border-line pb-4">
          <Input
            testID="doc-title-input"
            accessibilityLabel={t("web.note.page.title")}
            value={titleDraft()}
            placeholder={t("web.note.page.title")}
            submitBehavior="submit"
            onChange={(e) => titleDraft.set(e.value)}
            onSubmit={commitTitleRename}
            onBlur={commitTitleRename}
            class="w-full bg-transparent text-3xl font-bold text-ink placeholder:text-faint"
          />
          <View class="flex-row flex-wrap items-center justify-between gap-2">
            <View class="flex-row flex-wrap items-center gap-2">
              <Text testID="doc-stat-blocks" class="font-mono text-xs text-muted tabular-nums">
                {t("web.note.doc.blocksCount", { n: stats().blockCount })}
              </Text>
              <Text class="text-xs text-faint">·</Text>
              <Text testID="doc-stat-words" class="font-mono text-xs text-muted tabular-nums">
                {t("web.note.doc.wordsCount", { n: stats().wordCount })}
              </Text>
              <Text class="text-xs text-faint">·</Text>
              <Text testID="doc-stat-slides" class="font-mono text-xs text-muted tabular-nums">
                {t("web.note.doc.slidesCount", { n: stats().slideCount })}
              </Text>
            </View>
            <View class="flex-row items-center gap-2">
              <Text testID="doc-save-status" class={`text-xs ${dirty() ? "text-warn-ink" : "text-faint"}`}>
                {statusLabel()}
              </Text>
              <If when={props.savedAt !== undefined && !dirty() && !saving()}>
                <Icon name="check" size={12} tone="leaf" />
              </If>
              <If when={stats().slideCount > 1 && props.onOpenPresenter !== undefined}>
                <Button size="compact" tone="plain" icon="presenter" testID="doc-presenter-btn" onPress={() => props.onOpenPresenter?.()}>
                  Presenter
                </Button>
              </If>
            </View>
          </View>
        </View>

        <If
          when={blocks().length > 0}
          else={
            <View class="py-6">
              <Empty
                icon="notes"
                action={
                  <Button size="control" tone="primary" icon="add" testID="doc-empty-add-btn" onPress={handleAppendTail}>
                    {t("web.note.doc.addBlock")}
                  </Button>
                }
              >
                {t("web.note.doc.empty")}
              </Empty>
            </View>
          }
        >
          <View testID="doc-blocks-list" class="gap-1.5">
            <Each of={blocks()} key={(b) => b.id}>
              {(b) => (
                <View class={highlightedBlockId() === b().id ? "rounded-md bg-selected" : ""}>
                  <BlockItem
                    block={b()}
                    allBlocks={blocks()}
                    slideIndices={slideIndices()}
                    note={props.note}
                    notes={props.notes}
                    issues={props.issues}
                    focusedBlockId={focusedBlockId()}
                    onFocusBlock={(id) => focusedBlockId.set(id)}
                    onUpdateBlock={handleUpdateBlock}
                    onInsertAfter={handleInsertAfter}
                    onMoveBlock={handleMoveBlock}
                    onDuplicateBlock={handleDuplicateBlock}
                    onDeleteBlock={handleDeleteBlock}
                    onCreateIssueFromBlock={props.onCreateIssueFromBlock}
                    onOpenNote={props.onOpenNote}
                    onOpenIssue={props.onOpenIssue}
                    onScrollToBlock={(targetId) => {
                      highlightedBlockId.set(targetId);
                      focusedBlockId.set(targetId);
                    }}
                    onOpenLightbox={(pic) => lightboxPicture.set(pic)}
                  />
                </View>
              )}
            </Each>
          </View>
        </If>

        <View class="flex-row items-center justify-between gap-2 pt-2 pl-14">
          <Button size="compact" tone="quiet" icon="add" testID="doc-append-block-btn" onPress={handleAppendTail}>
            {t("web.note.doc.addBlock")}
          </Button>
          <Text class="text-2xs text-faint">{t("web.note.doc.slashHint")}</Text>
        </View>

        <View testID="doc-links-panel" class="mt-4 gap-2 rounded-lg border border-line bg-side p-3">
          <View
            role="button"
            testID="doc-links-toggle"
            accessibilityState={{ expanded: linksOpen() }}
            onPress={() => linksOpen.set(!linksOpen())}
            class="flex-row items-center justify-between gap-2"
          >
            <View class="flex-row items-center gap-2">
              <Icon name={linksOpen() ? "choose" : "expand"} size={13} tone="muted" />
              <Text class="text-xs font-semibold text-ink">{t("web.note.links.backlinks", { n: backlinksCount() })}</Text>
              <Text class="text-xs text-faint">·</Text>
              <Text class="text-xs font-semibold text-muted">{t("web.note.links.outgoing", { n: outgoingCount() })}</Text>
            </View>
          </View>
          <If when={linksOpen()}>
            <If when={backlinksCount() > 0 || outgoingCount() > 0} else={<Text class="px-1 py-1 text-xs text-faint">{t("web.note.links.empty")}</Text>}>
              <View class="gap-3 pt-1 md:flex-row">
                <View class="min-w-0 flex-1 gap-1">
                  <Text class="px-2 text-2xs font-semibold text-muted">{t("web.note.links.backlinks", { n: backlinksCount() })}</Text>
                  <If when={backlinksCount() > 0} else={<Text class="px-2 text-2xs text-faint">{t("web.note.links.empty")}</Text>}>
                    <Each of={props.links?.backlinks ?? []} key={(l) => l.id}>
                      {(l) => <LinkRowItem link={l()} idPrefix="backlink" onOpenNote={props.onOpenNote} onOpenIssue={props.onOpenIssue} />}
                    </Each>
                  </If>
                </View>
                <View class="min-w-0 flex-1 gap-1">
                  <Text class="px-2 text-2xs font-semibold text-muted">{t("web.note.links.outgoing", { n: outgoingCount() })}</Text>
                  <If when={outgoingCount() > 0} else={<Text class="px-2 text-2xs text-faint">{t("web.base.table.empty")}</Text>}>
                    <Each of={props.links?.outgoing ?? []} key={(l) => l.id}>
                      {(l) => <LinkRowItem link={l()} idPrefix="outgoing" onOpenNote={props.onOpenNote} onOpenIssue={props.onOpenIssue} />}
                    </Each>
                  </If>
                </View>
              </View>
            </If>
          </If>
        </View>
      </Scroll>

      <Lightbox
        pictures={lightboxPictures()}
        at={lightboxPicture() !== undefined ? 0 : undefined}
        onAt={(at) => {
          if (at === undefined) lightboxPicture.set(undefined);
        }}
      />
    </View>
  );
}
