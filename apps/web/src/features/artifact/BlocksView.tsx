import { t } from "@vibevalley/i18n";
// A blocks artifact, written block by block with the helpers. A block shows its marks until it is clicked into; then it is
// a plain field (marks are kept through the edit), and Enter splits it, Backspace at its start joins it to the one before,
// Up and Down at its ends move between blocks.

import { createEffect, createMemo, createSignal, For, onSettled, Show, untrack } from "solid-js";
import type { JSX } from "@solidjs/web";
import { type Agent, ownerId, type TextSpan } from "@vibevalley/protocol";
import { api } from "../../base/api";
import { BlockEditor, type EditBlock } from "./editor";
import { hexColor, swatches } from "../../ui/cast";
import { knownTypes } from "./blocks";
import { createExternal } from "../../base/external";
import { ready, useAgents } from "../../base/query";
import { AgentFace } from "../../ui/Face";
import { Checkbox } from "../../ui/Checkbox";

/** The owner's lines on the attribution bar. */
const ownerColor = "#c8a46e";

/** Who wrote a block last, as the bar beside it shows: the owner's colour, or the helper's (its look's trim, else a colour
 * picked from its id, the same every time). */
function authorColor(updatedBy: string, agent: Agent | undefined) {
  if (updatedBy === ownerId) return ownerColor;
  if (agent?.look.trim) return hexColor(agent.look.trim);
  let h = 0;
  for (let i = 0; i < updatedBy.length; i++) h = (h * 31 + updatedBy.charCodeAt(i)) & 0x7fffffff;
  return hexColor(swatches.trim[h % swatches.trim.length]!);
}

/** A block as one drawing of the editor shows it; `block` is the editor's own, for its actions. */
interface Row {
  readonly block: EditBlock;
  readonly type: string;
  readonly attrs: EditBlock["attrs"];
  readonly text: string;
  readonly spans: readonly TextSpan[];
  readonly updatedBy: string;
  readonly problem: string | undefined;
  readonly depth: number;
  readonly number: number | undefined;
  readonly writing: boolean;
  readonly showFace: boolean;
  readonly wanted: boolean;
}

/** Keyed by the id by its caller: one editor for the page's life, handed to onEditor for what the page's menu does
 * with it (the demo, which polls faster while it runs). */
export function BlocksView(props: { id: string; onEditor?: (editor: BlockEditor) => void }) {
  const editor = new BlockEditor(
    api,
    untrack(() => props.id),
  );
  untrack(() => props.onEditor)?.(editor);
  onSettled(() => {
    void editor.load();
    return () => editor.dispose();
  });
  // The editor changes its blocks in place and bumps its version; each version is drawn as fresh rows, matched by id.
  const version = createExternal(editor.subscribe, () => editor.version);
  const all = useAgents();
  const agents = createMemo(() => new Map(ready(all, []).map((a) => [a.id, a])));
  const rows = createMemo((): Row[] => {
    version();
    const numbers = editor.numbers;
    let lastAuthor: string | undefined;
    return editor.blocks.map((b) => {
      const writing = editor.writing(b);
      const row: Row = {
        block: b,
        type: b.type,
        attrs: { ...b.attrs },
        text: b.text,
        spans: b.spans,
        updatedBy: b.updatedBy,
        problem: b.problem,
        depth: editor.depthOf(b),
        number: numbers.get(b.id),
        writing,
        showFace: writing || (b.updatedBy !== ownerId && b.updatedBy !== lastAuthor),
        wanted: editor.focusId === b.id,
      };
      lastAuthor = b.updatedBy;
      return row;
    });
  });
  const status = () => {
    version();
    return (
      editor.error ??
      (editor.busy
        ? t("web.artifact.blocks.saving")
        : [
            t("web.artifact.blocks.saved"),
            t("web.artifact.blocks.blocks", { n: editor.blocks.length }),
            ...(editor.othersWriting ? [t("web.artifact.blocks.helpersWriting")] : []),
          ].join(" · "))
    );
  };
  return (
    <article
      aria-label={(version(), editor.artifact?.title) ?? ""}
      data-testid="artifact-blocks"
      data-key={props.id}
      data-state={(version(), editor.error ? "error" : editor.busy ? "saving" : "saved")}
      data-blocks={(version(), editor.blocks.length)}
      data-writing={(version(), editor.othersWriting) ? "" : undefined}
      class="flex min-h-0 flex-1 flex-col"
    >
      {/* Nothing written yet has nothing to report; the line comes with the first block. */}
      <p role="status" class={["truncate pb-2 pl-[35px] text-xs", (version(), editor.error) ? "text-berry" : "text-muted"]}>
        {(version(), editor.blocks.length > 0 || editor.busy || editor.error) ? status() : ""}
      </p>
      <div class="min-h-0 flex-1 overflow-y-auto pr-3">
        <For each={rows()} keyed={(r) => r.block.id}>
          {(row) => <BlockRow editor={editor} row={row()} agent={agents().get(row().updatedBy)} />}
        </For>
        {/* Below the last block: a click starts a new paragraph. */}
        <button
          type="button"
          data-testid="artifact-append"
          aria-label={t("web.artifact.blocks.append")}
          class="block h-16 w-full cursor-text pl-[35px] text-left text-base text-faint"
          onClick={() => editor.append()}
        >
          {(version(), editor.blocks.length === 0 && !editor.busy) ? t("web.artifact.blocks.start") : ""}
        </button>
      </div>
    </article>
  );
}

