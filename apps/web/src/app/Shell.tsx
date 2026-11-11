import type { JSX } from "@solidjs/web";
import * as stylex from "@stylexjs/stylex";
import { For, onSettled, Show } from "solid-js";

import { t } from "@vibevalley/i18n";

import { pressed } from "#/base/shortcuts.ts";
import { QuickSwitcher, switcher } from "#/features/channel/index.ts";
import { waitingOnUser } from "#/features/inbox/index.ts";
import { NotesSearch } from "#/features/pkm/index.ts";
import { useCore, useFrames } from "#/infra/frame.ts";
import { Link as A, NavLink, useMatches } from "#/infra/router.ts";
import { useUpdates } from "#/infra/settings.ts";
import { OrchestratorFace } from "#/ui/domain/Face.tsx";
import { Icon } from "#/ui/Icon.tsx";
import type { IconName } from "#/ui/icons.ts";
import { titleBar } from "#/ui/layout.tsx";
import { styleProps } from "#/ui/positioner.ts";
import { ShortcutSheet } from "#/ui/ShortcutSheet.tsx";
import { Hint } from "#/ui/Tip.tsx";

import { type Place, places, settingsPlace } from "./places";

/** The head's height, the rail's top slot's too. */
const head = 66;

const styles = stylex.create({
  slot: {
    position: "relative",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    gap: "0.125rem",
    borderRadius: "var(--radius-lg)",
    color: {
      default: "var(--color-on-rail)",
      "@supports (color:color-mix(in lab, red, red))": "color-mix(in oklab, var(--color-on-rail) 65%, transparent)",
      "@media (hover:hover)": { default: null, ":hover": "var(--color-on-rail)" },
      ":is([aria-current=page])": "var(--color-on-rail)",
    },
    backgroundColor: {
      default: null,
      "@media (hover:hover)": {
        default: null,
        ":hover": "var(--color-on-rail)",
        "@supports (color:color-mix(in lab, red, red))": { default: null, ":hover": "color-mix(in oklab, var(--color-on-rail) 6%, transparent)" },
      },
    },
    outlineStyle: { default: null, ":focus-visible": "solid" },
    outlineWidth: { default: null, ":focus-visible": 2 },
    outlineColor: { default: null, ":focus-visible": "var(--color-focus)" },
  },
  faceSlot: {
    width: { default: "2.75rem", "@media (width>=40rem)": "3rem" },
    height: { default: "2.75rem", "@media (width>=40rem)": "3rem" },
  },
  namedSlot: {
    width: { default: "3rem", "@media (width>=40rem)": "3.5rem" },
    // Tall slots only where the rail has the height for all of them: the desktop window opens 768px tall, and the
    // last place (the farm) must not scroll out of it.
    height: { default: "3rem", "@media (width>=40rem) and (height>=52rem)": "3.5rem" },
  },
  currentSlot: {
    backgroundColor: "color-mix(in srgb, var(--color-on-rail) 9%, transparent)",
  },
  linkDot: {
    display: "block",
    height: "0.5rem",
    width: "0.5rem",
    borderRadius: "9999px",
  },
  linkConnecting: {
    backgroundColor: "var(--wb-faint)",
  },
  linkLost: {
    backgroundColor: "var(--wb-berry)",
  },
  linkOpen: {
    backgroundColor: "var(--wb-leaf)",
  },
  deskStatus: {
    display: "flex",
    height: "1.75rem",
    alignItems: "center",
    gap: "0.375rem",
    borderRadius: "var(--radius-md)",
    borderStyle: "solid",
    borderWidth: "1px",
    borderColor: "var(--color-line)",
    backgroundColor: {
      default: "var(--color-page)",
      "@media (hover:hover)": {
        default: null,
        ":hover": "var(--color-hover)",
      },
    },
    paddingInline: "0.625rem",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--leading-xs)",
  },
  deskDot: {
    height: "0.5rem",
    width: "0.5rem",
    borderRadius: "9999px",
  },
  deskDotLive: {
    backgroundColor: "var(--color-leaf)",
  },
  deskDotOff: {
    backgroundColor: "var(--color-faint)",
  },
  shell: {
    display: "flex",
    height: "100%",
  },
  shellZoomed: {
    zoom: "var(--workbench-zoom,1)",
  },
  shellMain: {
    display: "flex",
    minWidth: "0",
    flex: "1",
    flexDirection: "column",
  },
  slotLabel: {
    display: {
      default: "none",
      "@media (width>=40rem)": "block",
    },
    width: "100%",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    overflow: "hidden",
    textAlign: "center",
    fontSize: "var(--text-xs)",
    lineHeight: "1rem",
  },
  railBadge: {
    position: "absolute",
    top: "0.125rem",
    right: "0.25rem",
    minWidth: "1rem",
    borderRadius: "9999px",
    backgroundColor: "var(--color-wheat)",
    paddingInline: "0.25rem",
    textAlign: "center",
    fontSize: "var(--text-2xs)",
    lineHeight: "1rem",
    fontWeight: "var(--font-weight-semibold)",
    color: "var(--color-ink)",
  },
  rail: {
    display: "flex",
    width: {
      default: "3.5rem",
      "@media (width>=40rem)": "4.5rem",
    },
    flexShrink: "0",
    flexDirection: "column",
    alignItems: "center",
    overflowY: "auto",
    borderRightStyle: "solid",
    borderRightWidth: "1px",
    borderColor: "var(--color-line)",
    backgroundColor: "var(--color-rail)",
    paddingBottom: "0.75rem",
  },
  railMinWidth: (minWidth: number) => ({
    minWidth,
  }),
  railTopInset: (height: number) => ({
    height,
    flexShrink: "0",
  }),
  railHead: {
    display: "flex",
    height: head,
    flexShrink: "0",
    alignItems: "center",
    justifyContent: "center",
  },
  railGroups: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: "0.25rem",
  },
  railDivider: {
    marginBlock: "0.25rem",
    height: "1px",
    width: "2rem",
    backgroundColor: {
      default: "var(--color-on-rail)",
      "@supports (color:color-mix(in lab, red, red))": "color-mix(in oklab, var(--color-on-rail) 10%, transparent)",
    },
  },
  railFooter: {
    marginTop: "auto",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: "0.25rem",
    paddingTop: "0.5rem",
  },
  linkStatus: {
    display: "flex",
    height: "1rem",
    alignItems: "center",
  },
  srOnly: {
    clipPath: "inset(50%)",
    whiteSpace: "nowrap",
    borderWidth: "0",
    width: "1px",
    height: "1px",
    margin: "-1px",
    padding: "0",
    position: "absolute",
    overflow: "hidden",
  },
  desk: {
    display: "flex",
    height: head,
    flexShrink: "0",
    alignItems: "center",
    gap: "0.75rem",
    borderBottomStyle: "solid",
    borderBottomWidth: "1px",
    borderColor: "var(--color-line)",
    paddingInline: "1.25rem",
  },
  deskSpacer: {
    flex: "1",
  },
  deskTitleWrap: {
    display: "flex",
    minWidth: "0",
    flex: "1",
    alignItems: "center",
    gap: "0.375rem",
  },
  deskTitle: {
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    overflow: "hidden",
    fontSize: "var(--text-lg)",
    lineHeight: "var(--leading-lg)",
    fontWeight: "var(--font-weight-semibold)",
  },
  shellBody: {
    position: "relative",
    minHeight: "0",
    flex: "1",
  },
});

