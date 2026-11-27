import { effect, keymap, signal, Text, untracked, View, type CaretEvent, type InputRef } from "nsh";
import { Input } from "nsh/base";

import { t } from "@vibevalley/i18n";
import type { DocBlock } from "@vibevalley/protocol";

import { Checkbox } from "../../../design/Checkbox";
import { useVdpNode } from "../../../infra/vdpProbe";
import { type BlockEditorTelemetryPatch, type FocusRequest, headingTextClass, resolveRequestedCaret, roundBounds } from "./blockEditorShared";
import { makeBlockId } from "./docOps";

type HeadingBlockData = Extract<DocBlock, { type: "heading" }>;
type TodoBlockData = Extract<DocBlock, { type: "todo" }>;

export function HeadingBlockView(props: {
  readonly block: HeadingBlockData;
  readonly focused: boolean;
  readonly focusRequest?: FocusRequest | undefined;
  readonly onFocus: () => void;
  readonly onFocusAdjacent?: ((dir: "prev" | "next") => void) | undefined;
  readonly onSplit?: ((selStart: number, selEnd: number) => void) | undefined;
  readonly onMergeBackward?: (() => void) | undefined;
  readonly onUpdate: (next: HeadingBlockData) => void;
  readonly onInsertAfter: (newBlock: DocBlock) => void;
  readonly onEditorTelemetry?: ((patch: BlockEditorTelemetryPatch) => void) | undefined;
}) {
  const nativeFocused = signal(false);
  const selection = signal<{ readonly start: number; readonly end: number }>({
    start: untracked(() => props.block.text.length),
    end: untracked(() => props.block.text.length),
  });
  let inputRef: InputRef | undefined;
  let handledFocusSeq = 0;

  const inputTestId = `doc-block-input-${props.block.id}`;

  const emitSelectionTelemetry = (sel: { readonly start: number; readonly end: number }, valueOverride?: string) => {
    props.onEditorTelemetry?.({
      focusedBlockId: props.block.id,
      activeTestId: inputTestId,
      value: valueOverride ?? untracked(() => props.block.text),
      selection: sel,
    });
  };

  const handleCaretMove = (e: CaretEvent) => {
    props.onEditorTelemetry?.({
      focusedBlockId: props.block.id,
      activeTestId: inputTestId,
      value: untracked(() => props.block.text),
      selection: untracked(selection),
      caretBounds: roundBounds(e.bounds),
      caretPageBounds: roundBounds(e.pageBounds),
    });
  };

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
      const nextSel = { start: pos, end: pos };
      selection.set(nextSel);
      emitSelectionTelemetry(nextSel);
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

  effect(() => {
    if (!nativeFocused()) return;
    return keymap.bind(
      {
        up: () => props.onFocusAdjacent?.("prev"),
        down: () => props.onFocusAdjacent?.("next"),
      },
      { when: "always" },
    );
  });

  return (
    <View testID={`doc-heading-${props.block.id}`} class="flex-row items-center gap-2 py-0.5">
      <Input
        ref={(el) => {
          inputRef = el;
        }}
        testID={inputTestId}
        value={props.block.text}
        placeholder={t("web.note.doc.headingPlaceholder", { level: props.block.level })}
        submitBehavior="submit"
        onFocus={() => {
          nativeFocused.set(true);
          props.onFocus();
          emitSelectionTelemetry(untracked(selection));
        }}
        onBlur={() => nativeFocused.set(false)}
        onSelectionChange={(e) => {
          const nextSel = { start: e.start, end: e.end };
          selection.set(nextSel);
          emitSelectionTelemetry(nextSel);
        }}
        onCaretMove={props.onEditorTelemetry ? handleCaretMove : undefined}
        onChange={(e) => {
          const prevLen = props.block.text.length;
          const nextCaret = Math.max(0, Math.min(e.value.length, untracked(selection).end + (e.value.length - prevLen)));
          const nextSel = { start: nextCaret, end: nextCaret };
          selection.set(nextSel);
          props.onUpdate({ ...props.block, text: e.value });
          emitSelectionTelemetry(nextSel, e.value);
        }}
        onSubmit={() => {
          if (props.onSplit) {
            const curSel = untracked(selection);
            props.onSplit(curSel.start, curSel.end);
          } else {
            props.onInsertAfter({ id: makeBlockId(), type: "prose", text: "" });
          }
        }}
        onKeyPress={(e) => {
          if (e.key === "Backspace") {
            const curSel = untracked(selection);
            if (curSel.start === 0 && curSel.end === 0) {
              props.onMergeBackward?.();
            }
          }
        }}
        class={`min-w-0 flex-1 bg-transparent px-1 py-0 text-ink placeholder:text-faint ${headingTextClass(props.block.level)}`}
      />
      <View
        role="button"
        focusable={false}
        testID={`doc-heading-level-${props.block.id}`}
        onPress={() => props.onUpdate({ ...props.block, level: props.block.level >= 3 ? 1 : props.block.level + 1 })}
        class={`shrink-0 rounded-xs bg-side px-1.5 py-0.5 hover:bg-hover ${
          props.focused ? "opacity-100" : "opacity-0 group-hover:opacity-100 focus-within:opacity-100"
        }`}
      >
        <Text class="font-mono text-2xs font-semibold text-faint">{`H${props.block.level}`}</Text>
      </View>
    </View>
  );
}

