import { Clipboard, computed, Scroll, signal, Text, untracked, View, type JSX } from "nsh";
import { Editor, Input, Menu, MenuItem, MenuSeparator, Popover } from "nsh/base";

import { t } from "@vibevalley/i18n";
import type { DocBlock, Issue, IssueId, Note, NoteId } from "@vibevalley/protocol";

import { Button } from "../../../design/Button";
import { TextInput } from "../../../design/Field";
import { useDesignHost } from "../../../design/host";
import { Icon } from "../../../design/Icon";
import { IconButton } from "../../../design/IconButton";
import { motionClass, popupTransition } from "../../../design/motion";
import { toast } from "../../../design/toasts";
import { mix } from "../../../design/tone";
import { useTimeout } from "../../../infra/base/timer";
import {
  addTableColumn,
  addTableRow,
  CALLOUT_TONES,
  calloutToneLabel,
  calloutVisualOf,
  cycleTableAlignment,
  extractTocEntries,
  insertTableColumnAt,
  insertTableRowAt,
  makeBlockId,
  moveTableColumn,
  moveTableRow,
  nextTableCellTarget,
  removeTableColumn,
  removeTableRow,
  updateTableCell,
  updateTableHeader,
} from "./docOps";
import { RichInlineField, type RichInlineFieldRef } from "./RichInlineField";

type ToggleBlockData = Extract<DocBlock, { type: "toggle" }>;
type CalloutBlockData = Extract<DocBlock, { type: "callout" }>;
type CodeBlockData = Extract<DocBlock, { type: "code" }>;
type TableBlockData = Extract<DocBlock, { type: "table" }>;
type BookmarkBlockData = Extract<DocBlock, { type: "bookmark" }>;
type TocBlockData = Extract<DocBlock, { type: "toc" }>;
type MathBlockData = Extract<DocBlock, { type: "math" }>;
type ColumnsBlockData = Extract<DocBlock, { type: "columns" }>;
type PageBreakBlockData = Extract<DocBlock, { type: "pageBreak" }>;

const menuPopupClass = `min-w-44 gap-0.5 rounded-lg border border-line-strong bg-elevated p-1 shadow-float ${motionClass("transition-opacity duration-120 ease-out")}`;
const menuItemClass = "h-7 flex-row items-center gap-2 rounded-md px-2 hover:bg-hover focus:bg-hover";

export function ToggleBlockView(props: {
  readonly block: ToggleBlockData;
  readonly notes: readonly Note[];
  readonly issues: readonly Issue[];
  readonly onUpdate: (next: ToggleBlockData) => void;
  readonly onOpenNote: (id: NoteId) => void;
  readonly onOpenIssue: (id: IssueId) => void;
  readonly renderChild: (child: () => DocBlock, prevChild?: () => DocBlock | undefined) => JSX.Element;
}) {
  const isCollapsed = () => props.block.collapsed === true;
  const children = () => props.block.children ?? [];

  return (
    <View testID={`doc-toggle-${props.block.id}`} class="min-w-0 py-1">
      <View class="min-w-0 flex-row items-start gap-1.5">
        <View
          role="button"
          testID={`doc-toggle-btn-${props.block.id}`}
          accessibilityLabel={props.block.title || t("web.note.doc.slash.toggle.label")}
          accessibilityState={{ expanded: !isCollapsed() }}
          onPress={() => props.onUpdate({ ...props.block, collapsed: !isCollapsed() })}
          class="mt-1 size-5 shrink-0 items-center justify-center rounded-xs hover:bg-hover"
        >
          <Icon name={isCollapsed() ? "next" : "choose"} size={12} tone="muted" />
        </View>
        <RichInlineField
          testID={`doc-toggle-title-${props.block.id}`}
          blockId={props.block.id}
          value={props.block.title}
          placeholder={t("web.note.doc.toggleTitlePlaceholder")}
          notes={props.notes}
          issues={props.issues}
          enterBehavior="submit"
          lineHeightPx={20}
          class="min-w-0 flex-1"
          textClass="w-full min-w-0 text-sm font-semibold leading-5 text-ink"
          onUpdate={(nextTitle) => props.onUpdate({ ...props.block, title: nextTitle })}
          onOpenNote={props.onOpenNote}
          onOpenIssue={props.onOpenIssue}
        />
      </View>
      <If when={!isCollapsed()}>
        <View testID={`doc-toggle-body-${props.block.id}`} class="mt-1 ml-3 min-w-0 gap-1 border-l border-line pl-4">
          <RichInlineField
            testID={`doc-toggle-text-${props.block.id}`}
            blockId={props.block.id}
            value={props.block.text}
            placeholder={t("web.note.doc.toggleBodyPlaceholder")}
            notes={props.notes}
            issues={props.issues}
            onUpdate={(nextText) => props.onUpdate({ ...props.block, text: nextText })}
            onOpenNote={props.onOpenNote}
            onOpenIssue={props.onOpenIssue}
          />
          <If when={children().length > 0}>
            <View class="min-w-0 gap-0">
              <Each of={children()} key={(child) => child.id}>
                {(child, idx) => props.renderChild(child, () => children()[idx() - 1])}
              </Each>
            </View>
          </If>
        </View>
      </If>
    </View>
  );
}

