import { Clipboard, computed, signal, Text, untracked, View, type JSX } from "nsh";
import { Input } from "nsh/base";

import { t } from "@vibevalley/i18n";
import type { DocBlock, Issue, IssueId, Note, NoteId } from "@vibevalley/protocol";

import { Button } from "../../../design/Button";
import { CodeBlock } from "../../../design/code/CodeBlock";
import { TextArea, TextInput } from "../../../design/Field";
import { useDesignHost } from "../../../design/host";
import { Icon } from "../../../design/Icon";
import { IconButton } from "../../../design/IconButton";
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
  makeBlockId,
  removeTableColumn,
  removeTableRow,
  setColumnsCount,
  updateTableCell,
  updateTableHeader,
} from "./docOps";
import { InlineRichText } from "./InlineRichText";

type ToggleBlockData = Extract<DocBlock, { type: "toggle" }>;
type CalloutBlockData = Extract<DocBlock, { type: "callout" }>;
type CodeBlockData = Extract<DocBlock, { type: "code" }>;
type TableBlockData = Extract<DocBlock, { type: "table" }>;
type BookmarkBlockData = Extract<DocBlock, { type: "bookmark" }>;
type TocBlockData = Extract<DocBlock, { type: "toc" }>;
type MathBlockData = Extract<DocBlock, { type: "math" }>;
type ColumnsBlockData = Extract<DocBlock, { type: "columns" }>;
type PageBreakBlockData = Extract<DocBlock, { type: "pageBreak" }>;

