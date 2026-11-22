// Backspace at the start is read from onKeyPress because nsh Input deletes nothing there.
import { Clipboard, effect, keymap, Overlay, PanResponder, signal, Text, untracked, View, type Bounds, type InputRef, type JSX, type ViewRef } from "nsh";
import { Input } from "nsh/base";

import { t } from "@vibevalley/i18n";
import type { PkmBlock, PkmBlockOp, PkmMarker, PkmPageSummary, PkmPageView, PkmSearchHit } from "@vibevalley/protocol";

import { Icon } from "../../design/Icon";
import type { IconName } from "../../design/icons";
import { Bubble } from "../../design/Tip";
import { toast } from "../../design/toasts";
import { mix, tone } from "../../design/tone";
import { api } from "../../infra/api";
import { spelled } from "../../infra/base/search";
import { useTimeout } from "../../infra/base/timer";
import { typedMarks } from "../../infra/base/typedMarks";
import { createEffect, untrack } from "../../infra/solid";
import { useLatest } from "../../infra/state/atom";
import { Body } from "./Body";
import { dayKey } from "./days";
import {
  type Around,
  autoPair,
  type Caret,
  type Command,
  commandAction,
  type Completion,
  completed,
  type EditAction,
  editAction,
  type Focus,
  type Keys,
  noteMarks,
  offered,
  pasteAction,
  saved,
  type Shut,
} from "./editing";
import { headingOf } from "./outline";
import type { DropAt } from "./selection";

export interface Writing {
  readonly block: string;
  readonly caret: () => Caret;
  readonly key: (e: Keys) => void;
  readonly insert: (text: string, back?: number) => void;
}

export const newId = () => crypto.randomUUID();
/** One level of the outline's indent, pt. */
export const indentPx = 20;

const markerLook: Partial<
  Record<PkmMarker, { readonly checked: boolean | "mixed"; readonly icon?: IconName; readonly border: string; readonly fill?: string; readonly ink: string }>
> = {
  TODO: { checked: false, border: "muted", fill: "page", ink: "muted" },
  LATER: { checked: false, border: "muted", fill: "page", ink: "muted" },
  WAITING: { checked: false, icon: "wait", border: "wheat", ink: "warn-ink" },
  DOING: { checked: "mixed", icon: "partly", border: "wheat", fill: "wheat/20", ink: "warn-ink" },
  NOW: { checked: "mixed", icon: "partly", border: "wheat", fill: "wheat/20", ink: "warn-ink" },
  DONE: { checked: true, icon: "ticked", border: "accent", fill: "accent", ink: "page" },
  CANCELED: { checked: true, icon: "close", border: "line", ink: "faint" },
};

const fillOf = (fill: string | undefined) => {
  if (!fill) return undefined;
  const [name = "", part] = fill.split("/");
  return part ? mix(name, Number(part) / 100) : tone(name);
};

