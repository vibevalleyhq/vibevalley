import * as stylex from "@stylexjs/stylex";
import { createEffect, createMemo, createSignal, For, Show, untrack } from "solid-js";

import { t } from "@vibevalley/i18n";
import type { PkmBlock, PkmBlockOp, PkmPageSummary, PkmPageView } from "@vibevalley/protocol";

import { useTimeout } from "#/base/timer.ts";
import { useQueryClient } from "#/infra/query.ts";
import { toast } from "#/ui/toasts.ts";

import type { Around, EditAction, Focus } from "./editing";
import { hasChildren, visibleBlocks } from "./outline";
import { Editor, indentPx, newId, Row, Toolbar, type Writing } from "./OutlineEditor";
import { type DropAt, dropAt, dropOps, outlineText, pickAction, type Picked, pickedIds, stepped } from "./selection";
import { pkmPageQuery, refreshVault } from "./vault";
import { PageWriter, pageServer } from "./writer";

const viewStyles = stylex.create({
  outlineSpan: {
    marginTop: "var(--spacing)",
    display: "flex",
    width: "calc(var(--spacing) * 4)",
    height: "calc(var(--spacing) * 4)",
    flexShrink: "0",
    alignItems: "center",
    justifyContent: "center",
  },
  outlineSpan2: {
    width: "calc(var(--spacing) * 1.5)",
    height: "calc(var(--spacing) * 1.5)",
    borderRadius: "2147483647px",
    backgroundColor: {
      default: "var(--wb-faint)",
      "@supports (color:color-mix(in lab, red, red))": "color-mix(in oklab, var(--wb-faint) 40%, transparent)",
    },
  },
  outlineSpan3: {
    minHeight: "calc(var(--spacing) * 6)",
    paddingInline: "var(--spacing)",
    fontSize: "var(--text-sm)",
    lineHeight: "calc(var(--spacing) * 6)",
    color: "var(--wb-faint)",
  },
});

/** point: a block to show and light up (?b= in the address). */
export function Outline(props: { view: PkmPageView; pages: readonly PkmPageSummary[]; point?: string | undefined; onEditing: (on: boolean) => void }) {
  const queries = useQueryClient();
  const slug = untrack(() => props.view.page.slug);
  const [blocks, setBlocks] = createSignal<PkmBlock[]>(untrack(() => props.view.page.blocks));
  const writer = new PageWriter(slug, untrack(blocks), pageServer, {
    changed: (b) => setBlocks(b),
    answered: (page) => {
      queries.setData(pkmPageQuery(slug), (v) => (v ? { value: { ...v.value, page } } : undefined));
      void refreshVault(queries);
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
      await queries.invalidate({ prefix: ["pkm"] });
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
        <span aria-hidden="true" {...stylex.attrs(viewStyles.outlineSpan)}>
          <span {...stylex.attrs(viewStyles.outlineSpan2)} />
        </span>
        <span {...stylex.attrs(viewStyles.outlineSpan3)}>{t("web.pkm.page.append")}</span>
      </button>
      <Show when={writing()}>{(w) => <Toolbar writing={w()} />}</Show>
    </section>
  );
}
