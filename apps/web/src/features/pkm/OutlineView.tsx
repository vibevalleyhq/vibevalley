import type { JSX } from "@solidjs/web";
import { createEffect, createMemo, createSignal, For, onSettled, Show, untrack } from "solid-js";

import { t } from "@vibevalley/i18n";
import type { PkmBlock, PkmBlockOp, PkmMarker, PkmPageSummary, PkmPageView, PkmSearchHit } from "@vibevalley/protocol";

import { useTimeout } from "@/base/timer";
import { api } from "@/infra/api";
import { queries } from "@/infra/query";
import { useLatest } from "@/state/atom";
import { Icon } from "@/ui/Icon";
import type { IconName } from "@/ui/icons";
import { toast } from "@/ui/toasts";

import { Body } from "./Body";
import { dayKey } from "./days";
import {
  type Around,
  type Caret,
  type Command,
  commandAction,
  type Completion,
  completed,
  completionAt,
  type EditAction,
  editAction,
  type Focus,
  type Keys,
  pasteAction,
  saved,
} from "./editing";
import { hasChildren, visibleBlocks } from "./outline";
import { type DropAt, dropAt, dropOps, outlineText, pickAction, type Picked, pickedIds, stepped } from "./selection";
import { refreshVault } from "./vault";
import { PageWriter, pageServer } from "./writer";

interface Writing {
  readonly block: string;
  readonly caret: () => Caret;
  readonly key: (e: Keys) => void;
  readonly insert: (text: string, back?: number) => void;
}

const newId = () => crypto.randomUUID();
/** One level of the outline's indent, px. */
const indentPx = 20;

