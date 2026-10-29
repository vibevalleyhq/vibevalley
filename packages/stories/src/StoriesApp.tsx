// Drawn with the host's token classes (bg-page, border-line…): the host's Tailwind scans this folder. Each frame contains
// its layout, so a part fixed to the window (a toast) stays in its frame; a modal <dialog> still opens over everything.

import { createMemo, createSignal, createStore, Errored, For, Match, onSettled, Show, Switch } from "solid-js";
import type { JSX } from "@solidjs/web";
import {
  Accessibility,
  AngleRight,
  Category,
  Check,
  Cursor,
  Eye,
  Folder,
  Frame,
  Hand,
  Language,
  Laptop,
  Layout,
  Link,
  Maximize,
  Mobile,
  Moon,
  Mouse,
  Restart,
  Search,
  Sun,
  Tablet,
  type IconFunction,
} from "reicon";
import type { Args, Axis, Control, Stories, Story } from "./format";
import { forceStates, type PseudoState, pseudoStates, pseudoStyleId } from "./pseudo";
import { A11yPanel, useAxe } from "./a11y";
import { type Entry, entries, isOpen, type Node, search, treeOf } from "./tree";

export type Theme = "light" | "dark" | "both";
export const widths = ["full", "400", "720", "1280"] as const;
export type Width = (typeof widths)[number];

const themeLook: Record<Theme, { icon: IconFunction; label: string }> = {
  light: { icon: Sun, label: "Light" },
  dark: { icon: Moon, label: "Dark" },
  both: { icon: Layout, label: "Light and dark side by side" },
};

export type Mode = "grid" | "single";

const modeLook: Record<Mode, { icon: IconFunction; label: string }> = {
  grid: { icon: Category, label: "Every state at once" },
  single: { icon: Frame, label: "One, with the arguments" },
};

const pseudoLook: Record<PseudoState, { icon: IconFunction; label: string }> = {
  rest: { icon: Cursor, label: "At rest" },
  hover: { icon: Mouse, label: "Under the pointer" },
  focus: { icon: Eye, label: "Focused from the keyboard" },
  active: { icon: Hand, label: "Pressed" },
};

const widthLook: Record<Width, { icon: IconFunction; label: string }> = {
  full: { icon: Maximize, label: "Full width" },
  "400": { icon: Mobile, label: "Phone, 400 px" },
  "720": { icon: Tablet, label: "Tablet, 720 px" },
  "1280": { icon: Laptop, label: "Laptop, 1280 px" },
};

function Glyph(props: { icon: IconFunction; size?: number; class?: string }) {
  return (
    <span aria-hidden="true" class={["inline-flex shrink-0", props.class]}>
      {props.icon({ size: props.size ?? 14 })}
    </span>
  );
}

interface View {
  readonly key: string;
  readonly theme: Theme;
  readonly width: Width;
  readonly mode: Mode;
  readonly pseudo: PseudoState;
}

const readView = (list: readonly Entry[]): View => {
  const q = new URLSearchParams(location.search);
  const key = q.get("s") ?? "";
  const theme = q.get("theme");
  const width = q.get("w");
  const pseudo = q.get("state");
  return {
    key: list.some((e) => e.key === key) ? key : (list[0]?.key ?? ""),
    theme: theme === "light" || theme === "dark" || theme === "both" ? theme : "both",
    width: widths.find((w) => w === width) ?? "full",
    mode: q.get("view") === "single" ? "single" : "grid",
    pseudo: pseudoStates.find((p) => p === pseudo) ?? "rest",
  };
};

/** The address holds the view; `lang` is the host's, read before the page draws (a change reloads it). */
const writeView = (v: View) => {
  const q = new URLSearchParams({ s: v.key, theme: v.theme, w: v.width, view: v.mode, state: v.pseudo });
  const lang = new URLSearchParams(location.search).get("lang");
  if (lang) q.set("lang", lang);
  history.replaceState(null, "", `${location.pathname}?${q}`);
};