const linkWords = { connecting: t("web.base.link.connecting"), open: t("web.base.link.open"), lost: t("web.base.link.lost") } as const;

function PlaceIcon(props: { place: Place }) {
  return <Icon name={props.place.icon} size={20} />;
}

/** name: none for the farm's face at the top, which is a picture of its own; a place's name sits under its icon so the rail reads without hovering. */
function Slot(props: { to: string; place: string; label: string; name?: string; current?: boolean; badge?: number; children: JSX.Element }) {
  return (
    <NavLink
      href={props.to}
      data-place={props.place}
      title={props.label}
      aria-label={props.label}
      aria-current={props.current === true ? "page" : undefined}
      data-badge={props.badge !== undefined && props.badge > 0 ? props.badge : undefined}
      {...stylex.attrs(styles.slot, props.name === undefined ? styles.faceSlot : styles.namedSlot, props.current === true && styles.currentSlot)}
    >
      {props.children}
      <Show when={props.name}>{(name) => <span {...stylex.attrs(styles.slotLabel)}>{name()}</span>}</Show>
      {/* How many wait on the user there: the place to go next, seen from anywhere. */}
      <Show when={props.badge}>
        {(n) => (
          <span data-testid="rail-badge" {...stylex.attrs(styles.railBadge)}>
            {n()}
          </span>
        )}
      </Show>
    </NavLink>
  );
}

/** One size up from a page's head (docs/style/design.md). */
function RailIcon(props: { name: IconName }) {
  return <Icon name={props.name} size={24} />;
}

const railGroups = ["work", "setup", "reference"] as const;

