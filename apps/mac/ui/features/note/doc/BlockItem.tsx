import { Scroll, Text, untracked, View, type JSX, type ViewRef } from "nsh";
import { Menu, MenuItem, MenuSeparator } from "nsh/base";

import { t } from "@vibevalley/i18n";
import type { DocBlock, Issue, IssueId, MediaAnnotation, Note, NoteId, NotePresence } from "@vibevalley/protocol";

import { Icon } from "../../../design/Icon";
import type { Picture } from "../../../design/Lightbox";
import { motionClass, popupTransition } from "../../../design/motion";
import { Keyed } from "../../../infra/base/dom";
import { useVdpNode } from "../../../infra/vdpProbe";
import { filterRemotePresences } from "../PresenceBadges";
import { type BlockEditorTelemetryPatch, type FocusRequest, isCardLikeBlock, outerBlockSpacingClass } from "./blockEditorShared";
import {
  type BlockFocusTarget,
  type BlockType,
  extractBlockTitle,
  isTurnIntoActive,
  makeBlockId,
  slashCommandLabel,
  TURN_INTO_OPTIONS,
  turnBlockInto,
} from "./docOps";
import {
  BaseEmbedBlockView,
  ChartBlockView,
  CompareBlockView,
  DiagramBlockView,
  IssueCardBlockView,
  IssueListBlockView,
  KpiBlockView,
  MediaBlockView,
  PreviewBlockView,
} from "./EmbedBlocks";
import { HeadingBlockView, TodoBlockView } from "./HeadingTodoBlocks";
import { ListBlockView, QuoteBlockView } from "./ListQuoteBlocks";
import type { DocAnnotationIndex, DocAnnotationRef } from "./mediaAnnotationModel";
import { ProseBlockView } from "./ProseBlockView";
import {
  BookmarkBlockView,
  CalloutBlockView,
  CodeBlockView,
  ColumnsBlockView,
  MathBlockView,
  PageBreakBlockView,
  TableBlockView,
  TocBlockView,
  ToggleBlockView,
} from "./StructuredBlocks";

export type { BlockEditorProbeSnapshot, BlockEditorTelemetryPatch, FocusRequest } from "./blockEditorShared";

interface BlockItemProps {
  readonly block: DocBlock;
  readonly prevBlock?: DocBlock | undefined;
  readonly allBlocks: readonly DocBlock[];
  readonly slideIndices: ReadonlyMap<string, number>;
  readonly note?: Note | undefined;
  readonly notes: readonly Note[];
  readonly issues: readonly Issue[];
  readonly focusedBlockId?: string | undefined;
  readonly focusRequest?: FocusRequest | undefined;
  readonly highlighted?: boolean | undefined;
  readonly presences?: readonly NotePresence[] | undefined;
  readonly depth?: number | undefined;
  readonly embedded?: boolean | undefined;
  readonly compactGutter?: boolean | undefined;
  readonly onFocusBlock?: ((id: string) => void) | undefined;
  readonly onRequestFocus?: ((target: BlockFocusTarget) => void) | undefined;
  readonly onFocusAdjacent?: ((id: string, dir: "prev" | "next") => void) | undefined;
  readonly onSplitBlock?: ((id: string, selStart: number, selEnd: number) => void) | undefined;
  readonly onMergeBackward?: ((id: string) => void) | undefined;
  readonly onUpdateBlock: (id: string, next: DocBlock) => void;
  readonly onInsertAfter: (afterId: string, newBlock: DocBlock) => void;
  readonly onMoveBlock: (id: string, direction: "up" | "down") => void;
  readonly onDuplicateBlock: (id: string) => void;
  readonly onDeleteBlock: (id: string) => void;
  readonly onCreateIssueFromBlock?: ((title: string, blockId: string) => Promise<IssueId | undefined>) | undefined;
  readonly onOpenNote: (id: NoteId) => void;
  readonly onOpenIssue: (id: IssueId) => void;
  readonly onScrollToBlock?: ((blockId: string) => void) | undefined;
  readonly onOpenLightbox?: ((pic: Picture) => void) | undefined;
  readonly onOpenMediaLightbox?: ((blockId: string) => void) | undefined;
  readonly annotationIndex?: DocAnnotationIndex | undefined;
  readonly selectedAnnotationId?: string | undefined;
  readonly highlightedBaseRowId?: string | undefined;
  readonly onSelectAnnotation?: ((blockId: string, annId: string | undefined, baseRowId?: string) => void) | undefined;
  readonly onJumpToBaseRow?: ((rowId: string, annId: string) => void) | undefined;
  readonly onSelectReviewRow?: ((rowId: string, ref?: DocAnnotationRef) => void) | undefined;
  readonly onCreateIssueFromAnnotation?: ((ann: MediaAnnotation, blockId: string) => Promise<IssueId | undefined>) | undefined;
  readonly onEditorTelemetry?: ((patch: BlockEditorTelemetryPatch) => void) | undefined;
}