// Which folders were opened or closed by hand: a convenience of this browser, gone without storage.
const toggledKey = "stories.toggled";
const readToggled = () => {
  try {
    return new Map<string, boolean>(JSON.parse(localStorage.getItem(toggledKey) ?? "[]") as [string, boolean][]);
  } catch {
    return new Map<string, boolean>();
  }
};
const writeToggled = (m: ReadonlyMap<string, boolean>) => {
  try {
    localStorage.setItem(toggledKey, JSON.stringify([...m]));
  } catch {
    // Not kept: the tree opens as it does by default next time.
  }
};

const isOwn = (n: globalThis.Node) => (n instanceof Element ? n : n.parentElement)?.id === pseudoStyleId;

export function StoriesApp(props: {
  stories: readonly Stories[];
  /** Paths to list first, in this order, at each depth ("设计体系", "组件", "组件/工作台"). */
  order?: readonly string[];
  /** What every story is drawn inside: the host's contexts (a router, a query cache). */
  wrap?: (story: () => JSX.Element) => JSX.Element;
  /** The languages the host can draw in, the first its own. */
  locales?: readonly string[];
  /** Called as each story opens, before it draws: the host forgets what the one before left (a query cache). */
  prepare?: () => void;
}) {
  const list = entries(props.stories, props.order);
  // The forced states are copies of the page's rules: written once the styles are in, and again when they change (dev).
  onSettled(() => {
    forceStates();
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Its own <style> is in the head too: a change there is not a reason to write it again, or it never stops.
    const again = new MutationObserver((changes) => {
      if (changes.every((c) => isOwn(c.target))) return;
      clearTimeout(timer);
      timer = setTimeout(forceStates, 100);
    });
    again.observe(document.head, { childList: true, subtree: true, characterData: true });
    return () => {
      clearTimeout(timer);
      again.disconnect();
    };
  });
  const [view, setView] = createSignal<View>(readView(list));
  const move = (patch: Partial<View>) => {
    const next = { ...view(), ...patch };
    setView(next);
    writeView(next);
  };
  const [q, setQ] = createSignal("");
  const shown = createMemo(() => search(list, q()));
  const tree = createMemo(() => treeOf(shown()));
  const open = createMemo(() => list.find((e) => e.key === view().key));
  const [toggled, setToggled] = createSignal<ReadonlyMap<string, boolean>>(readToggled());
  const folderOpen = (path: string, depth: number) => q().trim() !== "" || isOpen(path, depth, open()?.title, toggled());
  const toggle = (path: string, depth: number) => {
    const next = new Map(toggled()).set(path, !folderOpen(path, depth));
    setToggled(next);
    writeToggled(next);
  };

  const Tree = (p: { nodes: readonly Node[] }) => (
    <ul>
      <For each={p.nodes}>
        {(n) => (
          <li>
            <Switch>
              <Match when={n.kind === "folder" && n}>
                {(f) => (
                  <>
                    <button
                      type="button"
                      data-testid="story-folder"
                      data-key={f().path}
                      aria-expanded={folderOpen(f().path, f().depth) ? "true" : "false"}
                      onClick={() => toggle(f().path, f().depth)}
                      style={{ "padding-left": `${f().depth * 12 + 4}px` }}
                      class={[
                        "group flex w-full items-center gap-1 rounded-md py-1 pr-2 text-left hover:bg-hover",
                        f().depth === 0 ? "mt-2 text-xs font-semibold" : "text-muted hover:text-ink",
                      ]}
                    >
                      <Glyph icon={AngleRight} size={12} class="text-faint transition-transform group-aria-expanded:rotate-90" />
                      <Show when={f().depth > 0}>
                        <Glyph icon={Folder} size={14} class="text-faint" />
                      </Show>
                      <span class="truncate">{f().name}</span>
                    </button>
                    <Show when={folderOpen(f().path, f().depth)}>
                      <Tree nodes={f().children} />
                    </Show>
                  </>
                )}
              </Match>
              <Match when={n.kind === "story" && n}>
                {(s) => (
                  <a
                    href={`?s=${encodeURIComponent(s().entry.key)}`}
                    data-testid="story-link"
                    data-key={s().entry.key}
                    aria-current={view().key === s().entry.key ? "page" : undefined}
                    onClick={(ev) => {
                      if (ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.button !== 0) return;
                      ev.preventDefault();
                      move({ key: s().entry.key });
                    }}
                    style={{ "padding-left": `${s().depth * 12 + 20}px` }}
                    class="block truncate rounded-md py-1 pr-2 hover:bg-hover aria-[current=page]:bg-selected aria-[current=page]:font-medium"
                  >
                    {s().name}
                  </a>
                )}
              </Match>
            </Switch>
          </li>
        )}
      </For>
    </ul>
  );

  return (
    <div class="flex h-dvh min-h-0 bg-page text-sm text-ink">
      <nav data-testid="stories-tree" aria-label="Stories" class="flex w-72 shrink-0 flex-col border-r border-line bg-side">
        <div class="p-2">
          <label class="flex h-8 items-center gap-2 rounded-md border border-line bg-page px-2 text-muted focus-within:border-focus">
            <Glyph icon={Search} />
            <input
              type="search"
              data-testid="stories-search"
              aria-label="Search stories"
              placeholder="Search"
              value={q()}
              onInput={(e) => setQ(e.currentTarget.value)}
              onKeyDown={(e) => {
                const first = shown()[0];
                if (e.key === "Enter" && first) move({ key: first.key });
              }}
              class="min-w-0 flex-1 bg-transparent text-sm text-ink outline-none"
            />
          </label>
        </div>
        <div class="min-h-0 flex-1 overflow-y-auto px-2 pb-4">
          <Tree nodes={tree()} />
        </div>
        <div class="border-t border-line px-3 py-2 text-2xs text-muted">{`${list.length} stories`}</div>
      </nav>

      <Show when={open()} keyed fallback={<p class="m-auto text-muted">No stories.</p>}>
        {(e: Entry) => <Opened entry={e} view={view()} move={move} wrap={props.wrap} locales={props.locales ?? []} prepare={props.prepare} />}
      </Show>
    </div>
  );
}

