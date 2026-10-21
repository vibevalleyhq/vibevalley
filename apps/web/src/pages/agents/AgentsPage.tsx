// 帮工: the manager and every profile as cards; a card opens its profile, the last card
// makes a new one. /agents/<id> is a profile, /agents/new a new one.

import { useQueryClient } from "@tanstack/react-query";
import type { Agent, AgentTally, RuntimeInfo } from "@vibevalley/protocol";
import type { ReactNode } from "react";
import { Link, useParams } from "react-router";
import { useAgentIssues, useWorkAgents } from "../../data/agents";
import { api, reasonOf } from "../../data/api";
import { useCore } from "../../data/frame";
import { useRuntimes } from "../../data/runtimes";
import { useFarm } from "../../farm/store";
import { hexColor } from "../../rules/cast";
import { AgentFace, ManagerFace } from "../../ui/Face";
import { Icon } from "../../ui/Icon";
import { useToast } from "../../ui/Toast";
import { useSkills } from "../settings/SkillsPage";
import { AgentPage } from "./AgentPage";

export function AgentsRoute() {
  const id = useParams()["*"];
  return id ? <AgentPage key={id} id={decodeURIComponent(id)} /> : <AgentsPage />;
}

function AgentsPage() {
  const agents = useWorkAgents();
  const core = useCore();
  const runtimes = useRuntimes().data ?? [];
  const skills = new Map((useSkills().data ?? []).map((s) => [s.id, s.name]));
  const issues = useAgentIssues(agents);
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex max-w-6xl flex-col gap-6 px-4 pt-4 pb-8 sm:px-6">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div className="flex max-w-xl flex-col gap-1">
            <h1 className="text-2xl font-semibold">
              帮工 <span className="text-base font-normal text-muted">档案</span>
            </h1>
            <p className="text-sm text-muted">
              每个帮工是一种配置好的 runtime：用哪个 runtime 和模型、带什么人设和技能，在农场里是哪种小动物、穿什么。管家派活时派的就是帮工。
            </p>
          </div>
          <Link
            to="/agents/new"
            className="inline-flex h-7 items-center gap-1.5 rounded-md border border-accent bg-accent px-2.5 text-sm text-page hover:bg-leaf"
          >
            <Icon name="button-add" size={14} />
            捏一个新帮工
          </Link>
        </div>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <ManagerCard />
          {agents.map((a) => (
            <AgentCard
              key={a.id}
              agent={a}
              runtime={runtimes.find((r) => r.id === a.runtime)}
              tally={core?.progress?.agents?.[a.id]}
              here={(core?.sessions ?? []).filter((h) => h.agent === a.id).length}
              skillName={skills}
              errors={(issues[a.id] ?? []).filter((i) => i.level === "error").map((i) => i.text)}
            />
          ))}
          <Link
            to="/agents/new"
            aria-label="捏一个新帮工"
            className="flex min-h-44 flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-ink/20 text-sm font-medium text-muted hover:border-leaf/60 hover:text-[#3f6427]"
          >
            <Icon name="button-add" size={28} />
            捏一个新帮工
          </Link>
        </div>
      </div>
    </div>
  );
}

function CardShell({ to, label, muted = false, corner, children }: { to: string; label: string; muted?: boolean; corner?: ReactNode; children: ReactNode }) {
  return (
    <div className={`group relative ${muted ? "opacity-60" : ""}`}>
      <Link
        to={to}
        aria-label={label}
        className="flex h-full flex-col rounded-lg border border-line bg-page p-4 transition-colors hover:border-ink/20 hover:bg-[#fffbf2] focus-visible:outline-2 focus-visible:outline-focus"
      >
        {children}
      </Link>
      {corner && <div className="absolute top-3 right-3">{corner}</div>}
    </div>
  );
}

const footer = "mt-auto flex items-center gap-3 border-t border-line pt-3 text-xs text-muted";

