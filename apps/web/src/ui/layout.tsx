import type { JSX } from "@solidjs/web";
import * as stylex from "@stylexjs/stylex";
import { createSignal, omit, Show } from "solid-js";

import { Switch } from "@vibevalley/base-ui";
import { t } from "@vibevalley/i18n";

import { aria } from "#/base/dom.tsx";
import { currentHost } from "#/infra/host.ts";
import { Link as A } from "#/infra/router.ts";

import { TextInput, type TextInputProps } from "./Field";
import { Icon } from "./Icon";
import type { IconName } from "./icons";
import { styleProps } from "./positioner";
import { Hint } from "./Tip";

const styles = stylex.create({
  toggleLabel: {
    display: "flex",
    alignItems: "flex-start",
    gap: "0.5rem",
  },
  toggleDisabled: {
    opacity: ".5",
  },
  toggleEnabled: {
    cursor: "pointer",
  },
  switchRoot: {
    marginTop: "0.125rem",
    display: "flex",
    height: "1rem",
    width: "1.75rem",
    flexShrink: 0,
    alignItems: "center",
    borderRadius: "9999px",
    padding: "0.125rem",
    backgroundColor: { default: "var(--color-selected)", ":is([data-checked])": "var(--color-accent)" },
    transitionProperty: "color, background-color, border-color",
    transitionDuration: "180ms",
    transitionTimingFunction: "var(--ease-out)",
  },
  switchThumb: {
    display: "block",
    width: "0.75rem",
    height: "0.75rem",
    borderRadius: "9999px",
    backgroundColor: "var(--color-page)",
    boxShadow: "var(--shadow-toggle-thumb)",
    transitionProperty: "translate",
    transitionDuration: "180ms",
    transitionTimingFunction: "var(--ease-out)",
    translate: { default: null, ":is([data-checked])": "0.75rem 0" },
  },
  textLink: {
    cursor: "pointer",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--leading-xs)",
    textDecorationLine: "underline",
    textDecorationColor: { default: "currentcolor", "@supports (color:color-mix(in lab, red, red))": "color-mix(in oklab, currentcolor 50%, transparent)" },
  },
  quietLink: { color: { default: "var(--color-muted)", "@media (hover: hover)": { default: null, ":hover": "var(--color-ink)" } } },
  dangerLink: { color: { default: "var(--color-berry)", "@media (hover: hover)": { default: null, ":hover": "var(--color-ink)" } } },
  windowStrip: (height: number) => ({ pointerEvents: "none", position: "fixed", insetInline: 0, top: 0, height }),
  secretInput: { paddingRight: "2.25rem", fontFamily: "var(--font-mono)" },
  split: {
    display: "flex",
    height: "100%",
    minHeight: 0,
    flexDirection: { default: "column", "@media (width >= 48rem)": "row" },
    overflowX: { default: null, "@media (width >= 48rem)": "hidden" },
    overflowY: { default: "auto", "@media (width >= 48rem)": "hidden" },
  },
  splitGap: { gap: "0.75rem" },
  splitList: {
    flexShrink: 0,
    width: { default: null, "@media (width >= 48rem)": "17.5rem" },
    overflowY: { default: null, "@media (width >= 48rem)": "auto" },
  },
  splitEdge: {
    borderBottomWidth: { default: 1, "@media (width >= 48rem)": 0 },
    borderBottomStyle: "solid",
    borderRightWidth: { default: null, "@media (width >= 48rem)": 1 },
    borderRightStyle: "solid",
    borderColor: "var(--color-line)",
    backgroundColor: "var(--color-side)",
    paddingInline: "0.5rem",
    paddingBlock: "0.75rem",
  },
  splitBody: { minWidth: 0, flex: "1", overflowY: { default: null, "@media (width >= 48rem)": "auto" } },
  splitBodyEdge: { padding: "0.75rem" },
  column: { display: "flex", flexDirection: "column" },
  listHeader: { display: "flex", flexShrink: 0, alignItems: "center", gap: "0.5rem" },
  listHeaderBare: { height: "2rem", paddingInline: "0.5rem" },
  listHeaderBox: {
    height: "2.5rem",
    borderBottomWidth: 1,
    borderBottomStyle: "solid",
    borderColor: "var(--color-line)",
    paddingInline: "0.75rem",
  },
  listTitle: { flex: "1", textOverflow: "ellipsis", whiteSpace: "nowrap", overflow: "hidden" },
  listTitleBare: {
    fontSize: "var(--text-xs)",
    lineHeight: "var(--leading-xs)",
    fontWeight: "var(--font-weight-medium)",
    color: "var(--color-faint)",
  },
  listTitleBox: { fontSize: "var(--text-sm)", lineHeight: "var(--leading-sm)", fontWeight: "var(--font-weight-semibold)" },
  listBare: { gap: "1px" },
  listBox: { padding: "0.25rem" },
  listRow: {
    display: "flex",
    alignItems: "center",
    gap: "0.625rem",
    borderRadius: "var(--radius-md)",
    paddingInline: "0.625rem",
    paddingBlock: "0.5rem",
    backgroundColor: {
      default: null,
      ':where([aria-current="page"])': "var(--color-selected)",
      "@media (hover: hover)": { default: null, ":hover": "var(--color-hover)" },
    },
    outlineWidth: { default: null, ":focus-visible": 2 },
    outlineStyle: { default: null, ":focus-visible": "solid" },
    outlineColor: { default: null, ":focus-visible": "var(--color-focus)" },
  },
  rowText: { display: "flex", minWidth: 0, flex: "1", flexDirection: "column" },
  card: {
    display: "flex",
    flexDirection: "column",
    borderRadius: "var(--radius-lg)",
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: "var(--color-line)",
    backgroundColor: "var(--color-page)",
  },
  rowTitle: {
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    overflow: "hidden",
    fontSize: "var(--text-sm)",
    lineHeight: "var(--leading-sm)",
    fontWeight: "var(--font-weight-medium)",
  },
  rowLine: {
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    overflow: "hidden",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--leading-xs)",
    color: "var(--color-muted)",
  },
  cardHeader: {
    display: "flex",
    minHeight: "3rem",
    alignItems: "center",
    gap: "0.5rem",
    borderBottomStyle: "solid",
    borderBottomWidth: "1px",
    borderColor: "var(--color-line)",
    paddingInline: "1rem",
    paddingBlock: "0.5rem",
  },
  cardTitle: {
    minWidth: "0",
    flex: "1",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    overflow: "hidden",
    fontSize: "var(--text-base)",
    lineHeight: "var(--leading-base)",
    fontWeight: "var(--font-weight-semibold)",
  },
  cardBody: {
    display: "flex",
    flexDirection: "column",
    gap: "1rem",
    padding: "1rem",
  },
  quiet: {
    fontSize: "var(--text-sm)",
    lineHeight: "var(--leading-sm)",
    color: "var(--color-muted)",
  },
  empty: {
    display: "flex",
    height: "100%",
    minHeight: "12rem",
    alignItems: "center",
    justifyContent: "center",
    padding: "1.5rem",
  },
  emptyBody: {
    display: "flex",
    maxWidth: "24rem",
    flexDirection: "column",
    alignItems: "center",
    gap: "0.75rem",
    textAlign: "center",
    fontSize: "var(--text-sm)",
    lineHeight: "var(--leading-sm)",
    color: "var(--color-muted)",
  },
  emptyIcon: {
    color: "var(--color-faint)",
  },
  toggleBody: {
    display: "flex",
    flexDirection: "column",
  },
  toggleTitle: {
    display: "flex",
    alignItems: "center",
    gap: "0.25rem",
    fontSize: "var(--text-sm)",
    lineHeight: "var(--leading-sm)",
  },
  toggleHint: {
    fontSize: "var(--text-xs)",
    lineHeight: "var(--leading-xs)",
    color: "var(--color-muted)",
  },
  secretBox: {
    position: "relative",
    display: "flex",
  },
  reveal: {
    position: "absolute",
    insetBlock: "0",
    right: "0.25rem",
    marginBlock: "auto",
    display: "inline-flex",
    width: "1.75rem",
    height: "1.75rem",
    cursor: "pointer",
    alignItems: "center",
    justifyContent: "center",
    borderRadius: "var(--radius-sm)",
    color: {
      default: "var(--color-faint)",
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
});

