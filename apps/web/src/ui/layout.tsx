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

const viewStyles = stylex.create({
  toggleLabel: {
    display: "flex",
    alignItems: "flex-start",
    gap: "calc(var(--spacing) * 2)",
  },
  toggleDisabled: {
    opacity: ".5",
  },
  toggleEnabled: {
    cursor: "pointer",
  },
  switchRoot: {
    marginTop: "calc(var(--spacing) * 0.5)",
    display: "flex",
    height: "calc(var(--spacing) * 4)",
    width: "calc(var(--spacing) * 7)",
    flexShrink: 0,
    alignItems: "center",
    borderRadius: "2147483647px",
    padding: "calc(var(--spacing) * 0.5)",
    backgroundColor: { default: "var(--color-selected)", ":is([data-checked])": "var(--color-accent)" },
    transitionProperty: "color, background-color, border-color, outline-color, text-decoration-color, fill, stroke",
    transitionDuration: "var(--default-transition-duration)",
    transitionTimingFunction: "var(--default-transition-timing-function)",
  },
  switchThumb: {
    display: "block",
    width: "calc(var(--spacing) * 3)",
    height: "calc(var(--spacing) * 3)",
    borderRadius: "2147483647px",
    backgroundColor: "var(--color-page)",
    boxShadow: "var(--shadow-toggle-thumb)",
    transitionProperty: "transform, translate, scale, rotate",
    transitionDuration: "var(--default-transition-duration)",
    transitionTimingFunction: "var(--default-transition-timing-function)",
    translate: { default: null, ":is([data-checked])": "calc(var(--spacing) * 3) 0" },
  },
  textLink: {
    cursor: "pointer",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--text-xs--line-height)",
    textDecorationLine: "underline",
    textDecorationColor: { default: "currentcolor", "@supports (color:color-mix(in lab, red, red))": "color-mix(in oklab, currentcolor 50%, transparent)" },
  },
  quietLink: { color: { default: "var(--color-muted)", "@media (hover: hover)": { default: null, ":hover": "var(--color-ink)" } } },
  dangerLink: { color: { default: "var(--color-berry)", "@media (hover: hover)": { default: null, ":hover": "var(--color-ink)" } } },
  windowStrip: { pointerEvents: "none", position: "fixed", insetInline: 0, top: 0 },
  secretInput: { paddingRight: "calc(var(--spacing) * 9)", fontFamily: "var(--font-mono)" },
  split: {
    display: "flex",
    height: "100%",
    minHeight: 0,
    flexDirection: { default: "column", "@media (width >= 48rem)": "row" },
    overflowX: { default: null, "@media (width >= 48rem)": "hidden" },
    overflowY: { default: "auto", "@media (width >= 48rem)": "hidden" },
  },
  splitGap: { gap: "calc(var(--spacing) * 3)" },
  splitList: {
    flexShrink: 0,
    width: { default: null, "@media (width >= 48rem)": "calc(var(--spacing) * 70)" },
    overflowY: { default: null, "@media (width >= 48rem)": "auto" },
  },
  splitEdge: {
    borderBottomWidth: { default: 1, "@media (width >= 48rem)": 0 },
    borderBottomStyle: "solid",
    borderRightWidth: { default: null, "@media (width >= 48rem)": 1 },
    borderRightStyle: "solid",
    borderColor: "var(--color-line)",
    backgroundColor: "var(--color-side)",
    paddingInline: "calc(var(--spacing) * 2)",
    paddingBlock: "calc(var(--spacing) * 3)",
  },
  splitBody: { minWidth: 0, flex: "1", overflowY: { default: null, "@media (width >= 48rem)": "auto" } },
  splitBodyEdge: { padding: "calc(var(--spacing) * 3)" },
  column: { display: "flex", flexDirection: "column" },
  listHeader: { display: "flex", flexShrink: 0, alignItems: "center", gap: "calc(var(--spacing) * 2)" },
  listHeaderBare: { height: "calc(var(--spacing) * 8)", paddingInline: "calc(var(--spacing) * 2)" },
  listHeaderBox: {
    height: "calc(var(--spacing) * 10)",
    borderBottomWidth: 1,
    borderBottomStyle: "solid",
    borderColor: "var(--color-line)",
    paddingInline: "calc(var(--spacing) * 3)",
  },
  listTitle: { flex: "1", textOverflow: "ellipsis", whiteSpace: "nowrap", overflow: "hidden" },
  listTitleBare: {
    fontSize: "var(--text-xs)",
    lineHeight: "var(--text-xs--line-height)",
    fontWeight: "var(--font-weight-medium)",
    color: "var(--color-faint)",
  },
  listTitleBox: { fontSize: "var(--text-sm)", lineHeight: "var(--text-sm--line-height)", fontWeight: "var(--font-weight-semibold)" },
  listBare: { gap: "1px" },
  listBox: { padding: "var(--spacing)" },
  listRow: {
    display: "flex",
    alignItems: "center",
    gap: "calc(var(--spacing) * 2.5)",
    borderRadius: "var(--radius-md)",
    paddingInline: "calc(var(--spacing) * 2.5)",
    paddingBlock: "calc(var(--spacing) * 2)",
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
  listRowSpan: {
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    overflow: "hidden",
    fontSize: "var(--text-sm)",
    lineHeight: "var(--text-sm--line-height)",
    fontWeight: "var(--font-weight-medium)",
  },
  listRowSpan2: {
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    overflow: "hidden",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--text-xs--line-height)",
    color: "var(--color-muted)",
  },
  cardHeader: {
    display: "flex",
    minHeight: "calc(var(--spacing) * 12)",
    alignItems: "center",
    gap: "calc(var(--spacing) * 2)",
    borderBottomStyle: "solid",
    borderBottomWidth: "1px",
    borderColor: "var(--color-line)",
    paddingInline: "calc(var(--spacing) * 4)",
    paddingBlock: "calc(var(--spacing) * 2)",
  },
  cardH2: {
    minWidth: "0",
    flex: "1",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    overflow: "hidden",
    fontSize: "var(--text-base)",
    lineHeight: "var(--text-base--line-height)",
    fontWeight: "var(--font-weight-semibold)",
  },
  cardDiv: {
    display: "flex",
    flexDirection: "column",
    gap: "calc(var(--spacing) * 4)",
    padding: "calc(var(--spacing) * 4)",
  },
  quietP: {
    fontSize: "var(--text-sm)",
    lineHeight: "var(--text-sm--line-height)",
    color: "var(--color-muted)",
  },
  emptyDiv: {
    display: "flex",
    height: "100%",
    minHeight: "calc(var(--spacing) * 48)",
    alignItems: "center",
    justifyContent: "center",
    padding: "calc(var(--spacing) * 6)",
  },
  emptyDiv2: {
    display: "flex",
    maxWidth: "calc(var(--spacing) * 96)",
    flexDirection: "column",
    alignItems: "center",
    gap: "calc(var(--spacing) * 3)",
    textAlign: "center",
    fontSize: "var(--text-sm)",
    lineHeight: "var(--text-sm--line-height)",
    color: "var(--color-muted)",
  },
  emptyIcon: {
    color: "var(--color-faint)",
  },
  toggleSpan: {
    display: "flex",
    flexDirection: "column",
  },
  toggleSpan2: {
    display: "flex",
    alignItems: "center",
    gap: "var(--spacing)",
    fontSize: "var(--text-sm)",
    lineHeight: "var(--text-sm--line-height)",
  },
  toggleSpan3: {
    fontSize: "var(--text-xs)",
    lineHeight: "var(--text-xs--line-height)",
    color: "var(--color-muted)",
  },
  secretInputSpan: {
    position: "relative",
    display: "flex",
  },
  reveal: {
    position: "absolute",
    insetBlock: "0",
    right: "var(--spacing)",
    marginBlock: "auto",
    display: "inline-flex",
    width: "calc(var(--spacing) * 7)",
    height: "calc(var(--spacing) * 7)",
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
    <div {...stylex.attrs(viewStyles.split, props.edge !== true && viewStyles.splitGap)}>
      <div {...stylex.attrs(viewStyles.splitList, props.edge === true && viewStyles.splitEdge)}>{props.list}</div>
      <div {...stylex.attrs(viewStyles.splitBody, props.edge === true && viewStyles.splitBodyEdge)}>{props.children}</div>
    </div>
  );
}