function ManagerCard() {
  const look = useFarm((s) => s.managerLook);
  return (
    <CardShell to="/manager" label="管家">
      <div className="flex items-start gap-3 pb-3">
        <span className="flex size-20 shrink-0 items-center justify-center rounded-lg bg-hover">
          <ManagerFace size={68} look={look} />
        </span>
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className="text-base font-semibold">管家</span>
          <span className="line-clamp-2 text-sm text-muted">不下地：派活、盯进度、转告结果，也接电话。</span>
        </span>
      </div>
      <div className={footer}>
        <span>记性</span>
        <span>旧账</span>
        <span>声音</span>
      </div>
    </CardShell>
  );
}

function AgentCard({
  agent: a,
  runtime,
  tally,
  here,
  skillName,
  errors,
}: {
  agent: Agent;
  runtime?: RuntimeInfo;
  tally?: AgentTally;
  here: number;
  skillName: Map<string, string>;
  errors: string[];
}) {
  const client = useQueryClient();
  const toast = useToast();
  const available = runtime?.installation.status === "available";
  const toggle = async () => {
    try {
      await api.agent.save({ id: a.id, body: { ...a, enabled: !a.enabled } });
      await client.invalidateQueries({ queryKey: ["agents"] });
    } catch (e) {
      toast(reasonOf(e));
    }
  };
  return (
    <CardShell
      to={`/agents/${encodeURIComponent(a.id)}`}
      label={a.name}
      muted={!a.enabled}
      corner={
        <button
          type="button"
          onClick={toggle}
          aria-label={`${a.enabled ? "停用" : "启用"} ${a.name}`}
          className="cursor-pointer rounded-md border border-line bg-page px-2 py-0.5 text-xs font-medium text-muted opacity-0 group-hover:opacity-100 hover:bg-[#f6eedd] hover:text-ink focus-visible:opacity-100"
        >
          {a.enabled ? "停用" : "启用"}
        </button>
      }
    >
      <div className="flex items-start gap-3">
        <span
          className="flex size-20 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-hover"
          style={{ background: `radial-gradient(70% 70% at 50% 70%, ${hexColor(a.look.hat ?? "")}33, transparent), var(--color-hover)` }}
        >
          <AgentFace agentId={a.id} look={a.look} size={68} muted={!a.enabled} />
        </span>
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className="flex items-center gap-2">
            <span className="truncate text-base font-semibold">{a.name}</span>
            {here > 0 && <span className="shrink-0 rounded bg-hat px-1.5 text-xs text-bark-900">在场 {here}</span>}
          </span>
          <span className="line-clamp-2 text-sm text-muted">{a.role}</span>
          <span className="flex min-w-0 items-center gap-1.5 pt-1 text-xs text-muted">
            <span className={`size-[7px] shrink-0 rounded-full ${available ? "bg-leaf" : "bg-berry"}`} aria-hidden />
            <span className="truncate">{[runtime?.preset.label ?? a.runtime, a.model, a.effort].filter(Boolean).join(" · ")}</span>
          </span>
        </span>
      </div>
      {a.skills.length > 0 && (
        <div className="flex flex-wrap gap-1 pt-3">
          {a.skills.map((id) => (
            <span key={id} className="rounded bg-hover px-1.5 text-xs">
              {skillName.get(id) ?? id}
            </span>
          ))}
        </div>
      )}
      <div className={`${footer} mt-3`}>
        <span title="从这份档案派出去的帮工，干的活收进主分支的次数（服务端的账本）">
          雇过 <span className="font-medium text-ink">{Math.round(tally?.hired ?? 0)}</span>
        </span>
        <span>
          收成 <span className="font-medium text-[#3f6427]">{Math.round(tally?.harvested ?? 0)}</span>
        </span>
        {errors.length > 0 ? (
          <span className="min-w-0 flex-1 truncate text-right text-berry" title={errors.join("\n")}>
            派不出去：{errors[0]}
          </span>
        ) : (
          <span className="min-w-0 flex-1 truncate text-right">{a.tags.slice(0, 4).join(" · ")}</span>
        )}
      </div>
    </CardShell>
  );
}