export function Row(props: {
  block: PkmBlock;
  refs: PkmPageView["transclusions"];
  folded: boolean;
  parent: boolean;
  lit: boolean;
  picked: boolean;
  comments: number;
  focus: Focus | undefined;
  onToggle: () => void;
  /** shift: picking up to it instead of writing in it. */
  onOpen: (at: number | "end", shift: boolean) => void;
  onMarker: (marker: PkmMarker | undefined) => void;
  onMakeIssue?: () => void;
  /** The row's view, to scroll to it and to measure it under a drag. */
  onRef?: (ref: ViewRef | undefined) => void;
  /** Where the blocks being dragged would land on this row. */
  dropping: DropAt | undefined;
  /** This row is among the ones being dragged. */
  dragged: boolean;
  /** The bullet's drag, in window points; `end(false)` is a drag taken away. */
  drag: { start: (x: number, y: number) => void; move: (x: number, y: number) => void; end: (dropped: boolean) => void };
  children: JSX.Element;
}) {
  const pan = PanResponder.create({
    // A press folds the block; only a move of a few points starts a drag.
    onMoveShouldSetPanResponder: (_, g) => Math.abs(g.dx) + Math.abs(g.dy) > 4,
    onPanResponderGrant: (_, g) => props.drag.start(g.x0, g.y0),
    onPanResponderMove: (_, g) => props.drag.move(g.moveX, g.moveY),
    onPanResponderRelease: () => props.drag.end(true),
    onPanResponderTerminate: () => props.drag.end(false),
  });
  const done = () => props.block.marker === "DONE" || props.block.marker === "CANCELED";
  const look = () => (props.block.marker ? markerLook[props.block.marker] : undefined);
  return (
    <View
      ref={(r) => props.onRef?.(r)}
      testID="pkm-block"
      accessibilityLabel={props.block.id}
      accessibilityState={{ selected: props.picked }}
      class={`group flex-row items-start gap-1 rounded-sm py-px ${props.dragged ? "opacity-40" : ""}`}
      style={{
        paddingLeft: props.block.depth * indentPx,
        ...(props.picked ? { backgroundColor: tone("selected") } : props.lit ? { backgroundColor: mix("wheat", 0.2) } : {}),
      }}
    >
      <If when={props.dropping}>
        {(at) => (
          <View
            testID={`pkm-drop-${at()}`}
            class={`absolute right-0 h-0.5 rounded-full bg-water ${at() === "before" ? "-top-px" : "-bottom-px"}`}
            style={{ left: (props.block.depth + (at() === "inside" ? 2 : 1)) * indentPx, pointerEvents: "none" }}
          />
        )}
      </If>
      <Each of={Array.from({ length: props.block.depth }, (_, i) => i)}>
        {(i) => <View class="absolute inset-y-0 border-l border-line" style={{ left: i() * indentPx + 7.5 }} />}
      </Each>
      <View
        {...pan.panHandlers}
        role="button"
        accessibilityLabel={props.folded ? t("web.pkm.page.expand") : t("web.pkm.page.collapse")}
        accessibilityState={props.parent ? { expanded: !props.folded } : undefined}
        testID="pkm-bullet"
        // A leaf's bullet folds nothing, and is still what the row is dragged by.
        onPress={() => props.parent && props.onToggle()}
        class="mt-1 h-4 w-4 shrink-0 items-center justify-center rounded-xs hover:bg-hover"
      >
        <If
          when={props.parent && props.folded}
          else={
            <>
              <View class={`h-1.5 w-1.5 rounded-full bg-muted ${props.parent ? "group-hover:opacity-0" : ""}`} />
              <If when={props.parent}>
                <View class="absolute opacity-0 group-hover:opacity-100">
                  <Icon name="choose" size={11} tone="muted" />
                </View>
              </If>
            </>
          }
        >
          <View class="h-4 w-4 items-center justify-center rounded-xs bg-selected">
            <Icon name="expand" size={10} tone="ink" />
          </View>
        </If>
      </View>
      <If when={look()}>
        {(l) => (
          <View
            role="checkbox"
            testID="pkm-marker"
            accessibilityState={{ checked: l().checked }}
            accessibilityLabel={t(`web.pkm.marker.${props.block.marker ?? "TODO"}`)}
            tooltip={<Bubble text={t(`web.pkm.marker.${props.block.marker ?? "TODO"}`)} />}
            onPress={() => props.onMarker(props.block.marker === "DONE" ? "TODO" : "DONE")}
            class="mt-1 h-4 w-4 shrink-0 items-center justify-center rounded-xs border"
            style={{ borderColor: tone(l().border), ...(fillOf(l().fill) ? { backgroundColor: fillOf(l().fill) } : {}) }}
          >
            <If when={l().icon}>{(icon) => <Icon name={icon()} size={10} tone={l().ink} />}</If>
          </View>
        )}
      </If>
      <View class="min-w-0 flex-1">
        <If
          when={props.focus}
          else={
            <View
              role="button"
              testID="pkm-block-text"
              accessibilityHint={t("web.pkm.page.edit")}
              // A link inside it takes its own press (Body), so following one does not open the box.
              onPress={(e) => props.onOpen("end", e.modifiers.shift)}
              class="min-h-6 rounded-sm px-1 py-0.5"
            >
              <If when={props.block.body} else={<Text class="text-sm text-faint">{" "}</Text>}>
                <Body text={props.block.body} refs={props.refs} class={`text-sm ${done() ? "text-muted line-through" : "text-ink"}`} />
              </If>
            </View>
          }
        >
          {props.children}
        </If>
      </View>
      <If when={!props.focus && props.block.body.trim() !== ""}>
        <View class="mt-0.5 shrink-0 flex-row items-center gap-0.5 opacity-0 group-hover:opacity-100">
          <View
            role="button"
            testID="pkm-copy-ref"
            accessibilityLabel={t("web.pkm.page.copyRef")}
            tooltip={<Bubble text={t("web.pkm.page.copyRef")} />}
            onPress={() => {
              void Clipboard.writeText(`((${props.block.id}))`);
              toast(t("web.pkm.page.copiedRef"));
            }}
            class="h-5 w-5 items-center justify-center rounded-sm hover:bg-selected"
          >
            <Icon name="copy" size={11} tone="muted" />
          </View>
          <If when={props.onMakeIssue}>
            {(make) => (
              <View
                role="button"
                testID="pkm-to-issue"
                accessibilityLabel={t("web.pkm.page.toIssue")}
                tooltip={<Bubble text={t("web.pkm.page.toIssue")} />}
                onPress={() => make()()}
                class="h-5 w-5 items-center justify-center rounded-sm hover:bg-selected"
              >
                <Icon name="issues" size={11} tone="muted" />
              </View>
            )}
          </If>
        </View>
      </If>
      <If when={props.comments > 0}>
        <View
          testID="pkm-bubble"
          accessibilityLabel={t("web.pkm.comments.count", { n: props.comments })}
          class="mt-0.5 h-5 shrink-0 flex-row items-center gap-0.5 rounded-full px-1.5"
          style={{ backgroundColor: mix("wheat", 0.2) }}
        >
          <Icon name="thread" size={10} tone="warn-ink" />
          <Text class="text-2xs font-medium text-warn-ink" style={{ fontVariant: ["tabular-nums"] }}>
            {String(props.comments)}
          </Text>
        </View>
      </If>
    </View>
  );
}