const frameWidth = (w: Width) => (w === "full" ? undefined : `${w}px`);

/** The open story: its arguments live here, so they start over when another story opens. */
function Opened(props: {
  entry: Entry;
  view: View;
  move: (patch: Partial<View>) => void;
  wrap: ((story: () => JSX.Element) => JSX.Element) | undefined;
  locales: readonly string[];
  prepare: (() => void) | undefined;
}) {
  props.prepare?.();
  const story = props.entry.story;
  const [args, setArgs] = createStore<Args>({ ...story.args });
  const set = (patch: Partial<Args>) =>
    setArgs((a) => {
      Object.assign(a, patch);
    });
  const themes = () => {
    const own = props.entry.themes;
    const asked = own.filter((t) => props.view.theme === "both" || t === props.view.theme);
    return asked.length > 0 ? asked : own.slice(0, 1);
  };
  const grid = story.grid;
  const mode = (): Mode => (grid ? props.view.mode : "single");
  const draw = (over: Partial<Args> = {}) => {
    const wrap = props.wrap ?? ((s) => s());
    // The panel's arguments, with the cell's own over them; still a store underneath, so the panel moves every cell.
    const merged = new Proxy(args, { get: (target, key): unknown => (typeof key === "string" && key in over ? over[key] : Reflect.get(target, key)) });
    return wrap(() => story.render(merged, set));
  };
  const names = Object.keys(story.args ?? {});
  let canvas!: HTMLDivElement;
  const axe = useAxe(
    () => canvas,
    () => [props.view.key, props.view.theme, props.view.width, mode(), props.view.pseudo, JSON.stringify(args)],
  );
  const [auditing, setAuditing] = createSignal(false);
  const lang = () => new URLSearchParams(location.search).get("lang") ?? props.locales[0] ?? "";

  return (
    <>
      <main class="flex min-w-0 flex-1 flex-col">
        <header class="flex flex-wrap items-center gap-2 border-b border-line px-4 py-2">
          <div class="flex min-w-0 flex-1 flex-col">
            <h1 data-testid="story-name" class="truncate text-sm font-semibold">
              <span class="font-normal text-muted">{`${props.entry.title.split("/").join(" / ")} / `}</span>
              {props.entry.name}
            </h1>
            <Show when={story.note}>{(note) => <p class="text-xs text-muted">{note()}</p>}</Show>
          </div>
          <Show when={grid}>
            <Pick label="View" testid="story-mode" value={mode()} options={["grid", "single"]} looks={modeLook} onChange={(m) => props.move({ mode: m })} />
          </Show>
          <Show when={mode() === "single"}>
            <Pick
              label="Interaction state"
              testid="story-state"
              value={props.view.pseudo}
              options={pseudoStates}
              looks={pseudoLook}
              onChange={(pseudo) => props.move({ pseudo })}
            />
          </Show>
          <Pick
            label="Theme"
            testid="story-theme"
            value={props.view.theme}
            options={["light", "dark", "both"]}
            looks={themeLook}
            onChange={(theme) => props.move({ theme })}
          />
          <Pick label="Width" testid="story-width" value={props.view.width} options={widths} looks={widthLook} onChange={(width) => props.move({ width })} />
          <Show when={props.locales.length > 1}>
            <Pick
              label="Language"
              testid="story-lang"
              value={lang()}
              options={props.locales}
              looks={Object.fromEntries(props.locales.map((l) => [l, { icon: Language, label: l, text: l.toUpperCase() }]))}
              onChange={(l) => {
                const q = new URLSearchParams(location.search);
                q.set("lang", l);
                location.search = q.toString();
              }}
            />
          </Show>
          <button
            type="button"
            data-testid="story-a11y"
            data-count={axe.count() ?? ""}
            aria-pressed={auditing() ? "true" : "false"}
            aria-label="Accessibility"
            title={axe.count() === undefined ? "Accessibility: checking" : `Accessibility: ${axe.count()} found`}
            onClick={() => setAuditing(!auditing())}
            class="flex h-8 items-center gap-1 rounded-md border border-line px-2 text-muted hover:text-ink aria-pressed:bg-selected aria-pressed:text-ink"
          >
            <Glyph icon={Accessibility} size={16} />
            <span class={["font-mono text-xs", (axe.count() ?? 0) > 0 && "text-berry"]}>{axe.count() ?? "…"}</span>
          </button>
          <CopyLink />
        </header>
        <div
          ref={(el) => (canvas = el)}
          data-testid="story-canvas"
          class={[
            "flex min-h-0 flex-1 items-start gap-4 overflow-auto bg-hover p-4",
            props.view.width === "full" && mode() === "single" ? "flex-col xl:flex-row" : props.view.width === "full" ? "flex-col" : "flex-row",
          ]}
        >
          <For each={themes()}>
            {(theme) => (
              <div
                data-theme={theme}
                data-testid="story-frame"
                data-pseudo={mode() === "single" && props.view.pseudo !== "rest" ? props.view.pseudo : undefined}
                tabindex="0"
                aria-label={theme}
                style={{ width: frameWidth(props.view.width) }}
                class={[
                  "relative flex shrink-0 self-stretch overflow-auto rounded-lg [contain:layout] border border-line p-6 pt-8 outline-none focus-visible:outline-2 focus-visible:outline-focus xl:self-auto",
                  props.entry.frame ?? "bg-page text-ink",
                  props.view.width === "full" && "min-w-0 flex-1 shrink",
                  story.fill && mode() === "single" ? "h-[36rem] flex-col *:min-h-0 *:flex-1" : "min-h-40 items-center justify-center",
                ]}
              >
                <span class="absolute top-2 left-3 flex items-center gap-1 rounded-xs bg-page px-1 font-mono text-2xs text-muted">
                  <Glyph icon={themeLook[theme].icon} size={12} />
                  {theme}
                </span>
                <Errored
                  fallback={(err, reset) => (
                    <div data-testid="story-error" role="alert" class="flex flex-col gap-2 text-berry">
                      <pre class="font-mono text-xs whitespace-pre-wrap">{String(err())}</pre>
                      <button type="button" class="self-start rounded-md border border-line px-2 py-1 text-ink" onClick={reset}>
                        Try again
                      </button>
                    </div>
                  )}
                >
                  <Show when={mode() === "grid" && grid} fallback={draw()}>
                    {(g) => <Grid rows={g().rows} cols={g().cols} draw={draw} />}
                  </Show>
                </Errored>
              </div>
            )}
          </For>
        </div>
        <Show when={auditing()}>
          <A11yPanel result={axe.result()} onAgain={axe.again} />
        </Show>
      </main>

      <Show when={names.length > 0}>
        <aside data-testid="story-args" aria-label="Arguments" class="flex w-64 shrink-0 flex-col gap-3 overflow-y-auto border-l border-line bg-side p-3">
          <div class="flex items-center justify-between">
            <h2 class="text-xs font-semibold text-muted">Arguments</h2>
            <button
              type="button"
              data-testid="story-reset"
              aria-label="Reset the arguments"
              title="Reset the arguments"
              class="flex size-6 items-center justify-center rounded-md text-muted hover:bg-hover hover:text-ink"
              onClick={() => set({ ...story.args })}
            >
              <Glyph icon={Restart} size={14} />
            </button>
          </div>
          <For each={names}>
            {(name) => (
              <ArgControl
                name={name}
                value={args[name]!}
                control={story.controls?.[name]}
                fixed={mode() === "grid" && axisNames(grid).includes(name)}
                onChange={(v) => set({ [name]: v })}
              />
            )}
          </For>
        </aside>
      </Show>
    </>
  );
}

