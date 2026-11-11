import * as stylex from "@stylexjs/stylex";
import { createSignal, For, Show } from "solid-js";

import { t } from "@vibevalley/i18n";
import type { Agent, FarmView, Session } from "@vibevalley/protocol";

import { aria, useClickAway } from "#/base/dom.tsx";
import { farm, useFarm } from "#/farm/store.ts";
import { isBusy, isRipe, plotOf } from "#/farm/world/plots.ts";
import { webRoutes } from "#/farm/world/world.ts";
import { bottleSprite, quotaOf } from "#/features/runtime/index.ts";
import { useCore, useFrames } from "#/infra/frame.ts";
import { ready, useAgents, useRuntimes } from "#/infra/query.ts";
import { useRouter } from "#/infra/router.ts";
import { setPick, usePrefs } from "#/state/prefs.ts";
import { AgentFace } from "#/ui/Face.tsx";
import { PxButton, SpriteIcon } from "#/ui/pixel/index.ts";
import { styleProps } from "#/ui/positioner.ts";

import { HudCard } from "./HudCard";

const styles = stylex.create({
  expandArrow: { rotate: "90deg" },
  collapseArrow: { rotate: "-90deg" },
  friendButton: {
    position: "relative",
    display: "flex",
    width: "72px",
    cursor: "pointer",
    flexDirection: "column",
    alignItems: "center",
    paddingBlock: "0.25rem",
  },
  friendButtonIdle: {
    backgroundColor: {
      default: null,
      "@media (hover:hover)": {
        default: null,
        ":hover": "var(--color-cream-200)",
      },
    },
  },
  friendButtonPicked: {
    backgroundColor: {
      default: "var(--color-px-leaf-wash)",
      "@supports (color:color-mix(in lab, red, red))": "color-mix(in oklab, var(--color-leaf-300) 60%, transparent)",
    },
  },
  friendCard: {
    position: "absolute",
    bottom: "100%",
    left: "0",
    zIndex: "10",
    marginBottom: "0.625rem",
    width: "18rem",
    backgroundColor: "var(--color-cream-50)",
    padding: "0.75rem",
    textAlign: "left",
    boxShadow: "var(--shadow-px)",
  },
  friendName: {
    marginTop: "0.125rem",
    maxWidth: "68px",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    overflow: "hidden",
    fontSize: "12px",
  },
  friendNameEnabled: {
    color: "var(--color-bark-900)",
  },
  friendNameDisabled: {
    color: "var(--color-bark-400)",
  },
  staminaTrack: {
    display: "flex",
    height: "7px",
    width: "52px",
    gap: "1px",
    backgroundColor: "var(--color-bark-900)",
    padding: "1px",
  },
  staminaBar: {
    flex: "1",
  },
  staminaLit: {
    backgroundColor: "var(--color-agent-stage-edge)",
  },
  staminaEmpty: {
    backgroundColor: "var(--color-bark-800)",
  },
  friend: {
    position: "relative",
  },
  faceFrame: {
    padding: "0.125rem",
  },
  facePicked: {
    backgroundColor: "var(--color-leaf-500)",
  },
  faceIdle: {
    backgroundColor: "var(--color-cream-300)",
  },
  staminaPlaceholder: {
    height: "7px",
  },
  friendDot: {
    position: "absolute",
    top: "0",
    right: "0.625rem",
    height: "0.75rem",
    width: "0.75rem",
    borderStyle: "solid",
    borderWidth: "2px",
    borderColor: "var(--color-cream-300)",
  },
  dotBug: {
    backgroundColor: "var(--color-berry-500)",
  },
  dotRipe: {
    backgroundColor: "var(--color-wheat)",
  },
  dotBusy: {
    backgroundColor: "var(--color-leaf-500)",
  },
  dotRest: {
    backgroundColor: "var(--color-cream-300)",
  },
  dotAway: {
    backgroundColor: "transparent",
  },
  cardHeader: {
    display: "flex",
    alignItems: "center",
    gap: "0.75rem",
  },
  cardMeta: {
    minWidth: "0",
  },
  cardTitle: {
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    overflow: "hidden",
    fontSize: "16px",
  },
  cardRuntime: {
    fontSize: "12px",
    color: "var(--color-bark-600)",
  },
  cardStatus: {
    fontSize: "12px",
    color: "var(--color-bark-800)",
  },
  energyBox: {
    marginTop: "0.5rem",
    display: "flex",
    alignItems: "center",
    gap: "0.5rem",
    backgroundColor: "var(--color-cream-100)",
    paddingInline: "0.5rem",
    paddingBlock: "0.375rem",
  },
  energyText: {
    minWidth: "0",
    fontSize: "12px",
  },
  energyShort: {
    color: "var(--color-bark-800)",
  },
  energyDetail: {
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    overflow: "hidden",
    color: "var(--color-bark-500)",
  },
  duty: {
    marginTop: "0.5rem",
    fontSize: "13px",
    color: "var(--color-bark-800)",
  },
  cardActions: {
    marginTop: "0.75rem",
    display: "flex",
    alignItems: "center",
    gap: "0.5rem",
  },
  disabledText: {
    fontSize: "13px",
    color: "var(--color-bark-600)",
  },
  friends: {
    pointerEvents: "auto",
    position: "relative",
  },
  popup: {
    position: "absolute",
    bottom: "100%",
    left: "0",
    marginBottom: "0.25rem",
    width: "max-content",
    maxWidth: "min(640px,90vw)",
  },
  list: {
    display: "flex",
    flexWrap: "wrap",
    gap: "0.25rem",
    paddingBlock: "0.375rem",
  },
  toggle: {
    position: "relative",
    cursor: "pointer",
  },
  stack: (width: number) => ({
    position: "relative",
    height: "22px",
    width,
  }),
  stackFace: (left: number, zIndex: number) => ({
    position: "absolute",
    top: "0",
    left,
    zIndex,
  }),
  busyCount: {
    display: "flex",
    height: "1rem",
    minWidth: "1rem",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "var(--color-leaf-500)",
    paddingInline: "0.25rem",
    fontSize: "10px",
    lineHeight: "1",
    color: "var(--color-bark-900)",
  },
  stageDot: {
    position: "absolute",
    top: "-0.25rem",
    left: "-0.25rem",
    height: "0.625rem",
    width: "0.625rem",
    borderStyle: "solid",
    borderWidth: "2px",
    borderColor: "var(--color-cream-300)",
  },
});

