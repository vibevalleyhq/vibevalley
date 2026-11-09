import type { JSX } from "@solidjs/web";
import * as stylex from "@stylexjs/stylex";
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
import { createMemo, createSignal, createStore, Errored, For, Match, onSettled, Show, Switch } from "solid-js";

import { A11yPanel, useAxe } from "./a11y";
import type { Args, Axis, Control, Stories, Story } from "./format";
import { forceStates, type PseudoState, pseudoStates, pseudoStyleId } from "./pseudo";
import { type Entry, entries, isOpen, type Node, search, treeOf } from "./tree";
import { treeRow } from "./tree.stylex";

const viewStyles = stylex.create({
  frameDefault: { backgroundColor: "var(--color-page)", color: "var(--color-ink)" },
  treeSpan: {
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    overflow: "hidden",
  },
  storiesAppDiv: {
    display: "flex",
    height: "100dvh",
    minHeight: "0",
    backgroundColor: "var(--color-page)",
    fontSize: "var(--text-sm)",
    lineHeight: "var(--text-sm--line-height)",
    color: "var(--color-ink)",
  },
  storiesTree: {
    display: "flex",
    width: "calc(var(--spacing) * 72)",
    flexShrink: "0",
    flexDirection: "column",
    borderRightStyle: "solid",
    borderRightWidth: "1px",
    borderColor: "var(--color-line)",
    backgroundColor: "var(--color-side)",
  },
  storiesAppDiv2: {
    padding: "calc(var(--spacing) * 2)",
  },
  storiesAppLabel: {
    display: "flex",
    height: "calc(var(--spacing) * 8)",
    alignItems: "center",
    gap: "calc(var(--spacing) * 2)",
    borderRadius: "var(--radius-md)",
    borderStyle: "solid",
    borderWidth: "1px",
    borderColor: {
      default: "var(--color-line)",
      ":focus-within": "var(--color-focus)",
    },
    backgroundColor: "var(--color-page)",
    paddingInline: "calc(var(--spacing) * 2)",
    color: "var(--color-muted)",
  },
  storiesSearch: {
    minWidth: "0",
    flex: "1",
    backgroundColor: "transparent",
    fontSize: "var(--text-sm)",
    lineHeight: "var(--text-sm--line-height)",
    color: "var(--color-ink)",
    outlineStyle: "none",
  },
  storiesAppDiv3: {
    minHeight: "0",
    flex: "1",
    overflowY: "auto",
    paddingInline: "calc(var(--spacing) * 2)",
    paddingBottom: "calc(var(--spacing) * 4)",
  },
  storiesAppDiv4: {
    borderTopStyle: "solid",
    borderTopWidth: "1px",
    borderColor: "var(--color-line)",
    paddingInline: "calc(var(--spacing) * 3)",
    paddingBlock: "calc(var(--spacing) * 2)",
    fontSize: "var(--text-2xs)",
    lineHeight: "var(--text-2xs--line-height)",
    color: "var(--color-muted)",
  },
  storiesAppP: {
    margin: "auto",
    color: "var(--color-muted)",
  },
  openedMain: {
    display: "flex",
    minWidth: "0",
    flex: "1",
    flexDirection: "column",
  },
  openedHeader: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: "calc(var(--spacing) * 2)",
    borderBottomStyle: "solid",
    borderBottomWidth: "1px",
    borderColor: "var(--color-line)",
    paddingInline: "calc(var(--spacing) * 4)",
    paddingBlock: "calc(var(--spacing) * 2)",
  },
  storyName: {
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    overflow: "hidden",
    fontSize: "var(--text-sm)",
    lineHeight: "var(--text-sm--line-height)",
    fontWeight: "var(--font-weight-semibold)",
  },
  openedSpan: {
    fontWeight: "var(--font-weight-normal)",
    color: "var(--color-muted)",
  },
  openedP: {
    fontSize: "var(--text-xs)",
    lineHeight: "var(--text-xs--line-height)",
    color: "var(--color-muted)",
  },
  openedSpan2: {
    position: "absolute",
    top: "calc(var(--spacing) * 2)",
    left: "calc(var(--spacing) * 3)",
    display: "flex",
    alignItems: "center",
    gap: "var(--spacing)",
    borderRadius: "var(--radius-xs)",
    backgroundColor: "var(--color-page)",
    paddingInline: "var(--spacing)",
    fontFamily: "var(--font-mono)",
    fontSize: "var(--text-2xs)",
    lineHeight: "var(--text-2xs--line-height)",
    color: "var(--color-muted)",
  },
  storyError: {
    display: "flex",
    flexDirection: "column",
    gap: "calc(var(--spacing) * 2)",
    color: "var(--color-berry)",
  },
  openedPre: {
    fontFamily: "var(--font-mono)",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--text-xs--line-height)",
    whiteSpace: "pre-wrap",
  },
  openedButton: {
    alignSelf: "flex-start",
    borderRadius: "var(--radius-md)",
    borderStyle: "solid",
    borderWidth: "1px",
    borderColor: "var(--color-line)",
    paddingInline: "calc(var(--spacing) * 2)",
    paddingBlock: "var(--spacing)",
    color: "var(--color-ink)",
  },
  storyArgs: {
    display: "flex",
    width: "calc(var(--spacing) * 64)",
    flexShrink: "0",
    flexDirection: "column",
    gap: "calc(var(--spacing) * 3)",
    overflowY: "auto",
    borderLeftStyle: "solid",
    borderLeftWidth: "1px",
    borderColor: "var(--color-line)",
    backgroundColor: "var(--color-side)",
    padding: "calc(var(--spacing) * 3)",
  },
  openedDiv: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
  },
  openedH2: {
    fontSize: "var(--text-xs)",
    lineHeight: "var(--text-xs--line-height)",
    fontWeight: "var(--font-weight-semibold)",
    color: "var(--color-muted)",
  },
  storyReset: {
    display: "flex",
    width: "calc(var(--spacing) * 6)",
    height: "calc(var(--spacing) * 6)",
    alignItems: "center",
    justifyContent: "center",
    borderRadius: "var(--radius-md)",
    color: {
      default: "var(--color-muted)",
      "@media (hover:hover)": {
        default: null,
        ":hover": "var(--color-ink)",
      },
    },
    backgroundColor: {
      default: null,
      "@media (hover:hover)": {
        default: null,
        ":hover": "var(--color-hover)",
      },
    },
  },
  storyGrid: {
    borderCollapse: "separate",
    borderSpacing: "0px 0px",
    alignSelf: "flex-start",
  },
  storyCell: {
    padding: "calc(var(--spacing) * 2)",
    verticalAlign: "middle",
  },
  pickDiv: {
    display: "flex",
    borderRadius: "var(--radius-md)",
    borderStyle: "solid",
    borderWidth: "1px",
    borderColor: "var(--color-line)",
    padding: "calc(var(--spacing) * .5)",
  },
  pickSpan: {
    fontFamily: "var(--font-mono)",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--text-xs--line-height)",
  },
  storyCopyLink: {
    display: "flex",
    width: "calc(var(--spacing) * 8)",
    height: "calc(var(--spacing) * 8)",
    alignItems: "center",
    justifyContent: "center",
    borderRadius: "var(--radius-md)",
    borderStyle: "solid",
    borderWidth: "1px",
    borderColor: "var(--color-line)",
    color: {
      default: "var(--color-muted)",
      "@media (hover:hover)": {
        default: null,
        ":hover": "var(--color-ink)",
      },
    },
  },
  storyArg: {
    display: "flex",
    flexDirection: "column",
    gap: "var(--spacing)",
    opacity: {
      default: null,
      ":disabled": ".5",
    },
  },
  argControlLabel: {
    display: "flex",
    alignItems: "center",
    gap: "calc(var(--spacing) * 2)",
  },
});

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