const axisNames = (grid: Story["grid"]) => [grid?.rows, grid?.cols].flatMap((a) => (a === undefined || a === "pseudo" ? [] : [a[0]]));

interface Cell {
  readonly label: string;
  readonly over: Partial<Args>;
  readonly pseudo?: PseudoState;
}

const cellsOf = (axis: Axis<Args> | undefined): Cell[] =>
  axis === undefined
    ? [{ label: "", over: {} }]
    : axis === "pseudo"
      ? pseudoStates.map((p) => ({ label: p, over: {}, pseudo: p }))
      : axis[1].map((v) => ({ label: String(v), over: { [axis[0]]: v } }));

/** A forced state is the cell's own, so a row of states sits side by side. */
function Grid(props: { rows: Axis<Args> | undefined; cols: Axis<Args> | undefined; draw: (over: Partial<Args>) => JSX.Element }) {
  const rows = cellsOf(props.rows);
  const cols = cellsOf(props.cols);
  const label = "px-2 py-1 text-left font-mono text-2xs font-normal text-muted";
  return (
    <table data-testid="story-grid" class="border-separate border-spacing-0 self-start">
      <Show when={props.cols !== undefined}>
        <thead>
          <tr>
            <Show when={props.rows !== undefined}>
              <td />
            </Show>
            <For each={cols}>{(c) => <th class={label}>{c.label}</th>}</For>
          </tr>
        </thead>
      </Show>
      <tbody>
        <For each={rows}>
          {(r) => (
            <tr>
              <Show when={props.rows !== undefined}>
                <th scope="row" class={[label, "pr-4"]}>
                  {r.label}
                </th>
              </Show>
              <For each={cols}>
                {(c) => (
                  <td data-testid="story-cell" data-pseudo={(c.pseudo ?? r.pseudo) === "rest" ? undefined : (c.pseudo ?? r.pseudo)} class="p-2 align-middle">
                    {props.draw({ ...r.over, ...c.over })}
                  </td>
                )}
              </For>
            </tr>
          )}
        </For>
      </tbody>
    </table>
  );
}

