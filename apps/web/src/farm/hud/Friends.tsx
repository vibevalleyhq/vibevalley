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

import { HudCard } from "./HudCard";

const recipeStyles = stylex.create({
  expandArrow: { rotate: "90deg" },
  collapseArrow: { rotate: "-90deg" },
  friendButton: {
    position: "relative",
    display: "flex",
    width: "72px",
    cursor: "pointer",
    flexDirection: "column",
    alignItems: "center",
    paddingBlock: "var(--spacing)",
  },
  friendButtonVariant1Case1: {
    backgroundColor: {
      default: null,
      "@media (hover:hover)": {
        default: null,
        ":hover": "var(--color-cream-200)",
      },
    },
  },
  friendButtonVariant1Case2: {
    backgroundColor: {
      default: "var(--color-px-leaf-wash)",
      "@supports (color:color-mix(in lab, red, red))": "color-mix(in oklab, var(--color-leaf-300) 60%, transparent)",
    },
  },
  friendDiv: {
    position: "absolute",
    bottom: "100%",
    left: "0",
    zIndex: "10",
    marginBottom: "calc(var(--spacing) * 2.5)",
    width: "calc(var(--spacing) * 72)",
    backgroundColor: "var(--color-cream-50)",
    padding: "calc(var(--spacing) * 3)",
    textAlign: "left",
    boxShadow: "var(--shadow-px)",
  },
});

const variantStyles = stylex.create({
  friendSpan: {
    marginTop: "calc(var(--spacing) * .5)",
    maxWidth: "68px",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    overflow: "hidden",
    fontSize: "12px",
  },
  friendSpanVariant: {
    color: "var(--color-bark-900)",
  },
  friendSpanVariant2: {
    color: "var(--color-bark-400)",
  },
});