const glyphStyles = stylex.create({
  root: { display: "inline-flex", flexShrink: 0 },
  muted: { color: "var(--color-faint)" },
  arrow: {
    transitionProperty: "transform, translate, scale, rotate",
    transitionTimingFunction: "var(--default-transition-timing-function)",
    transitionDuration: "var(--default-transition-duration)",
    rotate: { default: null, [stylex.when.ancestor('[aria-expanded="true"]', treeRow)]: "90deg" },
  },
});

function Glyph(props: { icon: IconFunction; size?: number; styles?: stylex.StyleXStyles }) {
  return (
    <span aria-hidden="true" {...styleProps(glyphStyles.root, props.styles)}>
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
    const stored: unknown = JSON.parse(localStorage.getItem(toggledKey) ?? "[]");
    return new Map(
      Array.isArray(stored) ? stored.filter((e): e is [string, boolean] => Array.isArray(e) && typeof e[0] === "string" && typeof e[1] === "boolean") : [],
    );
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
  /** Paths to list first, in this order, at each depth ("Design System", "Components", "Components/Workbench"). */
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
                      {...styleProps(
                        viewerStyles.indent(f().depth * 12 + 4),
                        treeRow,
                        viewerStyles.folder,
                        f().depth === 0 ? viewerStyles.rootFolder : viewerStyles.nestedFolder,
                      )}
                    >
                      <Glyph icon={AngleRight} size={12} styles={[glyphStyles.muted, glyphStyles.arrow]} />
                      <Show when={f().depth > 0}>
                        <Glyph icon={Folder} size={14} styles={glyphStyles.muted} />
                      </Show>
                      <span {...stylex.attrs(viewStyles.treeSpan)}>{f().name}</span>
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
                    {...styleProps(viewerStyles.link, viewerStyles.indent(s().depth * 12 + 20))}
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
    <div {...stylex.attrs(viewStyles.storiesAppDiv)}>
      <nav data-testid="stories-tree" aria-label="Stories" {...stylex.attrs(viewStyles.storiesTree)}>
        <div {...stylex.attrs(viewStyles.storiesAppDiv2)}>
          <label {...stylex.attrs(viewStyles.storiesAppLabel)}>
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
              {...stylex.attrs(viewStyles.storiesSearch)}
            />
          </label>
        </div>
        <div {...stylex.attrs(viewStyles.storiesAppDiv3)}>
          <Tree nodes={tree()} />
        </div>
        <div {...stylex.attrs(viewStyles.storiesAppDiv4)}>{`${list.length} stories`}</div>
      </nav>

      <Show when={open()} keyed fallback={<p {...stylex.attrs(viewStyles.storiesAppP)}>No stories.</p>}>
        {(e: Entry) => <Opened entry={e} view={view()} move={move} wrap={props.wrap} locales={props.locales ?? []} prepare={props.prepare} />}
      </Show>
    </div>
  );
}