function Pick<T extends string>(props: {
  label: string;
  testid: string;
  value: T;
  options: readonly T[];
  looks: Record<T, { icon: IconFunction; label: string; text?: string }>;
  onChange: (v: T) => void;
}) {
  return (
    <div role="radiogroup" aria-label={props.label} data-testid={props.testid} class="flex rounded-md border border-line p-0.5">
      <For each={props.options}>
        {(o) => (
          <button
            type="button"
            role="radio"
            aria-checked={props.value === o ? "true" : "false"}
            aria-label={props.looks[o].label}
            title={props.looks[o].label}
            data-value={String(o)}
            onClick={() => props.onChange(o)}
            class="flex h-7 min-w-7 items-center justify-center rounded-sm px-1 text-muted hover:text-ink aria-checked:bg-selected aria-checked:text-ink"
          >
            <Show when={props.looks[o].text} fallback={<Glyph icon={props.looks[o].icon} size={16} />}>
              {(text) => <span class="font-mono text-xs">{text()}</span>}
            </Show>
          </button>
        )}
      </For>
    </div>
  );
}

/** The address holds the view: copying it shares this story, theme and width. */
function CopyLink() {
  const [copied, setCopied] = createSignal(false);
  return (
    <button
      type="button"
      data-testid="story-copy-link"
      aria-label="Copy link to this view"
      title={copied() ? "Copied" : "Copy link to this view"}
      onClick={() =>
        void navigator.clipboard?.writeText(location.href).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        })
      }
      class="flex size-8 items-center justify-center rounded-md border border-line text-muted hover:text-ink"
    >
      <Glyph icon={copied() ? Check : Link} size={16} />
    </button>
  );
}