export function CalloutBlockView(props: {
  readonly block: CalloutBlockData;
  readonly notes: readonly Note[];
  readonly issues: readonly Issue[];
  readonly onUpdate: (next: CalloutBlockData) => void;
  readonly onOpenNote: (id: NoteId) => void;
  readonly onOpenIssue: (id: IssueId) => void;
}) {
  const toneOpen = signal(false);
  const visual = () => calloutVisualOf(props.block.tone);
  const bgStyle = () => (visual().mixToken !== undefined ? { backgroundColor: mix(visual().mixToken ?? "water", 0.14) } : undefined);

  return (
    <View testID={`doc-callout-${props.block.id}`} class={`min-w-0 gap-1.5 rounded-lg border border-line p-3 ${visual().bgClass}`} style={bgStyle()}>
      <View class="min-w-0 flex-row items-start gap-2">
        <Popover
          open={toneOpen()}
          onOpenChange={(e) => toneOpen.set(e.open)}
          placement="bottom"
          align="start"
          offset={4}
          popupClass="flex-row items-center gap-1 rounded-lg border border-line bg-elevated p-1 shadow-float"
          trigger={
            <View
              role="button"
              testID={`doc-callout-tone-trigger-${props.block.id}`}
              accessibilityLabel={visual().label}
              class="mt-0.5 shrink-0 rounded-xs p-0.5 hover:bg-hover"
            >
              <Icon name={visual().icon} size={16} tone={visual().iconTone} />
            </View>
          }
        >
          <Each of={CALLOUT_TONES} key={(toneKey) => toneKey}>
            {(toneKey) => {
              const active = () => visual().tone === toneKey();
              return (
                <View
                  role="button"
                  focusable={false}
                  testID={`doc-callout-tone-${toneKey()}-${props.block.id}`}
                  onPress={() => {
                    props.onUpdate({ ...props.block, tone: toneKey() });
                    toneOpen.set(false);
                  }}
                  class={`rounded-xs px-2 py-1 ${active() ? "bg-selected" : "hover:bg-hover"}`}
                >
                  <Text class={`text-2xs font-medium ${active() ? "text-ink" : "text-muted"}`}>{calloutToneLabel(toneKey())}</Text>
                </View>
              );
            }}
          </Each>
        </Popover>
        <RichInlineField
          testID={`doc-callout-title-${props.block.id}`}
          blockId={props.block.id}
          value={props.block.title ?? ""}
          placeholder={visual().label}
          notes={props.notes}
          issues={props.issues}
          enterBehavior="submit"
          lineHeightPx={20}
          class="min-w-0 flex-1"
          contentClass="px-0.5 py-0"
          textClass={`w-full min-w-0 text-sm font-semibold leading-5 ${visual().textClass}`}
          onUpdate={(nextTitle) => props.onUpdate({ ...props.block, title: nextTitle || undefined })}
          onOpenNote={props.onOpenNote}
          onOpenIssue={props.onOpenIssue}
        />
      </View>
      <RichInlineField
        testID={`doc-callout-text-${props.block.id}`}
        blockId={props.block.id}
        value={props.block.text}
        placeholder={t("web.note.doc.calloutPlaceholder")}
        notes={props.notes}
        issues={props.issues}
        onUpdate={(nextText) => props.onUpdate({ ...props.block, text: nextText })}
        onOpenNote={props.onOpenNote}
        onOpenIssue={props.onOpenIssue}
      />
    </View>
  );
}

const CODE_LANGUAGES = ["typescript", "rust", "python", "json", "sql", "bash", "markdown", "plaintext"] as const;