const commands = (todayTitle: string): (Command & { readonly label: string })[] => [
  { key: "todo", marker: "TODO", label: t("web.pkm.command.todo") },
  { key: "doing", marker: "DOING", label: t("web.pkm.command.doing") },
  { key: "done", marker: "DONE", label: t("web.pkm.command.done") },
  { key: "clear", marker: undefined, label: t("web.pkm.command.clear") },
  { key: "h1", text: "# ", label: t("web.pkm.command.h1") },
  { key: "h2", text: "## ", label: t("web.pkm.command.h2") },
  { key: "code", text: "```\n\n```", caretOffset: 4, label: t("web.pkm.command.code") },
  { key: "today", text: `[[${todayTitle}]]`, label: t("web.pkm.command.today") },
];

interface Choice {
  readonly key: string;
  readonly label: string;
  readonly hint?: string;
  readonly pick: () => void;
}

const keys = (key: string, mods: Partial<Omit<Keys, "key">> = {}): Keys => ({ key, shiftKey: false, altKey: false, metaKey: false, ctrlKey: false, ...mods });

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
  /** Left by a key that picks the block (Esc, Shift+↑↓ past its ends): the outline takes the keys from the box. */
  onLeave: (extend: "up" | "down" | undefined) => void;
}) {
  let el: InputRef | undefined;
  const anchor = signal<ViewRef | undefined>(undefined);
  const caretBox = signal<Bounds | undefined>(undefined);
  const id = untrack(() => props.block.id);
  // The box's words and selection as the input last said; `placed` moves the caret.
  const draft = signal(untrack(() => props.block.body));
  const sel = signal({ start: 0, end: 0 });
  const placed = signal<{ start: number; end?: number } | undefined>(undefined);
  const fenceMode = () => {
    const s = draft().trimStart();
    return s.startsWith("```") || s.startsWith("~~~");
  };
  const editorLook = () => {
    if (fenceMode()) return "font-mono text-xs";
    const level = headingOf(draft())?.level;
    return level === 1 ? "text-lg font-semibold" : level === 2 ? "text-base font-semibold" : level === 3 ? "text-sm font-semibold" : "text-sm";
  };
  const minHeight = () => {
    const level = fenceMode() ? undefined : headingOf(draft())?.level;
    return level === 1 ? 30 : level === 2 ? 27 : 24;
  };
  const height = signal(untrack(minHeight));
  const focused = signal(false);
  const shut = signal<Shut | undefined>(undefined);
  const picked = signal(0);
  const composing = signal(false);
  const later = useTimeout();
  const leaving = useTimeout();
  const caret = (): Caret => ({ value: untracked(draft), start: untracked(sel).start, end: untracked(sel).end });
  const save = () => {
    if (!handedOn) props.run(saved(props.block, untracked(draft)));
  };
  const write = (value: string, at: number) => {
    draft.set(value);
    sel.set({ start: at, end: at });
    placed.set({ start: at });
  };
  createEffect(
    () => props.focus,
    (f, before) => {
      if (!f) {
        caretBox.set(undefined);
        return;
      }
      // `props.focus` tracks `b()` in OutlineView; ignore autosave re-runs of the same focus token so the caret is not yanked to the end.
      if (f === before) return;
      const body = untrack(() => props.block.body);
      if (untracked(draft) !== body && !untracked(focused)) draft.set(body);
      const value = untracked(draft);
      const at = f.at === "end" ? value.length : Math.min(f.at, value.length);
      write(value, at);
      queueMicrotask(() => el?.focus());
    },
  );
  const completion = (): Completion | undefined => (composing() ? undefined : offered({ value: draft(), caret: sel().start, shut: shut() }).completion);
  const caretTo = (at: number) => shut.set(offered({ value: untracked(draft), caret: at, shut: untracked(shut) }).shut);
  const blockQuery = () => {
    const c = completion();
    return c?.kind === "block" && c.query.trim() !== "" ? c.query.trim() : undefined;
  };
  const found = useLatest(blockQuery, (text) => api.pkm.search({ text, limit: 8 }), 150);
  const choices = (): Choice[] => {
    const c = completion();
    if (!c) return [];
    const q = c.query.toLowerCase();
    // Picked later: the completion is read again then, where the caret is by that time.
    const take = (choice: string) => () => {
      const now = untracked(completion);
      if (!now) return;
      const done = completed(untracked(draft), untracked(sel).start, now, choice);
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
              const now = untracked(completion);
              if (!now) return;
              const value = untracked(draft);
              const a = commandAction(props.block, caret(), now, cmd);
              write(
                value.slice(0, now.from) + ("text" in cmd ? cmd.text : "") + value.slice(untracked(sel).start),
                a.kind === "ops" && a.focus.at !== "end" ? a.focus.at : now.from,
              );
              props.act(a);
            },
          }));
      }
    }
  };
  // The ops already carry what was typed here; once the caret moves to another block, this box must not save its old
  // words over them as it closes.
  let handedOn = false;
  const hand = (a: EditAction & { kind: "ops" }) => {
    if (a.focus.block !== id) handedOn = true;
    else {
      const updated = a.ops.findLast((o) => o.op === "update" && o.block === id && o.body !== undefined);
      if (updated?.op === "update" && updated.body !== undefined && updated.body !== untracked(draft)) {
        write(updated.body, a.focus.at === "end" ? updated.body.length : a.focus.at);
      }
    }
    props.act(a);
  };
  const key = (e: Keys) => {
    if (untracked(composing)) return;
    const list = untracked(choices);
    if (list.length > 0) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        picked.set((untracked(picked) + (e.key === "ArrowDown" ? 1 : list.length - 1)) % list.length);
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        list[Math.min(untracked(picked), list.length - 1)]?.pick();
        picked.set(0);
        return;
      }
      if (e.key === "Escape") {
        // The words typed stay; the list goes until the caret leaves this trigger.
        const c = untracked(completion);
        if (c) shut.set({ kind: c.kind, from: c.from });
        return;
      }
    }
    if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === "z" && untracked(draft) === props.block.body) {
      props.undo();
      return;
    }
    const a = editAction(e, props.block, caret(), props.around(), newId);
    if (!a) return;
    if (a.kind === "leave") {
      save();
      el?.blur();
      props.onLeave(a.extend);
      return;
    }
    hand(a);
  };
  // The keys the box gives up while it has the focus; the others stay the input's (see the header).
  effect(() => {
    if (!focused() || composing()) return;
    if (choices().length > 0) {
      return keymap.bind(
        { up: () => key(keys("ArrowUp")), down: () => key(keys("ArrowDown")), tab: () => key(keys("Tab")), escape: () => key(keys("Escape")) },
        { when: "always" },
      );
    }
    const offs = [
      keymap.bind(
        {
          tab: () => key(keys("Tab")),
          "shift+tab": () => key(keys("Tab", { shiftKey: true })),
          "alt+up": () => key(keys("ArrowUp", { altKey: true })),
          "alt+down": () => key(keys("ArrowDown", { altKey: true })),
          "mod+enter": () => key(keys("Enter", { metaKey: true })),
          escape: () => key(keys("Escape")),
        },
        { when: "always" },
      ),
    ];
    const value = draft();
    const { start, end } = sel();
    const around = untracked(props.around);
    if (start === end) {
      if (around.previous && !value.slice(0, start).includes("\n")) offs.push(keymap.bind("up", () => key(keys("ArrowUp")), { when: "always" }));
      if (around.next && !value.slice(end).includes("\n")) offs.push(keymap.bind("down", () => key(keys("ArrowDown")), { when: "always" }));
      if (start === 0) offs.push(keymap.bind("shift+up", () => key(keys("ArrowUp", { shiftKey: true })), { when: "always" }));
      if (end === value.length) offs.push(keymap.bind("shift+down", () => key(keys("ArrowDown", { shiftKey: true })), { when: "always" }));
    }
    if (value === props.block.body) offs.push(keymap.bind("mod+z", () => key(keys("z", { metaKey: true })), { when: "always" }));
    return () => offs.forEach((off) => off());
  });
  const writing: Writing = {
    block: id,
    caret,
    key: (k) => key(k),
    insert: (text, back = 0) => {
      const { start, end } = untracked(sel);
      const value = untracked(draft);
      write(value.slice(0, start) + text + value.slice(end), start + text.length - back);
      el?.focus();
    },
  };
  return (
    <View ref={(r) => anchor.set(r)} testID="pkm-editing">
      <Input
        ref={(r) => (el = r)}
        multiline
        submitBehavior="submit"
        pasteBehavior="report"
        autoCorrect={false}
        autoCapitalize="none"
        testID="pkm-editor"
        accessibilityLabel={t("web.pkm.page.edit")}
        value={draft()}
        selectedRange={placed()}
        onFocus={() => {
          focused.set(true);
          props.onWriting(writing);
          leaving(() => undefined, 0);
        }}
        onBlur={() => {
          focused.set(false);
          caretBox.set(undefined);
          if (!handedOn) save();
          // A block moved under the caret (Tab, Alt+↑↓) loses the focus for a moment; only a box left for good closes.
          leaving(() => {
            if (!untracked(focused)) {
              props.onWriting(undefined);
              props.onLeft();
            }
          }, 120);
        }}
        onCompositionChange={(e) => composing.set(e.composing)}
        onChange={(e) => {
          const was = untracked(draft);
          const at = Math.max(0, untracked(sel).start + (e.value.length - was.length));
          const composingNow = untracked(composing);
          const mark = composingNow ? undefined : typedMarks(e.value, at, noteMarks);
          const nextValue = mark ? e.value.slice(0, mark.from) + mark.text + e.value.slice(mark.to) : e.value;
          const nextAt = mark ? mark.from + mark.text.length : at;
          const paired = composingNow ? undefined : autoPair(was, nextValue, nextAt);
          if (paired) {
            write(paired.value, paired.caret);
            caretTo(paired.caret);
            picked.set(0);
            later(save, 800);
            return;
          }
          if (mark) {
            write(nextValue, nextAt);
            caretTo(nextAt);
            picked.set(0);
            later(save, 800);
            return;
          }
          draft.set(e.value);
          sel.set({ start: at, end: at });
          caretTo(at);
          picked.set(0);
          // Words are kept a moment after the last key, not only when the box is left.
          later(save, 800);
        }}
        onSelectionChange={(e) => {
          sel.set({ start: e.start, end: e.end });
          caretTo(e.start);
        }}
        onCaretMove={(e) => caretBox.set(e.pageBounds.size.height > 0 ? e.pageBounds : undefined)}
        onSubmit={() => key(keys("Enter"))}
        onKeyPress={(e) => {
          const { start, end } = untracked(sel);
          if (e.key === "Backspace" && start === 0 && end === 0) key(keys("Backspace"));
        }}
        onPaste={(e) => {
          const a = pasteAction(e.text, props.block, caret(), newId);
          if (a?.kind === "ops") hand(a);
          else if (e.text) el?.insertText(e.text);
        }}
        onContentSizeChange={(e) => height.set(Math.max(untracked(minHeight), Math.ceil(e.size.height - 0.05) + 4))}
        class={`w-full rounded-sm bg-hover px-1 py-0.5 text-ink ${editorLook()}`}
        style={{ height: height() }}
      />
      <If when={choices().length > 0}>
        <Overlay
          anchor={caretBox() ?? anchor()}
          placement="bottom"
          align="start"
          offset={4}
          margin={8}
          testID="pkm-complete"
          class="max-h-64 w-80 max-w-full rounded-lg border border-line bg-elevated p-1 shadow-float"
        >
          <Each of={choices()} key={(c) => c.key}>
            {(c, i) => (
              <View
                role="option"
                testID="pkm-choice"
                focusable={false}
                accessibilityLabel={c().label}
                accessibilityState={{ selected: i() === Math.min(picked(), choices().length - 1) }}
                onMouseEnter={() => picked.set(i())}
                onPress={() => {
                  c().pick();
                  el?.focus();
                }}
                class={`flex-row items-center gap-2 rounded-md px-2 py-1 ${i() === Math.min(picked(), choices().length - 1) ? "bg-selected" : "hover:bg-hover"}`}
              >
                <Text class="min-w-0 flex-1 truncate text-sm text-ink">{c().label}</Text>
                <If when={c().hint}>{(h) => <Text class="shrink-0 truncate text-xs text-muted">{h()}</Text>}</If>
              </View>
            )}
          </Each>
        </Overlay>
      </If>
    </View>
  );
}
