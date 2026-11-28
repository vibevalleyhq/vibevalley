import { computed, cleanup, effect, signal, Text, untracked, View, type ViewRef } from "nsh";
import {
  Bold,
  Code,
  createRichEditor,
  defineExtension,
  Document,
  HardBreak,
  History,
  Italic,
  Paragraph,
  RichEditor,
  RichEditorPlugin,
  richExtension,
  RichLink,
  Strike,
  deleteRange,
  insertContentAt,
  insertText,
  markdown,
  setTextSelection,
  toggleMark,
  typographyRules,
  type RichEditorSelection,
  type RichNodeJSON,
  type RichSelectionJSON,
} from "nsh/base";

import { t } from "@vibevalley/i18n";
import type { Issue, IssueId, Note, NoteId } from "@vibevalley/protocol";
import { issueId, noteId } from "@vibevalley/protocol/schema";

import { Icon } from "../../../design/Icon";
import { Dot } from "../../../design/Tag";
import { useTimeout } from "../../../infra/base/timer";
import { useVdpNode, VdpAnchor } from "../../../infra/vdpProbe";
import type { BlockEditorTelemetryPatch, FocusRequest } from "./blockEditorShared";
import { ISSUE_STATUS_DOT_TONE, resolveIssueRef } from "./docOps";
import { createVvRefNode, markdownToRichDoc, richDocToMarkdown, splitRichDocToParagraphMarkdowns, type VvRefAttrs } from "./richInlineCodec";

export interface RichInlineCaretContext {
  readonly plainBeforeCaret: string;
  readonly pmFrom: number;
  readonly pmTo: number;
  readonly pmPositions: readonly number[];
  readonly selectionEmpty: boolean;
  readonly onFirstLine: boolean;
  readonly onLastLine: boolean;
  readonly atStart: boolean;
  readonly atEnd: boolean;
}

export interface RichInlineFieldRef {
  focus: (caret?: "start" | "end" | number) => void;
  blur: () => void;
  applyMark: (mark: "bold" | "italic" | "code" | "strike") => void;
  insertText: (text: string) => void;
  insertVvRef: (attrs: VvRefAttrs, trailingSpace?: boolean) => void;
  replaceRangeWithVvRef: (pmFrom: number, pmTo: number, attrs: VvRefAttrs, trailingSpace?: boolean) => void;
  deleteRangeAndSync: (pmFrom: number, pmTo: number) => string;
}

function paragraphEndPos(doc: RichNodeJSON | undefined): number {
  const first = doc?.content?.[0];
  if (!first || !first.content) return 1;
  let size = 0;
  for (const child of first.content) {
    if (child.type === "text") {
      size += (child.text ?? "").length;
    } else {
      size += 1;
    }
  }
  return 1 + size;
}

function resolveCaretPmPos(doc: RichNodeJSON | undefined, target: "start" | "end" | number | undefined): number {
  if (target === "start") return 1;
  const end = paragraphEndPos(doc);
  if (target === "end" || target === undefined) return end;
  const first = doc?.content?.[0];
  if (!first || !first.content) return 1;
  let offset = Math.max(0, target);
  let pmCursor = 1;
  for (const child of first.content) {
    const len = child.type === "text" ? (child.text ?? "").length : 1;
    if (offset <= len) return pmCursor + offset;
    offset -= len;
    pmCursor += len;
  }
  return end;
}

function normalizeSelection(sel: RichEditorSelection | RichSelectionJSON | undefined): RichEditorSelection {
  if (!sel) return { kind: "text", anchor: 1, head: 1, from: 1, to: 1, empty: true };
  if ("from" in sel && typeof sel.from === "number" && typeof sel.to === "number") {
    const kind: RichEditorSelection["kind"] = sel.kind === "node" || sel.kind === "all" ? sel.kind : "text";
    return {
      kind,
      anchor: typeof sel.anchor === "number" ? sel.anchor : sel.from,
      head: typeof sel.head === "number" ? sel.head : sel.to,
      from: sel.from,
      to: sel.to,
      empty: typeof sel.empty === "boolean" ? sel.empty : sel.from === sel.to,
    };
  }
  const anchor = typeof sel.anchor === "number" ? sel.anchor : 1;
  const head = typeof sel.head === "number" ? sel.head : anchor;
  const from = Math.min(anchor, head);
  const to = Math.max(anchor, head);
  const kind: RichEditorSelection["kind"] = "type" in sel && (sel.type === "node" || sel.type === "all") ? sel.type : "text";
  return {
    kind,
    anchor,
    head,
    from,
    to,
    empty: from === to,
  };
}