const barHeight = (type: string) => (type === "divider" ? 16 : type === "heading" ? 28 : 20);

function BlockRow(props: { editor: BlockEditor; row: Row; agent?: Agent | undefined }) {
  const r = () => props.row;
  const writer = () => (r().updatedBy === ownerId ? t("web.artifact.blocks.owner") : (props.agent?.name ?? r().updatedBy));
  const mark = (): JSX.Element | undefined => {
    switch (r().type) {
      case "bulleted":
        return "•";
      case "numbered":
        return `${r().number ?? 1}.`;
      case "memory_item":
        return <span class="text-xs text-muted">{t("web.artifact.blocks.memoryItem")}</span>;
      case "todo":
        return (
          <Checkbox
            class="mt-1"
            checked={r().attrs.checked ?? false}
            label={r().attrs.checked ? t("web.artifact.blocks.done") : t("web.artifact.blocks.notDone")}
            onChange={() => props.editor.toggle(r().block)}
          />
        );
      default:
        return undefined;
    }
  };
  const box = () => (r().type === "quote" ? "border-l-[3px] border-line pl-3" : r().type === "code" ? "rounded-md bg-code-bg px-3 py-2 text-code-ink" : "");
  const kind = () =>
    !knownTypes.has(r().type) ? "unknown" : r().type === "divider" ? "divider" : r().type === "image" ? "image" : r().type === "issue_ref" ? "issue" : "text";
  return (
    <div
      data-block={r().block.id}
      data-type={r().type}
      data-writing={r().writing ? "" : undefined}
      class={["flex items-start pb-0.5", r().type === "heading" ? "pt-2.5" : "pt-0.5"]}
    >
      <span class="w-[22px] shrink-0 pt-[3px]">
        <Show when={r().showFace}>
          <AgentFace agentId={r().updatedBy} look={props.agent?.look} runtime={props.agent?.runtime} size={18} />
        </Show>
      </span>
      <span
        title={r().writing ? t("web.artifact.blocks.writing", { who: writer() }) : t("web.artifact.blocks.wrote", { who: writer() })}
        aria-label={r().writing ? t("web.artifact.blocks.writing", { who: writer() }) : undefined}
        class={["mt-0.5 mr-2.5 shrink-0 rounded-sm", r().writing ? "w-1 animate-pulse" : "w-[3px]"]}
        style={{ height: `${barHeight(r().type)}px`, background: authorColor(r().updatedBy, props.agent) }}
      />
      <span class="shrink-0" style={{ width: `${20 * r().depth}px` }} />
      <div class="min-w-0 flex-1">
        {/* One shape for every text block: a block that changes type keeps its field, and the field its focus. */}
        <Show
          when={kind() === "text"}
          fallback={
            <Show when={kind() !== "divider"} fallback={<hr class="my-2 border-line" />}>
              <Placeholder
                text={
                  kind() === "image"
                    ? t("web.artifact.blocks.image", { alt: r().attrs.alt ?? "", src: r().attrs.src ?? "" }).trim()
                    : kind() === "issue"
                      ? t("web.artifact.blocks.issue", { id: r().attrs.issueId ?? "" })
                      : t("web.artifact.blocks.unknown", { type: r().type })
                }
              />
            </Show>
          }
        >
          <div class={["flex items-start", box()]}>
            <Show when={mark() !== undefined}>
              <span class="w-[26px] shrink-0 pt-px">{mark()}</span>
            </Show>
            <div class="min-w-0 flex-1">
              <BlockField editor={props.editor} row={r()} />
            </div>
          </div>
        </Show>
        <Show when={r().problem}>
          <p class="text-xs text-berry">{r().problem}</p>
        </Show>
      </div>
    </div>
  );
}

function Placeholder(props: { text: string }) {
  return <div class="rounded-md bg-hover px-2.5 py-1.5 text-sm text-muted">{props.text}</div>;
}