const viewStyles = stylex.create({
  staminaSpan: {
    display: "flex",
    height: "7px",
    width: "52px",
    gap: "1px",
    backgroundColor: "var(--color-bark-900)",
    padding: "1px",
  },
  staminaSpan2: {
    flex: "1",
  },
  friend: {
    position: "relative",
  },
  friendSpan: {
    padding: "calc(var(--spacing) * .5)",
  },
  friendSpan2: {
    height: "7px",
  },
  friendSpan3: {
    position: "absolute",
    top: "0",
    right: "calc(var(--spacing) * 2.5)",
    height: "calc(var(--spacing) * 3)",
    width: "calc(var(--spacing) * 3)",
    borderStyle: "solid",
    borderWidth: "2px",
    borderColor: "var(--color-cream-300)",
  },
  friendDiv: {
    display: "flex",
    alignItems: "center",
    gap: "calc(var(--spacing) * 3)",
  },
  friendDiv2: {
    minWidth: "0",
  },
  friendP: {
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    overflow: "hidden",
    fontSize: "16px",
  },
  friendP2: {
    fontSize: "12px",
    color: "var(--color-bark-600)",
  },
  friendP3: {
    fontSize: "12px",
    color: "var(--color-bark-800)",
  },
  friendDiv3: {
    marginTop: "calc(var(--spacing) * 2)",
    display: "flex",
    alignItems: "center",
    gap: "calc(var(--spacing) * 2)",
    backgroundColor: "var(--color-cream-100)",
    paddingInline: "calc(var(--spacing) * 2)",
    paddingBlock: "calc(var(--spacing) * 1.5)",
  },
  friendDiv4: {
    minWidth: "0",
    fontSize: "12px",
  },
  friendP4: {
    color: "var(--color-bark-800)",
  },
  friendP5: {
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    overflow: "hidden",
    color: "var(--color-bark-500)",
  },
  friendP6: {
    marginTop: "calc(var(--spacing) * 2)",
    fontSize: "13px",
    color: "var(--color-bark-800)",
  },
  friendDiv5: {
    marginTop: "calc(var(--spacing) * 3)",
    display: "flex",
    alignItems: "center",
    gap: "calc(var(--spacing) * 2)",
  },
  friendSpan4: {
    fontSize: "13px",
    color: "var(--color-bark-600)",
  },
  friends: {
    pointerEvents: "auto",
    position: "relative",
  },
  friendsDiv: {
    position: "absolute",
    bottom: "100%",
    left: "0",
    marginBottom: "var(--spacing)",
    width: "max-content",
    maxWidth: "min(640px,90vw)",
  },
  friendsSpan: {
    display: "flex",
    flexWrap: "wrap",
    gap: "var(--spacing)",
    paddingBlock: "calc(var(--spacing) * 1.5)",
  },
  friendsToggle: {
    position: "relative",
    cursor: "pointer",
  },
  friendsSpan2: {
    position: "relative",
    height: "22px",
  },
  friendsSpan3: {
    position: "absolute",
    top: "0",
  },
  friendsSpan4: {
    display: "flex",
    height: "calc(var(--spacing) * 4)",
    minWidth: "calc(var(--spacing) * 4)",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "var(--color-leaf-500)",
    paddingInline: "var(--spacing)",
    fontSize: "10px",
    lineHeight: "1",
    color: "var(--color-bark-900)",
  },
  friendsSpan5: {
    position: "absolute",
    top: "calc(var(--spacing) * -1)",
    left: "calc(var(--spacing) * -1)",
    height: "calc(var(--spacing) * 2.5)",
    width: "calc(var(--spacing) * 2.5)",
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

const status: Record<FriendStatus, { dot: string; label: string }> = {
  bug: { dot: "#c84a3a", label: t("web.farm.friends.status.bug") },
  ripe: { dot: "#e5a93c", label: t("web.farm.friends.status.ripe") },
  busy: { dot: "#74a046", label: t("web.farm.friends.status.busy") },
  rest: { dot: "#c8a46e", label: t("web.farm.friends.status.rest") },
  away: { dot: "transparent", label: t("web.farm.friends.status.away") },
};

/** Lit segments of `segments`, at least one while anything is left. */
function Stamina(props: { fill: number; segments?: number }) {
  const segments = () => props.segments ?? 8;
  const lit = () => (props.fill <= 0 ? 0 : Math.max(1, Math.round(props.fill * segments())));
  return (
    <span {...stylex.attrs(viewStyles.staminaSpan)} aria-hidden="true">
      <For each={Array.from({ length: segments() }, (_, i) => i)}>
        {(i) => <span {...stylex.attrs(viewStyles.staminaSpan2)} style={{ background: i < lit() ? "#7ea64f" : "#46301d" }} />}
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
    <div
      ref={box}
      {...stylex.attrs(viewStyles.friend)}
      data-testid="friend"
      data-key={props.agent.id}
      data-state={props.st}
      data-picked={picked() ? "" : undefined}
    >
      <button
        type="button"
        data-testid="friend-open"
        aria-label={t("shared.join.and", { a: props.agent.name, b: status[props.st].label })}
        aria-expanded={aria(open())}
        onClick={() => setOpen(!open())}
        {...stylex.attrs(recipeStyles.friendButton, picked() ? recipeStyles.friendButtonVariant1Case2 : recipeStyles.friendButtonVariant1Case1)}
      >
        <span {...stylex.attrs(viewStyles.friendSpan)} style={{ background: picked() ? "#74a046" : "#c8a46e" }}>
          <AgentFace agentId={props.agent.id} runtime={props.agent.runtime} look={props.agent.look} size={46} muted={!props.agent.enabled} />
        </span>
        <span {...stylex.attrs(variantStyles.friendSpan, props.agent.enabled ? variantStyles.friendSpanVariant : variantStyles.friendSpanVariant2)}>
          {props.agent.name}
        </span>
        <Show when={quota().level !== "unknown"} fallback={<span {...stylex.attrs(viewStyles.friendSpan2)} />}>
          <Stamina fill={quota().fill} />
        </Show>
        <Show when={props.st !== "away"}>
          <span {...stylex.attrs(viewStyles.friendSpan3)} style={{ background: status[props.st].dot }} />
        </Show>
      </button>
      <Show when={open()}>
        <div data-testid="friend-card" {...stylex.attrs(recipeStyles.friendDiv)} role="dialog" aria-label={props.agent.name}>
          <div {...stylex.attrs(viewStyles.friendDiv)}>
            <AgentFace agentId={props.agent.id} runtime={props.agent.runtime} look={props.agent.look} size={60} muted={!props.agent.enabled} />
            <div {...stylex.attrs(viewStyles.friendDiv2)}>
              <p {...stylex.attrs(viewStyles.friendP)}>{props.agent.name}</p>
              <p {...stylex.attrs(viewStyles.friendP2)}>
                {runtime()?.preset.label ?? props.agent.runtime}
                {props.agent.model ? ` · ${props.agent.model}` : ""}
              </p>
              <p {...stylex.attrs(viewStyles.friendP3)}>
                {status[props.st].label}
                {tally() ? t("web.farm.friends.tally", { hired: Math.round(tally()!.hired), harvested: Math.round(tally()!.harvested) }) : ""}
              </p>
            </div>
          </div>
          <div {...stylex.attrs(viewStyles.friendDiv3)}>
            <SpriteIcon name={bottleSprite(quota())} size={30} label={quota().text} />
            <div {...stylex.attrs(viewStyles.friendDiv4)}>
              <p {...stylex.attrs(viewStyles.friendP4)}>{t("web.farm.friends.energy", { short: quota().short || "—" })}</p>
              <p {...stylex.attrs(viewStyles.friendP5)} title={quota().text}>
                {t("shared.join.labeled", { label: runtime()?.preset.label ?? props.agent.runtime, text: quota().text })}
              </p>
            </div>
          </div>
          <p {...stylex.attrs(viewStyles.friendP6)}>{props.agent.duty}</p>
          <div {...stylex.attrs(viewStyles.friendDiv5)}>
            <div {...stylex.attrs(viewStyles.staminaSpan2)}>
              <Show when={props.agent.enabled} fallback={<span {...stylex.attrs(viewStyles.friendSpan4)}>{t("web.farm.friends.disabled")}</span>}>
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
    <div ref={box} {...stylex.attrs(viewStyles.friends)} aria-label={t("web.farm.friends.helpers")} role="group" data-testid="friends">
      <Show when={open()}>
        {/* As wide as the helpers in a row (the button under it is narrower), wrapping only past the cap. */}
        <div {...stylex.attrs(viewStyles.friendsDiv)}>
          <HudCard>
            <span {...stylex.attrs(viewStyles.friendsSpan)}>
              <For each={sorted()} keyed={(a) => a.id}>
                {(a, i) => <Friend agent={a()} st={statuses()[i()]!} />}
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
        {...stylex.attrs(viewStyles.friendsToggle)}
      >
        <HudCard height={props.height}>
          <span {...stylex.attrs(viewStyles.friendsSpan2)} style={{ width: `${sorted().length === 0 ? 0 : 22 + (Math.min(3, sorted().length) - 1) * 12}px` }}>
            <For each={sorted().slice(0, 3)} keyed={(a) => a.id}>
              {(a, i) => (
                <span {...stylex.attrs(viewStyles.friendsSpan3)} style={{ left: `${i() * 12}px`, "z-index": 3 - i() }}>
                  <AgentFace agentId={a().id} runtime={a().runtime} look={a().look} size={22} />
                </span>
              )}
            </For>
          </span>
          <span>{t("web.farm.friends.helpers")}</span>
          <Show when={busy() > 0}>
            <span {...stylex.attrs(viewStyles.friendsSpan4)}>{busy()}</span>
          </Show>
          <SpriteIcon name="button-next" size={12} styles={open() ? recipeStyles.collapseArrow : recipeStyles.expandArrow} />
        </HudCard>
        <Show when={stage()}>{(a) => <span {...stylex.attrs(viewStyles.friendsSpan5)} style={{ background: status[a()].dot }} />}</Show>
      </button>
    </div>
  );
}
