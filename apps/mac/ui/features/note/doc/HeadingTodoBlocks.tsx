import { View } from "nsh";

import { t } from "@vibevalley/i18n";
import type { DocBlock, Issue, IssueId, Note, NoteId } from "@vibevalley/protocol";

import { Checkbox } from "../../../design/Checkbox";
import { type BlockEditorTelemetryPatch, type FocusRequest, headingTextClass } from "./blockEditorShared";
import { makeBlockId } from "./docOps";
import { RichInlineField } from "./RichInlineField";

type HeadingBlockData = Extract<DocBlock, { type: "heading" }>;
type TodoBlockData = Extract<DocBlock, { type: "todo" }>;

export function HeadingBlockView(props: {
  readonly block: HeadingBlockData;
  readonly notes?: readonly Note[] | undefined;
  readonly issues?: readonly Issue[] | undefined;
  readonly focused: boolean;
  readonly focusRequest?: FocusRequest | undefined;
  readonly onFocus: () => void;
  readonly onFocusAdjacent?: ((dir: "prev" | "next") => void) | undefined;
  readonly onSplit?: ((selStart: number, selEnd: number) => void) | undefined;
  readonly onMergeBackward?: (() => void) | undefined;
  readonly onUpdate: (next: HeadingBlockData) => void;
  readonly onInsertAfter: (newBlock: DocBlock) => void;
  readonly onOpenNote?: ((id: NoteId) => void) | undefined;
  readonly onOpenIssue?: ((id: IssueId) => void) | undefined;
  readonly onEditorTelemetry?: ((patch: BlockEditorTelemetryPatch) => void) | undefined;
}) {
  return (
    <View testID={`doc-heading-${props.block.id}`} class="min-w-0 py-0.5">
      <RichInlineField
        testID={`doc-block-input-${props.block.id}`}
        blockId={props.block.id}
        accessibilityLabel={props.block.text || t("web.note.doc.headingPlaceholder", { level: props.block.level })}
        value={props.block.text}
        placeholder={t("web.note.doc.headingPlaceholder", { level: props.block.level })}
        notes={props.notes}
        issues={props.issues}
        focused={props.focused}
        focusRequest={props.focusRequest}
        lineHeightPx={props.block.level === 1 ? 32 : props.block.level === 2 ? 28 : 24}
        textClass={`w-full min-w-0 text-ink ${headingTextClass(props.block.level)}`}
        onFocus={props.onFocus}
        onUpdate={(nextText) => props.onUpdate({ ...props.block, text: nextText })}
        onSplit={(beforeMd, afterMd) => {
          props.onUpdate({ ...props.block, text: beforeMd });
          props.onInsertAfter({ id: makeBlockId(), type: "prose", text: afterMd });
        }}
        onMergeBackward={props.onMergeBackward}
        onFocusAdjacent={props.onFocusAdjacent}
        onOpenNote={props.onOpenNote}
        onOpenIssue={props.onOpenIssue}
        onEditorTelemetry={props.onEditorTelemetry}
      />
    </View>
  );
}

export function TodoBlockView(props: {
  readonly block: TodoBlockData;
  readonly notes?: readonly Note[] | undefined;
  readonly issues?: readonly Issue[] | undefined;
  readonly focusRequest?: FocusRequest | undefined;
  readonly onFocus: () => void;
  readonly onFocusAdjacent?: ((dir: "prev" | "next") => void) | undefined;
  readonly onSplit?: ((selStart: number, selEnd: number) => void) | undefined;
  readonly onMergeBackward?: (() => void) | undefined;
  readonly onUpdate: (next: TodoBlockData) => void;
  readonly onInsertAfter: (newBlock: DocBlock) => void;
  readonly onOpenNote?: ((id: NoteId) => void) | undefined;
  readonly onOpenIssue?: ((id: IssueId) => void) | undefined;
  readonly onEditorTelemetry?: ((patch: BlockEditorTelemetryPatch) => void) | undefined;
}) {
  return (
    <View testID={`doc-todo-${props.block.id}`} class="min-w-0 flex-row items-start gap-2 py-px">
      <View class="shrink-0 pt-0.5">
        <Checkbox
          checked={props.block.checked}
          label={props.block.text || t("web.note.doc.slash.todo.label")}
          testid={`doc-todo-check-${props.block.id}`}
          onChange={(checked) => props.onUpdate({ ...props.block, checked })}
        />
      </View>
      <View class="min-w-0 flex-1">
        <RichInlineField
          testID={`doc-block-input-${props.block.id}`}
          blockId={props.block.id}
          accessibilityLabel={props.block.text || t("web.note.doc.todoPlaceholder")}
          value={props.block.text}
          placeholder={t("web.note.doc.todoPlaceholder")}
          notes={props.notes}
          issues={props.issues}
          focusRequest={props.focusRequest}
          contentClass="px-0 py-0.5"
          textClass={props.block.checked ? "text-sm leading-5 text-faint line-through" : "text-sm leading-5 text-ink"}
          onFocus={props.onFocus}
          onUpdate={(nextText) => props.onUpdate({ ...props.block, text: nextText })}
          onSplit={(beforeMd, afterMd) => {
            props.onUpdate({ ...props.block, text: beforeMd });
            props.onInsertAfter({ id: makeBlockId(), type: "todo", text: afterMd, checked: false });
          }}
          onMergeBackward={props.onMergeBackward}
          onFocusAdjacent={props.onFocusAdjacent}
          onOpenNote={props.onOpenNote}
          onOpenIssue={props.onOpenIssue}
          onEditorTelemetry={props.onEditorTelemetry}
        />
      </View>
    </View>
  );
}
