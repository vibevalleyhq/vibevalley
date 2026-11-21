import { Clipboard, effect, keymap, Text, untracked, View, type ViewRef } from "nsh";

import { t } from "@vibevalley/i18n";
import type { PkmBlock, PkmBlockOp, PkmPageSummary, PkmPageView } from "@vibevalley/protocol";

import { createEffect, createMemo, createSignal, untrack } from "../../../solid";
import { useTimeout } from "../../base/timer";
import { api, newSendKey } from "../../infra/api";
import { useQueryClient } from "../../infra/query";
import { createAct } from "../../ui/act";
import { toast } from "../../ui/toasts";
import { mix } from "../../ui/tone";
import type { Around, EditAction, Focus, Keys } from "./editing";
import { hasChildren, headingOf, visibleBlocks } from "./outline";
import { Editor, indentPx, newId, Row } from "./OutlineEditor";
import { type DropAt, dropAt, dropOps, outlineText, pickAction, type Picked, pickedIds, stepped } from "./selection";
import { pkmPageQuery, refreshVault } from "./vault";
import { PageWriter, pageServer } from "./writer";

type Rect = { x: number; y: number; w: number; h: number };

const keys = (key: string, mods: Partial<Omit<Keys, "key">> = {}): Keys => ({ key, shiftKey: false, altKey: false, metaKey: false, ctrlKey: false, ...mods });