/** point: a block to show and light up (?b= in the address). */
export function Outline(props: { view: PkmPageView; pages: readonly PkmPageSummary[]; point?: string | undefined; onEditing: (on: boolean) => void }) {
  const slug = untrack(() => props.view.page.slug);
  const [blocks, setBlocks] = createSignal<PkmBlock[]>(untrack(() => props.view.page.blocks));
  const writer = new PageWriter(slug, untrack(blocks), pageServer, {
    changed: (b) => setBlocks(b),
    answered: (page) => {
      queries.setQueryData<PkmPageView>(["pkm", "page", slug], (v) => (v ? { ...v, page } : v));
      void refreshVault();
    },
    refused: (why) => toast(t("web.pkm.page.notSaved", { why }), "bad"),
  });
  const [focus, setFocus] = createSignal<Focus>();
  const collapsed = createMemo<ReadonlySet<string>>(() => new Set(blocks().flatMap((b) => (b.props.collapsed === "true" ? [b.id] : []))));
  const [picked, setPicked] = createSignal<Picked>();
  const [dragged, setDragged] = createSignal<readonly string[]>([]);
  const [dropping, setDropping] = createSignal<{ readonly target: string; readonly at: DropAt }>();
  let outlineEl!: HTMLElement;
  const [writing, setWriting] = createSignal<Writing>();
  const [lit, setLit] = createSignal<string>();
  const unlight = useTimeout();
  const editing = () => focus()?.block;
  createEffect(
    () => editing() !== undefined,
    (on) => {
      props.onEditing(on);
    },
  );
  // The server's copy (read again, or another editor wrote the file) is taken whenever nothing of ours is on the way
  // and no block is being written.
  createEffect(
    () => props.view.page.blocks,
    (server) => {
      if (untrack(editing) === undefined) writer.take(server);
    },
  );
  const run = (ops: readonly PkmBlockOp[], next?: Focus) => {
    writer.apply(ops);
    if (next) setFocus(next);
  };
  const undo = () => {
    const done = writer.undo();
    if (!done) return;
    void done.then(async (u) => {
      toast(u.undone ? t("web.pkm.page.undone", { what: u.what ?? "" }) : t("web.pkm.page.nothingToUndo"));
      await queries.invalidateQueries({ queryKey: ["pkm"] });
    });
  };
  const act = (a: EditAction | undefined) => {
    if (!a) return false;
    if (a.kind === "leave") setFocus(undefined);
    else run(a.ops, a.focus);
    return true;
  };
  const shown = createMemo(() => visibleBlocks(blocks(), collapsed()));
  const around = (id: string): Around => {
    const list = shown();
    const i = list.findIndex((b) => b.id === id);
    const all = blocks();
    const at = all.findIndex((b) => b.id === id);
    const parent = hasChildren(all, at);
    return {
      previous: list[i - 1],
      next: list[i + 1],
      parent,
      firstChild: parent && !collapsed().has(id) ? all[at + 1] : undefined,
    };
  };
  // Unfolded is no line at all: the file's printer leaves out an empty value.
  const toggle = (id: string) => run([{ op: "update", block: id, props: { collapsed: collapsed().has(id) ? "" : "true" } }]);
  const pickedNow = createMemo(() => {
    const p = picked();
    return new Set(p ? pickedIds(shown(), p) : []);
  });
  /** The outline takes the keys: the box being written in, if any, is left (and saves as it goes). */
  const pickFrom = (p: Picked) => {
    setPicked(p);
    outlineEl.focus();
  };
  const left = (id: string, extend?: "up" | "down") => pickFrom({ anchor: id, head: extend ? stepped(shown(), id, extend) : id });
  const open = (id: string, at: number | "end", shift: boolean) => {
    if (!shift) {
      setPicked(undefined);
      setFocus({ block: id, at });
      return;
    }
    pickFrom({ anchor: picked()?.anchor ?? focus()?.block ?? id, head: id });
  };
  const pickKey = (e: KeyboardEvent) => {
    const p = picked();
    // Keys in a box inside the outline are the box's.
    if (!p || e.target !== e.currentTarget || e.isComposing) return;
    const a = pickAction(e, blocks(), shown(), p);
    if (!a) return;
    e.preventDefault();
    switch (a.kind) {
      case "ops":
        run(a.ops);
        if (a.done === true) setPicked(undefined);
        return;
      case "pick":
        setPicked(a.picked);
        document.querySelector(`[data-testid="pkm-block"][data-key="${CSS.escape(a.picked.head)}"]`)?.scrollIntoView({ block: "nearest" });
        return;
      case "open":
        setPicked(undefined);
        setFocus({ block: a.block, at: "end" });
        return;
      case "unpick":
        setPicked(undefined);
        return;
    }
  };
  const drag = (id: string, e: DragEvent) => {
    const ids = pickedNow().has(id) ? [...pickedNow()] : [id];
    setDragged(ids);
    e.dataTransfer?.setData("text/plain", outlineText(blocks(), ids));
    if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
  };
  const over = (row: PkmBlock, e: DragEvent, box: DOMRect) => {
    if (dragged().length === 0) return;
    e.preventDefault();
    const at = dropAt((e.clientY - box.top) / box.height, e.clientX - box.left - row.depth * indentPx - indentPx);
    const ops = dropOps(blocks(), dragged(), row.id, at);
    setDropping(ops.length > 0 ? { target: row.id, at } : undefined);
  };
  const drop = (e: DragEvent) => {
    e.preventDefault();
    const d = dropping();
    if (d) run(dropOps(blocks(), dragged(), d.target, d.at));
    setDragged([]);
    setDropping(undefined);
  };
  const copy = (e: ClipboardEvent, cut: boolean) => {
    const p = picked();
    if (!p || e.target !== e.currentTarget) return;
    const ids = pickedIds(shown(), p);
    e.clipboardData?.setData("text/plain", outlineText(blocks(), ids));
    e.preventDefault();
    if (!cut) return;
    const a = pickAction({ key: "Delete", shiftKey: false, altKey: false, metaKey: false, ctrlKey: false }, blocks(), shown(), p);
    if (a?.kind === "ops") run(a.ops);
    setPicked(undefined);
  };
  // The last empty block is written in, so that a click there twice does not leave empty ones behind.
  const writeOn = () => {
    const end = shown().at(-1);
    if (end?.body === "" && !end.marker) {
      setFocus({ block: end.id, at: 0 });
      return;
    }
    const id = newId();
    const last = blocks().findLast((b) => b.depth === 0);
    run([last ? { op: "insert_after", block: last.id, id, body: "" } : { op: "append", id, body: "" }], { block: id, at: 0 });
  };
  const counts = createMemo(() => {
    const n = new Map<string, number>();
    for (const c of props.view.comments) n.set(c.block, (n.get(c.block) ?? 0) + 1);
    return n;
  });
  createEffect(
    () => props.point,
    (point) => {
      if (!point) return;
      queueMicrotask(() => {
        document.querySelector(`[data-testid="pkm-block"][data-key="${CSS.escape(point)}"]`)?.scrollIntoView({ block: "center" });
        setLit(point);
        unlight(() => setLit(undefined), 1600);
      });
    },
  );
  return (
    <section
      ref={(el) => (outlineEl = el)}
      data-testid="pkm-outline"
      data-editing={editing() ?? ""}
      data-picked={pickedNow().size}
      // Focused while blocks are picked, so their keys come here; never in the tab order itself.
      tabindex="-1"
      aria-label={t("web.pkm.page.outline")}
      onKeyDown={pickKey}
      onCopy={(e) => copy(e, false)}
      onCut={(e) => copy(e, true)}
      onFocusOut={(e) => {
        if (!(e.relatedTarget instanceof Node && outlineEl.contains(e.relatedTarget))) setPicked(undefined);
      }}
      class="group/outline flex flex-col outline-none"
    >
      <For each={shown()} keyed={(b) => b.id}>
        {(b) => (
          <Row
            block={b()}
            refs={props.view.transclusions}
            folded={collapsed().has(b().id)}
            parent={hasChildren(
              blocks(),
              blocks().findIndex((x) => x.id === b().id),
            )}
            lit={lit() === b().id}
            picked={pickedNow().has(b().id)}
            dropping={dropping()?.target === b().id ? dropping()?.at : undefined}
            onDrag={(e) => drag(b().id, e)}
            onDragOver={(e, box) => over(b(), e, box)}
            onDrop={drop}
            onDragEnd={() => {
              setDragged([]);
              setDropping(undefined);
            }}
            comments={counts().get(b().id) ?? 0}
            focus={focus()?.block === b().id ? focus() : undefined}
            onToggle={() => toggle(b().id)}
            onOpen={(at, shift) => open(b().id, at, shift)}
            onMarker={(marker) => run([marker ? { op: "set_marker", block: b().id, marker } : { op: "set_marker", block: b().id }])}
          >
            <Editor
              block={b()}
              around={() => around(b().id)}
              focus={focus()?.block === b().id ? focus() : undefined}
              pages={props.pages}
              act={act}
              run={run}
              undo={undo}
              onWriting={setWriting}
              onLeave={(extend) => left(b().id, extend)}
              onLeft={() => setFocus((f) => (f?.block === b().id ? undefined : f))}
            />
          </Row>
        )}
      </For>
      <button
        type="button"
        data-testid="pkm-append"
        onClick={writeOn}
        class={[
          "flex w-full cursor-text items-start gap-1 rounded-sm py-px text-left transition-opacity duration-120 focus-visible:opacity-100 pointer-coarse:opacity-100",
          blocks().length === 0 ? "" : "opacity-0 group-hover/outline:opacity-100",
        ]}
      >
        <span aria-hidden="true" class="mt-1 flex size-4 shrink-0 items-center justify-center">
          <span class="size-1.5 rounded-full bg-faint/40" />
        </span>
        <span class="min-h-6 px-1 text-sm leading-6 text-faint">{t("web.pkm.page.append")}</span>
      </button>
      <Show when={writing()}>{(w) => <Toolbar writing={w()} />}</Show>
    </section>
  );
}

