import { signal, Text, untracked, View } from "nsh";
import { Input } from "nsh/base";

import { t } from "@vibevalley/i18n";
import type { DocBlock, Issue, IssueId, Note, NoteId } from "@vibevalley/protocol";

import type { BlockEditorTelemetryPatch, FocusRequest } from "./blockEditorShared";
import { makeBlockId } from "./docOps";
import { RichInlineField, type RichInlineFieldRef } from "./RichInlineField";

type ListBlockData = Extract<DocBlock, { type: "list" }>;
type QuoteBlockData = Extract<DocBlock, { type: "quote" }>;

export function ListBlockView(props: {
  readonly block: ListBlockData;
  readonly notes?: readonly Note[] | undefined;
  readonly issues?: readonly Issue[] | undefined;
  readonly focusRequest?: FocusRequest | undefined;
  readonly onFocus: () => void;
  readonly onFocusAdjacent?: ((dir: "prev" | "next") => void) | undefined;
  readonly onUpdate: (next: ListBlockData) => void;
  readonly onInsertAfter: (newBlock: DocBlock) => void;
  readonly onOpenNote?: ((id: NoteId) => void) | undefined;
  readonly onOpenIssue?: ((id: IssueId) => void) | undefined;
  readonly onEditorTelemetry?: ((patch: BlockEditorTelemetryPatch) => void) | undefined;
}) {
  const fieldRefs = new Map<number, RichInlineFieldRef>();
  const focusedItem = signal<number | undefined>(undefined);
  let pendingAutoFocusIdx: number | undefined;

  const focusItemAt = (idx: number, caret: "start" | "end" | number | undefined) => {
    queueMicrotask(() => {
      const items = untracked(() => props.block.items);
      const clampedIdx = Math.max(0, Math.min(Math.max(0, items.length - 1), idx));
      fieldRefs.get(clampedIdx)?.focus(caret);
    });
  };

  const makeItemFocusRequest = (idx: number): FocusRequest | undefined => {
    const req = props.focusRequest;
    if (!req || req.blockId !== props.block.id) return undefined;
    const count = props.block.items.length;
    const targetIdx = req.itemIndex ?? (req.caret === "end" ? Math.max(0, count - 1) : 0);
    return targetIdx === idx ? req : undefined;
  };

  return (
    <View testID={`doc-list-${props.block.id}`} class="relative min-w-0 gap-0">
      <Each of={props.block.items} key={(_, idx) => String(idx)}>
        {(item, idx) => {
          const itemTestId = () => `doc-list-item-${props.block.id}-${idx()}`;
          return (
            <View class="min-w-0 flex-row items-start gap-2">
              <View class="w-4 shrink-0 items-end pt-0.5">
                <Text class="font-mono text-xs leading-5 text-muted">{props.block.ordered ? `${idx() + 1}.` : "•"}</Text>
              </View>
              <View class="min-w-0 flex-1">
                <RichInlineField
                  ref={(api) => {
                    fieldRefs.set(idx(), api);
                  }}
                  testID={itemTestId()}
                  blockId={props.block.id}
                  accessibilityLabel={item() || t("web.note.doc.listItemPlaceholder")}
                  value={item()}
                  placeholder={t("web.note.doc.listItemPlaceholder")}
                  notes={props.notes}
                  issues={props.issues}
                  focused={focusedItem() === idx()}
                  autoFocus={untracked(() => pendingAutoFocusIdx === idx())}
                  focusRequest={makeItemFocusRequest(idx())}
                  contentClass="px-0 py-0.5"
                  textClass="text-sm leading-5 text-ink"
                  onFocus={() => {
                    focusedItem.set(idx());
                    props.onFocus();
                  }}
                  onBlur={() => {
                    if (untracked(focusedItem) === idx()) focusedItem.set(undefined);
                  }}
                  onUpdate={(nextVal) => {
                    const i = idx();
                    const next = [...props.block.items];
                    next[i] = nextVal;
                    props.onUpdate({ ...props.block, items: next });
                  }}
                  onSplit={(beforeMd, afterMd) => {
                    const i = idx();
                    const curItems = props.block.items;
                    if (beforeMd === "" && afterMd === "" && curItems.length > 1 && i === curItems.length - 1) {
                      props.onUpdate({ ...props.block, items: curItems.slice(0, -1) });
                      props.onInsertAfter({ id: makeBlockId(), type: "prose", text: "" });
                      return;
                    }
                    const next = [...curItems];
                    next[i] = beforeMd;
                    next.splice(i + 1, 0, afterMd);
                    pendingAutoFocusIdx = i + 1;
                    props.onUpdate({ ...props.block, items: next });
                    pendingAutoFocusIdx = undefined;
                    focusItemAt(i + 1, "start");
                  }}
                  onMergeBackward={() => {
                    const i = idx();
                    if (i > 0) {
                      const prevItem = props.block.items[i - 1] ?? "";
                      const curItem = props.block.items[i] ?? "";
                      const next = [...props.block.items];
                      next[i - 1] = `${prevItem}${curItem}`;
                      next.splice(i, 1);
                      props.onUpdate({ ...props.block, items: next });
                      focusItemAt(i - 1, prevItem.length);
                    }
                  }}
                  onFocusAdjacent={(dir) => {
                    const i = idx();
                    if (dir === "prev") {
                      if (i > 0) focusItemAt(i - 1, "end");
                      else props.onFocusAdjacent?.("prev");
                    } else {
                      if (i < props.block.items.length - 1) focusItemAt(i + 1, "start");
                      else props.onFocusAdjacent?.("next");
                    }
                  }}
                  onOpenNote={props.onOpenNote}
                  onOpenIssue={props.onOpenIssue}
                  onEditorTelemetry={props.onEditorTelemetry}
                />
              </View>
            </View>
          );
        }}
      </Each>
    </View>
  );
}

