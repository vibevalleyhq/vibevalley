// The helpers at the HUD's bottom left: a button with the first three faces and how many are at work; open, every
// profile with how its plots are doing and its runtime's stamina, and for each a card to send it the next job or open
// its profile.

import { farmWording } from "../words";
import { createSignal, For, Show } from "solid-js";
import { type Agent, orchestratorAgent } from "@vibevalley/protocol";
import { bottleSprite, quotaOf } from "../../features/runtime";
import { statusOf, type FriendStatus } from "./friendStatus";
import { farm } from "../store";
import { webRoutes } from "../world/places";
import { aria, useClickAway } from "../../base/util";
import { useRouter } from "../../base/router";
import { useCore, useFrames } from "../../base/frame";
import { ready, useAgents, useRuntimes } from "../../base/query";
import { AgentFace } from "../../ui/Face";
import { PxButton, SpriteIcon } from "../../ui/pixel";
import { useFarm } from "../state";
import { HudCard } from "./HudCard";
import { setPick, usePrefs } from "../../base/prefs";

const status: Record<FriendStatus, { dot: string; label: string }> = {
  bug: { dot: "#c84a3a", label: farmWording().friends.status.bug },
  ripe: { dot: "#e5a93c", label: farmWording().friends.status.ripe },
  busy: { dot: "#74a046", label: farmWording().friends.status.busy },
  rest: { dot: "#c8a46e", label: farmWording().friends.status.rest },
  away: { dot: "transparent", label: farmWording().friends.status.away },
};