/** edge: a page's own list as a side column against the rail (its ListCard bare), not a card in a page that already has one. */
export function Split(props: { list: JSX.Element; children: JSX.Element; edge?: boolean }) {
  return (
    <div {...stylex.attrs(styles.split, props.edge !== true && styles.splitGap)}>
      <div {...stylex.attrs(styles.splitList, props.edge === true && styles.splitEdge)}>{props.list}</div>
      <div {...stylex.attrs(styles.splitBody, props.edge === true && styles.splitBodyEdge)}>{props.children}</div>
    </div>
  );
}

/** bare: in a side column (Split edge), no box of its own. */
export function ListCard(props: { title: string; label?: string; action?: JSX.Element; children: JSX.Element; testid?: string; bare?: boolean }) {
  const bare = () => props.bare === true;
  return (
    <section aria-label={props.label ?? props.title} data-testid={props.testid} {...stylex.attrs(bare() ? styles.column : styles.card)}>
      <header {...stylex.attrs(styles.listHeader, bare() ? styles.listHeaderBare : styles.listHeaderBox)}>
        <h2 {...stylex.attrs(styles.listTitle, bare() ? styles.listTitleBare : styles.listTitleBox)}>{props.title}</h2>
        {props.action}
      </header>
      <ul {...stylex.attrs(styles.column, bare() ? styles.listBare : styles.listBox)}>{props.children}</ul>
    </section>
  );
}