type FriendStatus = "bug" | "ripe" | "busy" | "rest" | "away";

function statusOf(mine: readonly Session[], view: FarmView): FriendStatus {
  const crops = mine.map((s) => plotOf(view, s).crop);
  if (crops.includes("withered")) return "bug";
  if (crops.some(isRipe)) return "ripe";
  if (mine.some(isBusy)) return "busy";
  return mine.length > 0 ? "rest" : "away";
}

const status: Record<FriendStatus, { dot: stylex.StyleXStyles; label: string }> = {
  bug: { dot: styles.dotBug, label: t("web.farm.friends.status.bug") },
  ripe: { dot: styles.dotRipe, label: t("web.farm.friends.status.ripe") },
  busy: { dot: styles.dotBusy, label: t("web.farm.friends.status.busy") },
  rest: { dot: styles.dotRest, label: t("web.farm.friends.status.rest") },
  away: { dot: styles.dotAway, label: t("web.farm.friends.status.away") },
};

/** Lit segments of `segments`, at least one while anything is left. */
function Stamina(props: { fill: number; segments?: number }) {
  const segments = () => props.segments ?? 8;
  const lit = () => (props.fill <= 0 ? 0 : Math.max(1, Math.round(props.fill * segments())));
  return (
    <span {...stylex.attrs(styles.staminaTrack)} aria-hidden="true">
      <For each={Array.from({ length: segments() }, (_, i) => i)}>
        {(i) => <span {...stylex.attrs(styles.staminaBar, i < lit() ? styles.staminaLit : styles.staminaEmpty)} />}
      </For>
    </span>
  );
}