const field = "h-8 w-full rounded-md border border-line bg-page px-2 text-sm outline-none focus:border-focus";

/** Without a control, one follows the value's type. */
function ArgControl(props: {
  name: string;
  value: string | number | boolean;
  control: Control | undefined;
  /** Set by the grid's rows or columns: shown, not editable, while the grid is up. */
  fixed: boolean;
  onChange: (v: string | number | boolean) => void;
}) {
  const control = (): Control =>
    props.control ?? (typeof props.value === "boolean" ? { kind: "boolean" } : typeof props.value === "number" ? { kind: "number" } : { kind: "text" });
  const id = `arg-${props.name}`;
  return (
    <fieldset
      data-testid="story-arg"
      data-name={props.name}
      disabled={props.fixed}
      title={props.fixed ? "Set by the grid" : undefined}
      class="flex flex-col gap-1 disabled:opacity-50"
    >
      {(() => {
        const c = control();
        switch (c.kind) {
          case "boolean":
            return (
              <label class="flex items-center gap-2">
                <input type="checkbox" checked={props.value === true} onChange={(e) => props.onChange(e.currentTarget.checked)} />
                <span class="font-mono text-xs">{props.name}</span>
              </label>
            );
          case "number":
            return (
              <>
                <label for={id} class="font-mono text-xs">
                  {props.name}
                </label>
                <input
                  id={id}
                  type="number"
                  min={c.min}
                  max={c.max}
                  step={c.step}
                  value={String(props.value)}
                  onInput={(e) => {
                    const n = e.currentTarget.valueAsNumber;
                    if (Number.isFinite(n)) props.onChange(n);
                  }}
                  class={field}
                />
              </>
            );
          case "choice":
            return (
              <>
                <label for={id} class="font-mono text-xs">
                  {props.name}
                </label>
                <select id={id} value={String(props.value)} onChange={(e) => props.onChange(e.currentTarget.value)} class={field}>
                  <For each={c.options}>{(o) => <option value={o}>{o}</option>}</For>
                </select>
              </>
            );
          case "text":
            return (
              <>
                <label for={id} class="font-mono text-xs">
                  {props.name}
                </label>
                {c.long ? (
                  <textarea
                    id={id}
                    rows={6}
                    value={String(props.value)}
                    onInput={(e) => props.onChange(e.currentTarget.value)}
                    class={[field, "h-auto py-1 font-mono text-xs"]}
                  />
                ) : (
                  <input id={id} type="text" value={String(props.value)} onInput={(e) => props.onChange(e.currentTarget.value)} class={field} />
                )}
              </>
            );
        }
      })()}
    </fieldset>
  );
}
