import type { JSX } from "@solidjs/web";
import * as stylex from "@stylexjs/stylex";
import { For, onSettled, Show } from "solid-js";

import { t } from "@vibevalley/i18n";

import { pressed } from "#/base/shortcuts.ts";
import { QuickSwitcher, switcher } from "#/features/channel/index.ts";
import { waitingOnOwner } from "#/features/inbox/index.ts";
import { NotesSearch } from "#/features/pkm/index.ts";
import { useCore, useFrames } from "#/infra/frame.ts";
import { Link as A, NavLink, useMatches } from "#/infra/router.ts";
import { useUpdates } from "#/infra/settings.ts";
import { OrchestratorFace } from "#/ui/Face.tsx";
import { Icon } from "#/ui/Icon.tsx";
import type { IconName } from "#/ui/icons.ts";
import { titleBar } from "#/ui/layout.tsx";
import { ShortcutSheet } from "#/ui/ShortcutSheet.tsx";
import { Hint } from "#/ui/Tip.tsx";

import { type Place, places, settingsPlace } from "./places";

const variantStyles2 = stylex.create({
  deskA: {
    display: "flex",
    height: "calc(var(--spacing) * 7)",
    alignItems: "center",
    gap: "calc(var(--spacing) * 1.5)",
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
    paddingInline: "calc(var(--spacing) * 2.5)",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--text-xs--line-height)",
  },
});

const variantStyles = stylex.create({
  deskSpan: {
    height: "calc(var(--spacing) * 2)",
    width: "calc(var(--spacing) * 2)",
    borderRadius: "2147483647px",
  },
  deskSpanVariant: {
    backgroundColor: "var(--color-leaf)",
  },
  deskSpanVariant2: {
    backgroundColor: "var(--color-faint)",
  },
  shellDiv: {
    display: "flex",
    height: "100%",
  },
  shellDivVariant: {
    zoom: "var(--workbench-zoom,1)",
  },
  shellDivVariant2: {},
  shellMain: {
    display: "flex",
    minWidth: "0",
    flex: "1",
    flexDirection: "column",
  },
});

const viewStyles = stylex.create({
  slotSpan: {
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
    lineHeight: "calc(var(--spacing) * 4)",
  },
  railBadge: {
    position: "absolute",
    top: "calc(var(--spacing) * .5)",
    right: "var(--spacing)",
    minWidth: "calc(var(--spacing) * 4)",
    borderRadius: "2147483647px",
    backgroundColor: "var(--color-wheat)",
    paddingInline: "var(--spacing)",
    textAlign: "center",
    fontSize: "var(--text-2xs)",
    lineHeight: "calc(var(--spacing) * 4)",
    fontWeight: "var(--font-weight-semibold)",
    color: "var(--color-ink)",
  },
  rail: {
    display: "flex",
    width: {
      default: "calc(var(--spacing) * 14)",
      "@media (width>=40rem)": "calc(var(--spacing) * 18)",
    },
    flexShrink: "0",
    flexDirection: "column",
    alignItems: "center",
    overflowY: "auto",
    borderRightStyle: "solid",
    borderRightWidth: "1px",
    borderColor: "var(--color-line)",
    backgroundColor: "var(--color-rail)",
    paddingBottom: "calc(var(--spacing) * 3)",
  },
  railDiv: {
    flexShrink: "0",
  },
  railDiv2: {
    display: "flex",
    flexShrink: "0",
    alignItems: "center",
    justifyContent: "center",
  },
  railDiv3: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: "var(--spacing)",
  },
  railSpan: {
    marginBlock: "var(--spacing)",
    height: "1px",
    width: "calc(var(--spacing) * 8)",
    backgroundColor: {
      default: "var(--color-on-rail)",
      "@supports (color:color-mix(in lab, red, red))": "color-mix(in oklab, var(--color-on-rail) 10%, transparent)",
    },
  },
  railDiv4: {
    marginTop: "auto",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: "var(--spacing)",
    paddingTop: "calc(var(--spacing) * 2)",
  },
  link: {
    display: "flex",
    height: "calc(var(--spacing) * 4)",
    alignItems: "center",
  },
  railSpan2: {
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
    flexShrink: "0",
    alignItems: "center",
    gap: "calc(var(--spacing) * 3)",
    borderBottomStyle: "solid",
    borderBottomWidth: "1px",
    borderColor: "var(--color-line)",
    paddingInline: "calc(var(--spacing) * 5)",
  },
  deskSpan: {
    flex: "1",
  },
  deskDiv: {
    display: "flex",
    minWidth: "0",
    flex: "1",
    alignItems: "center",
    gap: "calc(var(--spacing) * 1.5)",
  },
  deskH1: {
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    overflow: "hidden",
    fontSize: "var(--text-lg)",
    lineHeight: "var(--text-lg--line-height)",
    fontWeight: "var(--font-weight-semibold)",
  },
  shellDiv: {
    position: "relative",
    minHeight: "0",
    flex: "1",
  },
});