function Friend(props: { agent: Agent; st: FriendStatus }) {
  const pick = usePrefs((p) => p.pick);
  const core = useCore();
  const runtimes = useRuntimes();
  const router = useRouter();
  const [open, setOpen] = createSignal(false);
  const runtime = () => ready(runtimes, []).find((r) => r.id === props.agent.runtime);
  const quota = () => quotaOf(runtime());
  const picked = () => pick() === props.agent.id;
  const tally = () => core()?.progress?.agents[props.agent.id];
  const box = useClickAway(open, () => setOpen(false));
  return (
    <div ref={box} {...stylex.attrs(styles.friend)} data-testid="friend" data-key={props.agent.id} data-state={props.st} data-picked={picked() ? "" : undefined}>
      <button
        type="button"
        data-testid="friend-open"
        aria-label={t("shared.join.and", { a: props.agent.name, b: status[props.st].label })}
        aria-expanded={aria(open())}
        onClick={() => setOpen(!open())}
        {...stylex.attrs(styles.friendButton, picked() ? styles.friendButtonPicked : styles.friendButtonIdle)}
      >
        <span {...stylex.attrs(styles.faceFrame, picked() ? styles.facePicked : styles.faceIdle)}>
          <AgentFace agentId={props.agent.id} runtime={props.agent.runtime} look={props.agent.look} size={46} muted={!props.agent.enabled} />
        </span>
        <span {...stylex.attrs(styles.friendName, props.agent.enabled ? styles.friendNameEnabled : styles.friendNameDisabled)}>{props.agent.name}</span>
        <Show when={quota().level !== "unknown"} fallback={<span {...stylex.attrs(styles.staminaPlaceholder)} />}>
          <Stamina fill={quota().fill} />
        </Show>
        <Show when={props.st !== "away"}>
          <span {...styleProps([styles.friendDot, status[props.st].dot])} />
        </Show>
      </button>
      <Show when={open()}>
        <div data-testid="friend-card" {...stylex.attrs(styles.friendCard)} role="dialog" aria-label={props.agent.name}>
          <div {...stylex.attrs(styles.cardHeader)}>
            <AgentFace agentId={props.agent.id} runtime={props.agent.runtime} look={props.agent.look} size={60} muted={!props.agent.enabled} />
            <div {...stylex.attrs(styles.cardMeta)}>
              <p {...stylex.attrs(styles.cardTitle)}>{props.agent.name}</p>
              <p {...stylex.attrs(styles.cardRuntime)}>
                {runtime()?.preset.label ?? props.agent.runtime}
                {props.agent.model ? ` · ${props.agent.model}` : ""}
              </p>
              <p {...stylex.attrs(styles.cardStatus)}>
                {status[props.st].label}
                {(() => {
                  const counts = tally();
                  return counts ? t("web.farm.friends.tally", { hired: Math.round(counts.hired), harvested: Math.round(counts.harvested) }) : "";
                })()}
              </p>
            </div>
          </div>
          <div {...stylex.attrs(styles.energyBox)}>
            <SpriteIcon name={bottleSprite(quota())} size={30} label={quota().text} />
            <div {...stylex.attrs(styles.energyText)}>
              <p {...stylex.attrs(styles.energyShort)}>{t("web.farm.friends.energy", { short: quota().short || "—" })}</p>
              <p {...stylex.attrs(styles.energyDetail)} title={quota().text}>
                {t("shared.join.labeled", { label: runtime()?.preset.label ?? props.agent.runtime, text: quota().text })}
              </p>
            </div>
          </div>
          <p {...stylex.attrs(styles.duty)}>{props.agent.duty}</p>
          <div {...stylex.attrs(styles.cardActions)}>
            <div {...stylex.attrs(styles.staminaBar)}>
              <Show when={props.agent.enabled} fallback={<span {...stylex.attrs(styles.disabledText)}>{t("web.farm.friends.disabled")}</span>}>
                <PxButton tone={picked() ? "plain" : "primary"} data-testid="friend-pick" onClick={() => setPick(picked() ? "auto" : props.agent.id)}>
                  {picked() ? t("web.farm.friends.unpick") : t("web.farm.friends.pick")}
                </PxButton>
              </Show>
            </div>
            <Show when={webRoutes.includes("/agents")}>
              <PxButton
                data-testid="friend-profile"
                onClick={() => {
                  setOpen(false);
                  router.navigate(`/agents/${encodeURIComponent(props.agent.id)}`);
                }}
              >
                {t("web.farm.friends.profile")}
              </PxButton>
            </Show>
          </div>
        </div>
      </Show>
    </div>
  );
}