const menuPopupClass = `min-w-52 gap-0.5 rounded-lg border border-line-strong bg-elevated p-1 shadow-float ${motionClass("transition-opacity duration-120 ease-out")}`;
const menuItemClass = "h-7 flex-row items-center gap-2 rounded-md px-2 hover:bg-hover focus:bg-hover";

function renderNestedChild(child: () => DocBlock, props: BlockItemProps, prevChild?: () => DocBlock | undefined): JSX.Element {
  return (
    <BlockItem
      block={child()}
      prevBlock={prevChild?.()}
      allBlocks={props.allBlocks}
      slideIndices={props.slideIndices}
      note={props.note}
      notes={props.notes}
      issues={props.issues}
      focusedBlockId={props.focusedBlockId}
      focusRequest={props.focusRequest}
      presences={props.presences}
      depth={(props.depth ?? 0) + 1}
      embedded={false}
      compactGutter={props.compactGutter}
      onFocusBlock={props.onFocusBlock}
      onRequestFocus={props.onRequestFocus}
      onFocusAdjacent={props.onFocusAdjacent}
      onSplitBlock={props.onSplitBlock}
      onMergeBackward={props.onMergeBackward}
      onUpdateBlock={props.onUpdateBlock}
      onInsertAfter={props.onInsertAfter}
      onMoveBlock={props.onMoveBlock}
      onDuplicateBlock={props.onDuplicateBlock}
      onDeleteBlock={props.onDeleteBlock}
      onCreateIssueFromBlock={props.onCreateIssueFromBlock}
      onOpenNote={props.onOpenNote}
      onOpenIssue={props.onOpenIssue}
      onScrollToBlock={props.onScrollToBlock}
      onOpenLightbox={props.onOpenLightbox}
      onOpenMediaLightbox={props.onOpenMediaLightbox}
      annotationIndex={props.annotationIndex}
      selectedAnnotationId={props.selectedAnnotationId}
      highlightedBaseRowId={props.highlightedBaseRowId}
      onSelectAnnotation={props.onSelectAnnotation}
      onJumpToBaseRow={props.onJumpToBaseRow}
      onSelectReviewRow={props.onSelectReviewRow}
      onCreateIssueFromAnnotation={props.onCreateIssueFromAnnotation}
      onEditorTelemetry={props.onEditorTelemetry}
    />
  );
}