function buildCaretContext(doc: RichNodeJSON | undefined, rawSel: RichEditorSelection | RichSelectionJSON): RichInlineCaretContext {
  const sel = normalizeSelection(rawSel);
  const first = doc?.content?.[0];
  const children = first?.content ?? [];
  const endPos = paragraphEndPos(doc);
  let pmCursor = 1;
  let plainBeforeCaret = "";
  const pmPositions: number[] = [];
  let hasBreakAfterCaret = false;

  for (const child of children) {
    if (child.type === "text") {
      const txt = child.text ?? "";
      for (let i = 0; i < txt.length; i++) {
        const pos = pmCursor + i;
        if (pos < sel.to) {
          plainBeforeCaret += txt[i];
          pmPositions.push(pos);
        }
      }
      pmCursor += txt.length;
    } else if (child.type === "hardBreak") {
      if (pmCursor < sel.to) {
        plainBeforeCaret += "\n";
        pmPositions.push(pmCursor);
      } else {
        hasBreakAfterCaret = true;
      }
      pmCursor += 1;
    } else {
      if (pmCursor < sel.to) {
        plainBeforeCaret += "\uFFFC";
        pmPositions.push(pmCursor);
      }
      pmCursor += 1;
    }
  }

  return {
    plainBeforeCaret,
    pmFrom: sel.from,
    pmTo: sel.to,
    pmPositions,
    selectionEmpty: sel.empty,
    onFirstLine: !plainBeforeCaret.includes("\n"),
    onLastLine: !hasBreakAfterCaret,
    atStart: sel.empty && sel.from <= 1,
    atEnd: sel.empty && sel.to >= endPos,
  };
}