export function Friends(props: { height: number }) {
  const agents = useAgents();
  const frames = useFrames();
  const open = useFarm((s) => s.friendsOpen);
  const sorted = () => {
    const work = ready(agents, []).filter((a) => a.role === "worker");
    return [...work.filter((a) => a.enabled), ...work.filter((a) => !a.enabled)];
  };
  const statuses = () => {
    const sessions = frames.frame?.state.sessions ?? [];
    const view = frames.frame?.view ?? { level: { level: 1, xp: 0, need: 10 }, plots: {}, plays: {}, achievements: [] };
    return sorted().map((a) =>
      statusOf(
        sessions.filter((s) => s.agent === a.id),
        view,
      ),
    );
  };
  const busy = () => statuses().filter((s) => s === "busy").length;
  const stage = (): FriendStatus | undefined => (statuses().includes("bug") ? "bug" : statuses().includes("ripe") ? "ripe" : undefined);
  const box = useClickAway(open, () => farm.friendsOpen(false));
  return (
    <div ref={box} {...stylex.attrs(styles.friends)} aria-label={t("web.farm.friends.helpers")} role="group" data-testid="friends">
      <Show when={open()}>
        {/* As wide as the helpers in a row (the button under it is narrower), wrapping only past the cap. */}
        <div {...stylex.attrs(styles.popup)}>
          <HudCard>
            <span {...stylex.attrs(styles.list)}>
              <For each={sorted()} keyed={(a) => a.id}>
                {(a, i) => <Friend agent={a()} st={statuses()[i()] ?? "away"} />}
              </For>
            </span>
          </HudCard>
        </div>
      </Show>
      <button
        type="button"
        data-testid="friends-toggle"
        aria-label={t("web.farm.friends.helpers")}
        aria-expanded={aria(open())}
        onClick={() => farm.friendsOpen(!open())}
        {...stylex.attrs(styles.toggle)}
      >
        <HudCard height={props.height}>
          <span {...styleProps(styles.stack(sorted().length === 0 ? 0 : 22 + (Math.min(3, sorted().length) - 1) * 12))}>
            <For each={sorted().slice(0, 3)} keyed={(a) => a.id}>
              {(a, i) => (
                <span {...styleProps(styles.stackFace(i() * 12, 3 - i()))}>
                  <AgentFace agentId={a().id} runtime={a().runtime} look={a().look} size={22} />
                </span>
              )}
            </For>
          </span>
          <span>{t("web.farm.friends.helpers")}</span>
          <Show when={busy() > 0}>
            <span {...stylex.attrs(styles.busyCount)}>{busy()}</span>
          </Show>
          <SpriteIcon name="button-next" size={12} styles={open() ? styles.collapseArrow : styles.expandArrow} />
        </HudCard>
        <Show when={stage()}>{(a) => <span {...styleProps([styles.stageDot, status[a()].dot])} />}</Show>
      </button>
    </div>
  );
}
