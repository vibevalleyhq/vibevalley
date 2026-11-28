import { cleanup, computed, effect, Image, keymap, Scroll, signal, Text, untracked, View, windowSize } from "nsh";
import { Input } from "nsh/base";

import { t } from "@vibevalley/i18n";
import type { DocBlock, DocView, Issue, IssueId, MediaAnnotation, Note, NoteId, NoteLink, NoteLinkListResult } from "@vibevalley/protocol";
import { issueId, noteId } from "@vibevalley/protocol/schema";

import { Button } from "../../design/Button";
import { Icon } from "../../design/Icon";
import { Empty } from "../../design/layout";
import { Lightbox, type Picture } from "../../design/Lightbox";
import { useTimeout } from "../../infra/base/timer";
import { isVdpEnabled, useVdpNode, VdpAnchor } from "../../infra/vdpProbe";
import { BlockItem, type BlockEditorProbeSnapshot, type BlockEditorTelemetryPatch, type FocusRequest } from "./doc/BlockItem";
import {
  type BlockFocusTarget,
  computeDocStats,
  computeSlideIndices,
  deleteBlockById,
  duplicateBlockById,
  extractTocEntries,
  insertBlockAfter,
  makeBlockId,
  mergeBlockBackward,
  moveBlockById,
  neighborBlockId,
  replaceBlockById,
  splitBlockAtSelection,
} from "./doc/docOps";
import { buildDocAnnotationIndex, type DocAnnotationRef } from "./doc/mediaAnnotationModel";
import { MediaAnnotationOverlay } from "./doc/MediaAnnotationOverlay";

interface BlockDocViewProps {
  readonly note: Note;
  readonly docView?: DocView | undefined;
  readonly notes: readonly Note[];
  readonly issues: readonly Issue[];
  readonly links?: NoteLinkListResult | undefined;
  readonly busy?: boolean | undefined;
  readonly savedAt?: number | undefined;
  readonly embedded?: boolean | undefined;
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

function relationLabel(rel: string): string {
  switch (rel) {
    case "embed":
      return t("web.note.links.relation.embed");
    case "ref":
      return t("web.note.links.relation.ref");
    default:
      return t("web.note.links.relation.link");
  }
}

function findBlockById(blocks: readonly DocBlock[], id: string): DocBlock | undefined {
  for (const b of blocks) {
    if (b.id === id) return b;
    if (b.children) {
      const found = findBlockById(b.children, id);
      if (found) return found;
    }
    if (b.type === "columns") {
      for (const col of b.columns) {
        const found = findBlockById(col.blocks, id);
        if (found) return found;
      }
    }
  }
  return undefined;
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
      class="flex-row items-center gap-2 rounded-md px-2 py-1 hover:bg-hover"
    >
      <Icon name={entityKind() === "note" ? "notes" : "issues"} size={13} tone="muted" />
      <Text class="min-w-0 flex-1 truncate text-xs font-medium text-ink">{props.link.title || entityId()}</Text>
      <Text class="shrink-0 text-2xs text-faint">{relationLabel(props.link.relation)}</Text>
    </View>
  );
}

