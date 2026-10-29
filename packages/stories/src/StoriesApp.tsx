// Drawn with the host's token classes (bg-page, border-line…): the host's Tailwind scans this folder. Each frame contains
// its layout, so a part fixed to the window (a toast) stays in its frame; a modal <dialog> still opens over everything.

import { createMemo, createSignal, createStore, Errored, For, Show } from "solid-js";
import type { JSX } from "@solidjs/web";
import type { Args, Control, Stories, Story } from "./format";

export type Theme = "light" | "dark" | "both";
export const widths = ["full", "400", "720", "1280"] as const;
export type Width = (typeof widths)[number];

export interface Entry {
  /** "ui/Button:Tones": the address of one story. */
  readonly key: string;
  readonly title: string;
  readonly name: string;
  readonly story: Story;
  readonly themes: readonly ("light" | "dark")[];
  readonly frame: string | undefined;
}

/** Every story, by group (`order` first, the rest after), then title, then as written. Two files with one title is a
 * mistake, said once. */
export function entries(modules: readonly Stories[], order: readonly string[] = []): Entry[] {
  const seen = new Set<string>();
  const rank = (title: string) => {
    const i = order.indexOf(title.split("/")[0]!);
    return i === -1 ? order.length : i;
  };
  return [...modules]
    .sort((a, b) => rank(a.title) - rank(b.title) || a.title.localeCompare(b.title))
    .flatMap((m) => {
      if (seen.has(m.title)) throw new Error(`two stories files are titled ${m.title}`);
      seen.add(m.title);
      return Object.entries(m.stories).map(([name, story]) => ({
        key: `${m.title}:${name}`,
        title: m.title,
        name,
        story,
        themes: m.themes ?? ["light", "dark"],
        frame: m.frame,
      }));
    });
}

export function search(list: readonly Entry[], q: string): Entry[] {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  return list.filter((e) => words.every((w) => e.key.toLowerCase().includes(w)));
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

export function StoriesApp(props: {
  stories: readonly Stories[];
  /** The groups (a title's first part) to list first, in this order. */
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
  const open = createMemo(() => list.find((e) => e.key === view().key));

  return (
    <div class="flex h-dvh min-h-0 bg-page text-sm text-ink">
      <nav data-testid="stories-tree" aria-label="Stories" class="flex w-64 shrink-0 flex-col border-r border-line bg-side">
        <div class="p-2">
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
            class="h-8 w-full rounded-md border border-line bg-page px-2 text-sm outline-none focus:border-focus"
          />
        </div>
        <ul class="min-h-0 flex-1 overflow-y-auto px-2 pb-4">
          <For each={groups(shown())}>
            {(g) => (
              <li class="mt-2">
                <div class="px-2 py-1 font-mono text-2xs text-muted">{g.title}</div>
                <ul>
                  <For each={g.entries}>
                    {(e) => (
                      <li>
                        <a
                          href={`?s=${encodeURIComponent(e.key)}`}
                          data-testid="story-link"
                          data-key={e.key}
                          aria-current={view().key === e.key ? "page" : undefined}
                          onClick={(ev) => {
                            if (ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.button !== 0) return;
                            ev.preventDefault();
                            move({ key: e.key });
                          }}
                          class="block truncate rounded-md px-2 py-1 hover:bg-hover aria-[current=page]:bg-selected aria-[current=page]:font-medium"
                        >
                          {e.name}
                        </a>
                      </li>
                    )}
                  </For>
                </ul>
              </li>
            )}
          </For>
        </ul>
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

function groups(list: readonly Entry[]) {
  const out: { title: string; entries: Entry[] }[] = [];
  for (const e of list) {
    const last = out.at(-1);
    if (last?.title === e.title) last.entries.push(e);
    else out.push({ title: e.title, entries: [e] });
  }
  return out;
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
              <span class="font-normal text-muted">{`${props.entry.title} / `}</span>
              {props.entry.name}
            </h1>
            <Show when={story.note}>{(note) => <p class="text-xs text-muted">{note()}</p>}</Show>
          </div>
          <Pick label="Theme" testid="story-theme" value={props.theme} options={["light", "dark", "both"]} onChange={props.onTheme} />
          <Pick label="Width" testid="story-width" value={props.width} options={widths} onChange={props.onWidth} />
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
                <span class="absolute top-2 left-3 rounded-xs bg-page px-1 font-mono text-2xs text-muted">{theme}</span>
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
              class="rounded-md px-2 py-0.5 text-xs text-muted hover:bg-hover"
              onClick={() => set({ ...story.args })}
            >
              Reset
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

function Pick<T extends string>(props: { label: string; testid: string; value: T; options: readonly T[]; onChange: (v: T) => void }) {
  return (
    <div role="radiogroup" aria-label={props.label} data-testid={props.testid} class="flex rounded-md border border-line p-0.5">
      <For each={props.options}>
        {(o) => (
          <button
            type="button"
            role="radio"
            aria-checked={props.value === o ? "true" : "false"}
            data-value={String(o)}
            onClick={() => props.onChange(o)}
            class="rounded-sm px-2 py-0.5 text-xs text-muted hover:text-ink aria-checked:bg-selected aria-checked:font-medium aria-checked:text-ink"
          >
            {o}
          </button>
        )}
      </For>
    </div>
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