export function TodoBlockView(props: {
  readonly block: TodoBlockData;
  readonly focusRequest?: FocusRequest | undefined;
  readonly onFocus: () => void;
  readonly onFocusAdjacent?: ((dir: "prev" | "next") => void) | undefined;
  readonly onSplit?: ((selStart: number, selEnd: number) => void) | undefined;
  readonly onMergeBackward?: (() => void) | undefined;
  readonly onUpdate: (next: TodoBlockData) => void;
  readonly onInsertAfter: (newBlock: DocBlock) => void;
  readonly onEditorTelemetry?: ((patch: BlockEditorTelemetryPatch) => void) | undefined;
}) {
  const nativeFocused = signal(false);
  const selection = signal<{ readonly start: number; readonly end: number }>({
    start: untracked(() => props.block.text.length),
    end: untracked(() => props.block.text.length),
  });
  let inputRef: InputRef | undefined;
  let handledFocusSeq = 0;

  const inputTestId = `doc-block-input-${props.block.id}`;

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
      const nextSel = { start: pos, end: pos };
      selection.set(nextSel);
      props.onEditorTelemetry?.({
        focusedBlockId: props.block.id,
        activeTestId: inputTestId,
        value: untracked(() => props.block.text),
        selection: nextSel,
      });
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

  effect(() => {
    if (!nativeFocused()) return;
    return keymap.bind(
      {
        up: () => props.onFocusAdjacent?.("prev"),
        down: () => props.onFocusAdjacent?.("next"),
      },
      { when: "always" },
    );
  });

  return (
    <View testID={`doc-todo-${props.block.id}`} class="flex-row items-center gap-2 py-0.5">
      <Checkbox
        checked={props.block.checked}
        label={props.block.text || t("web.note.doc.slash.todo.label")}
        testid={`doc-todo-check-${props.block.id}`}
        onChange={(checked) => props.onUpdate({ ...props.block, checked })}
      />
      <Input
        ref={(el) => {
          inputRef = el;
        }}
        testID={inputTestId}
        value={props.block.text}
        placeholder={t("web.note.doc.todoPlaceholder")}
        submitBehavior="submit"
        onFocus={() => {
          nativeFocused.set(true);
          props.onFocus();
          props.onEditorTelemetry?.({
            focusedBlockId: props.block.id,
            activeTestId: inputTestId,
            value: props.block.text,
            selection: untracked(selection),
          });
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
        onChange={(e) => {
          const prevLen = props.block.text.length;
          const nextCaret = Math.max(0, Math.min(e.value.length, untracked(selection).end + (e.value.length - prevLen)));
          selection.set({ start: nextCaret, end: nextCaret });
          props.onUpdate({ ...props.block, text: e.value });
        }}
        onSubmit={() => {
          if (props.onSplit) {
            const curSel = untracked(selection);
            props.onSplit(curSel.start, curSel.end);
          } else {
            props.onInsertAfter({ id: makeBlockId(), type: "todo", checked: false, text: "" });
          }
        }}
        onKeyPress={(e) => {
          if (e.key === "Backspace") {
            const curSel = untracked(selection);
            if (curSel.start === 0 && curSel.end === 0) {
              props.onMergeBackward?.();
            }
          }
        }}
        class={`min-w-0 flex-1 bg-transparent px-1 py-0 text-sm leading-6 placeholder:text-faint ${props.block.checked ? "text-muted line-through" : "text-ink"}`}
      />
    </View>
  );
}