/** bare: in a side column (Split edge), no box of its own. */
export function ListCard(props: { title: string; label?: string; action?: JSX.Element; children: JSX.Element; testid?: string; bare?: boolean }) {
  const bare = () => props.bare === true;
  return (
    <section aria-label={props.label ?? props.title} data-testid={props.testid} {...stylex.attrs(bare() ? viewStyles.column : viewStyles.card)}>
      <header {...stylex.attrs(viewStyles.listHeader, bare() ? viewStyles.listHeaderBare : viewStyles.listHeaderBox)}>
        <h2 {...stylex.attrs(viewStyles.listTitle, bare() ? viewStyles.listTitleBare : viewStyles.listTitleBox)}>{props.title}</h2>
        {props.action}
      </header>
      <ul {...stylex.attrs(viewStyles.column, bare() ? viewStyles.listBare : viewStyles.listBox)}>{props.children}</ul>
    </section>
  );
}

/** A row: a link to its detail, marked when it is the open one. */
export function ListRow(props: { to: string; item?: string; active?: boolean; title: string; line?: string; leading?: JSX.Element; trailing?: JSX.Element }) {
  return (
    <li>
      <A
        href={props.to}
        data-testid="list-row"
        data-key={props.item}
        aria-current={props.active === true ? "page" : undefined}
        {...stylex.attrs(viewStyles.listRow)}
      >
        {props.leading}
        <span {...stylex.attrs(viewStyles.rowText)}>
          <span {...stylex.attrs(viewStyles.listRowSpan)}>{props.title}</span>
          <Show when={props.line}>
            <span {...stylex.attrs(viewStyles.listRowSpan2)}>{props.line}</span>
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
    <section data-testid={props.testid} data-key={props.item} {...styleProps([viewStyles.card, props.styles])}>
      <Show when={props.title !== undefined}>
        <header {...stylex.attrs(viewStyles.cardHeader)}>
          <h2 {...stylex.attrs(viewStyles.cardH2)}>{props.title}</h2>
          {props.action}
        </header>
      </Show>
      <div {...stylex.attrs(viewStyles.cardDiv)}>{props.children}</div>
    </section>
  );
}