const markerLook: Partial<Record<PkmMarker, { readonly checked: boolean | "mixed"; readonly icon?: IconName; readonly tone: string }>> = {
  TODO: { checked: false, tone: "border-muted bg-page hover:border-ink" },
  LATER: { checked: false, tone: "border-muted bg-page hover:border-ink" },
  WAITING: { checked: false, icon: "wait", tone: "border-wheat text-warn-ink" },
  DOING: { checked: "mixed", icon: "partly", tone: "border-wheat bg-wheat/20 text-warn-ink" },
  NOW: { checked: "mixed", icon: "partly", tone: "border-wheat bg-wheat/20 text-warn-ink" },
  DONE: { checked: true, icon: "ticked", tone: "border-accent bg-accent text-page" },
  CANCELED: { checked: true, icon: "close", tone: "border-line text-faint" },
};

function Row(props: {
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
        "group relative flex items-start gap-1 rounded-sm py-px transition-colors duration-280",
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
        class="relative mt-1 flex size-4 shrink-0 cursor-pointer items-center justify-center rounded-xs text-muted hover:bg-hover disabled:cursor-default"
      >
        <span class={["size-1.5 rounded-full bg-muted", props.parent ? (props.folded ? "ring-3 ring-line" : "group-hover:hidden") : ""]} />
        <Show when={props.parent && !props.folded}>
          <Icon name="choose" size={12} class="absolute hidden group-hover:block" />
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
            class={["mt-1 flex size-4 shrink-0 cursor-pointer items-center justify-center rounded-xs border", look().tone]}
          >
            <Show when={look().icon}>{(icon) => <Icon name={icon()} size={10} />}</Show>
          </button>
        )}
      </Show>
      <div class={["min-w-0 flex-1", done() ? "text-muted" : ""]}>
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
              class={["min-h-6 cursor-text rounded-sm px-1 text-sm leading-6", done() ? "line-through decoration-faint" : ""]}
            >
              <Show when={props.block.body} fallback={<span class="text-faint">{" "}</span>}>
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
          class="mt-0.5 inline-flex h-5 shrink-0 items-center gap-0.5 rounded-full bg-wheat/20 px-1.5 text-2xs text-warn-ink hover:bg-wheat/30"
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