export function RichInlineField(props: {
  readonly testID: string;
  readonly blockId?: string | undefined;
  readonly accessibilityLabel?: string | undefined;
  readonly value: string;
  readonly placeholder?: string | undefined;
  readonly editable?: boolean | undefined;
  readonly notes?: readonly Note[] | undefined;
  readonly issues?: readonly Issue[] | undefined;
  readonly focused?: boolean | undefined;
  readonly autoFocus?: boolean | undefined;
  readonly focusRequest?: FocusRequest | undefined;
  readonly popupOpen?: boolean | undefined;
  readonly showBubbleMenu?: boolean | undefined;
  readonly enterBehavior?: "split" | "submit" | undefined;
  readonly lineHeightPx?: number | undefined;
  readonly class?: string | undefined;
  readonly contentClass?: string | undefined;
  readonly textClass?: string | undefined;
  readonly ref?: ((api: RichInlineFieldRef) => void) | undefined;
  readonly onUpdate: (nextMarkdown: string, ctx: RichInlineCaretContext) => void;
  readonly onSplit?: ((beforeMarkdown: string, afterMarkdown: string) => void) | undefined;
  readonly onEnter?: ((currentMarkdown: string) => void) | undefined;
  readonly onSubmit?: (() => void) | undefined;
  readonly onTab?: ((shiftKey: boolean) => boolean) | undefined;
  readonly onMergeBackward?: (() => void) | undefined;
  readonly onFocusAdjacent?: ((dir: "prev" | "next") => void) | undefined;
  readonly onCapturedPopupKey?: ((key: string) => void) | undefined;
  readonly onSelectionChange?: ((ctx: RichInlineCaretContext) => void) | undefined;
  readonly onFocus?: (() => void) | undefined;
  readonly onBlur?: (() => void) | undefined;
  readonly onOpenNote?: ((id: NoteId) => void) | undefined;
  readonly onOpenIssue?: ((id: IssueId) => void) | undefined;
  readonly onEditorTelemetry?: ((patch: BlockEditorTelemetryPatch) => void) | undefined;
}) {
  const initialMarkdown = untracked(() => props.value);
  let lastKnownMarkdown = initialMarkdown;
  let handledFocusSeq = 0;
  let pendingCaretTarget: "start" | "end" | number | undefined = untracked(() =>
    props.focusRequest !== undefined && props.focusRequest.blockId === props.blockId ? props.focusRequest.caret : undefined,
  );
  const autoFocusOnMount = untracked(
    () => props.autoFocus === true || (props.focusRequest !== undefined && props.blockId !== undefined && props.focusRequest.blockId === props.blockId),
  );
  const focusRetryTimer = useTimeout();

  const focused = signal(false);
  const selState = signal<RichEditorSelection>({
    kind: "text",
    anchor: 1,
    head: 1,
    from: 1,
    to: 1,
    empty: true,
  });
  const docRevision = signal(0);

  const pluginPrefix = untracked(() => props.testID);
  const popupPlugin = new RichEditorPlugin(`vv-popup-${pluginPrefix}`);
  popupPlugin.captureKeys(["ArrowUp", "ArrowDown", "Enter", "Tab", "Escape"], (key) => {
    props.onCapturedPopupKey?.(key);
  });

  const backspacePlugin = new RichEditorPlugin(`vv-bs-${pluginPrefix}`);
  backspacePlugin.captureKeys(["Backspace"], () => {
    props.onMergeBackward?.();
  });

  const upPlugin = new RichEditorPlugin(`vv-up-${pluginPrefix}`);
  upPlugin.captureKeys(["ArrowUp"], () => {
    props.onFocusAdjacent?.("prev");
  });

  const downPlugin = new RichEditorPlugin(`vv-down-${pluginPrefix}`);
  downPlugin.captureKeys(["ArrowDown"], () => {
    props.onFocusAdjacent?.("next");
  });

  const submitPlugin = new RichEditorPlugin(`vv-submit-${pluginPrefix}`);
  submitPlugin.captureKeys(["Enter"], () => {
    props.onSubmit?.();
  });

  const tabPlugin = new RichEditorPlugin(`vv-tab-${pluginPrefix}`);
  tabPlugin.captureKeys(["Tab", "Shift-Tab"], (key) => {
    props.onTab?.(key === "Shift-Tab");
  });

  const vvRefExtension = defineExtension({
    name: "vvRef",
    node: {
      group: "inline",
      inline: true,
      atom: true,
      selectable: true,
      attrs: {
        kind: { default: "note" },
        id: { default: "" },
        label: { default: "" },
        embed: { default: false },
        raw: { default: "" },
      },
    },
    addNodeView: () => (nodeProps) => {
      const attrs = computed(() => nodeProps.node.attrs as Partial<VvRefAttrs>);
      const kind = computed(() => attrs().kind ?? "issueNumber");
      const refId = computed(() => attrs().id ?? "");
      const isEmbed = computed(() => Boolean(attrs().embed));
      const resolvedNote = computed(() => {
        if (kind() !== "note") return undefined;
        return (props.notes ?? []).find((n) => n.id === refId());
      });
      const resolvedIssue = computed(() => {
        if (kind() === "note") return undefined;
        return resolveIssueRef(props.issues ?? [], refId());
      });
      const pillTestId = computed(() => {
        if (kind() === "note") return `doc-inline-note-${refId()}`;
        const iss = resolvedIssue();
        if (kind() === "issue" && iss) return `doc-inline-issue-${iss.number}`;
        return `doc-inline-issue-${refId()}`;
      });
      const displayLabel = computed(() => {
        const attrLabel = attrs().label;
        const customLabel = typeof attrLabel === "string" && attrLabel.length > 0 ? attrLabel : undefined;
        if (kind() === "note") {
          const note = resolvedNote();
          const title = note?.title ?? customLabel ?? refId();
          return isEmbed() ? `! ${title}` : title;
        }
        const iss = resolvedIssue();
        if (iss) {
          return `${isEmbed() ? "! " : ""}#${iss.number} ${iss.title}`;
        }
        const fallback = customLabel ?? `#${refId()}`;
        return isEmbed() ? `! ${fallback}` : fallback;
      });
      return (
        <View
          role="button"
          testID={pillTestId()}
          onPress={() => {
            if (kind() === "note") {
              props.onOpenNote?.(noteId(refId()));
              return;
            }
            const iss = resolvedIssue();
            if (iss) {
              props.onOpenIssue?.(iss.id);
            } else if (kind() === "issue") {
              props.onOpenIssue?.(issueId(refId()));
            }
          }}
          class={`mx-0.5 max-w-64 flex-row items-center gap-1 overflow-hidden rounded-sm border px-1.5 py-px align-middle ${
            nodeProps.selected ? "border-accent bg-selected" : "border-line bg-side hover:border-faint hover:bg-hover"
          }`}
        >
          <If
            when={kind() === "note"}
            else={
              <If when={resolvedIssue()} else={<Icon name="issues" size={11} tone="accent" />}>
                {(found) => <Dot tone={ISSUE_STATUS_DOT_TONE[found().status]} size={8} ring={false} />}
              </If>
            }
          >
            <Icon name="notes" size={11} tone="accent" />
          </If>
          <Text class="min-w-0 shrink truncate text-xs font-medium text-ink">{displayLabel()}</Text>
        </View>
      );
    },
  });

  const vvKeyPluginsExtension = defineExtension({
    name: "vvKeyPlugins",
    priority: 1000,
    addInputRules: () => typographyRules(),
    addProseMirrorPlugins: () => [
      popupPlugin,
      submitPlugin,
      tabPlugin,
      backspacePlugin,
      upPlugin,
      downPlugin,
      markdown({ blockRules: false, inlineRules: true, paste: true, copyAsMarkdown: true }),
    ],
  });

  const editor = createRichEditor({
    extensions: [vvKeyPluginsExtension, Document, Paragraph, richExtension("text"), HardBreak, Bold, Italic, Code, Strike, RichLink, History, vvRefExtension],
    doc: markdownToRichDoc(initialMarkdown),
    editable: untracked(() => props.editable !== false),
  });

  const emitTelemetry = (ctx: RichInlineCaretContext, valueOverride?: string) => {
    if (!props.onEditorTelemetry || !props.blockId) return;
    props.onEditorTelemetry({
      focusedBlockId: props.blockId,
      activeTestId: props.testID,
      value: valueOverride ?? lastKnownMarkdown,
      selection: { start: Math.max(0, ctx.pmFrom - 1), end: Math.max(0, ctx.pmTo - 1) },
    });
  };

  const syncCaptureFlags = (ctx: RichInlineCaretContext) => {
    const isOpen = props.popupOpen === true;
    const isFocused = untracked(focused);
    popupPlugin.capturing = isFocused && isOpen;
    submitPlugin.capturing = isFocused && !isOpen && props.enterBehavior === "submit";
    tabPlugin.capturing = isFocused && !isOpen && props.onTab !== undefined;
    backspacePlugin.capturing = isFocused && !isOpen && ctx.atStart && props.onMergeBackward !== undefined;
    upPlugin.capturing = isFocused && !isOpen && ctx.selectionEmpty && ctx.onFirstLine && props.onFocusAdjacent !== undefined;
    downPlugin.capturing = isFocused && !isOpen && ctx.selectionEmpty && ctx.onLastLine && props.onFocusAdjacent !== undefined;
  };

  effect(() => {
    const isOpen = props.popupOpen === true;
    const isFocused = focused();
    const sel = selState();
    docRevision();
    const ctx = buildCaretContext(editor.doc, sel);
    popupPlugin.capturing = isFocused && isOpen;
    submitPlugin.capturing = isFocused && !isOpen && props.enterBehavior === "submit";
    tabPlugin.capturing = isFocused && !isOpen && props.onTab !== undefined;
    backspacePlugin.capturing = isFocused && !isOpen && ctx.atStart && props.onMergeBackward !== undefined;
    upPlugin.capturing = isFocused && !isOpen && ctx.selectionEmpty && ctx.onFirstLine && props.onFocusAdjacent !== undefined;
    downPlugin.capturing = isFocused && !isOpen && ctx.selectionEmpty && ctx.onLastLine && props.onFocusAdjacent !== undefined;
  });

  effect(() => {
    const isEditable = props.editable !== false;
    if (editor.isEditable !== isEditable) {
      editor.setEditable(isEditable);
    }
  });

  effect(() => {
    const external = props.value;
    if (external === lastKnownMarkdown) return;
    lastKnownMarkdown = external;
    const wasFocused = editor.isFocused;
    editor.setContent(markdownToRichDoc(external), "json");
    docRevision.set(untracked(docRevision) + 1);
    if (wasFocused || pendingCaretTarget !== undefined) {
      const targetPos = pendingCaretTarget !== undefined ? resolveCaretPmPos(editor.doc, pendingCaretTarget) : paragraphEndPos(editor.doc);
      editor.run(setTextSelection(targetPos));
    }
  });

  const focusWithCaret = (caret?: "start" | "end" | number) => {
    pendingCaretTarget = caret;
    queueMicrotask(() => {
      focused.set(true);
      editor.focus();
      const targetPos = resolveCaretPmPos(editor.doc, caret);
      editor.run(setTextSelection(targetPos));
      const ctx = buildCaretContext(editor.doc, editor.selection);
      syncCaptureFlags(ctx);
      emitTelemetry(ctx);
    });
    focusRetryTimer(() => {
      if (editor.isFocused) return;
      pendingCaretTarget = caret;
      focused.set(true);
      editor.focus();
      const targetPos = resolveCaretPmPos(editor.doc, caret);
      editor.run(setTextSelection(targetPos));
      const ctx = buildCaretContext(editor.doc, editor.selection);
      syncCaptureFlags(ctx);
      emitTelemetry(ctx);
    }, 16);
  };

  effect(() => {
    const req = props.focusRequest;
    if (!req || !props.blockId || req.blockId !== props.blockId || req.seq === handledFocusSeq) return;
    handledFocusSeq = req.seq;
    focusWithCaret(req.caret);
  });

  const handleDocChange = () => {
    const doc = editor.doc;
    const sel = normalizeSelection(editor.selection);
    selState.set(sel);
    docRevision.set(untracked(docRevision) + 1);

    const blocks = doc.content ?? [];
    if (blocks.length > 1) {
      const parts = splitRichDocToParagraphMarkdowns(doc);
      const beforeMd = parts[0] ?? "";
      const afterMd = parts.slice(1).join("\n");
      lastKnownMarkdown = beforeMd;
      if (props.enterBehavior === "submit") {
        editor.setContent(markdownToRichDoc(beforeMd), "json");
        props.onUpdate(beforeMd, buildCaretContext(editor.doc, editor.selection));
        props.onSubmit?.();
        return;
      }
      if (props.onSplit) {
        focused.set(false);
        editor.blur();
      }
      editor.setContent(markdownToRichDoc(beforeMd), "json");
      if (props.onSplit) {
        props.onSplit(beforeMd, afterMd);
      } else if (props.onEnter) {
        props.onEnter(beforeMd);
      } else {
        props.onUpdate(beforeMd, buildCaretContext(editor.doc, editor.selection));
      }
      return;
    }

    const nextMd = richDocToMarkdown(doc);
    const ctx = buildCaretContext(doc, sel);
    syncCaptureFlags(ctx);
    if (nextMd !== lastKnownMarkdown) {
      lastKnownMarkdown = nextMd;
      props.onUpdate(nextMd, ctx);
    }
    if (untracked(focused)) {
      emitTelemetry(ctx, nextMd);
    }
  };

  const api: RichInlineFieldRef = {
    focus: focusWithCaret,
    blur: () => editor.blur(),
    applyMark: (mark) => {
      editor.focus();
      editor.run(toggleMark(mark));
      handleDocChange();
    },
    insertText: (text) => {
      editor.focus();
      editor.run(insertText(text));
      handleDocChange();
    },
    insertVvRef: (attrs, trailingSpace = true) => {
      const content: RichNodeJSON[] = [createVvRefNode(attrs)];
      if (trailingSpace) content.push({ type: "text", text: " " });
      editor.focus();
      editor.run(insertContentAt(normalizeSelection(editor.selection).to, content, { updateSelection: true }));
      handleDocChange();
    },
    replaceRangeWithVvRef: (pmFrom, pmTo, attrs, trailingSpace = true) => {
      const content: RichNodeJSON[] = [createVvRefNode(attrs)];
      if (trailingSpace) content.push({ type: "text", text: " " });
      editor.focus();
      editor.run(insertContentAt({ from: pmFrom, to: pmTo }, content, { updateSelection: true }));
      handleDocChange();
    },
    deleteRangeAndSync: (pmFrom, pmTo) => {
      editor.run(deleteRange({ from: pmFrom, to: pmTo }));
      const nextMd = richDocToMarkdown(editor.doc);
      lastKnownMarkdown = nextMd;
      docRevision.set(untracked(docRevision) + 1);
      return nextMd;
    },
  };

  let wrapRef: ViewRef | undefined;
  const lineHeightPx = () => props.lineHeightPx ?? 24;
  const vdpTestId = untracked(() => props.testID);
  if (vdpTestId !== undefined) {
    useVdpNode({
      testId: vdpTestId,
      role: "textbox",
      text: () => props.value,
      getRef: () => wrapRef,
      getFocused: () => focused(),
      getLineCount: (bounds) => {
        if (bounds !== undefined && bounds.height > 0) {
          return Math.max(1, Math.round(bounds.height / lineHeightPx()));
        }
        return Math.max(1, props.value.split("\n").length);
      },
      onPress: () => {
        props.onFocus?.();
        api.focus("end");
      },
    });
  }

  props.ref?.(api);

  cleanup(() => {
    if (editor.isFocused) {
      editor.blur();
    }
    popupPlugin.dispose();
    submitPlugin.dispose();
    tabPlugin.dispose();
    backspacePlugin.dispose();
    upPlugin.dispose();
    downPlugin.dispose();
    editor.dispose();
  });

  const showBubble = computed(
    () => (props.showBubbleMenu ?? true) && focused() && props.popupOpen !== true && !selState().empty && selState().to > selState().from,
  );

  const isBoldActive = computed(() => {
    selState();
    docRevision();
    return editor.isActive("bold");
  });
  const isItalicActive = computed(() => {
    selState();
    docRevision();
    return editor.isActive("italic");
  });
  const isCodeActive = computed(() => {
    selState();
    docRevision();
    return editor.isActive("code");
  });
  const isStrikeActive = computed(() => {
    selState();
    docRevision();
    return editor.isActive("strike");
  });

  return (
    <View
      ref={(el) => {
        wrapRef = el;
      }}
      class={props.class ?? "w-full min-w-0"}
    >
      <RichEditor
        testID={props.testID}
        accessibilityLabel={props.accessibilityLabel ?? props.placeholder ?? undefined}
        editor={editor}
        autoFocus={autoFocusOnMount}
        editable={props.editable ?? true}
        placeholder={props.placeholder ?? null}
        showOnlyCurrent={false}
        bubbleMenuPlacement="top"
        bubbleMenuOffset={6}
        bubbleMenu={
          <If when={showBubble()}>
            <View
              testID={props.blockId ? `doc-format-bar-${props.blockId}` : undefined}
              class="flex-row items-center gap-0.5 rounded-md border border-line bg-elevated px-1 py-0.5 shadow-float"
            >
              <If when={props.blockId}>{(bid) => <VdpAnchor testId={`doc-format-bar-${bid()}`} role="toolbar" />}</If>
              <View
                role="button"
                focusable={false}
                testID={props.blockId ? `doc-fmt-bold-${props.blockId}` : undefined}
                accessibilityLabel={t("web.note.doc.bold")}
                onPress={() => api.applyMark("bold")}
                class={`h-6 min-w-6 items-center justify-center rounded-xs px-1.5 hover:bg-hover ${isBoldActive() ? "bg-selected" : ""}`}
              >
                <Text class={`text-xs font-bold ${isBoldActive() ? "text-accent" : "text-ink"}`}>B</Text>
              </View>
              <View
                role="button"
                focusable={false}
                testID={props.blockId ? `doc-fmt-italic-${props.blockId}` : undefined}
                accessibilityLabel={t("web.note.doc.italic")}
                onPress={() => api.applyMark("italic")}
                class={`h-6 min-w-6 items-center justify-center rounded-xs px-1.5 hover:bg-hover ${isItalicActive() ? "bg-selected" : ""}`}
              >
                <Text class={`text-xs italic ${isItalicActive() ? "text-accent" : "text-ink"}`}>I</Text>
              </View>
              <View
                role="button"
                focusable={false}
                testID={props.blockId ? `doc-fmt-code-${props.blockId}` : undefined}
                accessibilityLabel={t("web.note.doc.inlineCode")}
                onPress={() => api.applyMark("code")}
                class={`h-6 min-w-6 items-center justify-center rounded-xs px-1.5 hover:bg-hover ${isCodeActive() ? "bg-selected" : ""}`}
              >
                <Text class={`font-mono text-2xs ${isCodeActive() ? "text-accent" : "text-ink"}`}>{"<>"}</Text>
              </View>
              <View
                role="button"
                focusable={false}
                testID={props.blockId ? `doc-fmt-strike-${props.blockId}` : undefined}
                accessibilityLabel={t("web.note.doc.strike")}
                onPress={() => api.applyMark("strike")}
                class={`h-6 min-w-6 items-center justify-center rounded-xs px-1.5 hover:bg-hover ${isStrikeActive() ? "bg-selected" : ""}`}
              >
                <Text class={`text-xs line-through ${isStrikeActive() ? "text-accent" : "text-ink"}`}>S</Text>
              </View>
              <View class="mx-0.5 h-3.5 w-px bg-line" />
              <View
                role="button"
                focusable={false}
                testID={props.blockId ? `doc-fmt-link-${props.blockId}` : undefined}
                accessibilityLabel={t("web.note.doc.link")}
                onPress={() => api.insertText("[[")}
                class="h-6 items-center justify-center rounded-xs px-1.5 hover:bg-hover"
              >
                <Text class="font-mono text-2xs font-medium text-accent">{"[["}</Text>
              </View>
            </View>
          </If>
        }
        classes={{
          root: "w-full min-w-0",
          content: props.contentClass ?? "px-0 py-0",
          placeholder: "text-faint",
          caret: "bg-accent",
          selection: "bg-water/15",
          nodes: {
            paragraph: props.textClass ?? "w-full min-w-0 text-sm leading-6 text-ink",
          },
          marks: {
            bold: "font-bold",
            italic: "italic",
            strike: "line-through",
            code: "rounded-xs border border-line/70 bg-side px-1 py-px font-mono text-xs text-ink",
            link: "text-accent underline",
          },
        }}
        onChange={() => {
          handleDocChange();
        }}
        onSelectionChange={(ev) => {
          selState.set(ev.selection);
          const ctx = buildCaretContext(editor.doc, ev.selection);
          syncCaptureFlags(ctx);
          props.onSelectionChange?.(ctx);
          if (untracked(focused)) {
            emitTelemetry(ctx);
          }
        }}
        onFocus={() => {
          focused.set(true);
          if (pendingCaretTarget !== undefined) {
            const target = pendingCaretTarget;
            pendingCaretTarget = undefined;
            const targetPos = resolveCaretPmPos(editor.doc, target);
            editor.run(setTextSelection(targetPos));
          }
          const ctx = buildCaretContext(editor.doc, editor.selection);
          syncCaptureFlags(ctx);
          props.onFocus?.();
          emitTelemetry(ctx);
        }}
        onBlur={() => {
          focused.set(false);
          const ctx = buildCaretContext(editor.doc, editor.selection);
          syncCaptureFlags(ctx);
          props.onBlur?.();
        }}
      />
    </View>
  );
}
