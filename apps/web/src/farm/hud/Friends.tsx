// The helpers at the HUD's bottom left: a button with the first three faces
// and how many are at work; open, every profile with how its plots are doing and its runtime's stamina, and for each a
// card to send it the next job or open its profile.

import { useState } from "react";
import { useNavigate } from "react-router";
import type { Agent, FarmView, Session } from "@vibevalley/protocol";
import { useWorkAgents } from "../../data/agents";
import { useCore, useFrames } from "../../data/frame";
import { useRuntimes } from "../../data/runtimes";
import { AgentFace } from "../../ui/Face";
import { PxButton, SpriteIcon } from "../kit";
import { farm, useFarm } from "../store";
import { isBusy, isRipe, plotOf } from "../world/plots";
import { webRoutes } from "../world/places";
import { HudCard } from "./Hud";
import { bottleSprite, quotaOf } from "./rules";

export type FriendStatus = "bug" | "ripe" | "busy" | "rest" | "away";

const status: Record<FriendStatus, { dot: string; label: string }> = {
  bug: { dot: "#c84a3a", label: "地里有虫" },
  ripe: { dot: "#e5a93c", label: "熟了，等你收" },
  busy: { dot: "#74a046", label: "在干活" },
  rest: { dot: "#c8a46e", label: "在地里歇着" },
  away: { dot: "transparent", label: "没在农场" },
};

export function statusOf(mine: readonly Session[], view: FarmView): FriendStatus {
  const crops = mine.map((s) => plotOf(view, s).crop);
  if (crops.includes("withered")) return "bug";
  if (crops.some(isRipe)) return "ripe";
  if (mine.some(isBusy)) return "busy";
  return mine.length ? "rest" : "away";
}

/** Lit segments of `segments`, at least one while anything is left. */
function Stamina({ fill, segments = 8 }: { fill: number; segments?: number }) {
  const lit = fill <= 0 ? 0 : Math.max(1, Math.round(fill * segments));
  return (
    <span className="flex h-[7px] w-[52px] gap-px bg-bark-900 p-px" aria-hidden>
      {Array.from({ length: segments }, (_, i) => (
        <span key={i} className="flex-1" style={{ background: i < lit ? "#7ea64f" : "#46301d" }} />
      ))}
    </span>
  );
}

