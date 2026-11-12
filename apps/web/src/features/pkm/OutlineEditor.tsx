import type { JSX } from "@solidjs/web";
import { createEffect, createSignal, For, onSettled, Show, untrack } from "solid-js";

import { t } from "@vibevalley/i18n";
import type { PkmBlock, PkmBlockOp, PkmMarker, PkmPageSummary, PkmPageView, PkmSearchHit } from "@vibevalley/protocol";

import { spelled } from "#/base/search.ts";
import { useTimeout } from "#/base/timer.ts";
import { api } from "#/infra/api.ts";
import { useLatest } from "#/state/atom.ts";
import { Icon } from "#/ui/Icon.tsx";
import type { IconName } from "#/ui/icons.ts";
import { typeMarks } from "#/ui/markInput.ts";

import { Body } from "./Body";
import { dayKey } from "./days";
import {
  type Around,
  type Caret,
  type Command,
  commandAction,
  type Completion,
  completed,
  type EditAction,
  editAction,
  type Focus,
  type Keys,
  type Shut,
  noteMarks,
  offered,
  pasteAction,
  saved,
} from "./editing";
import type { DropAt } from "./selection";

export interface Writing {
  readonly block: string;
  readonly caret: () => Caret;
  readonly key: (e: Keys) => void;
  readonly insert: (text: string, back?: number) => void;
}

export const newId = () => crypto.randomUUID();
/** One level of the outline's indent, px. */
export const indentPx = 20;

const markerLook: Partial<Record<PkmMarker, { readonly checked: boolean | "mixed"; readonly icon?: IconName; readonly tone: JSX.ClassValue }>> = {
  TODO: { checked: false, tone: "border-muted hover:border-ink bg-page" },
  LATER: { checked: false, tone: "border-muted hover:border-ink bg-page" },
  WAITING: { checked: false, icon: "wait", tone: "border-wheat text-warn-ink" },
  DOING: { checked: "mixed", icon: "partly", tone: "border-wheat bg-wheat/20 text-warn-ink" },
  NOW: { checked: "mixed", icon: "partly", tone: "border-wheat bg-wheat/20 text-warn-ink" },
  DONE: { checked: true, icon: "ticked", tone: "border-accent bg-accent text-page" },
  CANCELED: { checked: true, icon: "close", tone: "border-line text-faint" },
};