const viewerStyles = stylex.create({
  canvas: {
    display: "flex",
    minHeight: 0,
    flex: "1",
    alignItems: "flex-start",
    gap: "calc(var(--spacing) * 4)",
    overflow: "auto",
    backgroundColor: "var(--color-hover)",
    padding: "calc(var(--spacing) * 4)",
  },
  row: { flexDirection: "row" },
  column: { flexDirection: "column" },
  responsive: { flexDirection: { default: "column", "@media (width >= 80rem)": "row" } },
  frame: {
    position: "relative",
    display: "flex",
    flexShrink: 0,
    alignSelf: { default: "stretch", "@media (width >= 80rem)": "auto" },
    overflow: "auto",
    borderRadius: "var(--radius-lg)",
    borderStyle: "solid",
    borderWidth: 1,
    borderColor: "var(--color-line)",
    paddingTop: "calc(var(--spacing) * 8)",
    paddingRight: "calc(var(--spacing) * 6)",
    paddingBottom: "calc(var(--spacing) * 6)",
    paddingLeft: "calc(var(--spacing) * 6)",
    contain: "layout",
    outlineStyle: "none",
    outlineWidth: { default: null, ":focus-visible": 2 },
    outlineColor: { default: null, ":focus-visible": "var(--color-focus)" },
  },
  fullFrame: { minWidth: 0, flexGrow: 1, flexBasis: "0%" },
  filledFrame: { height: "36rem", flexDirection: "column" },
  centeredFrame: { minHeight: "calc(var(--spacing) * 40)", alignItems: "center", justifyContent: "center" },
  frameWidth: (width: string) => ({ width }),
  folder: {
    display: "flex",
    width: "100%",
    alignItems: "center",
    gap: "var(--spacing)",
    borderRadius: "var(--radius-md)",
    paddingBlock: "var(--spacing)",
    paddingRight: "calc(var(--spacing) * 2)",
    textAlign: "left",
    backgroundColor: { default: null, "@media (hover: hover)": { default: null, ":hover": "var(--color-hover)" } },
  },
  rootFolder: {
    marginTop: "calc(var(--spacing) * 2)",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--text-xs--line-height)",
    fontWeight: "var(--font-weight-semibold)",
  },
  nestedFolder: { color: { default: "var(--color-muted)", "@media (hover: hover)": { default: null, ":hover": "var(--color-ink)" } } },
  indent: (paddingLeft: number) => ({ paddingLeft }),
  link: {
    display: "block",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    borderRadius: "var(--radius-md)",
    paddingBlock: "var(--spacing)",
    paddingRight: "calc(var(--spacing) * 2)",
    backgroundColor: {
      default: null,
      "@media (hover: hover)": { default: null, ':hover:not([aria-current="page"])': "var(--color-hover)" },
      ':is([aria-current="page"])': "var(--color-selected)",
    },
    fontWeight: { default: null, ':is([aria-current="page"])': "var(--font-weight-medium)" },
  },
  audit: {
    display: "flex",
    height: "calc(var(--spacing) * 8)",
    alignItems: "center",
    gap: "var(--spacing)",
    borderRadius: "var(--radius-md)",
    borderStyle: "solid",
    borderWidth: 1,
    borderColor: "var(--color-line)",
    paddingInline: "calc(var(--spacing) * 2)",
    color: {
      default: "var(--color-muted)",
      "@media (hover: hover)": { default: null, ":hover": "var(--color-ink)" },
      ':is([aria-pressed="true"])': "var(--color-ink)",
    },
    backgroundColor: { default: null, ':is([aria-pressed="true"])': "var(--color-selected)" },
  },
  count: { fontFamily: "var(--font-mono)", fontSize: "var(--text-xs)", lineHeight: "var(--text-xs--line-height)" },
  problem: { color: "var(--color-berry)" },
  gridLabel: {
    paddingLeft: "calc(var(--spacing) * 2)",
    paddingRight: "calc(var(--spacing) * 2)",
    paddingBlock: "var(--spacing)",
    textAlign: "left",
    fontFamily: "var(--font-mono)",
    fontSize: "var(--text-2xs)",
    lineHeight: "var(--text-2xs--line-height)",
    fontWeight: "var(--font-weight-normal)",
    color: "var(--color-muted)",
  },
  rowLabel: { paddingRight: "calc(var(--spacing) * 4)" },
  choice: {
    display: "flex",
    height: "calc(var(--spacing) * 7)",
    minWidth: "calc(var(--spacing) * 7)",
    alignItems: "center",
    justifyContent: "center",
    borderRadius: "var(--radius-sm)",
    paddingInline: "var(--spacing)",
    color: {
      default: "var(--color-muted)",
      "@media (hover: hover)": { default: null, ":hover": "var(--color-ink)" },
      ':is([aria-checked="true"])': "var(--color-ink)",
    },
    backgroundColor: { default: null, ':is([aria-checked="true"])': "var(--color-selected)" },
  },
  field: {
    height: "calc(var(--spacing) * 8)",
    width: "100%",
    borderRadius: "var(--radius-md)",
    borderStyle: "solid",
    borderWidth: 1,
    borderColor: { default: "var(--color-line)", ":focus": "var(--color-focus)" },
    backgroundColor: "var(--color-page)",
    paddingInline: "calc(var(--spacing) * 2)",
    fontSize: "var(--text-sm)",
    lineHeight: "var(--text-sm--line-height)",
    outlineStyle: "none",
  },
  longField: {
    height: "auto",
    paddingBlock: "var(--spacing)",
    fontFamily: "var(--font-mono)",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--text-xs--line-height)",
  },
});

