import { computed, effect, keymap, signal, Text, untracked, View, windowSize, type CaretEvent, type InputRef, type ViewRef } from "nsh";
import { Input } from "nsh/base";

import { t } from "@vibevalley/i18n";
import type { DocBlock, Issue, IssueId, Note, NoteId } from "@vibevalley/protocol";

import { VdpAnchor } from "../../../infra/vdpProbe";
import { type BlockEditorTelemetryPatch, type FocusRequest, resolveRequestedCaret, roundBounds } from "./blockEditorShared";
import {
  applyWikilinkReplacementWithCaret,
  createDefaultBlock,
  detectSlashTrigger,
  detectWikilinkTrigger,
  formatWikilinkToken,
  hasInlineRichTokens,
  type InlineMarkdownMarker,
  isCaretOnFirstLine,
  isCaretOnLastLine,
  makeBlockId,
  matchMarkdownInputRule,
  type SlashCommandItem,
  stripSlashTrigger,
  wrapInlineMarkdownSelection,
} from "./docOps";
import { InlineRichText } from "./InlineRichText";
import { SlashMenu } from "./SlashMenu";
import { WikilinkMenu, type WikilinkSuggestion } from "./WikilinkMenu";

type ProseBlockData = Extract<DocBlock, { type: "prose" }>;