function issueTitleOf(body: string): string {
  const first = (body.split("\n").find((l) => l.trim() !== "") ?? "").trim();
  const h = headingOf(first);
  return first
    .slice(h?.prefix ?? 0)
    .replace(/\[\[([^[\]|]+)\|([^[\]]+)\]\]/gu, "$2")
    .replace(/\[\[([^[\]]+)\]\]/gu, "$1")
    .trim()
    .slice(0, 120);
}

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
  const [lit, setLit] = createSignal<string>();
  const unlight = useTimeout();
  const makeAct = createAct();
  const makeIssue = (block: PkmBlock) => {
    const title = issueTitleOf(block.body);
    if (!title) return;
    const outline = outlineText(blocks(), [block.id]);
    const description = outline !== `- ${title}` ? `${outline}\n\n[[${props.view.page.title}]]` : `[[${props.view.page.title}]]`;
    void makeAct.run(async () => {
      await api.issue.create({ title, description, requestKey: newSendKey() });
      toast(t("web.pkm.page.issueMade"));
    });
  };
  const rows = new Map<string, ViewRef>();
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
  const left = (id: string, extend?: "up" | "down") => {
    setFocus(undefined);
    setPicked({ anchor: id, head: extend ? stepped(shown(), id, extend) : id });
  };
  const open = (id: string, at: number | "end", shift: boolean) => {
    if (!shift) {
      setPicked(undefined);
      setFocus({ block: id, at });
      return;
    }
    const anchor = picked()?.anchor ?? focus()?.block ?? id;
    setFocus(undefined);
    setPicked({ anchor, head: id });
  };
  const pickKey = (e: Keys) => {
    const p = untracked(picked);
    if (!p) return;
    const a = pickAction(e, blocks(), shown(), p);
    if (!a) return;
    switch (a.kind) {
      case "ops":
        run(a.ops);
        if (a.done === true) setPicked(undefined);
        return;
      case "pick":
        setPicked(a.picked);
        rows.get(a.picked.head)?.reveal({ vertical: "nearest" });
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
  const copy = (cut: boolean) => {
    const p = untracked(picked);
    if (!p) return;
    void Clipboard.writeText(outlineText(blocks(), pickedIds(shown(), p)));
    if (!cut) return;
    const a = pickAction(keys("Delete"), blocks(), shown(), p);
    if (a?.kind === "ops") run(a.ops);
    setPicked(undefined);
  };
  // While blocks are picked (no box has the focus), the outline's keys.
  effect(() => {
    if (!picked()) return;
    return keymap.bind(
      {
        escape: () => pickKey(keys("Escape")),
        enter: () => pickKey(keys("Enter")),
        "mod+enter": () => pickKey(keys("Enter", { metaKey: true })),
        backspace: () => pickKey(keys("Backspace")),
        delete: () => pickKey(keys("Delete")),
        tab: () => pickKey(keys("Tab")),
        "shift+tab": () => pickKey(keys("Tab", { shiftKey: true })),
        "alt+up": () => pickKey(keys("ArrowUp", { altKey: true })),
        "alt+down": () => pickKey(keys("ArrowDown", { altKey: true })),
        up: () => pickKey(keys("ArrowUp")),
        down: () => pickKey(keys("ArrowDown")),
        "shift+up": () => pickKey(keys("ArrowUp", { shiftKey: true })),
        "shift+down": () => pickKey(keys("ArrowDown", { shiftKey: true })),
        "mod+c": () => copy(false),
        "mod+x": () => copy(true),
      },
      { when: "notEditing" },
    );
  });
  const [dragged, setDragged] = createSignal<readonly string[]>([]);
  const [dropping, setDropping] = createSignal<{ readonly target: string; readonly at: DropAt }>();
  let rects: [PkmBlock, Rect][] = [];
  const drag = (id: string) => ({
    start: (x: number, y: number) => {
      const ids = untracked(pickedNow).has(id) ? [...untracked(pickedNow)] : [id];
      setFocus(undefined);
      setDragged(ids);
      pointer = { x, y };
      rects = [];
      void Promise.all(
        untracked(shown).map(async (b) => {
          const m = await rows.get(b.id)?.measure();
          return m ? ([b, { x: m.pagePosition.x, y: m.pagePosition.y, w: m.bounds.size.width, h: m.bounds.size.height }] as [PkmBlock, Rect]) : undefined;
        }),
      ).then((measured) => {
        if (untracked(dragged) !== ids) return;
        rects = measured.filter((r) => r !== undefined);
        over();
      });
    },
    move: (x: number, y: number) => {
      pointer = { x, y };
      over();
    },
    end: (dropped: boolean) => {
      const d = untracked(dropping);
      const ids = untracked(dragged);
      setDragged([]);
      setDropping(undefined);
      if (dropped && d) run(dropOps(blocks(), ids, d.target, d.at));
    },
  });
  // The pointer moves on while the rows are measured: where it is by then is what counts.
  let pointer = { x: 0, y: 0 };
  const over = () => {
    const { x, y } = pointer;
    const hit = rects.find(([, r]) => y >= r.y && y <= r.y + r.h);
    if (!hit) return setDropping(undefined);
    const [row, box] = hit;
    const at = dropAt((y - box.y) / box.h, x - box.x - row.depth * indentPx - indentPx);
    setDropping(dropOps(blocks(), untracked(dragged), row.id, at).length > 0 ? { target: row.id, at } : undefined);
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
        rows.get(point)?.reveal({ vertical: "center" });
        setLit(point);
        unlight(() => setLit(undefined), 1600);
      });
    },
  );
  return (
    <View testID="pkm-outline" accessibilityLabel={t("web.pkm.page.outline")} accessibilityValue={{ text: `${pickedNow().size}` }} class="group">
      <Each of={shown()} key={(b) => b.id}>
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
            comments={counts().get(b().id) ?? 0}
            focus={focus()?.block === b().id ? focus() : undefined}
            onToggle={() => toggle(b().id)}
            onOpen={(at, shift) => open(b().id, at, shift)}
            onMarker={(marker) => run([marker ? { op: "set_marker", block: b().id, marker } : { op: "set_marker", block: b().id }])}
            onMakeIssue={() => makeIssue(b())}
            onRef={(r) => (r ? rows.set(b().id, r) : rows.delete(b().id))}
            dropping={dropping()?.target === b().id ? dropping()?.at : undefined}
            dragged={dragged().includes(b().id)}
            drag={drag(b().id)}
          >
            <Editor
              block={b()}
              around={() => around(b().id)}
              focus={focus()?.block === b().id ? focus() : undefined}
              pages={props.pages}
              act={act}
              run={run}
              undo={undo}
              onWriting={() => undefined}
              onLeave={(extend) => left(b().id, extend)}
              onLeft={() => setFocus((f) => (f?.block === b().id ? undefined : f))}
            />
          </Row>
        )}
      </Each>
      <View
        role="button"
        testID="pkm-append"
        onPress={writeOn}
        class={`flex-row items-start gap-1 rounded-sm py-px transition duration-120 ease-out hover:bg-hover ${blocks().length !== 0 ? "opacity-0 group-hover:opacity-100" : ""}`}
      >
        <View class="mt-1 h-4 w-4 shrink-0 items-center justify-center">
          <View class="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: mix("faint", 0.4) }} />
        </View>
        <Text class="min-h-6 px-1 py-0.5 text-sm text-faint">{t("web.pkm.page.append")}</Text>
      </View>
    </View>
  );
}