function renderBlockContent(blockType: BlockType, props: BlockItemProps): JSX.Element {
  switch (blockType) {
    case "prose":
      return (
        <If when={props.block.type === "prose" ? props.block : undefined}>
          {(b) => (
            <ProseBlockView
              block={b()}
              notes={props.notes}
              issues={props.issues}
              focused={props.focusedBlockId === b().id}
              focusRequest={props.focusRequest}
              onFocus={() => props.onFocusBlock?.(b().id)}
              onFocusAdjacent={(dir) => props.onFocusAdjacent?.(b().id, dir)}
              onSplit={props.onSplitBlock ? (s, e) => props.onSplitBlock?.(b().id, s, e) : undefined}
              onMergeBackward={props.onMergeBackward ? () => props.onMergeBackward?.(b().id) : undefined}
              onUpdate={(next) => props.onUpdateBlock(b().id, next)}
              onInsertAfter={(nb) => props.onInsertAfter(b().id, nb)}
              onDelete={() => props.onDeleteBlock(b().id)}
              onOpenNote={props.onOpenNote}
              onOpenIssue={props.onOpenIssue}
              onEditorTelemetry={props.onEditorTelemetry}
            />
          )}
        </If>
      );
    case "heading":
      return (
        <If when={props.block.type === "heading" ? props.block : undefined}>
          {(b) => (
            <HeadingBlockView
              block={b()}
              notes={props.notes}
              issues={props.issues}
              focused={props.focusedBlockId === b().id}
              focusRequest={props.focusRequest}
              onFocus={() => props.onFocusBlock?.(b().id)}
              onFocusAdjacent={(dir) => props.onFocusAdjacent?.(b().id, dir)}
              onSplit={props.onSplitBlock ? (s, e) => props.onSplitBlock?.(b().id, s, e) : undefined}
              onMergeBackward={props.onMergeBackward ? () => props.onMergeBackward?.(b().id) : undefined}
              onUpdate={(next) => props.onUpdateBlock(b().id, next)}
              onInsertAfter={(nb) => props.onInsertAfter(b().id, nb)}
              onOpenNote={props.onOpenNote}
              onOpenIssue={props.onOpenIssue}
              onEditorTelemetry={props.onEditorTelemetry}
            />
          )}
        </If>
      );
    case "list":
      return (
        <If when={props.block.type === "list" ? props.block : undefined}>
          {(b) => (
            <ListBlockView
              block={b()}
              notes={props.notes}
              issues={props.issues}
              focusRequest={props.focusRequest}
              onFocus={() => props.onFocusBlock?.(b().id)}
              onFocusAdjacent={(dir) => props.onFocusAdjacent?.(b().id, dir)}
              onUpdate={(next) => props.onUpdateBlock(b().id, next)}
              onInsertAfter={(nb) => props.onInsertAfter(b().id, nb)}
              onOpenNote={props.onOpenNote}
              onOpenIssue={props.onOpenIssue}
              onEditorTelemetry={props.onEditorTelemetry}
            />
          )}
        </If>
      );
    case "todo":
      return (
        <If when={props.block.type === "todo" ? props.block : undefined}>
          {(b) => (
            <TodoBlockView
              block={b()}
              notes={props.notes}
              issues={props.issues}
              focusRequest={props.focusRequest}
              onFocus={() => props.onFocusBlock?.(b().id)}
              onFocusAdjacent={(dir) => props.onFocusAdjacent?.(b().id, dir)}
              onSplit={props.onSplitBlock ? (s, e) => props.onSplitBlock?.(b().id, s, e) : undefined}
              onMergeBackward={props.onMergeBackward ? () => props.onMergeBackward?.(b().id) : undefined}
              onUpdate={(next) => props.onUpdateBlock(b().id, next)}
              onInsertAfter={(nb) => props.onInsertAfter(b().id, nb)}
              onOpenNote={props.onOpenNote}
              onOpenIssue={props.onOpenIssue}
              onEditorTelemetry={props.onEditorTelemetry}
            />
          )}
        </If>
      );
    case "quote":
      return (
        <If when={props.block.type === "quote" ? props.block : undefined}>
          {(b) => (
            <QuoteBlockView
              block={b()}
              notes={props.notes}
              issues={props.issues}
              focusRequest={props.focusRequest}
              onFocus={() => props.onFocusBlock?.(b().id)}
              onFocusAdjacent={(dir) => props.onFocusAdjacent?.(b().id, dir)}
              onMergeBackward={props.onMergeBackward ? () => props.onMergeBackward?.(b().id) : undefined}
              onUpdate={(next) => props.onUpdateBlock(b().id, next)}
              onOpenNote={props.onOpenNote}
              onOpenIssue={props.onOpenIssue}
              onEditorTelemetry={props.onEditorTelemetry}
            />
          )}
        </If>
      );
    case "divider":
      return (
        <View testID={`doc-divider-${props.block.id}`} class="py-3">
          <View class="h-px w-full bg-line" />
        </View>
      );
    case "toggle":
      return (
        <If when={props.block.type === "toggle" ? props.block : undefined}>
          {(b) => (
            <ToggleBlockView
              block={b()}
              notes={props.notes}
              issues={props.issues}
              onUpdate={(next) => props.onUpdateBlock(b().id, next)}
              onOpenNote={props.onOpenNote}
              onOpenIssue={props.onOpenIssue}
              renderChild={(child, prevChild) => renderNestedChild(child, props, prevChild)}
            />
          )}
        </If>
      );
    case "callout":
      return (
        <If when={props.block.type === "callout" ? props.block : undefined}>
          {(b) => (
            <CalloutBlockView
              block={b()}
              notes={props.notes}
              issues={props.issues}
              onUpdate={(next) => props.onUpdateBlock(b().id, next)}
              onOpenNote={props.onOpenNote}
              onOpenIssue={props.onOpenIssue}
            />
          )}
        </If>
      );
    case "code":
      return (
        <If when={props.block.type === "code" ? props.block : undefined}>
          {(b) => <CodeBlockView block={b()} onUpdate={(next) => props.onUpdateBlock(b().id, next)} />}
        </If>
      );
    case "table":
      return (
        <If when={props.block.type === "table" ? props.block : undefined}>
          {(b) => (
            <TableBlockView
              block={b()}
              notes={props.notes}
              issues={props.issues}
              onUpdate={(next) => props.onUpdateBlock(b().id, next)}
              onOpenNote={props.onOpenNote}
              onOpenIssue={props.onOpenIssue}
            />
          )}
        </If>
      );
    case "bookmark":
      return (
        <If when={props.block.type === "bookmark" ? props.block : undefined}>
          {(b) => <BookmarkBlockView block={b()} onUpdate={(next) => props.onUpdateBlock(b().id, next)} />}
        </If>
      );
    case "toc":
      return (
        <If when={props.block.type === "toc" ? props.block : undefined}>
          {(b) => (
            <TocBlockView
              block={b()}
              allBlocks={props.allBlocks}
              onUpdate={(next) => props.onUpdateBlock(b().id, next)}
              onScrollToBlock={props.onScrollToBlock}
            />
          )}
        </If>
      );
    case "math":
      return (
        <If when={props.block.type === "math" ? props.block : undefined}>
          {(b) => <MathBlockView block={b()} onUpdate={(next) => props.onUpdateBlock(b().id, next)} />}
        </If>
      );
    case "columns":
      return (
        <If when={props.block.type === "columns" ? props.block : undefined}>
          {(b) => (
            <ColumnsBlockView
              block={b()}
              onUpdate={(next) => props.onUpdateBlock(b().id, next)}
              renderChild={(child, prevChild) => renderNestedChild(child, props, prevChild)}
            />
          )}
        </If>
      );
    case "pageBreak":
      return (
        <If when={props.block.type === "pageBreak" ? props.block : undefined}>
          {(b) => <PageBreakBlockView block={b()} slideIndex={props.slideIndices.get(b().id) ?? 2} onUpdate={(next) => props.onUpdateBlock(b().id, next)} />}
        </If>
      );
    case "kpi":
      return (
        <If when={props.block.type === "kpi" ? props.block : undefined}>
          {(b) => <KpiBlockView block={b()} onUpdate={(next) => props.onUpdateBlock(b().id, next)} />}
        </If>
      );
    case "chart":
      return (
        <If when={props.block.type === "chart" ? props.block : undefined}>
          {(b) => <ChartBlockView block={b()} onUpdate={(next) => props.onUpdateBlock(b().id, next)} />}
        </If>
      );
    case "diagram":
      return (
        <If when={props.block.type === "diagram" ? props.block : undefined}>
          {(b) => <DiagramBlockView block={b()} onUpdate={(next) => props.onUpdateBlock(b().id, next)} />}
        </If>
      );
    case "compare":
      return (
        <If when={props.block.type === "compare" ? props.block : undefined}>
          {(b) => (
            <CompareBlockView
              block={b()}
              issues={props.issues}
              selectedAnnotationId={props.selectedAnnotationId}
              onUpdate={(next) => props.onUpdateBlock(b().id, next)}
              onSelectAnnotation={(annId, rowId) => props.onSelectAnnotation?.(b().id, annId, rowId)}
              onJumpToBaseRow={props.onJumpToBaseRow}
              onOpenIssue={props.onOpenIssue}
              onCreateIssueFromAnnotation={props.onCreateIssueFromAnnotation}
              onOpenLightbox={props.onOpenLightbox}
            />
          )}
        </If>
      );
    case "media":
      return (
        <If when={props.block.type === "media" ? props.block : undefined}>
          {(b) => (
            <MediaBlockView
              block={b()}
              issues={props.issues}
              selectedAnnotationId={props.selectedAnnotationId}
              onUpdate={(next) => props.onUpdateBlock(b().id, next)}
              onSelectAnnotation={(annId, rowId) => props.onSelectAnnotation?.(b().id, annId, rowId)}
              onJumpToBaseRow={props.onJumpToBaseRow}
              onOpenIssue={props.onOpenIssue}
              onCreateIssueFromAnnotation={props.onCreateIssueFromAnnotation}
              onOpenMediaLightbox={props.onOpenMediaLightbox}
              onOpenLightbox={props.onOpenLightbox}
            />
          )}
        </If>
      );
    case "preview":
      return (
        <If when={props.block.type === "preview" ? props.block : undefined}>
          {(b) => <PreviewBlockView block={b()} note={props.note} onUpdate={(next) => props.onUpdateBlock(b().id, next)} />}
        </If>
      );
    case "baseEmbed":
      return (
        <If when={props.block.type === "baseEmbed" ? props.block : undefined}>
          {(b) => (
            <BaseEmbedBlockView
              block={b()}
              notes={props.notes}
              issues={props.issues}
              highlightedRowId={props.highlightedBaseRowId}
              annotationByRowId={props.annotationIndex?.byBaseRowId}
              annotationById={props.annotationIndex?.byAnnotationId}
              onUpdate={(next) => props.onUpdateBlock(b().id, next)}
              onOpenNote={props.onOpenNote}
              onOpenIssue={props.onOpenIssue}
              onSelectReviewRow={props.onSelectReviewRow}
            />
          )}
        </If>
      );
    case "issueCard":
      return (
        <If when={props.block.type === "issueCard" ? props.block : undefined}>
          {(b) => (
            <IssueCardBlockView block={b()} issues={props.issues} onUpdate={(next) => props.onUpdateBlock(b().id, next)} onOpenIssue={props.onOpenIssue} />
          )}
        </If>
      );
    case "issueList":
      return (
        <If when={props.block.type === "issueList" ? props.block : undefined}>
          {(b) => (
            <IssueListBlockView block={b()} issues={props.issues} onUpdate={(next) => props.onUpdateBlock(b().id, next)} onOpenIssue={props.onOpenIssue} />
          )}
        </If>
      );
  }
}