/** A row: a link to its detail, marked when it is the open one. */
export function ListRow(props: { to: string; item?: string; active?: boolean; title: string; line?: string; leading?: JSX.Element; trailing?: JSX.Element }) {
  return (
    <li>
      <A href={props.to} data-testid="list-row" data-key={props.item} aria-current={props.active === true ? "page" : undefined} {...stylex.attrs(styles.listRow)}>
        {props.leading}
        <span {...stylex.attrs(styles.rowText)}>
          <span {...stylex.attrs(styles.rowTitle)}>{props.title}</span>
          <Show when={props.line}>
            <span {...stylex.attrs(styles.rowLine)}>{props.line}</span>
          </Show>
        </span>
        {props.trailing}
      </A>
    </li>
  );
}

/** The open thing's card: a title, what sits beside it, and its body. */
export function Card(props: {
  title?: JSX.Element;
  action?: JSX.Element;
  children: JSX.Element;
  styles?: stylex.StyleXStyles;
  testid?: string;
  item?: string;
}) {
  return (
    <section data-testid={props.testid} data-key={props.item} {...styleProps([styles.card, props.styles])}>
      <Show when={props.title !== undefined}>
        <header {...stylex.attrs(styles.cardHeader)}>
          <h2 {...stylex.attrs(styles.cardTitle)}>{props.title}</h2>
          {props.action}
        </header>
      </Show>
      <div {...stylex.attrs(styles.cardBody)}>{props.children}</div>
    </section>
  );
}

/** Nothing to show yet, in words. */
export function Quiet(props: { children: JSX.Element }) {
  return <p {...stylex.attrs(styles.quiet)}>{props.children}</p>;
}