export function CodeBlockView(props: { readonly block: CodeBlockData; readonly onUpdate: (next: CodeBlockData) => void }) {
  const copied = signal(false);
  const copyTimer = useTimeout();

  const copyCode = () => {
    void Clipboard.write({ text: props.block.code })
      .then(() => {
        copied.set(true);
        toast(t("web.base.rich.copied"));
        copyTimer(() => copied.set(false), 1400);
      })
      .catch(() => {});
  };

  return (
    <View testID={`doc-code-${props.block.id}`} class="group relative overflow-hidden rounded-lg border border-line bg-code-bg p-2">
      <Editor
        testID={`doc-code-input-${props.block.id}`}
        value={props.block.code}
        language={props.block.language || "plaintext"}
        minRows={2}
        maxRows={18}
        lineNumbers={false}
        folding={false}
        scrollBeyondLastLine={false}
        softWrap
        onChange={(e) => props.onUpdate({ ...props.block, code: e.value })}
        class="w-full"
      />
      <View class="absolute top-1.5 right-1.5 z-10 flex-row items-center gap-1 rounded-md border border-line bg-elevated px-1.5 py-0.5 opacity-0 shadow-float group-hover:opacity-100 focus-within:opacity-100">
        <Menu
          placement="bottom"
          align="end"
          offset={4}
          popupClass={menuPopupClass}
          popupStartingClass={popupTransition("opacity-0")}
          popupEndingClass={popupTransition("opacity-0")}
          trigger={
            <View role="button" testID={`doc-code-lang-${props.block.id}`} class="rounded-xs px-1.5 py-0.5 hover:bg-hover">
              <Text class="font-mono text-2xs text-muted">{props.block.language || "plaintext"}</Text>
            </View>
          }
        >
          <Each of={CODE_LANGUAGES} key={(lang) => lang}>
            {(lang) => (
              <MenuItem onSelect={() => props.onUpdate({ ...props.block, language: lang() })} class={menuItemClass}>
                <Text class="min-w-0 flex-1 font-mono text-xs text-ink">{lang()}</Text>
                <If when={(props.block.language || "plaintext") === lang()}>
                  <Icon name="check" size={12} tone="accent" />
                </If>
              </MenuItem>
            )}
          </Each>
        </Menu>
        <IconButton
          icon={copied() ? "check" : "copy"}
          size={12}
          label={t("web.base.rich.copy")}
          onClick={copyCode}
          testid={`doc-code-copy-${props.block.id}`}
        />
      </View>
    </View>
  );
}

const DEFAULT_TABLE_COL_WIDTH = 180;
const MIN_TABLE_COL_WIDTH = 96;

function alignTextClass(align: string | undefined): string {
  switch (align) {
    case "center":
      return "text-center";
    case "right":
      return "text-right";
    default:
      return "text-left";
  }
}