function styleProps(...values: readonly (stylex.StyleXStyles | typeof treeRow)[]) {
  // attrs() kebab-cases custom property names too; object styles preserve the compiler's case-sensitive variables.
  const { className, ...attributes } = stylex.props(values);
  return { ...attributes, class: className };
}

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
      <main {...stylex.attrs(viewStyles.openedMain)}>
        <header {...stylex.attrs(viewStyles.openedHeader)}>
          <div {...stylex.attrs(viewStyles.openedMain)}>
            <h1 data-testid="story-name" {...stylex.attrs(viewStyles.storyName)}>
              <span {...stylex.attrs(viewStyles.openedSpan)}>{`${props.entry.title.split("/").join(" / ")} / `}</span>
              {props.entry.name}
            </h1>
            <Show when={story.note}>{(note) => <p {...stylex.attrs(viewStyles.openedP)}>{note()}</p>}</Show>
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
            {...stylex.attrs(viewerStyles.audit)}
          >
            <Glyph icon={Accessibility} size={16} />
            <span {...stylex.attrs(viewerStyles.count, (axe.count() ?? 0) > 0 && viewerStyles.problem)}>{axe.count() ?? "…"}</span>
          </button>
          <CopyLink />
        </header>
        <div
          ref={(el) => (canvas = el)}
          data-testid="story-canvas"
          {...stylex.attrs(
            viewerStyles.canvas,
            props.view.width === "full" && mode() === "single" ? viewerStyles.responsive : props.view.width === "full" ? viewerStyles.column : viewerStyles.row,
          )}
        >
          <For each={themes()}>
            {(theme) => (
              <div
                data-theme={theme}
                data-testid="story-frame"
                data-pseudo={mode() === "single" && props.view.pseudo !== "rest" ? props.view.pseudo : undefined}
                tabindex="0"
                aria-label={theme}
                data-story-fill={story.fill === true && mode() === "single" ? "true" : undefined}
                {...styleProps(
                  props.entry.frame ?? viewStyles.frameDefault,
                  viewerStyles.frame,
                  props.view.width === "full" && viewerStyles.fullFrame,
                  story.fill === true && mode() === "single" ? viewerStyles.filledFrame : viewerStyles.centeredFrame,
                  props.view.width !== "full" && viewerStyles.frameWidth(`${props.view.width}px`),
                )}
              >
                <span {...stylex.attrs(viewStyles.openedSpan2)}>
                  <Glyph icon={themeLook[theme].icon} size={12} />
                  {theme}
                </span>
                <Errored
                  fallback={(err, reset) => (
                    <div data-testid="story-error" role="alert" {...stylex.attrs(viewStyles.storyError)}>
                      <pre {...stylex.attrs(viewStyles.openedPre)}>{String(err())}</pre>
                      <button type="button" {...stylex.attrs(viewStyles.openedButton)} onClick={reset}>
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
        <aside data-testid="story-args" aria-label="Arguments" {...stylex.attrs(viewStyles.storyArgs)}>
          <div {...stylex.attrs(viewStyles.openedDiv)}>
            <h2 {...stylex.attrs(viewStyles.openedH2)}>Arguments</h2>
            <button
              type="button"
              data-testid="story-reset"
              aria-label="Reset the arguments"
              title="Reset the arguments"
              {...stylex.attrs(viewStyles.storyReset)}
              onClick={() => set({ ...story.args })}
            >
              <Glyph icon={Restart} size={14} />
            </button>
          </div>
          <For each={names}>
            {(name) => (
              <ArgControl
                name={name}
                value={args[name] ?? ""}
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
  return (
    <table data-testid="story-grid" {...stylex.attrs(viewStyles.storyGrid)}>
      <Show when={props.cols !== undefined}>
        <thead>
          <tr>
            <Show when={props.rows !== undefined}>
              <td />
            </Show>
            <For each={cols}>{(c) => <th {...stylex.attrs(viewerStyles.gridLabel)}>{c.label}</th>}</For>
          </tr>
        </thead>
      </Show>
      <tbody>
        <For each={rows}>
          {(r) => (
            <tr>
              <Show when={props.rows !== undefined}>
                <th scope="row" {...stylex.attrs(viewerStyles.gridLabel, viewerStyles.rowLabel)}>
                  {r.label}
                </th>
              </Show>
              <For each={cols}>
                {(c) => (
                  <td
                    data-testid="story-cell"
                    data-pseudo={(c.pseudo ?? r.pseudo) === "rest" ? undefined : (c.pseudo ?? r.pseudo)}
                    {...stylex.attrs(viewStyles.storyCell)}
                  >
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
    <div role="radiogroup" aria-label={props.label} data-testid={props.testid} {...stylex.attrs(viewStyles.pickDiv)}>
      <For each={props.options}>
        {(o) => (
          <button
            type="button"
            role="radio"
            aria-checked={props.value === o ? "true" : "false"}
            aria-label={props.looks[o].label}
            title={props.looks[o].label}
            data-value={o}
            onClick={() => props.onChange(o)}
            {...stylex.attrs(viewerStyles.choice)}
          >
            <Show when={props.looks[o].text} fallback={<Glyph icon={props.looks[o].icon} size={16} />}>
              {(text) => <span {...stylex.attrs(viewStyles.pickSpan)}>{text()}</span>}
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
      {...stylex.attrs(viewStyles.storyCopyLink)}
    >
      <Glyph icon={copied() ? Check : Link} size={16} />
    </button>
  );
}

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
      {...stylex.attrs(viewStyles.storyArg)}
    >
      {(() => {
        const c = control();
        switch (c.kind) {
          case "boolean":
            return (
              <label {...stylex.attrs(viewStyles.argControlLabel)}>
                <input type="checkbox" checked={props.value === true} onChange={(e) => props.onChange(e.currentTarget.checked)} />
                <span {...stylex.attrs(viewStyles.pickSpan)}>{props.name}</span>
              </label>
            );
          case "number":
            return (
              <>
                <label for={id} {...stylex.attrs(viewStyles.pickSpan)}>
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
                  {...stylex.attrs(viewerStyles.field)}
                />
              </>
            );
          case "choice":
            return (
              <>
                <label for={id} {...stylex.attrs(viewStyles.pickSpan)}>
                  {props.name}
                </label>
                <select id={id} value={String(props.value)} onChange={(e) => props.onChange(e.currentTarget.value)} {...stylex.attrs(viewerStyles.field)}>
                  <For each={c.options}>{(o) => <option value={o}>{o}</option>}</For>
                </select>
              </>
            );
          case "text":
            return (
              <>
                <label for={id} {...stylex.attrs(viewStyles.pickSpan)}>
                  {props.name}
                </label>
                {c.long === true ? (
                  <textarea
                    id={id}
                    rows={6}
                    value={String(props.value)}
                    onInput={(e) => props.onChange(e.currentTarget.value)}
                    {...stylex.attrs(viewerStyles.field, viewerStyles.longField)}
                  />
                ) : (
                  <input
                    id={id}
                    type="text"
                    value={String(props.value)}
                    onInput={(e) => props.onChange(e.currentTarget.value)}
                    {...stylex.attrs(viewerStyles.field)}
                  />
                )}
              </>
            );
        }
      })()}
    </fieldset>
  );
}