/** Nothing to show yet, in words. */
export function Quiet(props: { children: JSX.Element }) {
  return <p {...stylex.attrs(viewStyles.quietP)}>{props.children}</p>;
}

/** A place with nothing in it yet (docs/style/design.md): its icon, why it is empty, and the next step if there is one. */
export function Empty(props: { icon: IconName; children: JSX.Element; action?: JSX.Element; testid?: string }) {
  return (
    <div data-testid={props.testid ?? "empty"} {...stylex.attrs(viewStyles.emptyDiv)}>
      <div {...stylex.attrs(viewStyles.emptyDiv2)}>
        <Icon name={props.icon} size={48} styles={viewStyles.emptyIcon} />
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
    <label {...stylex.attrs(viewStyles.toggleLabel, props.disabled === true ? viewStyles.toggleDisabled : viewStyles.toggleEnabled)}>
      <Switch.Root
        data-testid={props.testid}
        checked={props.checked}
        onCheckedChange={props.onChange}
        aria-label={props.ariaLabel ?? props.label}
        disabled={props.disabled}
        {...stylex.attrs(viewStyles.switchRoot)}
      >
        <Switch.Thumb {...stylex.attrs(viewStyles.switchThumb)} />
      </Switch.Root>
      <span {...stylex.attrs(viewStyles.toggleSpan)}>
        <span {...stylex.attrs(viewStyles.toggleSpan2)}>
          {props.label}
          <Show when={props.tip}>{(t) => <Hint text={t()} />}</Show>
        </span>
        <Show when={props.hint}>
          <span {...stylex.attrs(viewStyles.toggleSpan3)}>{props.hint}</span>
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
    <span {...stylex.attrs(viewStyles.secretInputSpan)}>
      <TextInput {...rest} type={shown() ? "text" : "password"} autocomplete="off" spellcheck="false" styles={[viewStyles.secretInput, props.styles]} />
      <button
        type="button"
        data-testid="reveal"
        aria-pressed={aria(shown())}
        {...stylex.attrs(viewStyles.reveal)}
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
  const look = () => stylex.attrs(viewStyles.textLink, props.danger === true ? viewStyles.dangerLink : viewStyles.quietLink);
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
      <div aria-hidden="true" class={["window-drag", stylex.attrs(viewStyles.windowStrip).class]} style={{ height: `${titleBar.top}px` }} />
    </Show>
  );
}