/** The head's height, the rail's top slot's too. */
const head = 66;

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
      class={[
        "relative flex flex-col items-center justify-center gap-0.5 rounded-lg text-on-rail/65 hover:bg-on-rail/6 hover:text-on-rail focus-visible:outline-2 focus-visible:outline-focus aria-[current=page]:text-on-rail",
        // The farm's face at the top is a square picture.
        props.name === undefined ? "size-11 sm:size-12" : "size-12 sm:size-14",
      ]}
      style={props.current === true ? { background: "color-mix(in srgb, var(--color-on-rail) 9%, transparent)" } : undefined}
    >
      {props.children}
      <Show when={props.name}>{(name) => <span {...stylex.attrs(viewStyles.slotSpan)}>{name()}</span>}</Show>
      {/* How many wait on the owner there: the place to go next, seen from anywhere. */}
      <Show when={props.badge}>
        {(n) => (
          <span data-testid="rail-badge" {...stylex.attrs(viewStyles.railBadge)}>
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
  const waiting = () => waitingOnOwner(frames.frame?.inbox ?? []);
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
      {...stylex.attrs(viewStyles.rail)}
      // The window's buttons sit over the rail's top: it is at least as wide as they reach, and a little.
      style={titleBar.left > 0 ? { "min-width": `${titleBar.left + 8}px` } : undefined}
    >
      {/* Room for the desktop window's buttons over the rail's top. */}
      <div {...stylex.attrs(viewStyles.railDiv)} style={{ height: `${titleBar.top}px` }} />
      <div {...stylex.attrs(viewStyles.railDiv2)} style={{ height: `${head}px` }}>
        <Slot to="/farm" place="farm" label={t("web.base.farm")} current={props.farm}>
          <OrchestratorFace size={38} />
        </Slot>
      </div>
      <div {...stylex.attrs(viewStyles.railDiv3)}>
        <For each={railGroups}>
          {(group, i) => (
            <>
              <Show when={i() > 0}>
                <span aria-hidden="true" {...stylex.attrs(viewStyles.railSpan)} />
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
      <div {...stylex.attrs(viewStyles.railDiv4)}>
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
        <span role="status" data-testid="link" data-state={frames.link} title={linkWords[frames.link]} {...stylex.attrs(viewStyles.link)}>
          <span
            class={["block h-2 w-2 rounded-full", frames.link === "open" ? "bg-leaf" : frames.link === "lost" ? "bg-berry" : "bg-faint"]}
            aria-hidden="true"
          />
          <span {...stylex.attrs(viewStyles.railSpan2)}>{linkWords[frames.link]}</span>
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
    <div data-testid="desk" data-place={props.place?.id} {...stylex.attrs(viewStyles.desk)} style={{ height: `${head}px` }}>
      <Show when={props.place} fallback={<span {...stylex.attrs(viewStyles.deskSpan)} />}>
        {(place) => (
          <>
            <PlaceIcon place={place()} />
            {/* What the place is goes beside its name, on hover: a sentence under every head was read once and then only took room. */}
            <div {...stylex.attrs(viewStyles.deskDiv)}>
              <h1 {...stylex.attrs(viewStyles.deskH1)}>{place().label}</h1>
              <Hint text={place().hint} />
            </div>
          </>
        )}
      </Show>
      <A href="/farm" aria-label={status()} data-testid="desk-status" data-state={live() ? "live" : "off"} {...stylex.attrs(variantStyles2.deskA)}>
        <span {...stylex.attrs(variantStyles.deskSpan, live() ? variantStyles.deskSpanVariant : variantStyles.deskSpanVariant2)} aria-hidden="true" />
        {status()}
      </A>
    </div>
  );
}

export function Shell(props: { children: JSX.Element }) {
  const matches = useMatches();
  const meta = () => matches().at(-1)?.meta;
  const here = () => places.find((place) => place.id === meta()?.place);
  const inFarm = () => meta()?.skin === "farm";
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
    <div {...stylex.attrs(variantStyles.shellDiv, !inFarm() ? variantStyles.shellDivVariant : variantStyles.shellDivVariant2)}>
      <QuickSwitcher />
      <NotesSearch />
      <ShortcutSheet />
      <Rail here={here()} farm={inFarm()} />
      <main {...stylex.attrs(variantStyles.shellMain)}>
        <Show when={!inFarm() && here()?.id !== "chat"}>
          <Desk place={here()} />
        </Show>
        <div {...stylex.attrs(viewStyles.shellDiv)}>{props.children}</div>
      </main>
    </div>
  );
}