export function Row(props: {
  block: PkmBlock;
  refs: PkmPageView["transclusions"];
  folded: boolean;
  parent: boolean;
  lit: boolean;
  picked: boolean;
  dropping: DropAt | undefined;
  onDrag: (e: DragEvent) => void;
  /** box: the row's, which the place in it is read against. */
  onDragOver: (e: DragEvent, box: DOMRect) => void;
  onDrop: (e: DragEvent) => void;
  onDragEnd: () => void;
  comments: number;
  focus: Focus | undefined;
  onToggle: () => void;
  /** shift: picking up to it instead of writing in it. */
  onOpen: (at: number | "end", shift: boolean) => void;
  onMarker: (marker: PkmMarker | undefined) => void;
  children: JSX.Element;
}) {
  const done = () => props.block.marker === "DONE" || props.block.marker === "CANCELED";
  return (
    <div
      data-testid="pkm-block"
      data-key={props.block.id}
      data-marker={props.block.marker}
      data-lit={props.lit ? "" : undefined}
      data-picked={props.picked ? "" : undefined}
      class={[
        "group",
        "relative flex items-start gap-1 rounded-sm py-px transition-[color,background-color,border-color] ease-out duration-280",
        props.picked ? "bg-selected" : props.lit ? "bg-wheat/20" : "",
      ]}
      style={{ "padding-left": `${props.block.depth * indentPx}px` }}
      onDragOver={(e) => props.onDragOver(e, e.currentTarget.getBoundingClientRect())}
      onDrop={(e) => props.onDrop(e)}
    >
      <Show when={props.dropping}>
        {(at) => (
          <span
            aria-hidden="true"
            data-testid="pkm-drop"
            data-at={at()}
            class={["pointer-events-none absolute right-0 h-0.5 rounded-full bg-water", at() === "before" ? "-top-px" : "-bottom-px"]}
            style={{ left: `${(props.block.depth + (at() === "inside" ? 2 : 1)) * indentPx}px` }}
          />
        )}
      </Show>
      <For each={Array.from({ length: props.block.depth }, (_, i) => i)}>
        {(i) => <span aria-hidden="true" class="absolute inset-y-0 border-l border-line" style={{ left: `${i * indentPx + 9}px` }} />}
      </For>
      <button
        type="button"
        aria-label={props.folded ? t("web.pkm.page.expand") : t("web.pkm.page.collapse")}
        aria-expanded={props.parent ? (props.folded ? "false" : "true") : undefined}
        disabled={!props.parent}
        draggable="true"
        data-testid="pkm-bullet"
        onDragStart={(e) => props.onDrag(e)}
        onDragEnd={() => props.onDragEnd()}
        onClick={() => props.onToggle()}
        class="relative mt-1 flex w-4 h-4 shrink-0 cursor-pointer disabled:cursor-default items-center justify-center rounded-xs text-muted hover:bg-hover"
      >
        <span class={["w-1.5 h-1.5 rounded-full bg-muted", props.parent && props.folded ? "[box-shadow:0_0_0_3px_var(--color-line)]" : "group-hover:hidden"]} />
        <Show when={props.parent && !props.folded}>
          <Icon name="choose" size={12} class="absolute" />
        </Show>
      </button>
      <Show when={props.block.marker && markerLook[props.block.marker]}>
        {(look) => (
          <button
            type="button"
            role="checkbox"
            data-testid="pkm-marker"
            aria-checked={look().checked === "mixed" ? "mixed" : look().checked === true ? "true" : "false"}
            aria-label={t(`web.pkm.marker.${props.block.marker ?? "TODO"}`)}
            title={t(`web.pkm.marker.${props.block.marker ?? "TODO"}`)}
            onClick={() => props.onMarker(props.block.marker === "DONE" ? "TODO" : "DONE")}
            class={["mt-1 flex w-4 h-4 shrink-0 cursor-pointer items-center justify-center rounded-xs border", look().tone]}
          >
            <Show when={look().icon}>{(icon) => <Icon name={icon()} size={10} />}</Show>
          </button>
        )}
      </Show>
      <div class={["min-w-0 flex-1", done() && "text-muted"]}>
        <Show
          when={props.focus}
          fallback={
            <div
              // Not a button: its links are controls of their own.
              tabindex="0"
              data-testid="pkm-block-text"
              title={t("web.pkm.page.edit")}
              // A link inside it stops its click (Body), so following one does not open the box.
              onClick={(e) => props.onOpen("end", e.shiftKey)}
              // A Shift+click picks blocks; it does not select the words between.
              onMouseDown={(e) => e.shiftKey && e.preventDefault()}
              onKeyDown={(e) => e.key === "Enter" && props.onOpen("end", false)}
              class={["min-h-6 cursor-text rounded-sm px-1 text-sm leading-lg", done() ? "line-through decoration-faint" : ""]}
            >
              <Show when={props.block.body} fallback={<span class="text-faint">{"\u00a0"}</span>}>
                <Body text={props.block.body} refs={props.refs} />
              </Show>
            </div>
          }
        >
          {props.children}
        </Show>
      </div>
      <Show when={props.comments > 0}>
        <a
          href={`#comment-${props.block.id}`}
          data-testid="pkm-bubble"
          aria-label={t("web.pkm.comments.count", { n: props.comments })}
          class="mt-0.5 inline-flex h-5 shrink-0 items-center gap-0.5 rounded-full bg-wheat/20 hover:bg-wheat/30 px-1.5 text-2xs text-warn-ink"
        >
          <Icon name="thread" size={10} />
          {props.comments}
        </a>
      </Show>
    </div>
  );
}