export function BlockDocView(props: BlockDocViewProps) {
  const blocks = signal<readonly DocBlock[]>(untracked(() => props.docView?.blocks ?? []));
  const titleDraft = signal(untracked(() => props.note.title));
  const focusedBlockId = signal<string | undefined>(undefined);
  const focusRequest = signal<FocusRequest | undefined>(undefined);
  const highlightedBlockId = signal<string | undefined>(undefined);
  const dirty = signal(false);
  const saving = signal(false);
  const linksOpen = signal(true);
  const lightboxPicture = signal<Picture | undefined>(undefined);
  const lightboxMediaBlockId = signal<string | undefined>(undefined);
  const activeAnnotationLink = signal<
    { readonly annotationId?: string | undefined; readonly baseRowId?: string | undefined; readonly mediaBlockId?: string | undefined } | undefined
  >(undefined);
  const scheduleSaveTimer = useTimeout();

  let focusSeq = 0;
  let probeSnapshot: BlockEditorProbeSnapshot = {
    focusedBlockId: null,
    activeTestId: null,
    value: "",
    selection: null,
    caretBounds: null,
    caretPageBounds: null,
  };

  const requestFocus = (target: BlockFocusTarget) => {
    focusSeq += 1;
    focusedBlockId.set(target.blockId);
    focusRequest.set({
      blockId: target.blockId,
      caret: target.caret,
      itemIndex: target.itemIndex,
      seq: focusSeq,
    });
  };

  const handleNativeFocusBlock = (id: string) => {
    focusedBlockId.set(id);
    probeSnapshot = { ...probeSnapshot, focusedBlockId: id };
  };

  const handleEditorTelemetry = (patch: BlockEditorTelemetryPatch) => {
    probeSnapshot = {
      focusedBlockId: patch.focusedBlockId ?? probeSnapshot.focusedBlockId,
      activeTestId: patch.activeTestId ?? probeSnapshot.activeTestId,
      value: patch.value ?? probeSnapshot.value,
      selection: patch.selection ?? probeSnapshot.selection,
      caretBounds: patch.caretBounds ?? probeSnapshot.caretBounds,
      caretPageBounds: patch.caretPageBounds ?? probeSnapshot.caretPageBounds,
    };
  };

  const telemetryHandler = isVdpEnabled() ? handleEditorTelemetry : undefined;

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
      focusRequest.set(undefined);
      probeSnapshot = {
        focusedBlockId: null,
        activeTestId: null,
        value: "",
        selection: null,
        caretBounds: null,
        caretPageBounds: null,
      };
      return;
    }
    if (incomingBlocks !== undefined && incomingBlocks !== syncedDocRef && !untracked(dirty)) {
      syncedDocRef = incomingBlocks;
      blocks.set(incomingBlocks);
    }
  });

  const redundantLeadingH1Id = computed((): string | undefined => {
    if (props.embedded === true) return undefined;
    const first = blocks()[0];
    if (first?.type !== "heading" || first.level !== 1) return undefined;
    if (focusedBlockId() === first.id) return undefined;
    const noteTitle = props.note.title.trim();
    if (!noteTitle) return undefined;
    return first.text.trim() === noteTitle ? first.id : undefined;
  });
  const visibleBlocks = computed(() => {
    const skipId = redundantLeadingH1Id();
    return skipId !== undefined ? blocks().filter((b) => b.id !== skipId) : blocks();
  });
  const stats = computed(() => computeDocStats(blocks()));
  const slideIndices = computed(() => computeSlideIndices(blocks()));
  const annotationIndex = computed(() => buildDocAnnotationIndex(blocks()));
  const outlineEntries = computed(() => extractTocEntries(visibleBlocks(), 3));
  const showOutlineRail = computed(() => outlineEntries().length >= 2 && windowSize().width >= 1100);
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

  effect(() => {
    const activeId = focusedBlockId();
    if (!activeId) return;
    return keymap.bind(
      {
        "mod+shift+up": () => handleMoveBlock(activeId, "up"),
        "mod+shift+down": () => handleMoveBlock(activeId, "down"),
      },
      { when: "always" },
    );
  });

  const handleUpdateBlock = (id: string, next: DocBlock) => {
    const cur = untracked(blocks);
    const prevBlock = findBlockById(cur, id);
    const typeChanged = prevBlock !== undefined && prevBlock.type !== next.type;
    commitBlocks(replaceBlockById(cur, id, () => next));
    if (typeChanged && untracked(focusedBlockId) === id) {
      requestFocus({ blockId: next.id, caret: "end" });
    }
  };

  const handleInsertAfter = (afterId: string, newBlock: DocBlock) => {
    const next = insertBlockAfter(untracked(blocks), afterId, newBlock);
    commitBlocks(next);
    requestFocus({ blockId: newBlock.id, caret: "start" });
  };

  const handleSplitBlock = (id: string, selStart: number, selEnd: number) => {
    const res = splitBlockAtSelection(untracked(blocks), id, selStart, selEnd);
    if (!res) return;
    commitBlocks(res.blocks);
    requestFocus(res.focus);
  };

  const handleMergeBackward = (id: string) => {
    const res = mergeBlockBackward(untracked(blocks), id);
    if (!res) return;
    if (res.blocks.length === 0) {
      const fresh: DocBlock = { id: makeBlockId(), type: "prose", text: "" };
      commitBlocks([fresh]);
      requestFocus({ blockId: fresh.id, caret: 0 });
      return;
    }
    commitBlocks(res.blocks);
    requestFocus(res.focus);
  };

  const handleAppendTail = () => {
    const cur = untracked(blocks);
    const tailId = cur.at(-1)?.id;
    const newBlock: DocBlock = { id: makeBlockId(), type: "prose", text: "" };
    const next = insertBlockAfter(cur, tailId, newBlock);
    blocks.set(next);
    requestFocus({ blockId: newBlock.id, caret: "start" });
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
    const prevId = neighborBlockId(cur, id, "prev");
    const next = deleteBlockById(cur, id);
    if (next.length === 0) {
      const fresh: DocBlock = { id: makeBlockId(), type: "prose", text: "" };
      commitBlocks([fresh]);
      requestFocus({ blockId: fresh.id, caret: 0 });
      return;
    }
    commitBlocks(next);
    if (prevId !== undefined) requestFocus({ blockId: prevId, caret: "end" });
  };

  const handleFocusAdjacent = (id: string, dir: "prev" | "next") => {
    const target = neighborBlockId(untracked(blocks), id, dir);
    if (target !== undefined) {
      requestFocus({ blockId: target, caret: dir === "prev" ? "end" : "start" });
    }
  };

  const commitTitleRename = () => {
    const trimmed = untracked(titleDraft).trim();
    if (trimmed && trimmed !== props.note.title) {
      void props.onRenameTitle?.(trimmed);
    }
  };

  const handleSelectAnnotation = (blockId: string, annId: string | undefined, baseRowId?: string) => {
    if (annId === undefined) {
      activeAnnotationLink.set(undefined);
      return;
    }
    activeAnnotationLink.set({ annotationId: annId, baseRowId, mediaBlockId: blockId });
  };

  const handleJumpToBaseRow = (rowId: string, annId: string) => {
    const baseBlock = untracked(visibleBlocks).find((b) => b.type === "baseEmbed");
    const curRef = untracked(annotationIndex).byAnnotationId.get(annId);
    activeAnnotationLink.set({
      annotationId: annId,
      baseRowId: rowId,
      mediaBlockId: curRef?.blockId,
    });
    if (baseBlock !== undefined) {
      highlightedBlockId.set(baseBlock.id);
    }
  };

  const handleSelectReviewRow = (rowId: string, ref?: DocAnnotationRef) => {
    const resolved = ref ?? untracked(annotationIndex).byBaseRowId.get(rowId);
    if (resolved !== undefined) {
      activeAnnotationLink.set({
        annotationId: resolved.annotation.id,
        baseRowId: rowId,
        mediaBlockId: resolved.blockId,
      });
      highlightedBlockId.set(resolved.blockId);
    } else {
      activeAnnotationLink.set({ baseRowId: rowId });
    }
  };

  const handleCreateIssueFromAnnotation = async (ann: MediaAnnotation, blockId: string): Promise<IssueId | undefined> => {
    if (!props.onCreateIssueFromBlock) return undefined;
    return props.onCreateIssueFromBlock(`[#${ann.number}] ${ann.title}`, blockId);
  };

  const outgoingCount = () => props.links?.outgoing.length ?? 0;
  const backlinksCount = () => props.links?.backlinks.length ?? 0;
  useVdpNode({ testId: "note-block-doc-view", role: "region" });
  useVdpNode({
    testId: "doc-editor-probe",
    role: "status",
    text: () => JSON.stringify(probeSnapshot),
  });
  const lightboxPictures = computed((): readonly Picture[] => {
    const mediaId = lightboxMediaBlockId();
    if (mediaId !== undefined) {
      const blk = findBlockById(blocks(), mediaId);
      if (blk !== undefined && blk.type === "media" && blk.src.trim() !== "") {
        return [
          {
            src: blk.src,
            name: blk.caption || blk.src,
            renderOverlay: (frame) => {
              const liveBlk = () => {
                const found = findBlockById(blocks(), mediaId);
                return found?.type === "media" ? found : undefined;
              };
              const liveAnns = () => liveBlk()?.annotations ?? [];
              return (
                <MediaAnnotationOverlay
                  scopeId={`lb-${mediaId}`}
                  annotations={liveAnns()}
                  containerWidth={frame().width}
                  containerHeight={frame().height}
                  naturalWidth={frame().naturalWidth}
                  naturalHeight={frame().naturalHeight}
                  showOverlay
                  unresolvedOnly={false}
                  selectedId={activeAnnotationLink()?.annotationId}
                  issues={props.issues}
                  onSelect={(annId) => {
                    const found = annId !== undefined ? liveAnns().find((a) => a.id === annId) : undefined;
                    handleSelectAnnotation(mediaId, annId, found?.baseRowId);
                  }}
                  onChange={(next) => {
                    const current = liveBlk();
                    if (current !== undefined) handleUpdateBlock(mediaId, { ...current, annotations: [...next] });
                  }}
                  onOpenIssue={props.onOpenIssue}
                  onCreateIssue={props.onCreateIssueFromBlock ? (ann) => handleCreateIssueFromAnnotation(ann, mediaId) : undefined}
                  onJumpToBaseRow={(rowId, annId) => {
                    lightboxMediaBlockId.set(undefined);
                    handleJumpToBaseRow(rowId, annId);
                  }}
                />
              );
            },
          },
        ];
      }
    }
    const pic = lightboxPicture();
    return pic !== undefined ? [pic] : [];
  });

  const embedded = () => props.embedded === true;
  const contentInsetClass = () => (embedded() ? "pl-10" : "pl-14");
  const bodyContent = (
    <>
      <If when={!embedded()}>
        <If when={coverSrc()}>
          {(src) => (
            <View class="pl-14">
              <View testID="doc-cover-strip" class="mb-2 h-36 overflow-hidden rounded-xl border border-line bg-side">
                <Image src={src()} accessibilityLabel={props.note.title} class="h-36 w-full object-cover" />
              </View>
            </View>
          )}
        </If>

        <View class="mb-2 flex-row items-center justify-between gap-3 pl-14 pr-1">
          <Input
            testID="doc-title-input"
            accessibilityLabel={t("web.note.page.title")}
            value={titleDraft()}
            placeholder={t("web.note.page.title")}
            submitBehavior="submit"
            onChange={(e) => titleDraft.set(e.value)}
            onSubmit={commitTitleRename}
            onBlur={commitTitleRename}
            class="min-w-0 flex-1 bg-transparent px-1 text-3xl font-bold leading-tight text-ink placeholder:text-faint"
          />
          <View class="shrink-0 flex-row items-center gap-2">
            <If when={dirty() || saving()}>
              <Text testID="doc-save-status" class="text-2xs text-warn-ink">
                {saving() ? t("web.base.reading") : t("web.note.page.unsaved")}
              </Text>
            </If>
            <If when={stats().slideCount > 1 && props.onOpenPresenter !== undefined}>
              <Button size="compact" tone="quiet" icon="present" testID="doc-presenter-btn" onPress={() => props.onOpenPresenter?.()}>
                {t("web.note.doc.presenter")}
              </Button>
            </If>
          </View>
        </View>
      </If>

      <If
        when={visibleBlocks().length > 0}
        else={
          <View class={`py-6 ${contentInsetClass()}`}>
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
        <View testID="doc-blocks-list" class="gap-1">
          <Each of={visibleBlocks()} key={(b) => b.id}>
            {(b) => (
              <View class={highlightedBlockId() === b().id ? "rounded-md bg-selected" : ""}>
                <BlockItem
                  block={b()}
                  allBlocks={visibleBlocks()}
                  slideIndices={slideIndices()}
                  note={props.note}
                  notes={props.notes}
                  issues={props.issues}
                  focusedBlockId={focusedBlockId()}
                  focusRequest={focusRequest()}
                  compactGutter={embedded()}
                  onFocusBlock={handleNativeFocusBlock}
                  onRequestFocus={requestFocus}
                  onFocusAdjacent={handleFocusAdjacent}
                  onSplitBlock={handleSplitBlock}
                  onMergeBackward={handleMergeBackward}
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
                    requestFocus({ blockId: targetId, caret: "end" });
                  }}
                  onOpenLightbox={(pic) => {
                    lightboxMediaBlockId.set(undefined);
                    lightboxPicture.set(pic);
                  }}
                  onOpenMediaLightbox={(blockId) => {
                    lightboxPicture.set(undefined);
                    lightboxMediaBlockId.set(blockId);
                  }}
                  annotationIndex={annotationIndex()}
                  selectedAnnotationId={activeAnnotationLink()?.annotationId}
                  highlightedBaseRowId={activeAnnotationLink()?.baseRowId}
                  onSelectAnnotation={handleSelectAnnotation}
                  onJumpToBaseRow={handleJumpToBaseRow}
                  onSelectReviewRow={handleSelectReviewRow}
                  onCreateIssueFromAnnotation={props.onCreateIssueFromBlock ? handleCreateIssueFromAnnotation : undefined}
                  onEditorTelemetry={telemetryHandler}
                />
              </View>
            )}
          </Each>
        </View>
      </If>

      <View class={`flex-row items-center justify-between gap-2 pt-2 pr-1 opacity-70 hover:opacity-100 ${contentInsetClass()}`}>
        <Button size="compact" tone="quiet" icon="add" testID="doc-append-block-btn" onPress={handleAppendTail}>
          {t("web.note.doc.addBlock")}
        </Button>
        <View class="flex-row items-center gap-2">
          <If when={embedded() && (dirty() || saving())}>
            <Text testID="doc-save-status" class="text-2xs text-warn-ink">
              {saving() ? t("web.base.reading") : t("web.note.page.unsaved")}
            </Text>
          </If>
          <Text class="text-2xs text-faint">{t("web.note.doc.slashHint")}</Text>
        </View>
      </View>

      <If when={backlinksCount() > 0 || outgoingCount() > 0}>
        <>
          <VdpAnchor testId="doc-links-panel" role="region" />
          <View class={`pr-1 ${contentInsetClass()}`}>
            <View testID="doc-links-panel" class={`${embedded() ? "mt-5 pt-4" : "mt-10 pt-6"} gap-3 border-t border-line`}>
              <View
                role="button"
                testID="doc-links-toggle"
                accessibilityState={{ expanded: linksOpen() }}
                onPress={() => linksOpen.set(!linksOpen())}
                class="flex-row items-center gap-2"
              >
                <Icon name={linksOpen() ? "choose" : "expand"} size={12} tone="faint" />
                <Text class="text-xs font-semibold text-muted">{t("web.note.links.backlinks", { n: backlinksCount() })}</Text>
                <Text class="text-xs text-faint">·</Text>
                <Text class="text-xs font-medium text-faint">{t("web.note.links.outgoing", { n: outgoingCount() })}</Text>
              </View>
              <If when={linksOpen()}>
                <View class="gap-4 md:flex-row">
                  <If when={backlinksCount() > 0}>
                    <View class="min-w-0 flex-1 gap-0.5">
                      <Each of={props.links?.backlinks ?? []} key={(l) => l.id}>
                        {(l) => <LinkRowItem link={l()} idPrefix="backlink" onOpenNote={props.onOpenNote} onOpenIssue={props.onOpenIssue} />}
                      </Each>
                    </View>
                  </If>
                  <If when={outgoingCount() > 0}>
                    <View class="min-w-0 flex-1 gap-0.5">
                      <Each of={props.links?.outgoing ?? []} key={(l) => l.id}>
                        {(l) => <LinkRowItem link={l()} idPrefix="outgoing" onOpenNote={props.onOpenNote} onOpenIssue={props.onOpenIssue} />}
                      </Each>
                    </View>
                  </If>
                </View>
              </If>
            </View>
          </View>
        </>
      </If>
    </>
  );

  return (
    <View testID="note-block-doc-view" class={embedded() ? "min-w-0" : "min-h-0 flex-1 flex-row bg-page"}>
      <If
        when={embedded()}
        else={
          <Scroll class="min-h-0 flex-1" contentClass="mx-auto w-full max-w-3xl gap-3 pr-12 pl-4 pt-10 pb-24">
            {bodyContent}
          </Scroll>
        }
      >
        <View class="w-full gap-2">{bodyContent}</View>
      </If>

      <If when={!embedded() && showOutlineRail()}>
        <View testID="doc-outline-rail" class="hidden w-44 shrink-0 pt-10 pr-4 lg:flex">
          <View class="w-full min-w-0 gap-1 border-l border-line pl-3">
            <Text class="mb-1 text-2xs font-semibold text-faint">{t("web.note.doc.outline")}</Text>
            <Each of={outlineEntries()} key={(entry) => entry.blockId}>
              {(entry) => {
                const active = () => highlightedBlockId() === entry().blockId || focusedBlockId() === entry().blockId;
                return (
                  <View
                    role="button"
                    testID={`doc-outline-item-${entry().blockId}`}
                    onPress={() => {
                      highlightedBlockId.set(entry().blockId);
                      requestFocus({ blockId: entry().blockId, caret: "end" });
                    }}
                    class="w-full min-w-0 rounded-sm py-0.5 pr-1 hover:bg-hover"
                    style={{ paddingLeft: Math.max(0, entry().level - 1) * 10 }}
                  >
                    <Text class={`w-full truncate text-2xs ${active() ? "font-semibold text-accent" : "text-faint hover:text-ink"}`}>{entry().text}</Text>
                  </View>
                );
              }}
            </Each>
          </View>
        </View>
      </If>

      <Lightbox
        pictures={lightboxPictures()}
        at={lightboxPictures().length > 0 ? 0 : undefined}
        onAt={(at) => {
          if (at === undefined) {
            lightboxPicture.set(undefined);
            lightboxMediaBlockId.set(undefined);
          }
        }}
      />
    </View>
  );
}