/** Lit segments of `segments`, at least one while anything is left. */
function Stamina(props: { fill: number; segments?: number }) {
  const segments = () => props.segments ?? 8;
  const lit = () => (props.fill <= 0 ? 0 : Math.max(1, Math.round(props.fill * segments())));
  return (
    <span class="flex h-[7px] w-[52px] gap-px bg-bark-900 p-px" aria-hidden="true">
      <For each={Array.from({ length: segments() }, (_, i) => i)}>
        {(i) => <span class="flex-1" style={{ background: i < lit() ? "#7ea64f" : "#46301d" }} />}
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
  const tally = () => core()?.progress?.agents?.[props.agent.id];
  const box = useClickAway(open, () => setOpen(false));
  return (
    <div ref={box} class="relative">
      <button
        type="button"
        aria-label={`${props.agent.name}，${status[props.st].label}`}
        aria-expanded={aria(open())}
        onClick={() => setOpen(!open())}
        class={["relative flex w-[72px] cursor-pointer flex-col items-center py-1", picked() ? "bg-leaf-300/60" : "hover:bg-cream-200"]}
      >
        <span class="p-0.5" style={{ background: picked() ? "#74a046" : "#c8a46e" }}>
          <AgentFace agentId={props.agent.id} runtime={props.agent.runtime} look={props.agent.look} size={46} muted={!props.agent.enabled} />
        </span>
        <span class={["mt-0.5 max-w-[68px] truncate text-[12px]", props.agent.enabled ? "text-bark-900" : "text-bark-400"]}>{props.agent.name}</span>
        <Show when={quota().level !== "unknown"} fallback={<span class="h-[7px]" />}>
          <Stamina fill={quota().fill} />
        </Show>
        <Show when={props.st !== "away"}>
          <span class="absolute top-0 right-2.5 h-3 w-3 border-2 border-cream-300" style={{ background: status[props.st].dot }} />
        </Show>
      </button>
      <Show when={open()}>
        <div class="absolute bottom-full left-0 z-10 mb-2.5 w-72 bg-cream-50 p-3 text-left shadow-px" role="dialog" aria-label={props.agent.name}>
          <div class="flex items-center gap-3">
            <AgentFace agentId={props.agent.id} runtime={props.agent.runtime} look={props.agent.look} size={60} muted={!props.agent.enabled} />
            <div class="min-w-0">
              <p class="truncate text-[16px]">{props.agent.name}</p>
              <p class="text-[12px] text-bark-600">
                {runtime()?.preset.label ?? props.agent.runtime}
                {props.agent.model ? ` · ${props.agent.model}` : ""}
              </p>
              <p class="text-[12px] text-bark-800">
                {status[props.st].label}
                {tally() ? farmWording().friends.tally(Math.round(tally()!.hired), Math.round(tally()!.harvested)) : ""}
              </p>
            </div>
          </div>
          <div class="mt-2 flex items-center gap-2 bg-cream-100 px-2 py-1.5">
            <SpriteIcon name={bottleSprite(quota())} size={30} label={quota().text} />
            <div class="min-w-0 text-[12px]">
              <p class="text-bark-800">{farmWording().friends.energy(quota().short || "—")}</p>
              <p class="truncate text-bark-500" title={quota().text}>
                {runtime()?.preset.label ?? props.agent.runtime}：{quota().text}
              </p>
            </div>
          </div>
          <p class="mt-2 text-[13px] text-bark-800">{props.agent.role}</p>
          <div class="mt-3 flex items-center gap-2">
            <div class="flex-1">
              <Show when={props.agent.enabled} fallback={<span class="text-[13px] text-bark-600">{farmWording().friends.disabled}</span>}>
                <PxButton tone={picked() ? "plain" : "primary"} onClick={() => setPick(picked() ? "auto" : props.agent.id)}>
                  {picked() ? farmWording().friends.unpick : farmWording().friends.pick}
                </PxButton>
              </Show>
            </div>
            <Show when={webRoutes.includes("/agents")}>
              <PxButton
                onClick={() => {
                  setOpen(false);
                  router.navigate(`/agents/${encodeURIComponent(props.agent.id)}`);
                }}
              >
                {farmWording().friends.profile}
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
    const work = ready(agents, []).filter((a) => a.id !== orchestratorAgent);
    return [...work.filter((a) => a.enabled), ...work.filter((a) => !a.enabled)];
  };
  const statuses = () => {
    const sessions = frames.frame?.state.sessions ?? [];
    const view = frames.frame?.view ?? { level: { level: 1, xp: 0, need: 10 }, plots: {}, achievements: [] };
    return sorted().map((a) =>
      statusOf(
        sessions.filter((s) => s.agent === a.id),
        view,
      ),
    );
  };
  const busy = () => statuses().filter((s) => s === "busy").length;
  const attention = (): FriendStatus | undefined => (statuses().includes("bug") ? "bug" : statuses().includes("ripe") ? "ripe" : undefined);
  const box = useClickAway(open, () => farm.friendsOpen(false));
  return (
    <div ref={box} class="pointer-events-auto relative" aria-label={farmWording().friends.helpers} role="group">
      <Show when={open()}>
        {/* As wide as the helpers in a row (the button under it is narrower), wrapping only past the cap. */}
        <div class="absolute bottom-full left-0 mb-1 w-max max-w-[min(640px,90vw)]">
          <HudCard>
            <span class="flex flex-wrap gap-1 py-1.5">
              <For each={sorted()} keyed={(a) => a.id}>
                {(a, i) => <Friend agent={a()} st={statuses()[i()]!} />}
              </For>
            </span>
          </HudCard>
        </div>
      </Show>
      <button
        type="button"
        aria-label={farmWording().friends.helpers}
        aria-expanded={aria(open())}
        onClick={() => farm.friendsOpen(!open())}
        class="relative cursor-pointer"
      >
        <HudCard height={props.height}>
          <span class="relative h-[22px]" style={{ width: `${sorted().length === 0 ? 0 : 22 + (Math.min(3, sorted().length) - 1) * 12}px` }}>
            <For each={sorted().slice(0, 3)} keyed={(a) => a.id}>
              {(a, i) => (
                <span class="absolute top-0" style={{ left: `${i() * 12}px`, "z-index": 3 - i() }}>
                  <AgentFace agentId={a().id} runtime={a().runtime} look={a().look} size={22} />
                </span>
              )}
            </For>
          </span>
          <span>{farmWording().friends.helpers}</span>
          <Show when={busy() > 0}>
            <span class="flex h-4 min-w-4 items-center justify-center bg-leaf-500 px-1 text-[10px] leading-none text-cream-50">{busy()}</span>
          </Show>
          <SpriteIcon name="button-next" size={12} class={open() ? "-rotate-90" : "rotate-90"} />
        </HudCard>
        <Show when={attention()}>
          {(a) => <span class="absolute -top-1 -left-1 h-2.5 w-2.5 border-2 border-cream-300" style={{ background: status[a()].dot }} />}
        </Show>
      </button>
    </div>
  );
}