function Friend({ agent, st }: { agent: Agent; st: FriendStatus }) {
  const pick = useFarm((s) => s.pick);
  const core = useCore();
  const runtime = (useRuntimes().data ?? []).find((r) => r.id === agent.runtime);
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const quota = quotaOf(runtime);
  const picked = pick === agent.id;
  const tally = core?.progress?.agents?.[agent.id];
  return (
    <div className="relative">
      <button
        type="button"
        aria-label={`${agent.name}，${status[st].label}`}
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className={`relative flex w-[72px] cursor-pointer flex-col items-center py-1 ${picked ? "bg-leaf-300/60" : "hover:bg-cream-200"}`}
      >
        <span className="p-0.5" style={{ background: picked ? "#74a046" : "#c8a46e" }}>
          <AgentFace agentId={agent.id} look={agent.look} size={46} muted={!agent.enabled} />
        </span>
        <span className={`mt-0.5 max-w-[68px] truncate text-[12px] ${agent.enabled ? "text-bark-900" : "text-bark-400"}`}>{agent.name}</span>
        {quota.level === "unknown" ? <span className="h-[7px]" /> : <Stamina fill={quota.fill} />}
        {st !== "away" && <span className="absolute top-0 right-2.5 h-3 w-3 border-2 border-cream-300" style={{ background: status[st].dot }} />}
      </button>
      {open && (
        <div className="absolute bottom-full left-0 z-10 mb-2.5 w-72 bg-cream-50 p-3 text-left shadow-px" role="dialog" aria-label={agent.name}>
          <div className="flex items-center gap-3">
            <AgentFace agentId={agent.id} look={agent.look} size={60} muted={!agent.enabled} />
            <div className="min-w-0">
              <p className="truncate text-[16px]">{agent.name}</p>
              <p className="text-[12px] text-bark-600">
                {runtime?.preset.label ?? agent.runtime}
                {agent.model ? ` · ${agent.model}` : ""}
              </p>
              <p className="text-[12px] text-bark-800">
                {status[st].label}
                {tally ? ` · 请过 ${Math.round(tally.hired)} 次，收成 ${Math.round(tally.harvested)} 次` : ""}
              </p>
            </div>
          </div>
          <div className="mt-2 flex items-center gap-2 bg-cream-100 px-2 py-1.5">
            <SpriteIcon name={bottleSprite(quota)} size={30} label={quota.text} />
            <div className="min-w-0 text-[12px]">
              <p className="text-bark-800">精力 {quota.short || "—"}</p>
              <p className="truncate text-bark-500" title={quota.text}>
                {runtime?.preset.label ?? agent.runtime}：{quota.text}
              </p>
            </div>
          </div>
          <p className="mt-2 text-[13px] text-bark-800">{agent.role}</p>
          <div className="mt-3 flex items-center gap-2">
            <div className="flex-1">
              {agent.enabled ? (
                <PxButton tone={picked ? "plain" : "primary"} onClick={() => farm.setPick(picked ? "auto" : agent.id)}>
                  {picked ? "不再指定" : "下一单派它"}
                </PxButton>
              ) : (
                <span className="text-[13px] text-bark-600">停用了，派不出去</span>
              )}
            </div>
            {webRoutes.includes("/agents") && (
              <PxButton
                onClick={() => {
                  setOpen(false);
                  void navigate(`/agents/${encodeURIComponent(agent.id)}`);
                }}
              >
                档案
              </PxButton>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export function Friends({ height }: { height: number }) {
  const agents = useWorkAgents();
  const { frame } = useFrames();
  const open = useFarm((s) => s.friendsOpen);
  const sessions = frame?.state.sessions ?? [];
  const view = frame?.view ?? { level: { level: 1, xp: 0, need: 10 }, plots: {}, achievements: [] };
  const sorted = [...agents.filter((a) => a.enabled), ...agents.filter((a) => !a.enabled)];
  const statuses = sorted.map((a) =>
    statusOf(
      sessions.filter((s) => s.agent === a.id),
      view,
    ),
  );
  const busy = statuses.filter((s) => s === "busy").length;
  const attention = statuses.includes("bug") ? "bug" : statuses.includes("ripe") ? "ripe" : undefined;
  return (
    <div className="pointer-events-auto relative" aria-label="帮工" role="group">
      {open && (
        <div className="absolute bottom-full left-0 mb-1 max-w-[min(640px,90vw)]">
          <HudCard>
            <span className="flex flex-wrap gap-1 py-1.5">
              {sorted.map((a, i) => (
                <Friend key={a.id} agent={a} st={statuses[i]!} />
              ))}
            </span>
          </HudCard>
        </div>
      )}
      <button type="button" aria-label="帮工" aria-expanded={open} onClick={() => farm.friendsOpen(!open)} className="relative cursor-pointer">
        <HudCard height={height}>
          <span className="relative h-[22px]" style={{ width: sorted.length === 0 ? 0 : 22 + (Math.min(3, sorted.length) - 1) * 12 }}>
            {sorted.slice(0, 3).map((a, i) => (
              <span key={a.id} className="absolute top-0" style={{ left: i * 12, zIndex: 3 - i }}>
                <AgentFace agentId={a.id} look={a.look} size={22} />
              </span>
            ))}
          </span>
          <span>帮工</span>
          {busy > 0 && <span className="flex h-4 min-w-4 items-center justify-center bg-leaf-500 px-1 text-[10px] leading-none text-cream-50">{busy}</span>}
          <SpriteIcon name="button-next" size={12} className={open ? "-rotate-90" : "rotate-90"} />
        </HudCard>
        {attention && <span className="absolute -top-1 -left-1 h-2.5 w-2.5 border-2 border-cream-300" style={{ background: status[attention].dot }} />}
      </button>
    </div>
  );
}