function Rail(props: { here?: Place | undefined; farm: boolean }) {
  const frames = useFrames();
  const waiting = () => waitingOnUser(frames.frame?.inbox ?? []);
  const settings = settingsPlace;
  const updates = useUpdates();
  const ready = () => {
    const s = updates();
    return s?._tag === "ready" ? s : undefined;
  };
  return (
    <nav
      aria-label={t("web.base.rail")}
      data-testid="rail"
      // The window's buttons sit over the rail's top: it is at least as wide as they reach, and a little.
      {...styleProps([styles.rail, titleBar.left > 0 && styles.railMinWidth(titleBar.left + 8)])}
    >
      {/* Room for the desktop window's buttons over the rail's top. */}
      <div {...styleProps(styles.railTopInset(titleBar.top))} />
      <div {...stylex.attrs(styles.railHead)}>
        <Slot to="/farm" place="farm" label={t("web.base.farm")} current={props.farm}>
          <OrchestratorFace size={38} />
        </Slot>
      </div>
      <div {...stylex.attrs(styles.railGroups)}>
        <For each={railGroups}>
          {(group, i) => (
            <>
              <Show when={i() > 0}>
                <span aria-hidden="true" {...stylex.attrs(styles.railDivider)} />
              </Show>
              <For each={places.filter((p) => p.group === group && p.id !== "settings")}>
                {(p) => (
                  <Slot
                    to={p.path}
                    place={p.id}
                    label={`${p.label} · ${p.hint}`}
                    name={p.label}
                    current={p === props.here}
                    badge={p.id === "issues" ? waiting() : 0}
                  >
                    <RailIcon name={p.icon} />
                  </Slot>
                )}
              </For>
            </>
          )}
        </For>
      </div>
      <div {...stylex.attrs(styles.railFooter)}>
        <Show when={ready()}>
          {(r) => (
            <Slot to="/settings/about" place="update" label={t("web.base.updateReady", { next: r().next })} name={t("web.base.update")}>
              <RailIcon name="update" />
            </Slot>
          )}
        </Show>
        <Slot to={settings.path} place={settings.id} label={`${settings.label} · ${settings.hint}`} name={settings.label} current={props.here === settings}>
          <RailIcon name={settings.icon} />
        </Slot>
        <Slot to="/farm" place="farm" label={t("web.base.farm")} name={t("web.base.farmShort")} current={props.farm}>
          <RailIcon name="farm" />
        </Slot>
        <span role="status" data-testid="link" data-state={frames.link} title={linkWords[frames.link]} {...stylex.attrs(styles.linkStatus)}>
          <span
            {...stylex.attrs(styles.linkDot, frames.link === "open" ? styles.linkOpen : frames.link === "lost" ? styles.linkLost : styles.linkConnecting)}
            aria-hidden="true"
          />
          <span {...stylex.attrs(styles.srOnly)}>{linkWords[frames.link]}</span>
        </span>
      </div>
    </nav>
  );
}

/** The head over a page: its place, and the farm's state, which goes back to the farm. */
function Desk(props: { place?: Place | undefined }) {
  const core = useCore();
  const live = () => core()?.call === "live";
  const working = () => core()?.sessions.filter((s) => s.phase._tag === "working").length ?? 0;
  const status = () => (live() ? t("web.base.working", { n: working() }) : t("web.base.off"));
  return (
    <div data-testid="desk" data-place={props.place?.id} {...stylex.attrs(styles.desk)}>
      <Show when={props.place} fallback={<span {...stylex.attrs(styles.deskSpacer)} />}>
        {(place) => (
          <>
            <PlaceIcon place={place()} />
            {/* What the place is goes beside its name, on hover: a sentence under every head was read once and then only took room. */}
            <div {...stylex.attrs(styles.deskTitleWrap)}>
              <h1 {...stylex.attrs(styles.deskTitle)}>{place().label}</h1>
              <Hint text={place().hint} />
            </div>
          </>
        )}
      </Show>
      <A href="/farm" aria-label={status()} data-testid="desk-status" data-state={live() ? "live" : "off"} {...stylex.attrs(styles.deskStatus)}>
        <span {...stylex.attrs(styles.deskDot, live() ? styles.deskDotLive : styles.deskDotOff)} aria-hidden="true" />
        {status()}
      </A>
    </div>
  );
}

export function Shell(props: { children: JSX.Element }) {
  const matches = useMatches();
  const meta = () => matches().at(-1)?.meta;
  const here = () => places.find((place) => place.id === meta()?.place);
  // A function declaration: StyleX evaluates an arrow used in `stylex.attrs` at build time and fails on its body.
  function inFarm() {
    return meta()?.skin === "farm";
  }
  // Ctrl+K (⌘K on a Mac) anywhere in the workbench (base/shortcuts.ts).
  onSettled(() => {
    const key = (e: KeyboardEvent) => {
      if (!pressed(e, "switcher")) return;
      e.preventDefault();
      switcher.toggle();
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  });
  return (
    // The farm keeps integer art pixels; only workbench pages follow the interface zoom.
    <div {...stylex.attrs(styles.shell, !inFarm() && styles.shellZoomed)}>
      <QuickSwitcher />
      <NotesSearch />
      <ShortcutSheet />
      <Rail here={here()} farm={inFarm()} />
      <main {...stylex.attrs(styles.shellMain)}>
        {/* The chat and the library draw their own one bar at the top: the place's name would be a second. */}
        <Show when={!inFarm() && here()?.id !== "chat" && here()?.id !== "library"}>
          <Desk place={here()} />
        </Show>
        <div {...stylex.attrs(styles.shellBody)}>{props.children}</div>
      </main>
    </div>
  );
}