function Editor(props: {
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
  const completion = (): Completion | undefined => (composing() ? undefined : completionAt(draft(), caretAt()));
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
        const matches = props.pages.filter((p) => p.title.toLowerCase().includes(q)).slice(0, 8);
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
          .filter((cmd) => cmd.key.includes(q) || cmd.label.toLowerCase().includes(q))
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
        // The words typed stay; the list goes until the caret moves into another trigger.
        setCaretAt(-1);
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
          setDraft(e.currentTarget.value);
          setCaretAt(e.currentTarget.selectionStart);
          setPicked(0);
          grow();
          // Words are kept a moment after the last key, not only when the box is left.
          later(save, 800);
        }}
        onKeyUp={(e) => {
          if (e.key.startsWith("Arrow") || e.key === "Home" || e.key === "End") setCaretAt(e.currentTarget.selectionStart);
        }}
        onClick={(e) => setCaretAt(e.currentTarget.selectionStart)}
        onKeyDown={(e) => key(e)}
        onPaste={(e) => {
          const text = e.clipboardData?.getData("text/plain") ?? "";
          const a = pasteAction(text, props.block, caret(), newId);
          if (a?.kind !== "ops") return;
          e.preventDefault();
          hand(a);
        }}
        class="block min-h-6 w-full resize-none overflow-hidden rounded-sm bg-hover px-1 text-sm leading-6 text-ink outline-none"
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
function Toolbar(props: { writing: Writing }) {
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
      class="sticky bottom-0 z-10 mt-2 flex justify-around border-t border-line bg-page py-1 md:hidden"
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
            class="flex size-9 cursor-pointer items-center justify-center rounded-md text-muted hover:bg-hover hover:text-ink"
          >
            <Icon name={tool.icon} size={16} />
          </button>
        )}
      </For>
    </div>
  );
}