/** A block's whole type: size, line height and weight from one place, so no two font sizes meet on one element. */
function typeStyle(r: Row) {
  switch (r.type) {
    case "heading":
      return (r.attrs.level ?? 1) <= 1
        ? "text-2xl leading-8 font-semibold"
        : r.attrs.level === 2
          ? "text-xl leading-7 font-semibold"
          : "text-lg leading-7 font-semibold";
    case "code":
      return "font-mono text-sm leading-6";
    case "quote":
      return "text-base leading-6 text-muted";
    default:
      return r.type === "todo" && r.attrs.checked ? "text-base leading-6 text-muted line-through" : "text-base leading-6";
  }
}

function Marked(props: { spans: readonly TextSpan[] }) {
  return (
    <For each={props.spans}>
      {(s) => {
        const cls = {
          "font-semibold": !!s.marks.bold,
          italic: !!s.marks.italic,
          "rounded-xs bg-hover px-0.5 font-mono": !!s.marks.code,
          "line-through": !!s.marks.strike,
          "text-water underline": !!s.marks.link,
        };
        return (
          <Show when={s.marks.link} fallback={<span class={cls}>{s.t}</span>}>
            {(link) => (
              <a href={link()} target="_blank" rel="noreferrer" class={cls}>
                {s.t}
              </a>
            )}
          </Show>
        );
      }}
    </For>
  );
}

/** A block's text: the marks drawn until it is clicked into, then a plain field of its own. */
function BlockField(props: { editor: BlockEditor; row: Row }) {
  const [editing, setEditing] = createSignal(false);
  // focused is the editor's live flag, read again when editing changes: the editor sets it without a new version.
  const shown = () => editing() || props.row.wanted || props.row.block.focused;
  return (
    <Show
      when={shown()}
      fallback={
        <div
          role="textbox"
          tabindex={0}
          aria-label={t("web.artifact.blocks.block", { id: props.row.block.id })}
          onFocus={() => setEditing(true)}
          onClick={() => setEditing(true)}
          class={["min-h-6 cursor-text break-words whitespace-pre-wrap", typeStyle(props.row)]}
        >
          <Show when={props.row.text} fallback={<span class="text-faint">{props.row.type === "heading" ? t("web.artifact.blocks.heading") : " "}</span>}>
            <Marked spans={props.row.spans} />
          </Show>
        </div>
      }
    >
      <Field editor={props.editor} row={props.row} focusNow={editing() && !props.row.wanted} onLeave={() => setEditing(false)} />
    </Show>
  );
}

function Field(props: { editor: BlockEditor; row: Row; focusNow: boolean; onLeave: () => void }) {
  let el!: HTMLTextAreaElement;
  const b = () => props.row.block;
  // Clicked into: the field takes the focus once it is on the page.
  // Read here, not in onSettled: the prop is a memo made on first read, and onSettled may not make one.
  const focusNow = untrack(() => props.focusNow);
  onSettled(() => {
    if (focusNow) el.focus();
  });
  // The editor moved the text under the caret, or asked for this block to take the focus.
  createEffect(
    () => props.row,
    (row) => {
      el.style.height = "auto";
      el.style.height = `${el.scrollHeight}px`;
      if (row.wanted) {
        props.editor.focusId = undefined;
        el.focus();
      }
      const block = row.block;
      if (block.caret !== undefined && document.activeElement === el) {
        el.setSelectionRange(block.caret, block.caret);
        block.caret = undefined;
      }
    },
  );
  const key = (e: KeyboardEvent & { currentTarget: HTMLTextAreaElement }) => {
    const field = e.currentTarget;
    const block = b();
    if (block.composing || e.isComposing || field.selectionStart !== field.selectionEnd) return;
    const at = field.selectionStart;
    if (e.key === "Backspace" && at === 0) {
      e.preventDefault();
      props.editor.backspaceAtStart(block);
    } else if ((e.key === "ArrowUp" && at === 0) || (e.key === "ArrowDown" && at === field.value.length)) {
      const next = props.editor.neighbour(block, e.key === "ArrowUp" ? -1 : 1);
      if (!next) return;
      e.preventDefault();
      props.editor.moveTo(next, e.key === "ArrowUp" ? next.text.length : 0);
    }
  };
  return (
    <textarea
      ref={(t) => (el = t)}
      aria-label={t("web.artifact.blocks.block", { id: b().id })}
      rows={1}
      value={props.row.text}
      placeholder={props.row.type === "heading" ? t("web.artifact.blocks.heading") : undefined}
      spellcheck="false"
      onFocus={() => props.editor.focus(b(), true)}
      onBlur={() => {
        props.editor.focus(b(), false);
        props.onLeave();
      }}
      onCompositionStart={() => (b().composing = true)}
      onCompositionEnd={(e) => props.editor.composition(b(), false, e.currentTarget.value)}
      onInput={(e) => props.editor.edited(b(), e.currentTarget.value, e.currentTarget.selectionStart)}
      onKeyDown={key}
      class={["block w-full resize-none overflow-hidden bg-transparent outline-none placeholder:text-faint", typeStyle(props.row)]}
    />
  );
}