const commands = (todayTitle: string): (Command & { readonly label: string })[] => [
  { key: "todo", marker: "TODO", label: t("web.pkm.command.todo") },
  { key: "doing", marker: "DOING", label: t("web.pkm.command.doing") },
  { key: "done", marker: "DONE", label: t("web.pkm.command.done") },
  { key: "clear", marker: undefined, label: t("web.pkm.command.clear") },
  { key: "h1", text: "# ", label: t("web.pkm.command.h1") },
  { key: "h2", text: "## ", label: t("web.pkm.command.h2") },
  { key: "today", text: `[[${todayTitle}]]`, label: t("web.pkm.command.today") },
];

interface Choice {
  readonly key: string;
  readonly label: string;
  readonly hint?: string;
  readonly pick: () => void;
}

export function Editor(props: {
  block: PkmBlock;
  around: () => Around;
  focus: Focus | undefined;
  pages: readonly PkmPageSummary[];
  act: (a: EditAction | undefined) => boolean;
  run: (ops: readonly PkmBlockOp[], next?: Focus) => void;
  undo: () => void;
  onWriting: (w: Writing | undefined) => void;
  onLeft: () => void;
  /** Left by a key that picks the block (Esc, Shift+↑↓ past its ends): the outline takes the focus from the box. */
  onLeave: (extend: "up" | "down" | undefined) => void;
}) {
  let el!: HTMLTextAreaElement;
  const id = untrack(() => props.block.id);
  const [draft, setDraft] = createSignal(untrack(() => props.block.body));
  const [caretAt, setCaretAt] = createSignal(0);
  const [shut, setShut] = createSignal<Shut>();
  const [picked, setPicked] = createSignal(0);
  const [composing, setComposing] = createSignal(false);
  const later = useTimeout();
  const leaving = useTimeout();
  const caret = (): Caret => ({ value: el.value, start: el.selectionStart, end: el.selectionEnd });
  const grow = () => {
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  };
  const save = () => {
    if (!handedOn) props.run(saved(props.block, el.value));
  };
  createEffect(
    () => props.focus,
    (f) => {
      if (!f) return;
      const body = untrack(() => props.block.body);
      if (el.value !== body && document.activeElement !== el) {
        el.value = body;
        setDraft(body);
      }
      el.focus();
      const at = f.at === "end" ? el.value.length : Math.min(f.at, el.value.length);
      el.setSelectionRange(at, at);
      setCaretAt(at);
      grow();
    },
  );
  const completion = (): Completion | undefined => (composing() ? undefined : offered({ value: draft(), caret: caretAt(), shut: shut() }).completion);
  // Read from the box: the draft signal set in the same handler may not show the new words yet.
  const caretTo = (at: number) => {
    setCaretAt(at);
    setShut((s) => offered({ value: el.value, caret: at, shut: s }).shut);
  };
  const blockQuery = () => {
    const c = completion();
    return c?.kind === "block" && c.query.trim() !== "" ? c.query.trim() : undefined;
  };
  const found = useLatest(blockQuery, (text) => api.pkm.search({ text, limit: 8 }), 150);
  const write = (value: string, at: number) => {
    el.value = value;
    setDraft(value);
    el.setSelectionRange(at, at);
    setCaretAt(at);
    grow();
  };
  const choices = (): Choice[] => {
    const c = completion();
    if (!c) return [];
    const q = c.query.toLowerCase();
    // Picked later: the completion is read again then, where the caret is by that time.
    const take = (choice: string) => () => {
      const now = completion();
      if (!now) return;
      const done = completed(el.value, el.selectionStart, now, choice);
      write(done.value, done.caret);
    };
    switch (c.kind) {
      case "page":
      case "tag": {
        const matches = props.pages.filter((p) => spelled(p.title, q)).slice(0, 8);
        const fresh = c.query.trim() !== "" && !props.pages.some((p) => p.title.toLowerCase() === q.trim());
        return [
          ...matches.map((p) => ({ key: p.slug, label: p.title, pick: take(p.title) })),
          ...(fresh ? [{ key: "new", label: c.query.trim(), hint: t("web.pkm.complete.newPage"), pick: take(c.query.trim()) }] : []),
        ];
      }
      case "block": {
        const a = found();
        const hits: readonly PkmSearchHit[] = a?.state === "done" ? a.value : [];
        return hits.filter((h) => h.block !== id).map((h) => ({ key: h.block, label: h.plain, hint: h.pageTitle, pick: take(h.block) }));
      }
      case "command": {
        const today = props.pages.find((p) => p.day === dayKey(Date.now()))?.title ?? dayKey(Date.now()).replace(/-/gu, "_");
        return commands(today)
          .filter((cmd) => cmd.key.includes(q) || spelled(cmd.label, q))
          .map((cmd) => ({
            key: cmd.key,
            label: cmd.label,
            pick: () => {
              const now = completion();
              if (!now) return;
              const a = commandAction(props.block, caret(), now, cmd);
              write(
                el.value.slice(0, now.from) + ("text" in cmd ? cmd.text : "") + el.value.slice(el.selectionStart),
                a.kind === "ops" && a.focus.at !== "end" ? a.focus.at : now.from,
              );
              props.act(a);
            },
          }));
      }
    }
  };
  const key = (e: Keys & { preventDefault?: () => void; isComposing?: boolean }) => {
    if (e.isComposing === true || composing()) return;
    const list = choices();
    if (list.length > 0) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault?.();
        setPicked((i) => (i + (e.key === "ArrowDown" ? 1 : list.length - 1)) % list.length);
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault?.();
        list[Math.min(picked(), list.length - 1)]?.pick();
        setPicked(0);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault?.();
        // The words typed stay; the list goes until the caret leaves this trigger.
        const c = completion();
        if (c) setShut({ kind: c.kind, from: c.from });
        return;
      }
    }
    if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === "z" && el.value === props.block.body) {
      e.preventDefault?.();
      props.undo();
      return;
    }
    const a = editAction(e, props.block, caret(), props.around(), newId);
    if (!a) return;
    e.preventDefault?.();
    if (a.kind === "leave") {
      save();
      props.onLeave(a.extend);
      return;
    }
    hand(a);
  };
  // The ops already carry what was typed here; once the caret moves to another block, this box must not save its old
  // words over them as it closes.
  let handedOn = false;
  const hand = (a: EditAction & { kind: "ops" }) => {
    if (a.focus.block !== id) {
      handedOn = true;
      later(() => undefined, 0);
    }
    props.act(a);
  };
  const writing: Writing = {
    block: id,
    caret,
    key: (k) => key(k),
    insert: (text, back = 0) => {
      const at = el.selectionStart;
      const value = el.value.slice(0, at) + text + el.value.slice(el.selectionEnd);
      write(value, at + text.length - back);
      el.focus();
    },
  };
  onSettled(() => {
    grow();
    return () => props.onWriting(undefined);
  });
  return (
    <div class="relative">
      <textarea
        ref={(t) => (el = t)}
        data-testid="pkm-editor"
        rows={1}
        value={draft()}
        spellcheck="false"
        aria-label={t("web.pkm.page.edit")}
        onFocus={() => {
          props.onWriting(writing);
          leaving(() => undefined, 0);
        }}
        onBlur={() => {
          if (!handedOn) save();
          // A block moved under the caret (Tab, Alt+↑↓) loses the focus for a moment; only a box left for good closes.
          leaving(() => {
            if (document.activeElement !== el) {
              props.onWriting(undefined);
              props.onLeft();
            }
          }, 120);
        }}
        onCompositionStart={() => setComposing(true)}
        onCompositionEnd={() => setComposing(false)}
        onInput={(e) => {
          if (!e.isComposing && typeMarks(e.currentTarget, noteMarks)) return;
          setDraft(e.currentTarget.value);
          caretTo(e.currentTarget.selectionStart);
          setPicked(0);
          grow();
          // Words are kept a moment after the last key, not only when the box is left.
          later(save, 800);
        }}
        onKeyUp={(e) => {
          if (e.key.startsWith("Arrow") || e.key === "Home" || e.key === "End") caretTo(e.currentTarget.selectionStart);
        }}
        onClick={(e) => caretTo(e.currentTarget.selectionStart)}
        onKeyDown={(e) => key(e)}
        onPaste={(e) => {
          const text = e.clipboardData?.getData("text/plain") ?? "";
          const a = pasteAction(text, props.block, caret(), newId);
          if (a?.kind !== "ops") return;
          e.preventDefault();
          hand(a);
        }}
        class="block min-h-6 w-full resize-none overflow-hidden rounded-sm bg-hover px-1 text-sm leading-lg text-ink outline-none"
      />
      <Show when={choices().length > 0}>
        <ul
          role="listbox"
          data-testid="pkm-complete"
          class="absolute top-full left-0 z-20 mt-1 flex max-h-64 w-80 max-w-full flex-col overflow-y-auto rounded-lg border border-line bg-page p-1 shadow-float"
        >
          <For each={choices()} keyed={(c) => c.key}>
            {(c, i) => (
              <li
                role="option"
                aria-selected={i() === Math.min(picked(), choices().length - 1) ? "true" : "false"}
                data-key={c().key}
                onPointerDown={(e) => {
                  // Picked without taking the focus from the box.
                  e.preventDefault();
                  c().pick();
                }}
                class="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1 text-sm aria-selected:bg-selected"
              >
                <span class="min-w-0 flex-1 truncate">{c().label}</span>
                <Show when={c().hint}>{(h) => <span class="shrink-0 truncate text-xs text-muted">{h()}</span>}</Show>
              </li>
            )}
          </For>
        </ul>
      </Show>
    </div>
  );
}

