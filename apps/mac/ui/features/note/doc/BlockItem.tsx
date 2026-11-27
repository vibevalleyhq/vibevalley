import { computed, effect, signal, Text, untracked, View, type InputRef, type JSX } from "nsh";
import { Input, Menu, MenuItem, MenuSeparator } from "nsh/base";

import { t } from "@vibevalley/i18n";
import type { DocBlock, Issue, IssueId, Note, NoteId } from "@vibevalley/protocol";

import { Button } from "../../../design/Button";
import { Checkbox } from "../../../design/Checkbox";
import { Icon } from "../../../design/Icon";
import type { Picture } from "../../../design/Lightbox";
import { motionClass, popupTransition } from "../../../design/motion";
import { Keyed } from "../../../infra/base/dom";
import {
  applyWikilinkReplacement,
  createDefaultBlock,
  detectSlashTrigger,
  detectWikilinkTrigger,
  extractBlockTitle,
  formatWikilinkToken,
  makeBlockId,
  matchMarkdownInputRule,
  stripSlashTrigger,
  TURN_INTO_OPTIONS,
  turnBlockInto,
  type BlockType,
  type SlashCommandItem,
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
import { InlineRichText } from "./InlineRichText";
import { SlashMenu } from "./SlashMenu";
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
import { WikilinkMenu, type WikilinkSuggestion } from "./WikilinkMenu";

export interface BlockItemProps {
  readonly block: DocBlock;
  readonly allBlocks: readonly DocBlock[];
  readonly slideIndices: ReadonlyMap<string, number>;
  readonly notes: readonly Note[];
  readonly issues: readonly Issue[];
  readonly focusedBlockId?: string | undefined;
  readonly depth?: number | undefined;
  readonly onFocusBlock?: ((id: string) => void) | undefined;
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
}

type ProseBlockData = Extract<DocBlock, { type: "prose" }>;
type HeadingBlockData = Extract<DocBlock, { type: "heading" }>;
type ListBlockData = Extract<DocBlock, { type: "list" }>;
type TodoBlockData = Extract<DocBlock, { type: "todo" }>;
type QuoteBlockData = Extract<DocBlock, { type: "quote" }>;

const menuPopupClass = `min-w-48 max-h-80 gap-0.5 rounded-lg border border-line-strong bg-elevated p-1 shadow-float ${motionClass("transition-opacity duration-120 ease-out")}`;
const menuItemClass = "h-7 flex-row items-center gap-2 rounded-md px-2 hover:bg-hover focus:bg-hover";

function ProseBlockView(props: {
  readonly block: ProseBlockData;
  readonly notes: readonly Note[];
  readonly issues: readonly Issue[];
  readonly focused: boolean;
  readonly onFocus: () => void;
  readonly onUpdate: (next: DocBlock) => void;
  readonly onInsertAfter: (newBlock: DocBlock) => void;
  readonly onDelete: () => void;
  readonly onOpenNote: (id: NoteId) => void;
  readonly onOpenIssue: (id: IssueId) => void;
}) {
  const editing = signal(untracked(() => props.focused || props.block.text === ""));
  const menuDismissedAt = signal<string | undefined>(undefined);
  let inputRef: InputRef | undefined;

  effect(() => {
    if (props.focused) {
      editing.set(true);
      queueMicrotask(() => inputRef?.focus());
    }
  });

  const slashTrigger = computed(() => {
    if (!editing()) return undefined;
    const hit = detectSlashTrigger(props.block.text);
    if (!hit || menuDismissedAt() === props.block.text) return undefined;
    return hit;
  });

  const wikiTrigger = computed(() => {
    if (!editing()) return undefined;
    const hit = detectWikilinkTrigger(props.block.text);
    if (!hit || menuDismissedAt() === props.block.text) return undefined;
    return hit;
  });

  const handleInput = (val: string) => {
    if (untracked(menuDismissedAt) !== undefined) {
      menuDismissedAt.set(undefined);
    }
    const rule = matchMarkdownInputRule(val, props.block.id, false);
    if (rule) {
      props.onUpdate(rule.block);
      return;
    }
    props.onUpdate({ ...props.block, text: val });
  };

  const handleSlashSelect = (item: SlashCommandItem) => {
    const trig = untracked(slashTrigger);
    const cleaned = trig ? stripSlashTrigger(props.block.text, trig.triggerIndex) : props.block.text;
    const created = createDefaultBlock(item.type, {
      id: cleaned === "" ? props.block.id : makeBlockId(),
      headingLevel: item.headingLevel,
      listOrdered: item.listOrdered,
    });
    if (cleaned === "") {
      props.onUpdate(created);
    } else {
      props.onUpdate({ ...props.block, text: cleaned });
      props.onInsertAfter(created);
    }
  };

  const handleWikilinkSelect = (item: WikilinkSuggestion) => {
    const trig = untracked(wikiTrigger);
    if (!trig) return;
    if (trig.mode === "embed") {
      const cleaned = stripSlashTrigger(props.block.text, trig.startIndex);
      const embedBlock: DocBlock =
        item.kind === "note"
          ? { id: cleaned === "" ? props.block.id : makeBlockId(), type: "baseEmbed", noteId: item.note.id }
          : { id: cleaned === "" ? props.block.id : makeBlockId(), type: "issueCard", issueId: item.issue.id };
      if (cleaned === "") {
        props.onUpdate(embedBlock);
      } else {
        props.onUpdate({ ...props.block, text: cleaned });
        props.onInsertAfter(embedBlock);
      }
      return;
    }
    const token =
      trig.mode === "issue" && item.kind === "issue"
        ? `#${item.issue.number}`
        : item.kind === "note"
          ? formatWikilinkToken("note", item.note.id, item.note.title)
          : formatWikilinkToken("issue", item.issue.id, `#${item.issue.number} ${item.issue.title}`);
    const nextText = applyWikilinkReplacement(props.block.text, trig.startIndex, token);
    props.onUpdate({ ...props.block, text: nextText });
  };

  const hasLinks = computed(() => props.block.text.includes("[[") || /(?:^|[\s([,:;])#\d+/u.test(props.block.text));

  return (
    <View testID={`doc-prose-${props.block.id}`} class="relative">
      <If
        when={editing() || !hasLinks()}
        else={
          <InlineRichText
            testID={`doc-prose-rich-${props.block.id}`}
            text={props.block.text}
            placeholder={t("web.note.doc.slashHint")}
            notes={props.notes}
            issues={props.issues}
            onOpenNote={props.onOpenNote}
            onOpenIssue={props.onOpenIssue}
            onPressText={() => {
              editing.set(true);
              props.onFocus();
            }}
          />
        }
      >
        <Input
          ref={(el) => {
            inputRef = el;
          }}
          autoFocus={props.focused}
          multiline
          scrollbar={false}
          testID={`doc-block-input-${props.block.id}`}
          accessibilityLabel={props.block.text || t("web.note.blocks.start")}
          placeholder={props.focused ? t("web.note.doc.slashHint") : t("web.note.blocks.start")}
          value={props.block.text}
          submitBehavior="submit"
          onFocus={() => {
            editing.set(true);
            props.onFocus();
          }}
          onBlur={() => {
            if (!untracked(slashTrigger) && !untracked(wikiTrigger)) {
              editing.set(false);
            }
          }}
          onChange={(e) => handleInput(e.value)}
          onSubmit={() => {
            if (untracked(slashTrigger) || untracked(wikiTrigger)) return;
            const rule = matchMarkdownInputRule(props.block.text, props.block.id, true);
            if (rule) {
              props.onUpdate(rule.block);
              return;
            }
            props.onInsertAfter({ id: makeBlockId(), type: "prose", text: "" });
          }}
          onKeyPress={(e) => {
            if (e.key === "Backspace" && props.block.text === "") {
              props.onDelete();
            }
          }}
          class="min-h-6 w-full rounded-sm border border-transparent bg-transparent px-1 text-sm leading-6 text-ink placeholder:text-faint"
        />
      </If>
      <SlashMenu
        open={slashTrigger() !== undefined}
        query={slashTrigger()?.query ?? ""}
        testID={`doc-slash-menu-${props.block.id}`}
        onSelect={handleSlashSelect}
        onClose={() => menuDismissedAt.set(props.block.text)}
      />
      <WikilinkMenu
        open={slashTrigger() === undefined && wikiTrigger() !== undefined}
        mode={wikiTrigger()?.mode ?? "wikilink"}
        query={wikiTrigger()?.query ?? ""}
        notes={props.notes}
        issues={props.issues}
        testID={`doc-wikilink-menu-${props.block.id}`}
        onSelect={handleWikilinkSelect}
        onClose={() => menuDismissedAt.set(props.block.text)}
      />
    </View>
  );
}

function headingTextClass(level: number): string {
  switch (level) {
    case 1:
      return "text-2xl font-bold leading-8";
    case 2:
      return "text-xl font-semibold leading-7";
    default:
      return "text-lg font-semibold leading-6";
  }
}

function HeadingBlockView(props: {
  readonly block: HeadingBlockData;
  readonly focused: boolean;
  readonly onFocus: () => void;
  readonly onUpdate: (next: HeadingBlockData) => void;
  readonly onInsertAfter: (newBlock: DocBlock) => void;
}) {
  let inputRef: InputRef | undefined;
  effect(() => {
    if (props.focused) queueMicrotask(() => inputRef?.focus());
  });

  return (
    <View testID={`doc-heading-${props.block.id}`} class="mt-2 flex-row items-center gap-2">
      <View
        role="button"
        testID={`doc-heading-level-${props.block.id}`}
        onPress={() => props.onUpdate({ ...props.block, level: props.block.level >= 3 ? 1 : props.block.level + 1 })}
        class="shrink-0 rounded-xs bg-side px-1.5 py-0.5 hover:bg-hover"
      >
        <Text class="font-mono text-2xs font-semibold text-faint">{`H${props.block.level}`}</Text>
      </View>
      <Input
        ref={(el) => {
          inputRef = el;
        }}
        autoFocus={props.focused}
        testID={`doc-block-input-${props.block.id}`}
        value={props.block.text}
        placeholder={`Heading ${props.block.level}`}
        submitBehavior="submit"
        onFocus={props.onFocus}
        onChange={(e) => props.onUpdate({ ...props.block, text: e.value })}
        onSubmit={() => props.onInsertAfter({ id: makeBlockId(), type: "prose", text: "" })}
        class={`min-w-0 flex-1 bg-transparent px-1 text-ink placeholder:text-faint ${headingTextClass(props.block.level)}`}
      />
    </View>
  );
}

function ListBlockView(props: { readonly block: ListBlockData; readonly onUpdate: (next: ListBlockData) => void }) {
  return (
    <View testID={`doc-list-${props.block.id}`} class="gap-1">
      <View class="flex-row items-center justify-between gap-2">
        <View
          role="button"
          testID={`doc-list-toggle-ordered-${props.block.id}`}
          onPress={() => props.onUpdate({ ...props.block, ordered: !props.block.ordered })}
          class="rounded-xs bg-side px-1.5 py-0.5 hover:bg-hover"
        >
          <Text class="font-mono text-2xs text-muted">{props.block.ordered ? "1. Ordered" : "• Bulleted"}</Text>
        </View>
        <Button
          size="compact"
          tone="quiet"
          icon="add"
          testID={`doc-list-add-${props.block.id}`}
          onPress={() => props.onUpdate({ ...props.block, items: [...props.block.items, ""] })}
        >
          {t("web.base.chips.add")}
        </Button>
      </View>
      <Each of={props.block.items} key={(_, idx) => String(idx)}>
        {(item, idx) => (
          <View class="flex-row items-center gap-2">
            <View class="w-5 shrink-0 items-center justify-center">
              <If when={props.block.ordered} else={<View class="size-1.5 rounded-full bg-muted" />}>
                <Text class="font-mono text-xs text-muted tabular-nums">{`${idx() + 1}.`}</Text>
              </If>
            </View>
            <Input
              testID={`doc-list-item-${props.block.id}-${idx()}`}
              value={item()}
              placeholder="List item..."
              submitBehavior="submit"
              onChange={(e) => {
                const next = [...props.block.items];
                next[idx()] = e.value;
                props.onUpdate({ ...props.block, items: next });
              }}
              onSubmit={() => {
                const next = [...props.block.items];
                next.splice(idx() + 1, 0, "");
                props.onUpdate({ ...props.block, items: next });
              }}
              class="min-w-0 flex-1 bg-transparent px-1 py-0.5 text-sm leading-6 text-ink placeholder:text-faint"
            />
            <If when={props.block.items.length > 1}>
              <View
                role="button"
                testID={`doc-list-remove-${props.block.id}-${idx()}`}
                onPress={() => props.onUpdate({ ...props.block, items: props.block.items.filter((_, i) => i !== idx()) })}
                class="rounded-xs p-0.5 opacity-60 hover:bg-bad-soft hover:opacity-100"
              >
                <Icon name="close" size={12} tone="muted" />
              </View>
            </If>
          </View>
        )}
      </Each>
    </View>
  );
}

function TodoBlockView(props: {
  readonly block: TodoBlockData;
  readonly onUpdate: (next: TodoBlockData) => void;
  readonly onInsertAfter: (newBlock: DocBlock) => void;
}) {
  return (
    <View testID={`doc-todo-${props.block.id}`} class="flex-row items-center gap-2 py-0.5">
      <Checkbox
        checked={props.block.checked}
        label={props.block.text || "Todo"}
        testid={`doc-todo-check-${props.block.id}`}
        onChange={(checked) => props.onUpdate({ ...props.block, checked })}
      />
      <Input
        testID={`doc-block-input-${props.block.id}`}
        value={props.block.text}
        placeholder="To-do..."
        submitBehavior="submit"
        onChange={(e) => props.onUpdate({ ...props.block, text: e.value })}
        onSubmit={() => props.onInsertAfter({ id: makeBlockId(), type: "todo", checked: false, text: "" })}
        class={`min-w-0 flex-1 bg-transparent px-1 text-sm leading-6 placeholder:text-faint ${props.block.checked ? "text-muted line-through" : "text-ink"}`}
      />
    </View>
  );
}

function QuoteBlockView(props: {
  readonly block: QuoteBlockData;
  readonly notes: readonly Note[];
  readonly issues: readonly Issue[];
  readonly onUpdate: (next: QuoteBlockData) => void;
  readonly onOpenNote: (id: NoteId) => void;
  readonly onOpenIssue: (id: IssueId) => void;
}) {
  return (
    <View testID={`doc-quote-${props.block.id}`} class="flex-row gap-3 py-1">
      <View class="w-0.5 shrink-0 self-stretch rounded-full bg-accent" />
      <View class="min-w-0 flex-1 gap-1">
        <Input
          multiline
          scrollbar={false}
          testID={`doc-quote-text-${props.block.id}`}
          value={props.block.text}
          placeholder="Quote..."
          onChange={(e) => props.onUpdate({ ...props.block, text: e.value })}
          class="min-h-6 w-full bg-transparent text-sm leading-6 text-ink placeholder:text-faint"
        />
        <If when={props.block.text.includes("[[") || props.block.text.includes("#")}>
          <InlineRichText
            text={props.block.text}
            notes={props.notes}
            issues={props.issues}
            onOpenNote={props.onOpenNote}
            onOpenIssue={props.onOpenIssue}
            textClass="text-xs"
          />
        </If>
        <Input
          testID={`doc-quote-attr-${props.block.id}`}
          value={props.block.attribution ?? ""}
          placeholder="Attribution (optional)"
          onChange={(e) => props.onUpdate({ ...props.block, attribution: e.value || undefined })}
          class="bg-transparent text-xs text-muted placeholder:text-faint"
        />
      </View>
    </View>
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
              onFocus={() => props.onFocusBlock?.(b().id)}
              onUpdate={(next) => props.onUpdateBlock(b().id, next)}
              onInsertAfter={(nb) => props.onInsertAfter(b().id, nb)}
              onDelete={() => props.onDeleteBlock(b().id)}
              onOpenNote={props.onOpenNote}
              onOpenIssue={props.onOpenIssue}
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
              focused={props.focusedBlockId === b().id}
              onFocus={() => props.onFocusBlock?.(b().id)}
              onUpdate={(next) => props.onUpdateBlock(b().id, next)}
              onInsertAfter={(nb) => props.onInsertAfter(b().id, nb)}
            />
          )}
        </If>
      );
    case "list":
      return (
        <If when={props.block.type === "list" ? props.block : undefined}>
          {(b) => <ListBlockView block={b()} onUpdate={(next) => props.onUpdateBlock(b().id, next)} />}
        </If>
      );
    case "todo":
      return (
        <If when={props.block.type === "todo" ? props.block : undefined}>
          {(b) => <TodoBlockView block={b()} onUpdate={(next) => props.onUpdateBlock(b().id, next)} onInsertAfter={(nb) => props.onInsertAfter(b().id, nb)} />}
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
              onUpdate={(next) => props.onUpdateBlock(b().id, next)}
              onOpenNote={props.onOpenNote}
              onOpenIssue={props.onOpenIssue}
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
              renderChild={(child) => (
                <BlockItem
                  block={child}
                  allBlocks={props.allBlocks}
                  slideIndices={props.slideIndices}
                  notes={props.notes}
                  issues={props.issues}
                  focusedBlockId={props.focusedBlockId}
                  depth={(props.depth ?? 0) + 1}
                  onFocusBlock={props.onFocusBlock}
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
                />
              )}
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
          {(b) => <TableBlockView block={b()} onUpdate={(next) => props.onUpdateBlock(b().id, next)} />}
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
              renderChild={(child) => (
                <BlockItem
                  block={child}
                  allBlocks={props.allBlocks}
                  slideIndices={props.slideIndices}
                  notes={props.notes}
                  issues={props.issues}
                  focusedBlockId={props.focusedBlockId}
                  depth={(props.depth ?? 0) + 1}
                  onFocusBlock={props.onFocusBlock}
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
                />
              )}
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
          {(b) => <CompareBlockView block={b()} onUpdate={(next) => props.onUpdateBlock(b().id, next)} />}
        </If>
      );
    case "media":
      return (
        <If when={props.block.type === "media" ? props.block : undefined}>
          {(b) => <MediaBlockView block={b()} onUpdate={(next) => props.onUpdateBlock(b().id, next)} onOpenLightbox={props.onOpenLightbox} />}
        </If>
      );
    case "preview":
      return (
        <If when={props.block.type === "preview" ? props.block : undefined}>
          {(b) => <PreviewBlockView block={b()} onUpdate={(next) => props.onUpdateBlock(b().id, next)} />}
        </If>
      );
    case "baseEmbed":
      return (
        <If when={props.block.type === "baseEmbed" ? props.block : undefined}>
          {(b) => <BaseEmbedBlockView block={b()} notes={props.notes} onUpdate={(next) => props.onUpdateBlock(b().id, next)} onOpenNote={props.onOpenNote} />}
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
  const nested = () => (props.depth ?? 0) > 0;

  return (
    <View testID={`doc-block-${props.block.id}`} class={`group relative flex-row items-start rounded-md py-0.5 pr-1 ${nested() ? "pl-10" : "pl-14"}`}>
      <View
        class={`absolute top-1 left-0 flex-row items-center justify-end gap-0.5 pr-1 opacity-0 group-hover:opacity-100 focus-within:opacity-100 ${
          nested() ? "w-9" : "w-12"
        }`}
      >
        <View
          role="button"
          testID={`doc-gutter-add-${props.block.id}`}
          accessibilityLabel={t("web.note.doc.addBlock")}
          onPress={() => props.onInsertAfter(props.block.id, { id: makeBlockId(), type: "prose", text: "" })}
          class="size-5 shrink-0 items-center justify-center rounded-xs hover:bg-hover focus-visible:outline-2 focus-visible:outline-focus"
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
              class="size-5 shrink-0 items-center justify-center rounded-xs hover:bg-hover focus-visible:outline-2 focus-visible:outline-focus aria-expanded:bg-selected aria-expanded:opacity-100"
            >
              <Icon name="more" size={12} tone="muted" />
            </View>
          }
        >
          <MenuItem testID={`doc-menu-up-${props.block.id}`} onSelect={() => props.onMoveBlock(props.block.id, "up")} class={menuItemClass}>
            <Icon name="moveUp" size={13} tone="muted" />
            <Text class="min-w-0 flex-1 truncate text-xs text-ink">Move up</Text>
          </MenuItem>
          <MenuItem testID={`doc-menu-down-${props.block.id}`} onSelect={() => props.onMoveBlock(props.block.id, "down")} class={menuItemClass}>
            <Icon name="moveDown" size={13} tone="muted" />
            <Text class="min-w-0 flex-1 truncate text-xs text-ink">Move down</Text>
          </MenuItem>
          <MenuItem testID={`doc-menu-dup-${props.block.id}`} onSelect={() => props.onDuplicateBlock(props.block.id)} class={menuItemClass}>
            <Icon name="copy" size={13} tone="muted" />
            <Text class="min-w-0 flex-1 truncate text-xs text-ink">Duplicate</Text>
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
              <Text class="min-w-0 flex-1 truncate text-xs text-ink">Convert to Issue</Text>
            </MenuItem>
          </If>
          <MenuSeparator class="my-1 h-px bg-line" />
          <Text class="px-2 pt-0.5 pb-0.5 text-2xs font-semibold text-faint">Turn into</Text>
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
                <Text class="min-w-0 flex-1 truncate text-xs text-ink">{opt().label}</Text>
                <If when={props.block.type === opt().type}>
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
        </Menu>
      </View>

      <View class="min-w-0 flex-1">
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