/** A place with nothing in it yet (docs/style/design.md): its icon, why it is empty, and the next step if there is one. */
export function Empty(props: { icon: IconName; children: JSX.Element; action?: JSX.Element; testid?: string }) {
  return (
    <div data-testid={props.testid ?? "empty"} {...stylex.attrs(styles.empty)}>
      <div {...stylex.attrs(styles.emptyBody)}>
        <Icon name={props.icon} size={48} styles={styles.emptyIcon} />
        <p>{props.children}</p>
        {props.action}
      </div>
    </div>
  );
}

/** An on/off with its label, and what it means under it (hint) or behind an info icon (tip). */
export function Toggle(props: {
  label: string;
  /** What a screen reader says, where the label alone does not say which. */
  ariaLabel?: string;
  hint?: string | undefined;
  tip?: string;
  checked: boolean;
  onChange: (on: boolean) => void;
  disabled?: boolean;
  testid?: string;
}) {
  return (
    <label {...stylex.attrs(styles.toggleLabel, props.disabled === true ? styles.toggleDisabled : styles.toggleEnabled)}>
      <Switch.Root
        data-testid={props.testid}
        checked={props.checked}
        onCheckedChange={props.onChange}
        aria-label={props.ariaLabel ?? props.label}
        disabled={props.disabled}
        {...stylex.attrs(styles.switchRoot)}
      >
        <Switch.Thumb {...stylex.attrs(styles.switchThumb)} />
      </Switch.Root>
      <span {...stylex.attrs(styles.toggleBody)}>
        <span {...stylex.attrs(styles.toggleTitle)}>
          {props.label}
          <Show when={props.tip}>{(t) => <Hint text={t()} />}</Show>
        </span>
        <Show when={props.hint}>
          <span {...stylex.attrs(styles.toggleHint)}>{props.hint}</span>
        </Show>
      </span>
    </label>
  );
}

/** A key: hidden until the eye is pressed. */
export function SecretInput(props: TextInputProps) {
  const [shown, setShown] = createSignal(false);
  const rest = omit(props, "styles");
  return (
    <span {...stylex.attrs(styles.secretBox)}>
      <TextInput {...rest} type={shown() ? "text" : "password"} autocomplete="off" spellcheck="false" styles={[styles.secretInput, props.styles]} />
      <button
        type="button"
        data-testid="reveal"
        aria-pressed={aria(shown())}
        {...stylex.attrs(styles.reveal)}
        aria-label={shown() ? t("web.base.secret.hide") : t("web.base.secret.peek")}
        title={shown() ? t("web.base.secret.hide") : t("web.base.secret.peek")}
        onClick={() => setShown(!shown())}
      >
        <Icon name={shown() ? "hide" : "show"} size={16} />
      </button>
    </span>
  );
}

/** A quiet underlined word: a page to open in the browser, or onClick. */
export function TextLink(props: { children: JSX.Element; href?: string; onClick?: () => void; danger?: boolean }) {
  const look = () => stylex.attrs(styles.textLink, props.danger === true ? styles.dangerLink : styles.quietLink);
  return (
    <Show
      when={props.href}
      fallback={
        <button type="button" {...look()} onClick={() => props.onClick?.()}>
          {props.children}
        </button>
      }
    >
      <a href={props.href} target="_blank" rel="noreferrer" {...look()}>
        {props.children}
      </a>
    </Show>
  );
}

/** The strip's height, and where the window's buttons end along it. both 0 where the window has its own title bar. */
let bar: { top: number; left: number } | undefined;
const barOf = () => (bar ??= currentHost().titleBar ?? { top: 0, left: 0 });
export const titleBar = {
  get top(): number {
    return barOf().top;
  },
  get left(): number {
    return barOf().left;
  },
};

/** A strip along the page's top edge drags the desktop window, which has no title bar of its own (the host's titleBar). */
export function WindowStrip() {
  return (
    <Show when={titleBar.top > 0}>
      <div aria-hidden="true" data-window-drag="" {...styleProps(styles.windowStrip(titleBar.top))} />
    </Show>
  );
}