/** On a phone there is no Tab: the moves a key would make, above the keyboard while a block is being written. */
export function Toolbar(props: { writing: Writing }) {
  const press = (k: Partial<Keys> & { key: string }) => () => props.writing.key({ shiftKey: false, altKey: false, metaKey: false, ctrlKey: false, ...k });
  const tools: { readonly id: string; readonly icon: IconName; readonly label: string; readonly run: () => void }[] = [
    { id: "outdent", icon: "outdent", label: t("web.pkm.toolbar.outdent"), run: press({ key: "Tab", shiftKey: true }) },
    { id: "indent", icon: "indent", label: t("web.pkm.toolbar.indent"), run: press({ key: "Tab" }) },
    { id: "up", icon: "moveUp", label: t("web.pkm.toolbar.up"), run: press({ key: "ArrowUp", altKey: true }) },
    { id: "down", icon: "moveDown", label: t("web.pkm.toolbar.down"), run: press({ key: "ArrowDown", altKey: true }) },
    { id: "todo", icon: "check", label: t("web.pkm.toolbar.todo"), run: press({ key: "Enter", metaKey: true }) },
    { id: "link", icon: "link", label: t("web.pkm.toolbar.link"), run: () => props.writing.insert("[[]]", 2) },
  ];
  return (
    <div
      role="toolbar"
      aria-label={t("web.pkm.toolbar.label")}
      data-testid="pkm-toolbar"
      class="sticky bottom-0 z-10 mt-2 flex md:hidden justify-around border-t border-line bg-page py-1"
    >
      <For each={tools}>
        {(tool) => (
          <button
            type="button"
            aria-label={tool.label}
            data-key={tool.id}
            // The box keeps the focus, so the keyboard stays up.
            onPointerDown={(e) => e.preventDefault()}
            onClick={() => tool.run()}
            class="flex w-9 h-9 cursor-pointer items-center justify-center rounded-md text-muted hover:text-ink hover:bg-hover"
          >
            <Icon name={tool.icon} size={16} />
          </button>
        )}
      </For>
    </div>
  );
}
