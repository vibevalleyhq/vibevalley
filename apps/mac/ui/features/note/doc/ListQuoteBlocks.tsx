import { computed, effect, keymap, signal, Text, untracked, View, type InputRef } from "nsh";
import { Input } from "nsh/base";

import { t } from "@vibevalley/i18n";
import type { DocBlock, Issue, IssueId, Note, NoteId } from "@vibevalley/protocol";

import { Button } from "../../../design/Button";
import { Icon } from "../../../design/Icon";
import { useVdpNode, VdpAnchor } from "../../../infra/vdpProbe";
import { type BlockEditorTelemetryPatch, type FocusRequest, resolveRequestedCaret, roundBounds } from "./blockEditorShared";
import { isCaretOnFirstLine, isCaretOnLastLine, makeBlockId } from "./docOps";
import { InlineRichText } from "./InlineRichText";

type ListBlockData = Extract<DocBlock, { type: "list" }>;
type QuoteBlockData = Extract<DocBlock, { type: "quote" }>;

export function ListBlockView(props: {
  readonly block: ListBlockData;
  readonly focusRequest?: FocusRequest | undefined;
  readonly onFocus: () => void;
  readonly onFocusAdjacent?: ((dir: "prev" | "next") => void) | undefined;
  readonly onUpdate: (next: DocBlock) => void;
  readonly onInsertAfter: (newBlock: DocBlock) => void;
  readonly onEditorTelemetry?: ((patch: BlockEditorTelemetryPatch) => void) | undefined;
}) {
  const activeIdx = signal<number | undefined>(undefined);
  const inputRefs = new Map<number, InputRef>();
  const itemSelections = new Map<number, { readonly start: number; readonly end: number }>();
  let handledFocusSeq = 0;

  const focusItemAt = (idx: number, caret: "start" | "end" | number | undefined) => {
    queueMicrotask(() => {
      const items = untracked(() => props.block.items);
      const clampedIdx = Math.max(0, Math.min(Math.max(0, items.length - 1), idx));
      const ref = inputRefs.get(clampedIdx);
      if (!ref) return;
      const itemText = items[clampedIdx] ?? "";
      const pos = resolveRequestedCaret(caret, itemText.length);
      ref.focus();
      ref.setSelection(pos, pos);
      const nextSel = { start: pos, end: pos };
      itemSelections.set(clampedIdx, nextSel);
      props.onEditorTelemetry?.({
        focusedBlockId: props.block.id,
        activeTestId: `doc-list-item-${props.block.id}-${clampedIdx}`,
        value: itemText,
        selection: nextSel,
      });
    });
  };

  effect(() => {
    const req = props.focusRequest;
    if (!req || req.blockId !== props.block.id || req.seq === handledFocusSeq) return;
    handledFocusSeq = req.seq;
    const items = untracked(() => props.block.items);
    const targetIdx = req.itemIndex ?? (req.caret === "end" ? Math.max(0, items.length - 1) : 0);
    focusItemAt(targetIdx, req.caret);
  });

  effect(() => {
    const curIdx = activeIdx();
    if (curIdx === undefined) return;
    return keymap.bind(
      {
        up: () => {
          if (curIdx > 0) focusItemAt(curIdx - 1, "end");
          else props.onFocusAdjacent?.("prev");
        },
        down: () => {
          const count = untracked(() => props.block.items.length);
          if (curIdx < count - 1) focusItemAt(curIdx + 1, "start");
          else props.onFocusAdjacent?.("next");
        },
      },
      { when: "always" },
    );
  });

  return (
    <View testID={`doc-list-${props.block.id}`} class="relative gap-1">
      <Each of={props.block.items} key={(_, idx) => String(idx)}>
        {(item, idx) => {
          const itemTestId = () => `doc-list-item-${props.block.id}-${idx()}`;
          return (
            <View class="flex-row items-center gap-2">
              <View class="w-4 shrink-0 items-center justify-center">
                <If when={props.block.ordered} else={<View class="size-1.5 rounded-full bg-muted" />}>
                  <Text class="font-mono text-xs text-muted tabular-nums">{`${idx() + 1}.`}</Text>
                </If>
              </View>
              <VdpAnchor
                testId={itemTestId()}
                role="textbox"
                text={() => item()}
                getRef={() => inputRefs.get(idx())}
                onPress={() => {
                  props.onFocus();
                  focusItemAt(idx(), "end");
                }}
              />
              <Input
                ref={(el) => {
                  inputRefs.set(idx(), el);
                }}
                testID={itemTestId()}
                value={item()}
                placeholder={t("web.note.doc.listItemPlaceholder")}
                submitBehavior="submit"
                onFocus={() => {
                  const i = idx();
                  activeIdx.set(i);
                  props.onFocus();
                  const sel = itemSelections.get(i) ?? { start: item().length, end: item().length };
                  props.onEditorTelemetry?.({
                    focusedBlockId: props.block.id,
                    activeTestId: itemTestId(),
                    value: item(),
                    selection: sel,
                  });
                }}
                onBlur={() => {
                  if (untracked(activeIdx) === idx()) activeIdx.set(undefined);
                }}
                onSelectionChange={(e) => {
                  const i = idx();
                  const nextSel = { start: e.start, end: e.end };
                  itemSelections.set(i, nextSel);
                  props.onEditorTelemetry?.({
                    focusedBlockId: props.block.id,
                    activeTestId: itemTestId(),
                    value: item(),
                    selection: nextSel,
                  });
                }}
                onCaretMove={
                  props.onEditorTelemetry
                    ? (e) => {
                        const i = idx();
                        props.onEditorTelemetry?.({
                          focusedBlockId: props.block.id,
                          activeTestId: itemTestId(),
                          value: item(),
                          selection: itemSelections.get(i) ?? { start: 0, end: 0 },
                          caretBounds: roundBounds(e.bounds),
                          caretPageBounds: roundBounds(e.pageBounds),
                        });
                      }
                    : undefined
                }
                onChange={(e) => {
                  const i = idx();
                  const prevVal = props.block.items[i] ?? "";
                  const prevSel = itemSelections.get(i)?.end ?? prevVal.length;
                  const nextCaret = Math.max(0, Math.min(e.value.length, prevSel + (e.value.length - prevVal.length)));
                  itemSelections.set(i, { start: nextCaret, end: nextCaret });
                  const next = [...props.block.items];
                  next[i] = e.value;
                  props.onUpdate({ ...props.block, items: next });
                }}
                onSubmit={() => {
                  const i = idx();
                  const curItems = props.block.items;
                  const curText = curItems[i] ?? "";
                  if (curText === "" && curItems.length === 1) {
                    props.onUpdate({ id: props.block.id, type: "prose", text: "" });
                    return;
                  }
                  if (curText === "" && i === curItems.length - 1) {
                    props.onUpdate({ ...props.block, items: curItems.slice(0, -1) });
                    props.onInsertAfter({ id: makeBlockId(), type: "prose", text: "" });
                    return;
                  }
                  const sel = itemSelections.get(i) ?? { start: curText.length, end: curText.length };
                  const s = Math.max(0, Math.min(curText.length, Math.min(sel.start, sel.end)));
                  const e = Math.max(0, Math.min(curText.length, Math.max(sel.start, sel.end)));
                  const next = [...curItems];
                  next[i] = curText.slice(0, s);
                  next.splice(i + 1, 0, curText.slice(e));
                  props.onUpdate({ ...props.block, items: next });
                  focusItemAt(i + 1, 0);
                }}
                onKeyPress={(e) => {
                  if (e.key !== "Backspace") return;
                  const i = idx();
                  const curText = props.block.items[i] ?? "";
                  const sel = itemSelections.get(i) ?? { start: curText.length, end: curText.length };
                  if (sel.start !== 0 || sel.end !== 0) return;
                  if (i > 0) {
                    const prevItem = props.block.items[i - 1] ?? "";
                    const joinOffset = prevItem.length;
                    const next = [...props.block.items];
                    next[i - 1] = `${prevItem}${curText}`;
                    next.splice(i, 1);
                    props.onUpdate({ ...props.block, items: next });
                    focusItemAt(i - 1, joinOffset);
                  } else if (props.block.items.length === 1) {
                    props.onUpdate({ id: props.block.id, type: "prose", text: curText });
                  }
                }}
                class="min-w-0 flex-1 bg-transparent px-1 py-0 text-sm leading-6 text-ink placeholder:text-faint"
              />
              <If when={props.block.items.length > 1}>
                <View
                  role="button"
                  focusable={false}
                  testID={`doc-list-remove-${props.block.id}-${idx()}`}
                  onPress={() => props.onUpdate({ ...props.block, items: props.block.items.filter((_, i) => i !== idx()) })}
                  class="rounded-xs p-0.5 opacity-0 group-hover:opacity-60 hover:bg-bad-soft hover:opacity-100"
                >
                  <Icon name="close" size={12} tone="muted" />
                </View>
              </If>
            </View>
          );
        }}
      </Each>
      <View class="flex-row items-center justify-between gap-2 pl-6 opacity-0 group-hover:opacity-100 focus-within:opacity-100">
        <View
          role="button"
          focusable={false}
          testID={`doc-list-toggle-ordered-${props.block.id}`}
          onPress={() => props.onUpdate({ ...props.block, ordered: !props.block.ordered })}
          class="rounded-xs bg-side px-1.5 py-0.5 hover:bg-hover"
        >
          <Text class="font-mono text-2xs text-muted">{props.block.ordered ? t("web.note.doc.orderedList") : t("web.note.doc.bulletedList")}</Text>
        </View>
        <Button
          size="compact"
          tone="quiet"
          icon="add"
          testID={`doc-list-add-${props.block.id}`}
          onPress={() => {
            const nextIdx = props.block.items.length;
            props.onUpdate({ ...props.block, items: [...props.block.items, ""] });
            focusItemAt(nextIdx, 0);
          }}
        >
          {t("web.note.doc.add")}
        </Button>
      </View>
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
  const nativeFocused = signal(false);
  const selection = signal<{ readonly start: number; readonly end: number }>({
    start: untracked(() => props.block.text.length),
    end: untracked(() => props.block.text.length),
  });
  let inputRef: InputRef | undefined;
  let handledFocusSeq = 0;

  const inputTestId = `doc-quote-text-${props.block.id}`;

  effect(() => {
    const req = props.focusRequest;
    if (!req || req.blockId !== props.block.id || req.seq === handledFocusSeq) return;
    handledFocusSeq = req.seq;
    queueMicrotask(() => {
      if (!inputRef) return;
      const len = untracked(() => props.block.text.length);
      const pos = resolveRequestedCaret(req.caret, len);
      inputRef.focus();
      inputRef.setSelection(pos, pos);
      selection.set({ start: pos, end: pos });
    });
  });

  useVdpNode({
    testId: inputTestId,
    role: "textbox",
    text: () => props.block.text,
    getRef: () => inputRef,
    onPress: () => {
      props.onFocus();
      queueMicrotask(() => inputRef?.focus());
    },
  });

  const canMoveUp = computed(() => nativeFocused() && selection().start === selection().end && isCaretOnFirstLine(props.block.text, selection().start));
  const canMoveDown = computed(() => nativeFocused() && selection().start === selection().end && isCaretOnLastLine(props.block.text, selection().end));

  effect(() => {
    const up = canMoveUp();
    const down = canMoveDown();
    if (!up && !down) return;
    const offs: (() => void)[] = [];
    if (up) offs.push(keymap.bind("up", () => props.onFocusAdjacent?.("prev"), { when: "always" }));
    if (down) offs.push(keymap.bind("down", () => props.onFocusAdjacent?.("next"), { when: "always" }));
    return () => {
      for (const off of offs) off();
    };
  });

  return (
    <View testID={`doc-quote-${props.block.id}`} class="flex-row gap-3 py-1">
      <View class="w-0.5 shrink-0 self-stretch rounded-full bg-accent" />
      <View class="min-w-0 flex-1 gap-1">
        <Input
          ref={(el) => {
            inputRef = el;
          }}
          multiline
          scrollbar={false}
          testID={inputTestId}
          value={props.block.text}
          placeholder={t("web.note.doc.quotePlaceholder")}
          onFocus={() => {
            nativeFocused.set(true);
            props.onFocus();
          }}
          onBlur={() => nativeFocused.set(false)}
          onSelectionChange={(e) => {
            const nextSel = { start: e.start, end: e.end };
            selection.set(nextSel);
            props.onEditorTelemetry?.({
              focusedBlockId: props.block.id,
              activeTestId: inputTestId,
              value: props.block.text,
              selection: nextSel,
            });
          }}
          onCaretMove={
            props.onEditorTelemetry
              ? (e) => {
                  props.onEditorTelemetry?.({
                    focusedBlockId: props.block.id,
                    activeTestId: inputTestId,
                    value: props.block.text,
                    selection: untracked(selection),
                    caretBounds: roundBounds(e.bounds),
                    caretPageBounds: roundBounds(e.pageBounds),
                  });
                }
              : undefined
          }
          onChange={(e) => props.onUpdate({ ...props.block, text: e.value })}
          onKeyPress={(e) => {
            if (e.key === "Backspace") {
              const curSel = untracked(selection);
              if (curSel.start === 0 && curSel.end === 0) {
                props.onMergeBackward?.();
              }
            }
          }}
          class="min-h-6 w-full bg-transparent px-1 py-0 text-sm leading-6 text-ink placeholder:text-faint"
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
          placeholder={t("web.note.doc.attributionPlaceholder")}
          onChange={(e) => props.onUpdate({ ...props.block, attribution: e.value || undefined })}
          class={`bg-transparent px-1 text-xs text-muted placeholder:text-faint ${
            props.block.attribution ? "opacity-100" : "opacity-0 group-hover:opacity-100 focus:opacity-100"
          }`}
        />
      </View>
    </View>
  );
}