export function TableBlockView(props: {
  readonly block: TableBlockData;
  readonly notes?: readonly Note[] | undefined;
  readonly issues?: readonly Issue[] | undefined;
  readonly onUpdate: (next: TableBlockData) => void;
  readonly onOpenNote?: ((id: NoteId) => void) | undefined;
  readonly onOpenIssue?: ((id: IssueId) => void) | undefined;
}) {
  const cellRefs = new Map<string, RichInlineFieldRef>();
  const activeResize = signal<{ readonly colIdx: number; readonly startX: number; readonly baseWidth: number } | undefined>(undefined);

  const colWidthOf = (colIdx: number): number => {
    const w = props.block.columnWidths?.[colIdx];
    return typeof w === "number" && w >= MIN_TABLE_COL_WIDTH ? w : DEFAULT_TABLE_COL_WIDTH;
  };

  const setColumnWidth = (colIdx: number, rawWidth: number) => {
    const nextWidth = Math.max(MIN_TABLE_COL_WIDTH, Math.round(rawWidth));
    const widths = props.block.headers.map((_, idx) => (idx === colIdx ? nextWidth : colWidthOf(idx)));
    props.onUpdate({ ...props.block, columnWidths: widths });
  };

  const focusCell = (row: number, col: number) => {
    queueMicrotask(() => cellRefs.get(`${row}:${col}`)?.focus("end"));
  };

  const totalTableWidth = computed(() => props.block.headers.reduce((sum, _, idx) => sum + colWidthOf(idx), 0));

  return (
    <View
      testID={`doc-table-${props.block.id}`}
      onMouseMove={(e) => {
        const cur = untracked(activeResize);
        if (!cur) return;
        if (!e.pressedButton) {
          activeResize.set(undefined);
          return;
        }
        setColumnWidth(cur.colIdx, cur.baseWidth + (e.pagePosition.x - cur.startX));
      }}
      onMouseUp={() => {
        if (untracked(activeResize) !== undefined) activeResize.set(undefined);
      }}
      class="relative min-w-0 overflow-hidden rounded-md border border-line bg-page"
    >
      <View class="min-w-0 flex-row items-stretch">
        <Scroll horizontal scrollbar={false} class="min-w-0 flex-1" contentClass="flex-row">
          <View style={{ minWidth: totalTableWidth() }}>
            <View class="flex-row border-b border-line bg-side">
              <Each of={props.block.headers} key={(_, colIdx) => String(colIdx)}>
                {(header, colIdx) => {
                  const width = () => colWidthOf(colIdx());
                  return (
                    <View style={{ width: width() }} class="group relative min-w-0 shrink-0 border-r border-line px-2 py-1.5 last:border-r-0">
                      <RichInlineField
                        testID={`doc-table-header-${props.block.id}-${colIdx()}`}
                        blockId={props.block.id}
                        value={header()}
                        placeholder={`Col ${colIdx() + 1}`}
                        notes={props.notes}
                        issues={props.issues}
                        enterBehavior="submit"
                        lineHeightPx={20}
                        contentClass="px-0.5 py-0 pr-5"
                        textClass={`w-full min-w-0 text-xs font-semibold leading-5 text-ink ${alignTextClass(props.block.alignments?.[colIdx()])}`}
                        onUpdate={(nextHeader) => props.onUpdate(updateTableHeader(props.block, colIdx(), nextHeader))}
                        onOpenNote={props.onOpenNote}
                        onOpenIssue={props.onOpenIssue}
                      />
                      <View class="absolute top-0.5 right-2 z-10 opacity-0 group-hover:opacity-100 focus-within:opacity-100">
                        <Menu
                          placement="bottom"
                          align="end"
                          offset={4}
                          popupClass={menuPopupClass}
                          popupStartingClass={popupTransition("opacity-0")}
                          popupEndingClass={popupTransition("opacity-0")}
                          trigger={
                            <View
                              role="button"
                              testID={`doc-table-col-menu-${props.block.id}-${colIdx()}`}
                              accessibilityLabel={t("web.note.page.more")}
                              class="size-4 items-center justify-center rounded-xs bg-elevated shadow-float hover:bg-hover"
                            >
                              <Icon name="more" size={11} tone="muted" />
                            </View>
                          }
                        >
                          <MenuItem
                            testID={`doc-table-align-${props.block.id}-${colIdx()}`}
                            onSelect={() => props.onUpdate(cycleTableAlignment(props.block, colIdx()))}
                            class={menuItemClass}
                          >
                            <Icon name="indent" size={12} tone="muted" />
                            <Text class="min-w-0 flex-1 text-xs text-ink">{t("web.note.doc.tableAlign")}</Text>
                          </MenuItem>
                          <If when={colIdx() > 0}>
                            <MenuItem
                              testID={`doc-table-col-left-${props.block.id}-${colIdx()}`}
                              onSelect={() => props.onUpdate(moveTableColumn(props.block, colIdx(), colIdx() - 1))}
                              class={menuItemClass}
                            >
                              <Icon name="previous" size={12} tone="muted" />
                              <Text class="min-w-0 flex-1 text-xs text-ink">{t("web.note.doc.tableMoveColLeft")}</Text>
                            </MenuItem>
                          </If>
                          <If when={colIdx() < props.block.headers.length - 1}>
                            <MenuItem
                              testID={`doc-table-col-right-${props.block.id}-${colIdx()}`}
                              onSelect={() => props.onUpdate(moveTableColumn(props.block, colIdx(), colIdx() + 1))}
                              class={menuItemClass}
                            >
                              <Icon name="next" size={12} tone="muted" />
                              <Text class="min-w-0 flex-1 text-xs text-ink">{t("web.note.doc.tableMoveColRight")}</Text>
                            </MenuItem>
                          </If>
                          <MenuItem
                            testID={`doc-table-ins-col-${props.block.id}-${colIdx()}`}
                            onSelect={() => props.onUpdate(insertTableColumnAt(props.block, colIdx() + 1))}
                            class={menuItemClass}
                          >
                            <Icon name="add" size={12} tone="muted" />
                            <Text class="min-w-0 flex-1 text-xs text-ink">{t("web.note.doc.tableInsertColAfter")}</Text>
                          </MenuItem>
                          <MenuItem onSelect={() => setColumnWidth(colIdx(), colWidthOf(colIdx()) + 48)} class={menuItemClass}>
                            <Icon name="enlarge" size={12} tone="muted" />
                            <Text class="min-w-0 flex-1 text-xs text-ink">+48px</Text>
                          </MenuItem>
                          <MenuItem onSelect={() => setColumnWidth(colIdx(), colWidthOf(colIdx()) - 48)} class={menuItemClass}>
                            <Icon name="minus" size={12} tone="muted" />
                            <Text class="min-w-0 flex-1 text-xs text-ink">-48px</Text>
                          </MenuItem>
                          <If when={props.block.headers.length > 1}>
                            <MenuSeparator class="my-1 h-px bg-line" />
                            <MenuItem
                              testID={`doc-table-del-col-${props.block.id}-${colIdx()}`}
                              onSelect={() => props.onUpdate(removeTableColumn(props.block, colIdx()))}
                              class="h-7 flex-row items-center gap-2 rounded-md px-2 hover:bg-bad-soft focus:bg-bad-soft"
                            >
                              <Icon name="delete" size={12} tone="berry" />
                              <Text class="min-w-0 flex-1 text-xs text-berry">{t("web.note.doc.tableDeleteCol")}</Text>
                            </MenuItem>
                          </If>
                        </Menu>
                      </View>
                      <View
                        testID={`doc-table-resize-${props.block.id}-${colIdx()}`}
                        onPressDown={(e) =>
                          activeResize.set({
                            colIdx: colIdx(),
                            startX: e.pagePosition.x,
                            baseWidth: colWidthOf(colIdx()),
                          })
                        }
                        class="absolute top-0 right-0 bottom-0 z-10 w-1.5 hover:bg-accent"
                      />
                    </View>
                  );
                }}
              </Each>
            </View>
            <Each of={props.block.rows} key={(_, rowIdx) => String(rowIdx)}>
              {(row, rowIdx) => (
                <View class="group relative flex-row border-b border-line last:border-b-0">
                  <View class="absolute top-1 left-0.5 z-10 opacity-0 group-hover:opacity-100 focus-within:opacity-100">
                    <Menu
                      placement="right"
                      align="start"
                      offset={4}
                      popupClass={menuPopupClass}
                      popupStartingClass={popupTransition("opacity-0")}
                      popupEndingClass={popupTransition("opacity-0")}
                      trigger={
                        <View
                          role="button"
                          testID={`doc-table-row-menu-${props.block.id}-${rowIdx()}`}
                          accessibilityLabel={t("web.note.page.more")}
                          class="size-4 items-center justify-center rounded-xs bg-elevated shadow-float hover:bg-hover"
                        >
                          <Icon name="more" size={11} tone="muted" />
                        </View>
                      }
                    >
                      <If when={rowIdx() > 0}>
                        <MenuItem
                          testID={`doc-table-row-up-${props.block.id}-${rowIdx()}`}
                          onSelect={() => props.onUpdate(moveTableRow(props.block, rowIdx(), rowIdx() - 1))}
                          class={menuItemClass}
                        >
                          <Icon name="moveUp" size={12} tone="muted" />
                          <Text class="min-w-0 flex-1 text-xs text-ink">{t("web.note.doc.moveUp")}</Text>
                        </MenuItem>
                      </If>
                      <If when={rowIdx() < props.block.rows.length - 1}>
                        <MenuItem
                          testID={`doc-table-row-down-${props.block.id}-${rowIdx()}`}
                          onSelect={() => props.onUpdate(moveTableRow(props.block, rowIdx(), rowIdx() + 1))}
                          class={menuItemClass}
                        >
                          <Icon name="moveDown" size={12} tone="muted" />
                          <Text class="min-w-0 flex-1 text-xs text-ink">{t("web.note.doc.moveDown")}</Text>
                        </MenuItem>
                      </If>
                      <MenuItem
                        testID={`doc-table-ins-row-${props.block.id}-${rowIdx()}`}
                        onSelect={() => {
                          const targetRow = rowIdx() + 1;
                          props.onUpdate(insertTableRowAt(props.block, targetRow));
                          focusCell(targetRow, 0);
                        }}
                        class={menuItemClass}
                      >
                        <Icon name="add" size={12} tone="muted" />
                        <Text class="min-w-0 flex-1 text-xs text-ink">{t("web.note.doc.tableInsertRowBelow")}</Text>
                      </MenuItem>
                      <If when={props.block.rows.length > 1}>
                        <MenuSeparator class="my-1 h-px bg-line" />
                        <MenuItem
                          testID={`doc-table-del-row-${props.block.id}-${rowIdx()}`}
                          onSelect={() => props.onUpdate(removeTableRow(props.block, rowIdx()))}
                          class="h-7 flex-row items-center gap-2 rounded-md px-2 hover:bg-bad-soft focus:bg-bad-soft"
                        >
                          <Icon name="delete" size={12} tone="berry" />
                          <Text class="min-w-0 flex-1 text-xs text-berry">{t("web.note.doc.tableDeleteRow")}</Text>
                        </MenuItem>
                      </If>
                    </Menu>
                  </View>
                  <Each of={props.block.headers} key={(_, colIdx) => String(colIdx)}>
                    {(_, colIdx) => {
                      const cell = () => row()[colIdx()] ?? "";
                      return (
                        <View
                          role="button"
                          focusable={false}
                          testID={`doc-table-cell-${props.block.id}-${rowIdx()}-${colIdx()}`}
                          onPress={() => focusCell(rowIdx(), colIdx())}
                          style={{ width: colWidthOf(colIdx()) }}
                          class="min-w-0 shrink-0 overflow-hidden border-r border-line px-2 py-1 last:border-r-0"
                        >
                          <RichInlineField
                            ref={(el) => {
                              cellRefs.set(`${rowIdx()}:${colIdx()}`, el);
                            }}
                            testID={`doc-table-cell-input-${props.block.id}-${rowIdx()}-${colIdx()}`}
                            blockId={props.block.id}
                            value={cell()}
                            placeholder="…"
                            notes={props.notes}
                            issues={props.issues}
                            enterBehavior="submit"
                            lineHeightPx={20}
                            contentClass="px-1 py-0.5"
                            textClass={`w-full min-w-0 text-xs leading-5 text-ink ${alignTextClass(props.block.alignments?.[colIdx()])}`}
                            onUpdate={(nextText) => props.onUpdate(updateTableCell(props.block, rowIdx(), colIdx(), nextText))}
                            onOpenNote={props.onOpenNote}
                            onOpenIssue={props.onOpenIssue}
                            onSubmit={() => {
                              const nextTarget = nextTableCellTarget(props.block.rows.length, props.block.headers.length, rowIdx(), colIdx(), "down");
                              if (!nextTarget || nextTarget.addRow === true) {
                                const newRowIdx = props.block.rows.length;
                                props.onUpdate(addTableRow(props.block));
                                focusCell(newRowIdx, colIdx());
                              } else {
                                focusCell(nextTarget.row, nextTarget.col);
                              }
                            }}
                            onTab={(shiftKey) => {
                              const target = nextTableCellTarget(
                                props.block.rows.length,
                                props.block.headers.length,
                                rowIdx(),
                                colIdx(),
                                shiftKey ? "prev" : "next",
                              );
                              if (target && target.addRow !== true) {
                                focusCell(target.row, target.col);
                              } else if (!shiftKey) {
                                const newRowIdx = props.block.rows.length;
                                props.onUpdate(addTableRow(props.block));
                                focusCell(newRowIdx, 0);
                              }
                              return true;
                            }}
                          />
                        </View>
                      );
                    }}
                  </Each>
                </View>
              )}
            </Each>
          </View>
        </Scroll>
        <View
          role="button"
          testID={`doc-table-add-col-${props.block.id}`}
          accessibilityLabel={t("web.note.doc.addCol")}
          onPress={() => props.onUpdate(addTableColumn(props.block))}
          class="w-6 shrink-0 items-center justify-center border-l border-line bg-side hover:bg-hover"
        >
          <Icon name="add" size={12} tone="muted" />
        </View>
      </View>
      <View
        role="button"
        testID={`doc-table-add-row-${props.block.id}`}
        accessibilityLabel={t("web.note.doc.addRow")}
        onPress={() => props.onUpdate(addTableRow(props.block))}
        class="h-6 flex-row items-center justify-center gap-1 border-t border-line bg-side hover:bg-hover"
      >
        <Icon name="add" size={11} tone="muted" />
        <Text class="text-2xs text-muted">{t("web.note.doc.addRow")}</Text>
      </View>
    </View>
  );
}