export function BlockItem(props: BlockItemProps) {
  const rootEmbedded = () => props.embedded === true && (props.depth ?? 0) === 0;
  const compact = () => (props.depth ?? 0) > 0 || props.compactGutter === true;
  const compactLine = () => props.block.type === "todo" || props.block.type === "list";
  const blockPresences = () => filterRemotePresences(props.presences ?? []).filter((p) => p.nodeId === props.block.id || p.selector === props.block.id);
  const isSelectedSubtle = () =>
    !isCardLikeBlock(props.block.type) && (props.focusedBlockId === props.block.id || props.highlighted === true || blockPresences().length > 0);

  let blockRef: ViewRef | undefined;
  useVdpNode({
    testId: `doc-block-${props.block.id}`,
    role: "group",
    getRef: () => blockRef,
  });

  return (
    <View
      ref={(el) => {
        blockRef = el;
      }}
      testID={`doc-block-${props.block.id}`}
      class={`group relative flex-row items-start rounded-md pr-1 ${compactLine() ? "py-0" : "py-0.5"} ${rootEmbedded() ? "pl-0" : compact() ? "pl-9" : "pl-14"} ${outerBlockSpacingClass(props.block, props.prevBlock)}`}
    >
      <View
        class={`absolute flex-row items-center justify-end gap-0.5 opacity-0 group-hover:opacity-100 focus-within:opacity-100 ${
          compactLine() ? "top-0.5" : "top-1"
        } ${rootEmbedded() ? "-left-8 w-7 pr-0.5" : compact() ? "left-0 w-9 pr-0.5" : "left-0 w-12 pr-1"}`}
      >
        <View
          role="button"
          focusable={false}
          testID={`doc-gutter-add-${props.block.id}`}
          accessibilityLabel={t("web.note.doc.addBlock")}
          onPress={() => props.onInsertAfter(props.block.id, { id: makeBlockId(), type: "prose", text: "" })}
          class={`${compact() ? "size-4" : "size-5"} shrink-0 items-center justify-center rounded-xs hover:bg-hover focus-visible:outline-2 focus-visible:outline-focus`}
        >
          <Icon name="add" size={12} tone="muted" />
        </View>
        <Menu
          placement="bottom"
          align="start"
          offset={4}
          popupClass={menuPopupClass}
          popupStartingClass={popupTransition("opacity-0")}
          popupEndingClass={popupTransition("opacity-0")}
          trigger={
            <View
              testID={`doc-gutter-menu-${props.block.id}`}
              accessibilityLabel={t("web.note.page.more")}
              class={`${compact() ? "size-4" : "size-5"} shrink-0 items-center justify-center rounded-xs hover:bg-hover focus-visible:outline-2 focus-visible:outline-focus aria-expanded:bg-selected aria-expanded:opacity-100`}
            >
              <Icon name="more" size={12} tone="muted" />
            </View>
          }
        >
          <Scroll class="max-h-96" contentClass="gap-0.5">
            <If when={props.block.type === "heading"}>
              <Each of={[1, 2, 3] as const} key={(lv) => `h${lv}`}>
                {(lv) => (
                  <MenuItem
                    testID={`doc-menu-heading-${lv()}-${props.block.id}`}
                    onSelect={() => {
                      if (props.block.type === "heading") {
                        props.onUpdateBlock(props.block.id, { ...props.block, level: lv() });
                      }
                    }}
                    class={menuItemClass}
                  >
                    <Icon name="edit" size={13} tone="muted" />
                    <Text class="min-w-0 flex-1 truncate text-xs text-ink">{`H${lv()}`}</Text>
                  </MenuItem>
                )}
              </Each>
              <MenuSeparator class="my-1 h-px bg-line" />
            </If>
            <If when={props.block.type === "list"}>
              <MenuItem
                testID={`doc-list-toggle-ordered-${props.block.id}`}
                onSelect={() => {
                  if (props.block.type === "list") {
                    props.onUpdateBlock(props.block.id, { ...props.block, ordered: !props.block.ordered });
                  }
                }}
                class={menuItemClass}
              >
                <Icon name="indent" size={13} tone="muted" />
                <Text class="min-w-0 flex-1 truncate text-xs text-ink">
                  {props.block.type === "list" && props.block.ordered ? t("web.note.doc.bulletedList") : t("web.note.doc.orderedList")}
                </Text>
              </MenuItem>
              <MenuItem
                testID={`doc-list-add-${props.block.id}`}
                onSelect={() => {
                  if (props.block.type === "list") {
                    props.onUpdateBlock(props.block.id, { ...props.block, items: [...props.block.items, ""] });
                  }
                }}
                class={menuItemClass}
              >
                <Icon name="add" size={13} tone="muted" />
                <Text class="min-w-0 flex-1 truncate text-xs text-ink">{t("web.note.doc.addBlock")}</Text>
              </MenuItem>
              <MenuSeparator class="my-1 h-px bg-line" />
            </If>
            <If when={props.block.type === "quote"}>
              <MenuItem
                testID={`doc-quote-attr-toggle-${props.block.id}`}
                onSelect={() => {
                  if (props.block.type === "quote") {
                    props.onUpdateBlock(props.block.id, {
                      ...props.block,
                      attribution: props.block.attribution === undefined ? "" : undefined,
                    });
                  }
                }}
                class={menuItemClass}
              >
                <Icon name="reply" size={13} tone="muted" />
                <Text class="min-w-0 flex-1 truncate text-xs text-ink">{t("web.note.doc.attributionPlaceholder")}</Text>
              </MenuItem>
              <MenuSeparator class="my-1 h-px bg-line" />
            </If>
            <If when={props.block.type === "toggle"}>
              <MenuItem
                testID={`doc-toggle-add-child-${props.block.id}`}
                onSelect={() => {
                  if (props.block.type === "toggle") {
                    props.onUpdateBlock(props.block.id, {
                      ...props.block,
                      collapsed: false,
                      children: [...(props.block.children ?? []), { id: makeBlockId(), type: "prose", text: "" }],
                    });
                  }
                }}
                class={menuItemClass}
              >
                <Icon name="add" size={13} tone="muted" />
                <Text class="min-w-0 flex-1 truncate text-xs text-ink">{t("web.note.doc.addBlock")}</Text>
              </MenuItem>
              <MenuSeparator class="my-1 h-px bg-line" />
            </If>
            <If when={props.block.type === "columns"}>
              <MenuItem
                testID={`doc-columns-2-${props.block.id}`}
                onSelect={() => {
                  if (props.block.type === "columns") {
                    const cols = props.block.columns;
                    const next = cols.length === 3 ? [cols[0] ?? { blocks: [] }, { blocks: [...(cols[1]?.blocks ?? []), ...(cols[2]?.blocks ?? [])] }] : cols;
                    props.onUpdateBlock(props.block.id, { ...props.block, columns: next });
                  }
                }}
                class={menuItemClass}
              >
                <Icon name="sidebar" size={13} tone="muted" />
                <Text class="min-w-0 flex-1 truncate text-xs text-ink">{t("web.note.doc.columnsCount", { n: 2 })}</Text>
              </MenuItem>
              <MenuItem
                testID={`doc-columns-3-${props.block.id}`}
                onSelect={() => {
                  if (props.block.type === "columns") {
                    const cols = props.block.columns;
                    const next = cols.length === 2 ? [cols[0] ?? { blocks: [] }, cols[1] ?? { blocks: [] }, { blocks: [] }] : cols;
                    props.onUpdateBlock(props.block.id, { ...props.block, columns: next });
                  }
                }}
                class={menuItemClass}
              >
                <Icon name="sidebar" size={13} tone="muted" />
                <Text class="min-w-0 flex-1 truncate text-xs text-ink">{t("web.note.doc.columnsCount", { n: 3 })}</Text>
              </MenuItem>
              <MenuSeparator class="my-1 h-px bg-line" />
            </If>
            <If when={props.block.type === "kpi"}>
              <MenuItem
                testID={`doc-kpi-add-${props.block.id}`}
                onSelect={() => {
                  if (props.block.type === "kpi") {
                    props.onUpdateBlock(props.block.id, {
                      ...props.block,
                      items: [...props.block.items, { label: t("web.note.doc.slash.kpi.label"), value: "0", delta: "+0%", tone: "good" }],
                    });
                  }
                }}
                class={menuItemClass}
              >
                <Icon name="add" size={13} tone="muted" />
                <Text class="min-w-0 flex-1 truncate text-xs text-ink">{t("web.note.doc.add")}</Text>
              </MenuItem>
              <MenuSeparator class="my-1 h-px bg-line" />
            </If>
            <If when={props.block.type === "pageBreak"}>
              <MenuItem
                testID={`doc-page-break-notes-toggle-${props.block.id}`}
                onSelect={() => {
                  if (props.block.type === "pageBreak") {
                    props.onUpdateBlock(props.block.id, {
                      ...props.block,
                      speakerNotes: props.block.speakerNotes === undefined ? "" : undefined,
                    });
                  }
                }}
                class={menuItemClass}
              >
                <Icon name="notes" size={13} tone="muted" />
                <Text class="min-w-0 flex-1 truncate text-xs text-ink">{t("web.note.doc.speakerNotesPlaceholder")}</Text>
              </MenuItem>
              <MenuSeparator class="my-1 h-px bg-line" />
            </If>
            <MenuItem testID={`doc-menu-up-${props.block.id}`} onSelect={() => props.onMoveBlock(props.block.id, "up")} class={menuItemClass}>
              <Icon name="moveUp" size={13} tone="muted" />
              <Text class="min-w-0 flex-1 truncate text-xs text-ink">{t("web.note.doc.moveUp")}</Text>
            </MenuItem>
            <MenuItem testID={`doc-menu-down-${props.block.id}`} onSelect={() => props.onMoveBlock(props.block.id, "down")} class={menuItemClass}>
              <Icon name="moveDown" size={13} tone="muted" />
              <Text class="min-w-0 flex-1 truncate text-xs text-ink">{t("web.note.doc.moveDown")}</Text>
            </MenuItem>
            <MenuItem testID={`doc-menu-dup-${props.block.id}`} onSelect={() => props.onDuplicateBlock(props.block.id)} class={menuItemClass}>
              <Icon name="copy" size={13} tone="muted" />
              <Text class="min-w-0 flex-1 truncate text-xs text-ink">{t("web.note.doc.duplicate")}</Text>
            </MenuItem>
            <If when={props.onCreateIssueFromBlock !== undefined}>
              <MenuItem
                testID={`doc-menu-issue-${props.block.id}`}
                onSelect={() => {
                  const title = extractBlockTitle(props.block);
                  void props.onCreateIssueFromBlock?.(title, props.block.id);
                }}
                class={menuItemClass}
              >
                <Icon name="issues" size={13} tone="accent" />
                <Text class="min-w-0 flex-1 truncate text-xs text-ink">{t("web.note.doc.convertToIssue")}</Text>
              </MenuItem>
            </If>
            <MenuSeparator class="my-1 h-px bg-line" />
            <Text class="px-2 pt-0.5 pb-0.5 text-2xs font-semibold text-faint">{t("web.note.doc.turnInto")}</Text>
            <Each of={TURN_INTO_OPTIONS} key={(opt) => opt.key}>
              {(opt) => (
                <MenuItem
                  testID={`doc-turn-into-${opt().key}-${props.block.id}`}
                  onSelect={() => {
                    const next = turnBlockInto(props.block, opt().type, {
                      headingLevel: opt().headingLevel,
                      listOrdered: opt().listOrdered,
                    });
                    props.onUpdateBlock(props.block.id, next);
                  }}
                  class={menuItemClass}
                >
                  <Icon name={opt().icon} size={13} tone="muted" />
                  <Text class="min-w-0 flex-1 truncate text-xs text-ink">{slashCommandLabel(opt().key)}</Text>
                  <If when={isTurnIntoActive(props.block, opt())}>
                    <Icon name="check" size={12} tone="accent" />
                  </If>
                </MenuItem>
              )}
            </Each>
            <MenuSeparator class="my-1 h-px bg-line" />
            <MenuItem
              testID={`doc-menu-delete-${props.block.id}`}
              onSelect={() => props.onDeleteBlock(props.block.id)}
              class="h-7 flex-row items-center gap-2 rounded-md px-2 hover:bg-bad-soft focus:bg-bad-soft"
            >
              <Icon name="delete" size={13} tone="berry" />
              <Text class="min-w-0 flex-1 truncate text-xs text-berry">{t("web.note.page.delete")}</Text>
            </MenuItem>
          </Scroll>
        </Menu>
      </View>

      <View class={`min-w-0 flex-1 rounded-sm ${isSelectedSubtle() ? "bg-hover" : ""}`}>
        <Keyed key={props.block.type}>
          {() =>
            renderBlockContent(
              untracked(() => props.block.type),
              props,
            )
          }
        </Keyed>
      </View>
    </View>
  );
}
