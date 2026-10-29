// Drawn with the host's token classes (bg-page, border-line…): the host's Tailwind scans this folder. Each frame contains
// its layout, so a part fixed to the window (a toast) stays in its frame; a modal <dialog> still opens over everything.

import { createMemo, createSignal, createStore, Errored, For, Match, Show, Switch } from "solid-js";
import type { JSX } from "@solidjs/web";
import { AngleRight, Check, Folder, Laptop, Layout, Link, Maximize, Mobile, Moon, Restart, Search, Sun, Tablet, type IconFunction } from "reicon";
import type { Args, Control, Stories } from "./format";
import { type Entry, entries, isOpen, type Node, search, treeOf } from "./tree";

export type Theme = "light" | "dark" | "both";
export const widths = ["full", "400", "720", "1280"] as const;
export type Width = (typeof widths)[number];

const themeLook: Record<Theme, { icon: IconFunction; label: string }> = {
  light: { icon: Sun, label: "Light" },
  dark: { icon: Moon, label: "Dark" },
  both: { icon: Layout, label: "Light and dark side by side" },
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
}

const readView = (list: readonly Entry[]): View => {
  const q = new URLSearchParams(location.search);
  const key = q.get("s") ?? "";
  const theme = q.get("theme");
  const width = q.get("w");
  return {
    key: list.some((e) => e.key === key) ? key : (list[0]?.key ?? ""),
    theme: theme === "light" || theme === "dark" || theme === "both" ? theme : "both",
    width: widths.find((w) => w === width) ?? "full",
  };
};

const writeView = (v: View) => {
  const q = new URLSearchParams({ s: v.key, theme: v.theme, w: v.width });
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

export function StoriesApp(props: {
  stories: readonly Stories[];
  /** Paths to list first, in this order, at each depth ("设计体系", "组件", "组件/工作台"). */
  order?: readonly string[];
  /** What every story is drawn inside: the host's contexts (a router, a query cache). */
  wrap?: (story: () => JSX.Element) => JSX.Element;
}) {
  const list = entries(props.stories, props.order);
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
        {(e: Entry) => (
          <Opened
            entry={e}
            theme={view().theme}
            width={view().width}
            onTheme={(theme) => move({ theme })}
            onWidth={(width) => move({ width })}
            wrap={props.wrap}
          />
        )}
      </Show>
    </div>
  );
}

const frameWidth = (w: Width) => (w === "full" ? undefined : `${w}px`);

/** The open story: its arguments live here, so they start over when another story opens. */
function Opened(props: {
  entry: Entry;
  theme: Theme;
  width: Width;
  onTheme: (t: Theme) => void;
  onWidth: (w: Width) => void;
  wrap: ((story: () => JSX.Element) => JSX.Element) | undefined;
}) {
  const story = props.entry.story;
  const [args, setArgs] = createStore<Args>({ ...story.args });
  const set = (patch: Partial<Args>) =>
    setArgs((a) => {
      Object.assign(a, patch);
    });
  const themes = () => {
    const own = props.entry.themes;
    const asked = own.filter((t) => props.theme === "both" || t === props.theme);
    return asked.length > 0 ? asked : own.slice(0, 1);
  };
  const draw = () => {
    const wrap = props.wrap ?? ((s) => s());
    return wrap(() => story.render(args, set));
  };
  const names = Object.keys(story.args ?? {});

  return (
    <>
      <main class="flex min-w-0 flex-1 flex-col">
        <header class="flex flex-wrap items-center gap-3 border-b border-line px-4 py-2">
          <div class="flex min-w-0 flex-1 flex-col">
            <h1 data-testid="story-name" class="truncate text-sm font-semibold">
              <span class="font-normal text-muted">{`${props.entry.title.split("/").join(" / ")} / `}</span>
              {props.entry.name}
            </h1>
            <Show when={story.note}>{(note) => <p class="text-xs text-muted">{note()}</p>}</Show>
          </div>
          <Pick label="Theme" testid="story-theme" value={props.theme} options={["light", "dark", "both"]} looks={themeLook} onChange={props.onTheme} />
          <Pick label="Width" testid="story-width" value={props.width} options={widths} looks={widthLook} onChange={props.onWidth} />
          <CopyLink />
        </header>
        <div
          data-testid="story-canvas"
          class={["flex min-h-0 flex-1 items-start gap-4 overflow-auto bg-hover p-4", props.width === "full" ? "flex-col xl:flex-row" : "flex-row"]}
        >
          <For each={themes()}>
            {(theme) => (
              <div
                data-theme={theme}
                data-testid="story-frame"
                tabindex="0"
                aria-label={theme}
                style={{ width: frameWidth(props.width) }}
                class={[
                  "relative flex shrink-0 self-stretch overflow-auto rounded-lg [contain:layout] border border-line p-6 pt-8 outline-none focus-visible:outline-2 focus-visible:outline-focus xl:self-auto",
                  props.entry.frame ?? "bg-page text-ink",
                  props.width === "full" && "min-w-0 flex-1 shrink",
                  story.fill ? "h-[36rem] flex-col *:min-h-0 *:flex-1" : "min-h-40 items-center justify-center",
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
                  {draw()}
                </Errored>
              </div>
            )}
          </For>
        </div>
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
            {(name) => <ArgControl name={name} value={args[name]!} control={story.controls?.[name]} onChange={(v) => set({ [name]: v })} />}
          </For>
        </aside>
      </Show>
    </>
  );
}

function Pick<T extends string>(props: {
  label: string;
  testid: string;
  value: T;
  options: readonly T[];
  looks: Record<T, { icon: IconFunction; label: string }>;
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
            class="flex size-7 items-center justify-center rounded-sm text-muted hover:text-ink aria-checked:bg-selected aria-checked:text-ink"
          >
            <Glyph icon={props.looks[o].icon} size={16} />
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
function ArgControl(props: { name: string; value: string | number | boolean; control: Control | undefined; onChange: (v: string | number | boolean) => void }) {
  const control = (): Control =>
    props.control ?? (typeof props.value === "boolean" ? { kind: "boolean" } : typeof props.value === "number" ? { kind: "number" } : { kind: "text" });
  const id = `arg-${props.name}`;
  return (
    <div data-testid="story-arg" data-name={props.name} class="flex flex-col gap-1">
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
    </div>
  );
}