function domainOf(rawUrl: string): string {
  const m = /^https?:\/\/([^/?#]+)/iu.exec(rawUrl.trim());
  return m?.[1] ?? rawUrl;
}

export function BookmarkBlockView(props: { readonly block: BookmarkBlockData; readonly onUpdate: (next: BookmarkBlockData) => void }) {
  const host = useDesignHost();
  const inspectorOpen = signal(false);

  return (
    <View testID={`doc-bookmark-${props.block.id}`} class="group relative min-w-0 rounded-lg border border-line bg-side p-3">
      <View
        role="button"
        testID={`doc-bookmark-open-${props.block.id}`}
        onPress={() => {
          if (props.block.url.trim()) {
            void host.openExternal(props.block.url);
          } else {
            inspectorOpen.set(true);
          }
        }}
        class="min-w-0 gap-0.5 rounded-sm pr-14 hover:opacity-85"
      >
        <View class="min-w-0 flex-row items-center gap-1.5">
          <Icon name="link" size={14} tone="accent" />
          <Text class="min-w-0 flex-1 truncate text-sm font-semibold text-ink">{props.block.title || props.block.url || t("web.note.doc.bookmarkEdit")}</Text>
        </View>
        <If when={props.block.description}>{(desc) => <Text class="line-clamp-2 text-xs text-muted">{desc()}</Text>}</If>
        <If when={props.block.url.trim().length > 0}>
          <Text class="truncate font-mono text-2xs text-faint">{domainOf(props.block.url)}</Text>
        </If>
      </View>

      <View class="absolute top-2 right-2 z-10 flex-row items-center gap-1 rounded-md border border-line bg-elevated px-1 py-0.5 opacity-0 shadow-float group-hover:opacity-100 focus-within:opacity-100">
        <If when={props.block.url.trim().length > 0}>
          <IconButton
            icon="open"
            size={12}
            label={t("web.note.doc.bookmarkOpen")}
            onClick={() => void host.openExternal(props.block.url)}
            testid={`doc-bookmark-ext-${props.block.id}`}
          />
        </If>
        <Popover
          open={inspectorOpen()}
          onOpenChange={(e) => inspectorOpen.set(e.open)}
          placement="bottom"
          align="end"
          offset={6}
          popupClass="w-80 gap-2 rounded-lg border border-line bg-elevated p-3 shadow-float"
          trigger={
            <View role="button" testID={`doc-bookmark-edit-${props.block.id}`} class="rounded-xs p-1 hover:bg-hover">
              <Icon name="edit" size={13} tone="muted" />
            </View>
          }
        >
          <TextInput
            testID={`doc-bookmark-url-${props.block.id}`}
            value={props.block.url}
            placeholder="https://..."
            onInput={(v) => props.onUpdate({ ...props.block, url: v })}
          />
          <TextInput
            testID={`doc-bookmark-title-${props.block.id}`}
            value={props.block.title ?? ""}
            placeholder={t("web.note.doc.titleOptional")}
            onInput={(v) => props.onUpdate({ ...props.block, title: v || undefined })}
          />
          <TextInput
            testID={`doc-bookmark-desc-${props.block.id}`}
            value={props.block.description ?? ""}
            placeholder={t("web.note.doc.descOptional")}
            onInput={(v) => props.onUpdate({ ...props.block, description: v || undefined })}
          />
        </Popover>
      </View>
    </View>
  );
}

export function TocBlockView(props: {
  readonly block: TocBlockData;
  readonly allBlocks: readonly DocBlock[];
  readonly onUpdate: (next: TocBlockData) => void;
  readonly onScrollToBlock?: ((blockId: string) => void) | undefined;
}) {
  const maxLevel = () => props.block.maxLevel ?? 3;
  const entries = computed(() => extractTocEntries(props.allBlocks, maxLevel()));

  return (
    <View testID={`doc-toc-${props.block.id}`} class="group relative min-w-0 gap-1.5 border-l-2 border-line py-1 pl-3">
      <View class="relative min-h-6 flex-row items-center pr-24">
        <Text class="text-2xs font-semibold text-faint">{t("web.note.doc.tocTitle")}</Text>
        <View class="absolute top-0 right-0 flex-row items-center gap-1 opacity-0 group-hover:opacity-100 focus-within:opacity-100">
          <Each of={[1, 2, 3] as const} key={(lvl) => String(lvl)}>
            {(lvl) => (
              <View
                role="button"
                testID={`doc-toc-level-${lvl()}-${props.block.id}`}
                onPress={() => props.onUpdate({ ...props.block, maxLevel: lvl() })}
                class={`rounded-xs px-1.5 py-0.5 ${maxLevel() === lvl() ? "bg-selected" : "hover:bg-hover"}`}
              >
                <Text class={`font-mono text-2xs ${maxLevel() === lvl() ? "font-semibold text-ink" : "text-faint"}`}>{`H${lvl()}`}</Text>
              </View>
            )}
          </Each>
        </View>
      </View>
      <If when={entries().length > 0} else={<Text class="text-xs text-faint">{t("web.note.doc.tocEmpty")}</Text>}>
        <View class="gap-0.5">
          <Each of={entries()} key={(entry) => entry.blockId}>
            {(entry) => (
              <View
                role="button"
                testID={`doc-toc-entry-${entry().blockId}`}
                onPress={() => props.onScrollToBlock?.(entry().blockId)}
                class="rounded-sm py-0.5 pr-2 hover:bg-hover"
                style={{ paddingLeft: 4 + Math.max(0, entry().level - 1) * 14 }}
              >
                <Text class={`truncate text-xs ${entry().level === 1 ? "font-medium text-ink" : "text-muted"}`}>{entry().text}</Text>
              </View>
            )}
          </Each>
        </View>
      </If>
    </View>
  );
}

export function MathBlockView(props: { readonly block: MathBlockData; readonly onUpdate: (next: MathBlockData) => void }) {
  const editing = signal(false);
  const isDisplay = () => props.block.display !== false;

  return (
    <View testID={`doc-math-${props.block.id}`} class="group relative min-w-0 py-1">
      <View
        role="button"
        testID={`doc-math-preview-${props.block.id}`}
        onPress={() => editing.set(true)}
        class={`min-w-0 overflow-hidden rounded-md bg-side px-4 py-3 hover:bg-hover ${isDisplay() ? "items-center" : ""}`}
      >
        <Text class="max-w-full font-mono text-base font-medium text-ink">{props.block.expression || "\\sum_{i=1}^n x_i"}</Text>
      </View>

      <View class="absolute top-2 right-2 z-10 opacity-0 group-hover:opacity-100 focus-within:opacity-100">
        <Popover
          open={editing()}
          onOpenChange={(e) => editing.set(e.open)}
          placement="bottom"
          align="end"
          offset={6}
          popupClass="w-80 gap-2 rounded-lg border border-line bg-elevated p-3 shadow-float"
          trigger={
            <View
              role="button"
              testID={`doc-math-edit-${props.block.id}`}
              class="rounded-md border border-line bg-elevated px-1.5 py-0.5 shadow-float hover:bg-hover"
            >
              <Text class="font-mono text-2xs text-muted">{isDisplay() ? "LaTeX $$" : "LaTeX $"}</Text>
            </View>
          }
        >
          <View class="flex-row items-center justify-between gap-2">
            <Text class="text-2xs font-semibold text-muted">{isDisplay() ? "LaTeX $$...$$" : "LaTeX $...$"}</Text>
            <Button
              size="compact"
              tone="quiet"
              testID={`doc-math-display-${props.block.id}`}
              onPress={() => props.onUpdate({ ...props.block, display: !isDisplay() })}
            >
              {isDisplay() ? "Display" : "Inline"}
            </Button>
          </View>
          <Editor
            testID={`doc-math-input-${props.block.id}`}
            value={props.block.expression}
            language="markdown"
            placeholder="E = mc^2"
            minRows={2}
            maxRows={8}
            lineNumbers={false}
            folding={false}
            scrollBeyondLastLine={false}
            softWrap
            onChange={(e) => props.onUpdate({ ...props.block, expression: e.value })}
            class="w-full rounded-sm border border-line bg-page"
          />
        </Popover>
      </View>
    </View>
  );
}

export function ColumnsBlockView(props: {
  readonly block: ColumnsBlockData;
  readonly onUpdate: (next: ColumnsBlockData) => void;
  readonly renderChild: (child: () => DocBlock, prevChild?: () => DocBlock | undefined) => JSX.Element;
}) {
  return (
    <View testID={`doc-columns-${props.block.id}`} class="min-w-0 py-1">
      <View class="min-w-0 flex-row items-start gap-3">
        <Each of={props.block.columns} key={(_, idx) => String(idx)}>
          {(col, colIdx) => (
            <View testID={`doc-column-pane-${props.block.id}-${colIdx()}`} class="min-w-0 flex-1 gap-0 border-l border-line pl-3 first:border-l-0 first:pl-0">
              <Each of={col().blocks} key={(child) => child.id}>
                {(child, childIdx) => props.renderChild(child, () => col().blocks[childIdx() - 1])}
              </Each>
              <If when={col().blocks.length === 0}>
                <Button
                  size="compact"
                  tone="quiet"
                  icon="add"
                  testID={`doc-column-add-${props.block.id}-${colIdx()}`}
                  onPress={() => {
                    const nextCols = props.block.columns.map((c, idx) =>
                      idx === colIdx() ? { blocks: [...c.blocks, { id: makeBlockId(), type: "prose" as const, text: "" }] } : c,
                    );
                    props.onUpdate({ ...props.block, columns: nextCols });
                  }}
                >
                  {t("web.note.doc.addBlock")}
                </Button>
              </If>
            </View>
          )}
        </Each>
      </View>
    </View>
  );
}

export function PageBreakBlockView(props: {
  readonly block: PageBreakBlockData;
  readonly slideIndex: number;
  readonly onUpdate: (next: PageBreakBlockData) => void;
}) {
  return (
    <View testID={`doc-page-break-${props.block.id}`} class="my-2 min-w-0 gap-1.5 border-t border-dashed border-line-strong pt-3">
      <View class="min-w-0 flex-row items-start gap-2">
        <View class="mt-0.5 shrink-0 rounded-sm bg-side px-1.5 py-0.5">
          <Text class="font-mono text-2xs font-semibold text-accent">{t("web.note.doc.slideLabel", { n: props.slideIndex })}</Text>
        </View>
        <Input
          testID={`doc-page-break-title-${props.block.id}`}
          value={props.block.title ?? ""}
          placeholder={t("web.note.doc.slideTitlePlaceholder")}
          multiline
          scrollbar={false}
          submitBehavior="submit"
          onChange={(e) => props.onUpdate({ ...props.block, title: e.value || undefined })}
          class="min-w-0 flex-1 bg-transparent px-1 py-0 text-xs font-medium text-ink placeholder:text-faint"
        />
      </View>
      <If when={props.block.speakerNotes !== undefined}>
        <Input
          testID={`doc-page-break-notes-${props.block.id}`}
          value={props.block.speakerNotes ?? ""}
          placeholder={t("web.note.doc.speakerNotesPlaceholder")}
          multiline
          scrollbar={false}
          submitBehavior="submit"
          onChange={(e) => props.onUpdate({ ...props.block, speakerNotes: e.value || undefined })}
          class="min-w-0 w-full bg-transparent px-1 py-0.5 text-xs text-muted placeholder:text-faint"
        />
      </If>
    </View>
  );
}