export function QuoteBlockView(props: {
  readonly block: QuoteBlockData;
  readonly notes: readonly Note[];
  readonly issues: readonly Issue[];
  readonly focusRequest?: FocusRequest | undefined;
  readonly onFocus: () => void;
  readonly onFocusAdjacent?: ((dir: "prev" | "next") => void) | undefined;
  readonly onMergeBackward?: (() => void) | undefined;
  readonly onUpdate: (next: QuoteBlockData) => void;
  readonly onOpenNote: (id: NoteId) => void;
  readonly onOpenIssue: (id: IssueId) => void;
  readonly onEditorTelemetry?: ((patch: BlockEditorTelemetryPatch) => void) | undefined;
}) {
  return (
    <View testID={`doc-quote-${props.block.id}`} class="min-w-0 flex-row gap-3 py-1">
      <View class="w-0.5 shrink-0 self-stretch rounded-full bg-accent" />
      <View class="min-w-0 flex-1 gap-1">
        <RichInlineField
          testID={`doc-quote-text-${props.block.id}`}
          blockId={props.block.id}
          accessibilityLabel={props.block.text || t("web.note.doc.quotePlaceholder")}
          value={props.block.text}
          placeholder={t("web.note.doc.quotePlaceholder")}
          notes={props.notes}
          issues={props.issues}
          focusRequest={props.focusRequest}
          textClass="text-sm italic leading-6 text-muted"
          onFocus={props.onFocus}
          onUpdate={(nextText) => props.onUpdate({ ...props.block, text: nextText })}
          onMergeBackward={props.onMergeBackward}
          onFocusAdjacent={props.onFocusAdjacent}
          onOpenNote={props.onOpenNote}
          onOpenIssue={props.onOpenIssue}
          onEditorTelemetry={props.onEditorTelemetry}
        />
        <If when={props.block.attribution !== undefined}>
          <Input
            testID={`doc-quote-attr-${props.block.id}`}
            value={props.block.attribution ?? ""}
            placeholder={t("web.note.doc.attributionPlaceholder")}
            multiline
            scrollbar={false}
            submitBehavior="submit"
            onFocus={props.onFocus}
            onChange={(e) => props.onUpdate({ ...props.block, attribution: e.value || undefined })}
            class="min-w-0 w-full bg-transparent px-1 py-0 text-xs text-muted placeholder:text-faint"
          />
        </If>
      </View>
    </View>
  );
}