export function ProseBlockView(props: {
  readonly block: ProseBlockData;
  readonly notes: readonly Note[];
  readonly issues: readonly Issue[];
  readonly focused: boolean;
  readonly focusRequest?: FocusRequest | undefined;
  readonly onFocus: () => void;
  readonly onFocusAdjacent?: ((dir: "prev" | "next") => void) | undefined;
  readonly onSplit?: ((selStart: number, selEnd: number) => void) | undefined;
  readonly onMergeBackward?: (() => void) | undefined;
  readonly onUpdate: (next: DocBlock) => void;
  readonly onInsertAfter: (newBlock: DocBlock) => void;
  readonly onDelete: () => void;
  readonly onOpenNote: (id: NoteId) => void;
  readonly onOpenIssue: (id: IssueId) => void;
  readonly onEditorTelemetry?: ((patch: BlockEditorTelemetryPatch) => void) | undefined;
}) {
  const editing = signal(untracked(() => props.focused || props.block.text === ""));
  const nativeFocused = signal(false);
  const selection = signal<{ readonly start: number; readonly end: number }>({
    start: untracked(() => props.block.text.length),
    end: untracked(() => props.block.text.length),
  });
  const menuDismissedAt = signal<string | undefined>(undefined);
  const popupPlacement = signal<"bottom" | "top">("bottom");
  let inputRef: InputRef | undefined;
  let anchorRef: ViewRef | undefined;
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

  const focusProgrammatically = (caret: "start" | "end" | number | undefined) => {
    editing.set(true);
    queueMicrotask(() => {
      if (!inputRef) return;
      const len = untracked(() => props.block.text.length);
      const pos = resolveRequestedCaret(caret, len);
      inputRef.focus();
      inputRef.setSelection(pos, pos);
      const nextSel = { start: pos, end: pos };
      selection.set(nextSel);
      emitSelectionTelemetry(nextSel);
    });
  };

  effect(() => {
    const req = props.focusRequest;
    if (!req || req.blockId !== props.block.id || req.seq === handledFocusSeq) return;
    handledFocusSeq = req.seq;
    focusProgrammatically(req.caret);
  });

  const slashTrigger = computed(() => {
    if (!editing()) return undefined;
    const caret = selection().end;
    const hit = detectSlashTrigger(props.block.text, caret);
    if (!hit || menuDismissedAt() === `${props.block.text}@${caret}`) return undefined;
    return hit;
  });

  const wikiTrigger = computed(() => {
    if (!editing()) return undefined;
    const caret = selection().end;
    const hit = detectWikilinkTrigger(props.block.text, caret);
    if (!hit || menuDismissedAt() === `${props.block.text}@${caret}`) return undefined;
    return hit;
  });

  const popupOpen = computed(() => slashTrigger() !== undefined || wikiTrigger() !== undefined);

  effect(() => {
    if (!popupOpen()) {
      popupPlacement.set("bottom");
      return;
    }
    void anchorRef?.measure().then((measured) => {
      if (!measured) return;
      const bottom = measured.pagePosition.y + measured.bounds.size.height;
      const spaceBelow = windowSize().height - bottom;
      const spaceAbove = measured.pagePosition.y;
      popupPlacement.set(spaceBelow < 320 && spaceAbove > spaceBelow ? "top" : "bottom");
    });
  });

  const applyFormat = (marker: InlineMarkdownMarker) => {
    const curSel = untracked(selection);
    const wrapped = wrapInlineMarkdownSelection(props.block.text, marker, curSel.start, curSel.end);
    editing.set(true);
    props.onUpdate({ ...props.block, text: wrapped.text });
    const nextSel = { start: wrapped.start, end: wrapped.end };
    selection.set(nextSel);
    queueMicrotask(() => {
      inputRef?.focus();
      inputRef?.setSelection(wrapped.start, wrapped.end);
      emitSelectionTelemetry(nextSel, wrapped.text);
    });
  };

  const insertWikilinkTriggerAtCaret = () => {
    const curSel = untracked(selection);
    const text = props.block.text;
    const s = Math.max(0, Math.min(text.length, Math.min(curSel.start, curSel.end)));
    const e = Math.max(0, Math.min(text.length, Math.max(curSel.start, curSel.end)));
    const nextText = `${text.slice(0, s)}[[${text.slice(e)}`;
    const nextCaret = s + 2;
    editing.set(true);
    props.onUpdate({ ...props.block, text: nextText });
    const nextSel = { start: nextCaret, end: nextCaret };
    selection.set(nextSel);
    queueMicrotask(() => {
      inputRef?.focus();
      inputRef?.setSelection(nextCaret, nextCaret);
      emitSelectionTelemetry(nextSel, nextText);
    });
  };

  const formatBarActive = computed(() => props.focused && editing() && !popupOpen());
  effect(() => {
    if (!formatBarActive()) return;
    return keymap.bind(
      {
        "mod+b": () => applyFormat("**"),
        "mod+i": () => applyFormat("*"),
        "mod+e": () => applyFormat("`"),
      },
      { when: "always" },
    );
  });

  const canMoveUp = computed(
    () => nativeFocused() && !popupOpen() && selection().start === selection().end && isCaretOnFirstLine(props.block.text, selection().start),
  );
  const canMoveDown = computed(
    () => nativeFocused() && !popupOpen() && selection().start === selection().end && isCaretOnLastLine(props.block.text, selection().end),
  );

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

  const handleInput = (val: string) => {
    if (untracked(menuDismissedAt) !== undefined) {
      menuDismissedAt.set(undefined);
    }
    const prevText = props.block.text;
    const prevCaret = untracked(selection).end;
    const nextCaret = Math.max(0, Math.min(val.length, prevCaret + (val.length - prevText.length)));
    const nextSel = { start: nextCaret, end: nextCaret };
    selection.set(nextSel);

    const rule = matchMarkdownInputRule(val, props.block.id, false);
    if (rule) {
      props.onUpdate(rule.block);
      return;
    }
    props.onUpdate({ ...props.block, text: val });
    emitSelectionTelemetry(nextSel, val);
  };

  const handleSlashSelect = (item: SlashCommandItem) => {
    const trig = untracked(slashTrigger);
    const caretEnd = untracked(selection).end;
    const cleaned = trig ? stripSlashTrigger(props.block.text, trig.triggerIndex, caretEnd) : props.block.text;
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
    const caretEnd = untracked(selection).end;
    if (trig.mode === "embed") {
      const cleaned = stripSlashTrigger(props.block.text, trig.startIndex, caretEnd);
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
    const replaced = applyWikilinkReplacementWithCaret(props.block.text, trig.startIndex, token, caretEnd);
    props.onUpdate({ ...props.block, text: replaced.text });
    const nextSel = { start: replaced.caret, end: replaced.caret };
    selection.set(nextSel);
    queueMicrotask(() => {
      inputRef?.focus();
      inputRef?.setSelection(replaced.caret, replaced.caret);
      emitSelectionTelemetry(nextSel, replaced.text);
    });
  };

  const hasRichInline = computed(() => hasInlineRichTokens(props.block.text));

  return (
    <View
      ref={(el) => {
        anchorRef = el;
      }}
      testID={`doc-prose-${props.block.id}`}
      class="relative"
    >
      <If when={formatBarActive() && props.block.text.trim().length > 0}>
        <>
          <VdpAnchor testId={`doc-format-bar-${props.block.id}`} role="toolbar" />
          <View
            testID={`doc-format-bar-${props.block.id}`}
            class="absolute right-0 bottom-full z-20 mb-2.5 flex-row items-center gap-0.5 rounded-md border border-line bg-elevated px-1 py-0.5 shadow-float"
          >
            <View
              role="button"
              focusable={false}
              testID={`doc-fmt-bold-${props.block.id}`}
              accessibilityLabel={t("web.note.doc.bold")}
              onPress={() => applyFormat("**")}
              class="h-6 min-w-6 items-center justify-center rounded-xs px-1.5 hover:bg-hover"
            >
              <Text class="text-xs font-bold text-ink">B</Text>
            </View>
            <View
              role="button"
              focusable={false}
              testID={`doc-fmt-italic-${props.block.id}`}
              accessibilityLabel={t("web.note.doc.italic")}
              onPress={() => applyFormat("*")}
              class="h-6 min-w-6 items-center justify-center rounded-xs px-1.5 hover:bg-hover"
            >
              <Text class="text-xs text-ink italic">I</Text>
            </View>
            <View
              role="button"
              focusable={false}
              testID={`doc-fmt-code-${props.block.id}`}
              accessibilityLabel={t("web.note.doc.inlineCode")}
              onPress={() => applyFormat("`")}
              class="h-6 min-w-6 items-center justify-center rounded-xs px-1.5 hover:bg-hover"
            >
              <Text class="font-mono text-2xs text-ink">{"<>"}</Text>
            </View>
            <View
              role="button"
              focusable={false}
              testID={`doc-fmt-strike-${props.block.id}`}
              accessibilityLabel={t("web.note.doc.strike")}
              onPress={() => applyFormat("~~")}
              class="h-6 min-w-6 items-center justify-center rounded-xs px-1.5 hover:bg-hover"
            >
              <Text class="text-xs text-ink line-through">S</Text>
            </View>
            <View class="mx-0.5 h-3.5 w-px bg-line" />
            <View
              role="button"
              focusable={false}
              testID={`doc-fmt-link-${props.block.id}`}
              accessibilityLabel={t("web.note.doc.link")}
              onPress={insertWikilinkTriggerAtCaret}
              class="h-6 items-center justify-center rounded-xs px-1.5 hover:bg-hover"
            >
              <Text class="font-mono text-2xs font-medium text-accent">{"[["}</Text>
            </View>
          </View>
        </>
      </If>

      <If
        when={editing() || !hasRichInline()}
        else={
          <InlineRichText
            testID={`doc-prose-rich-${props.block.id}`}
            text={props.block.text}
            placeholder={t("web.note.blocks.start")}
            notes={props.notes}
            issues={props.issues}
            onOpenNote={props.onOpenNote}
            onOpenIssue={props.onOpenIssue}
            onPressText={(estimatedCaret) => {
              props.onFocus();
              focusProgrammatically(estimatedCaret ?? "end");
            }}
          />
        }
      >
        <>
          <VdpAnchor
            testId={inputTestId}
            role="textbox"
            text={() => props.block.text}
            getRef={() => inputRef}
            onPress={() => {
              props.onFocus();
              focusProgrammatically("end");
            }}
          />
          <Input
            ref={(el) => {
              inputRef = el;
            }}
            multiline
            scrollbar={false}
            testID={inputTestId}
            accessibilityLabel={props.block.text || t("web.note.blocks.start")}
            placeholder={t("web.note.blocks.start")}
            value={props.block.text}
            submitBehavior="submit"
            onFocus={() => {
              nativeFocused.set(true);
              editing.set(true);
              props.onFocus();
              emitSelectionTelemetry(untracked(selection));
            }}
            onBlur={() => {
              nativeFocused.set(false);
              if (!untracked(popupOpen)) {
                editing.set(false);
              }
            }}
            onSelectionChange={(e) => {
              const cur = untracked(selection);
              if (cur.start !== e.start || cur.end !== e.end) {
                const nextSel = { start: e.start, end: e.end };
                selection.set(nextSel);
                emitSelectionTelemetry(nextSel);
              } else {
                emitSelectionTelemetry(cur);
              }
            }}
            onCaretMove={props.onEditorTelemetry ? handleCaretMove : undefined}
            onChange={(e) => handleInput(e.value)}
            onSubmit={() => {
              if (untracked(popupOpen)) return;
              const rule = matchMarkdownInputRule(props.block.text, props.block.id, true);
              if (rule) {
                props.onUpdate(rule.block);
                return;
              }
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
                  if (props.onMergeBackward) props.onMergeBackward();
                  else if (props.block.text === "") props.onDelete();
                }
              }
            }}
            class="min-h-6 w-full rounded-sm bg-transparent px-1 py-0 text-sm leading-6 text-ink placeholder:text-faint"
          />
        </>
      </If>
      <SlashMenu
        open={slashTrigger() !== undefined}
        query={slashTrigger()?.query ?? ""}
        placement={popupPlacement()}
        testID={`doc-slash-menu-${props.block.id}`}
        onSelect={handleSlashSelect}
        onClose={() => menuDismissedAt.set(`${props.block.text}@${untracked(selection).end}`)}
      />
      <WikilinkMenu
        open={slashTrigger() === undefined && wikiTrigger() !== undefined}
        mode={wikiTrigger()?.mode ?? "wikilink"}
        query={wikiTrigger()?.query ?? ""}
        placement={popupPlacement()}
        notes={props.notes}
        issues={props.issues}
        testID={`doc-wikilink-menu-${props.block.id}`}
        onSelect={handleWikilinkSelect}
        onClose={() => menuDismissedAt.set(`${props.block.text}@${untracked(selection).end}`)}
      />
    </View>
  );
}
