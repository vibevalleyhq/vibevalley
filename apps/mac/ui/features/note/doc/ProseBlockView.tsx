import { computed, effect, signal, untracked, View, windowSize, type ViewRef } from "nsh";

import { t } from "@vibevalley/i18n";
import type { DocBlock, Issue, IssueId, Note, NoteId } from "@vibevalley/protocol";

import { VdpAnchor } from "../../../infra/vdpProbe";
import type { BlockEditorTelemetryPatch, FocusRequest } from "./blockEditorShared";
import {
  createDefaultBlock,
  detectSlashTrigger,
  detectWikilinkTrigger,
  filterSlashCommands,
  formatWikilinkToken,
  makeBlockId,
  matchMarkdownInputRule,
  type SlashCommandItem,
  stripSlashTrigger,
} from "./docOps";
import { RichInlineField, type RichInlineCaretContext, type RichInlineFieldRef } from "./RichInlineField";
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
  const caretCtx = signal<RichInlineCaretContext>({
    plainBeforeCaret: untracked(() => props.block.text),
    pmFrom: 1,
    pmTo: 1,
    pmPositions: [],
    selectionEmpty: true,
    onFirstLine: true,
    onLastLine: true,
    atStart: true,
    atEnd: true,
  });
  const nativeFocused = signal(false);
  const menuDismissedAt = signal<string | undefined>(undefined);
  const popupPlacement = signal<"bottom" | "top">("bottom");
  let fieldRef: RichInlineFieldRef | undefined;
  let anchorRef: ViewRef | undefined;

  const slashTrigger = computed(() => {
    if (!nativeFocused() && !props.focused) return undefined;
    const ctx = caretCtx();
    const hit = detectSlashTrigger(ctx.plainBeforeCaret, ctx.plainBeforeCaret.length);
    if (!hit || menuDismissedAt() === `${ctx.plainBeforeCaret}@${ctx.pmTo}`) return undefined;
    return hit;
  });

  const wikiTrigger = computed(() => {
    if (!nativeFocused() && !props.focused) return undefined;
    const ctx = caretCtx();
    const hit = detectWikilinkTrigger(ctx.plainBeforeCaret, ctx.plainBeforeCaret.length);
    if (!hit || menuDismissedAt() === `${ctx.plainBeforeCaret}@${ctx.pmTo}`) return undefined;
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

  const handleInput = (val: string, ctx: RichInlineCaretContext) => {
    caretCtx.set(ctx);
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
    const ctx = untracked(caretCtx);
    let cleaned = props.block.text;
    if (trig) {
      const pmFrom = ctx.pmPositions[trig.triggerIndex];
      if (pmFrom !== undefined && fieldRef) {
        cleaned = fieldRef.deleteRangeAndSync(pmFrom, ctx.pmTo);
      } else {
        cleaned = stripSlashTrigger(ctx.plainBeforeCaret, trig.triggerIndex, ctx.plainBeforeCaret.length);
      }
    }
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
    const ctx = untracked(caretCtx);
    const pmFrom = ctx.pmPositions[trig.startIndex] ?? ctx.pmTo;

    if (trig.mode === "embed") {
      const cleaned = fieldRef
        ? fieldRef.deleteRangeAndSync(pmFrom, ctx.pmTo)
        : stripSlashTrigger(ctx.plainBeforeCaret, trig.startIndex, ctx.plainBeforeCaret.length);
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

    if (fieldRef) {
      if (trig.mode === "issue" && item.kind === "issue") {
        fieldRef.replaceRangeWithVvRef(pmFrom, ctx.pmTo, {
          kind: "issueNumber",
          id: String(item.issue.number),
          label: `#${item.issue.number}`,
          raw: `#${item.issue.number}`,
        });
      } else if (item.kind === "note") {
        fieldRef.replaceRangeWithVvRef(pmFrom, ctx.pmTo, {
          kind: "note",
          id: item.note.id,
          label: item.note.title,
          raw: formatWikilinkToken("note", item.note.id, item.note.title),
        });
      } else {
        const label = `#${item.issue.number} ${item.issue.title}`;
        fieldRef.replaceRangeWithVvRef(pmFrom, ctx.pmTo, {
          kind: "issue",
          id: item.issue.id,
          label,
          raw: formatWikilinkToken("issue", item.issue.id, label),
        });
      }
      menuDismissedAt.set(undefined);
    }
  };

  const handleCapturedPopupKey = (key: string) => {
    const ctx = untracked(caretCtx);
    if (key === "Escape") {
      menuDismissedAt.set(`${ctx.plainBeforeCaret}@${ctx.pmTo}`);
      return;
    }
    if (key === "Enter" || key === "Tab") {
      const slash = untracked(slashTrigger);
      if (slash) {
        const items = filterSlashCommands(slash.query);
        const first = items.at(0);
        if (first !== undefined) {
          handleSlashSelect(first);
        }
      }
    }
  };

  return (
    <View
      ref={(el) => {
        anchorRef = el;
      }}
      testID={`doc-prose-${props.block.id}`}
      class="relative min-w-0"
    >
      <View testID={`doc-prose-rich-${props.block.id}`} class="min-w-0">
        <VdpAnchor
          testId={`doc-prose-rich-${props.block.id}`}
          role="region"
          text={() => props.block.text}
          getRef={() => anchorRef}
          onPress={() => {
            props.onFocus();
            fieldRef?.focus("end");
          }}
        />
        <RichInlineField
          ref={(api) => {
            fieldRef = api;
          }}
          testID={`doc-block-input-${props.block.id}`}
          blockId={props.block.id}
          accessibilityLabel={props.block.text || t("web.note.blocks.start")}
          value={props.block.text}
          placeholder={t("web.note.blocks.start")}
          notes={props.notes}
          issues={props.issues}
          focused={props.focused}
          focusRequest={props.focusRequest}
          popupOpen={popupOpen()}
          textClass="w-full min-w-0 text-base leading-7 text-ink"
          lineHeightPx={28}
          onFocus={() => {
            nativeFocused.set(true);
            props.onFocus();
          }}
          onBlur={() => {
            nativeFocused.set(false);
          }}
          onSelectionChange={(ctx) => {
            const prev = untracked(caretCtx);
            if (prev.pmFrom === ctx.pmFrom && prev.pmTo === ctx.pmTo && prev.plainBeforeCaret === ctx.plainBeforeCaret) {
              return;
            }
            caretCtx.set(ctx);
          }}
          onUpdate={handleInput}
          onSplit={(beforeMd, afterMd) => {
            if (untracked(popupOpen)) return;
            const rule = matchMarkdownInputRule(beforeMd, props.block.id, true);
            if (rule) {
              props.onUpdate(rule.block);
              return;
            }
            if (afterMd === "" && props.onSplit) {
              props.onUpdate({ ...props.block, text: beforeMd });
              props.onInsertAfter({ id: makeBlockId(), type: "prose", text: "" });
              return;
            }
            props.onUpdate({ ...props.block, text: beforeMd });
            props.onInsertAfter({ id: makeBlockId(), type: "prose", text: afterMd });
          }}
          onMergeBackward={() => {
            if (props.onMergeBackward) props.onMergeBackward();
            else if (props.block.text === "") props.onDelete();
          }}
          onFocusAdjacent={props.onFocusAdjacent}
          onCapturedPopupKey={handleCapturedPopupKey}
          onOpenNote={props.onOpenNote}
          onOpenIssue={props.onOpenIssue}
          onEditorTelemetry={props.onEditorTelemetry}
        />
      </View>

      <SlashMenu
        open={slashTrigger() !== undefined}
        query={slashTrigger()?.query ?? ""}
        placement={popupPlacement()}
        testID={`doc-slash-menu-${props.block.id}`}
        onSelect={handleSlashSelect}
        onClose={() => {
          const ctx = untracked(caretCtx);
          menuDismissedAt.set(`${ctx.plainBeforeCaret}@${ctx.pmTo}`);
        }}
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
        onClose={() => {
          const ctx = untracked(caretCtx);
          menuDismissedAt.set(`${ctx.plainBeforeCaret}@${ctx.pmTo}`);
        }}
      />
    </View>
  );
}