export function ToggleBlockView(props: {
  readonly block: ToggleBlockData;
  readonly notes: readonly Note[];
  readonly issues: readonly Issue[];
  readonly onUpdate: (next: ToggleBlockData) => void;
  readonly onOpenNote: (id: NoteId) => void;
  readonly onOpenIssue: (id: IssueId) => void;
  readonly renderChild: (child: DocBlock) => JSX.Element;
}) {
  const isCollapsed = () => props.block.collapsed === true;
  const children = () => props.block.children ?? [];

  return (
    <View testID={`doc-toggle-${props.block.id}`} class="py-1">
      <View class="flex-row items-center gap-1.5">
        <View
          role="button"
          testID={`doc-toggle-btn-${props.block.id}`}
          accessibilityLabel={props.block.title || t("web.note.doc.slash.toggle.label")}
          accessibilityState={{ expanded: !isCollapsed() }}
          onPress={() => props.onUpdate({ ...props.block, collapsed: !isCollapsed() })}
          class="size-6 shrink-0 items-center justify-center rounded-sm hover:bg-hover"
        >
          <Icon name={isCollapsed() ? "expand" : "choose"} size={12} tone="muted" />
        </View>
        <Input
          testID={`doc-toggle-title-${props.block.id}`}
          value={props.block.title}
          placeholder={t("web.note.doc.toggleTitlePlaceholder")}
          onChange={(e) => props.onUpdate({ ...props.block, title: e.value })}
          class="min-w-0 flex-1 rounded-sm bg-transparent px-1 py-0.5 text-sm font-semibold text-ink placeholder:text-faint"
        />
      </View>
      <If when={!isCollapsed()}>
        <View testID={`doc-toggle-body-${props.block.id}`} class="mt-1 ml-3 gap-1.5 border-l border-line pl-4">
          <Input
            multiline
            scrollbar={false}
            testID={`doc-toggle-text-${props.block.id}`}
            value={props.block.text}
            placeholder={t("web.note.doc.toggleBodyPlaceholder")}
            onChange={(e) => props.onUpdate({ ...props.block, text: e.value })}
            class="min-h-6 w-full rounded-sm bg-transparent px-1 py-0 text-sm leading-6 text-ink placeholder:text-faint"
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
          <If when={children().length > 0}>
            <View class="gap-1">
              <Each of={children()} key={(child) => child.id}>
                {(child) => props.renderChild(child())}
              </Each>
            </View>
          </If>
          <View class="flex-row opacity-0 group-hover:opacity-100 focus-within:opacity-100">
            <Button
              size="compact"
              tone="quiet"
              icon="add"
              testID={`doc-toggle-add-child-${props.block.id}`}
              onPress={() =>
                props.onUpdate({
                  ...props.block,
                  collapsed: false,
                  children: [...children(), { id: makeBlockId("tgl"), type: "prose", text: "" }],
                })
              }
            >
              {t("web.note.doc.addBlock")}
            </Button>
          </View>
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
  const visual = computed(() => calloutVisualOf(props.block.tone));
  const bgStyle = () => (visual().mixToken !== undefined ? { backgroundColor: mix(visual().mixToken ?? "water", 0.12) } : undefined);

  return (
    <View testID={`doc-callout-${props.block.id}`} class={`gap-1.5 rounded-lg border border-line p-3 ${visual().bgClass}`} style={bgStyle()}>
      <View class="flex-row items-center justify-between gap-2">
        <View class="min-w-0 flex-1 flex-row items-center gap-2">
          <Icon name={visual().icon} size={16} tone={visual().iconTone} />
          <Input
            testID={`doc-callout-title-${props.block.id}`}
            value={props.block.title ?? ""}
            placeholder={visual().label}
            onChange={(e) => props.onUpdate({ ...props.block, title: e.value || undefined })}
            class={`min-w-0 flex-1 bg-transparent px-1 py-0 text-sm leading-6 font-semibold placeholder:text-faint ${visual().textClass}`}
          />
        </View>
        <View class="flex-row items-center gap-1 opacity-0 group-hover:opacity-100 focus-within:opacity-100">
          <Each of={CALLOUT_TONES} key={(toneKey) => toneKey}>
            {(toneKey) => {
              const active = () => visual().tone === toneKey();
              return (
                <View
                  role="button"
                  focusable={false}
                  testID={`doc-callout-tone-${toneKey()}-${props.block.id}`}
                  onPress={() => props.onUpdate({ ...props.block, tone: toneKey() })}
                  class={`rounded-xs px-1.5 py-0.5 ${active() ? "bg-selected" : "hover:bg-hover"}`}
                >
                  <Text class={`text-2xs ${active() ? "font-semibold text-ink" : "text-muted"}`}>{calloutToneLabel(toneKey())}</Text>
                </View>
              );
            }}
          </Each>
        </View>
      </View>
      <Input
        multiline
        scrollbar={false}
        testID={`doc-callout-text-${props.block.id}`}
        value={props.block.text}
        placeholder={t("web.note.doc.calloutPlaceholder")}
        onChange={(e) => props.onUpdate({ ...props.block, text: e.value })}
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
    </View>
  );
}

const CODE_LANGUAGES = ["typescript", "rust", "python", "json", "sql", "bash", "markdown", "plaintext"] as const;

export function CodeBlockView(props: { readonly block: CodeBlockData; readonly onUpdate: (next: CodeBlockData) => void }) {
  const editing = signal(untracked(() => props.block.code.trim() === ""));
  const copied = signal(false);
  const later = useTimeout();

  const copyCode = () => {
    void Clipboard.writeText(props.block.code).then(
      () => {
        copied.set(true);
        toast(t("web.base.rich.copied"));
        later(() => copied.set(false), 1500);
      },
      () => undefined,
    );
  };

  return (
    <View testID={`doc-code-${props.block.id}`} class="relative overflow-hidden rounded-lg">
      <If
        when={editing()}
        else={
          <View class="relative">
            <CodeBlock code={props.block.code || "// empty"} language={props.block.language} class="my-0" />
            <View class="absolute top-1.5 right-8 flex-row items-center gap-1 opacity-0 group-hover:opacity-100 focus-within:opacity-100">
              <Button size="compact" tone="quiet" icon="edit" testID={`doc-code-mode-${props.block.id}`} onPress={() => editing.set(true)}>
                {t("web.note.doc.edit")}
              </Button>
            </View>
          </View>
        }
      >
        <View class="overflow-hidden rounded-lg border border-line bg-side">
          <View class="flex-row items-center justify-between gap-2 border-b border-line px-3 py-1.5">
            <View class="flex-row flex-wrap items-center gap-1">
              <Input
                testID={`doc-code-lang-${props.block.id}`}
                value={props.block.language ?? ""}
                placeholder={t("web.note.doc.codeLanguagePlaceholder")}
                onChange={(e) => props.onUpdate({ ...props.block, language: e.value.trim() || undefined })}
                class="h-6 w-28 rounded-xs border border-line bg-page px-1.5 font-mono text-2xs text-ink"
              />
              <Each of={CODE_LANGUAGES.slice(0, 4)} key={(lang) => lang}>
                {(lang) => (
                  <View
                    role="button"
                    onPress={() => props.onUpdate({ ...props.block, language: lang() })}
                    class={`rounded-xs px-1.5 py-0.5 hover:bg-hover ${(props.block.language ?? "") === lang() ? "bg-selected" : ""}`}
                  >
                    <Text class="font-mono text-2xs text-muted">{lang()}</Text>
                  </View>
                )}
              </Each>
            </View>
            <View class="flex-row items-center gap-1">
              <Button size="compact" tone="quiet" icon="show" testID={`doc-code-mode-${props.block.id}`} onPress={() => editing.set(false)}>
                {t("web.note.doc.preview")}
              </Button>
              <IconButton
                icon={copied() ? "check" : "copy"}
                size={14}
                label={t("web.base.rich.copy")}
                onClick={copyCode}
                testid={`doc-code-copy-${props.block.id}`}
              />
            </View>
          </View>
          <View class="p-2">
            <TextArea
              testID={`doc-code-input-${props.block.id}`}
              rows={5}
              value={props.block.code}
              placeholder={t("web.note.doc.codePlaceholder")}
              onInput={(v) => props.onUpdate({ ...props.block, code: v })}
              class="font-mono text-xs leading-relaxed"
            />
          </View>
        </View>
      </If>
    </View>
  );
}

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

export function TableBlockView(props: { readonly block: TableBlockData; readonly onUpdate: (next: TableBlockData) => void }) {
  const activeCell = signal<string | undefined>(undefined);
  return (
    <View testID={`doc-table-${props.block.id}`} class="overflow-hidden rounded-md border border-line bg-page">
      <View class="flex-row items-center border-b border-line bg-side px-2 py-1.5">
        <Each of={props.block.headers} key={(_, colIdx) => String(colIdx)}>
          {(header, colIdx) => {
            const align = () => props.block.alignments?.[colIdx()] ?? "left";
            return (
              <View class="min-w-0 flex-1 flex-row items-center gap-1 px-1">
                <Input
                  testID={`doc-table-header-${props.block.id}-${colIdx()}`}
                  value={header()}
                  onChange={(e) => props.onUpdate(updateTableHeader(props.block, colIdx(), e.value))}
                  class={`min-w-0 flex-1 bg-transparent text-xs font-semibold text-ink ${alignTextClass(align())}`}
                />
                <View
                  role="button"
                  testID={`doc-table-align-${props.block.id}-${colIdx()}`}
                  onPress={() => props.onUpdate(cycleTableAlignment(props.block, colIdx()))}
                  class="rounded-xs px-1 py-0.5 opacity-0 group-hover:opacity-100 hover:bg-hover"
                >
                  <Text class="font-mono text-2xs text-faint">{align() === "center" ? "C" : align() === "right" ? "R" : "L"}</Text>
                </View>
                <If when={props.block.headers.length > 1}>
                  <View
                    role="button"
                    testID={`doc-table-del-col-${props.block.id}-${colIdx()}`}
                    onPress={() => props.onUpdate(removeTableColumn(props.block, colIdx()))}
                    class="rounded-xs p-0.5 opacity-0 group-hover:opacity-100 hover:bg-bad-soft"
                  >
                    <Icon name="close" size={10} tone="muted" />
                  </View>
                </If>
              </View>
            );
          }}
        </Each>
        <View class="w-6 shrink-0" />
      </View>
      <Each of={props.block.rows} key={(_, rowIdx) => String(rowIdx)}>
        {(row, rowIdx) => (
          <View class="flex-row items-start border-t border-line px-2 py-1.5 hover:bg-hover">
            <Each of={row()} key={(_, colIdx) => String(colIdx)}>
              {(cell, colIdx) => {
                const cellKey = () => `${rowIdx()}:${colIdx()}`;
                const editing = () => activeCell() === cellKey();
                return (
                  <View class="min-w-0 flex-1 px-1">
                    <If
                      when={editing()}
                      else={
                        <View
                          role="button"
                          testID={`doc-table-cell-${props.block.id}-${rowIdx()}-${colIdx()}`}
                          onPress={() => activeCell.set(cellKey())}
                          class="min-h-6 justify-center rounded-xs border border-transparent px-1 py-0.5 hover:bg-hover"
                        >
                          <Text class={`text-xs leading-relaxed ${cell() ? "text-ink" : "text-faint"} ${alignTextClass(props.block.alignments?.[colIdx()])}`}>
                            {cell() || "…"}
                          </Text>
                        </View>
                      }
                    >
                      <Input
                        autoFocus
                        testID={`doc-table-cell-input-${props.block.id}-${rowIdx()}-${colIdx()}`}
                        value={cell()}
                        placeholder="…"
                        onChange={(e) => props.onUpdate(updateTableCell(props.block, rowIdx(), colIdx(), e.value))}
                        onSubmit={() => activeCell.set(undefined)}
                        onBlur={() => activeCell.set(undefined)}
                        class={`min-h-6 w-full min-w-0 rounded-xs border border-focus bg-page px-1 py-0.5 text-xs leading-relaxed text-ink placeholder:text-faint ${alignTextClass(props.block.alignments?.[colIdx()])}`}
                      />
                    </If>
                  </View>
                );
              }}
            </Each>
            <View class="w-6 shrink-0 items-center opacity-0 group-hover:opacity-100">
              <If when={props.block.rows.length > 1}>
                <View
                  role="button"
                  testID={`doc-table-del-row-${props.block.id}-${rowIdx()}`}
                  onPress={() => props.onUpdate(removeTableRow(props.block, rowIdx()))}
                  class="rounded-xs p-0.5 hover:bg-bad-soft"
                >
                  <Icon name="close" size={10} tone="muted" />
                </View>
              </If>
            </View>
          </View>
        )}
      </Each>
      <View class="flex-row items-center justify-end gap-1 border-t border-line bg-side px-2 py-1 opacity-0 group-hover:opacity-100 focus-within:opacity-100">
        <Button
          size="compact"
          tone="quiet"
          icon="add"
          testID={`doc-table-add-col-${props.block.id}`}
          onPress={() => props.onUpdate(addTableColumn(props.block))}
        >
          {t("web.note.doc.addCol")}
        </Button>
        <Button size="compact" tone="quiet" icon="add" testID={`doc-table-add-row-${props.block.id}`} onPress={() => props.onUpdate(addTableRow(props.block))}>
          {t("web.note.doc.addRow")}
        </Button>
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
  const editing = signal(untracked(() => props.block.url.trim() === ""));

  return (
    <View testID={`doc-bookmark-${props.block.id}`} class="gap-2 rounded-lg border border-line bg-side p-3">
      <If
        when={editing()}
        else={
          <View class="flex-row items-center justify-between gap-3">
            <View
              role="button"
              testID={`doc-bookmark-open-${props.block.id}`}
              onPress={() => void host.openExternal(props.block.url)}
              class="min-w-0 flex-1 gap-0.5 rounded-sm hover:opacity-80"
            >
              <View class="flex-row items-center gap-1.5">
                <Icon name="link" size={14} tone="accent" />
                <Text class="min-w-0 flex-1 truncate text-sm font-semibold text-ink">{props.block.title || props.block.url}</Text>
              </View>
              <If when={props.block.description}>{(desc) => <Text class="line-clamp-2 text-xs text-muted">{desc()}</Text>}</If>
              <Text class="truncate font-mono text-2xs text-faint">{domainOf(props.block.url)}</Text>
            </View>
            <View class="flex-row items-center gap-1 opacity-0 group-hover:opacity-100 focus-within:opacity-100">
              <IconButton
                icon="open"
                size={14}
                label={t("web.note.doc.bookmarkOpen")}
                onClick={() => void host.openExternal(props.block.url)}
                testid={`doc-bookmark-ext-${props.block.id}`}
              />
              <IconButton
                icon="edit"
                size={14}
                label={t("web.note.doc.bookmarkEdit")}
                onClick={() => editing.set(true)}
                testid={`doc-bookmark-edit-${props.block.id}`}
              />
            </View>
          </View>
        }
      >
        <View class="gap-2">
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
          <View class="flex-row justify-end">
            <Button size="compact" tone="primary" testID={`doc-bookmark-done-${props.block.id}`} onPress={() => editing.set(false)}>
              {t("web.base.form.save")}
            </Button>
          </View>
        </View>
      </If>
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
    <View testID={`doc-toc-${props.block.id}`} class="gap-1.5 border-l-2 border-line py-1 pl-3">
      <View class="flex-row items-center justify-between gap-2">
        <Text class="text-2xs font-semibold text-faint">{t("web.note.doc.tocTitle")}</Text>
        <View class="flex-row items-center gap-1 opacity-0 group-hover:opacity-100 focus-within:opacity-100">
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
  const editing = signal(untracked(() => props.block.expression.trim() === ""));
  const isDisplay = () => props.block.display !== false;

  return (
    <View testID={`doc-math-${props.block.id}`} class="gap-2 py-1">
      <View class={`flex-row items-center justify-between gap-2 ${editing() ? "opacity-100" : "opacity-0 group-hover:opacity-100 focus-within:opacity-100"}`}>
        <Text class="font-mono text-2xs font-semibold text-faint">{isDisplay() ? "LaTeX $$...$$" : "LaTeX $...$"}</Text>
        <View class="flex-row items-center gap-1">
          <Button
            size="compact"
            tone="quiet"
            testID={`doc-math-display-${props.block.id}`}
            onPress={() => props.onUpdate({ ...props.block, display: !isDisplay() })}
          >
            {isDisplay() ? t("web.note.doc.mathBlock") : t("web.note.doc.mathInline")}
          </Button>
          <Button
            size="compact"
            tone="quiet"
            icon={editing() ? "show" : "edit"}
            testID={`doc-math-edit-${props.block.id}`}
            onPress={() => editing.set(!editing())}
          >
            {editing() ? t("web.note.doc.render") : t("web.note.doc.edit")}
          </Button>
        </View>
      </View>
      <If
        when={editing()}
        else={
          <View
            role="button"
            testID={`doc-math-preview-${props.block.id}`}
            onPress={() => editing.set(true)}
            class={`rounded-md bg-side px-4 py-3 hover:bg-hover ${isDisplay() ? "items-center" : ""}`}
          >
            <Text class="font-mono text-base font-medium text-ink">{props.block.expression || "\\sum_{i=1}^n x_i"}</Text>
          </View>
        }
      >
        <TextArea
          testID={`doc-math-input-${props.block.id}`}
          rows={2}
          value={props.block.expression}
          placeholder="E = mc^2"
          onInput={(v) => props.onUpdate({ ...props.block, expression: v })}
          class="font-mono text-xs"
        />
      </If>
    </View>
  );
}

export function ColumnsBlockView(props: {
  readonly block: ColumnsBlockData;
  readonly onUpdate: (next: ColumnsBlockData) => void;
  readonly renderChild: (child: DocBlock) => JSX.Element;
}) {
  const count = () => props.block.columns.length;

  return (
    <View testID={`doc-columns-${props.block.id}`} class="gap-1.5 py-1">
      <View class="flex-row items-center justify-between gap-2 px-1 opacity-0 group-hover:opacity-100 focus-within:opacity-100">
        <Text class="text-2xs font-semibold text-muted">{t("web.note.doc.columnsCount", { n: count() })}</Text>
        <View class="flex-row items-center gap-1">
          <Button
            size="compact"
            tone={count() === 2 ? "primary" : "quiet"}
            testID={`doc-columns-2-${props.block.id}`}
            onPress={() => props.onUpdate(setColumnsCount(props.block, 2))}
          >
            {t("web.note.doc.columnsOption", { n: 2 })}
          </Button>
          <Button
            size="compact"
            tone={count() === 3 ? "primary" : "quiet"}
            testID={`doc-columns-3-${props.block.id}`}
            onPress={() => props.onUpdate(setColumnsCount(props.block, 3))}
          >
            {t("web.note.doc.columnsOption", { n: 3 })}
          </Button>
        </View>
      </View>
      <View class="flex-row items-start gap-4">
        <Each of={props.block.columns} key={(_, idx) => String(idx)}>
          {(col, colIdx) => (
            <View testID={`doc-column-pane-${props.block.id}-${colIdx()}`} class="min-w-0 flex-1 gap-1.5 border-l border-line pl-3 first:border-l-0 first:pl-0">
              <Each of={col().blocks} key={(child) => child.id}>
                {(child) => props.renderChild(child())}
              </Each>
              <View class="opacity-0 group-hover:opacity-100 focus-within:opacity-100">
                <Button
                  size="compact"
                  tone="quiet"
                  icon="add"
                  testID={`doc-column-add-${props.block.id}-${colIdx()}`}
                  onPress={() => {
                    const nextCols = props.block.columns.map((c, i) =>
                      i === colIdx() ? { blocks: [...c.blocks, { id: makeBlockId("col"), type: "prose" as const, text: "" }] } : c,
                    );
                    props.onUpdate({ ...props.block, columns: nextCols });
                  }}
                >
                  {t("web.note.doc.addBlock")}
                </Button>
              </View>
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
    <View testID={`doc-page-break-${props.block.id}`} class="my-2 gap-1.5 border-t border-dashed border-line-strong pt-3">
      <View class="flex-row items-center gap-2">
        <View class="rounded-sm bg-side px-1.5 py-0.5">
          <Text class="font-mono text-2xs font-semibold text-accent">{t("web.note.doc.slideLabel", { n: props.slideIndex })}</Text>
        </View>
        <Input
          testID={`doc-page-break-title-${props.block.id}`}
          value={props.block.title ?? ""}
          placeholder={t("web.note.doc.slideTitlePlaceholder")}
          onChange={(e) => props.onUpdate({ ...props.block, title: e.value || undefined })}
          class="min-w-0 flex-1 bg-transparent text-sm font-semibold text-ink placeholder:text-faint"
        />
      </View>
      <Input
        testID={`doc-page-break-notes-${props.block.id}`}
        value={props.block.speakerNotes ?? ""}
        placeholder={t("web.note.doc.speakerNotesPlaceholder")}
        onChange={(e) => props.onUpdate({ ...props.block, speakerNotes: e.value || undefined })}
        class={`w-full bg-transparent px-1 py-0.5 text-xs text-muted placeholder:text-faint ${
          props.block.speakerNotes ? "opacity-100" : "opacity-0 group-hover:opacity-100 focus:opacity-100"
        }`}
      />
    </View>
  );
}
