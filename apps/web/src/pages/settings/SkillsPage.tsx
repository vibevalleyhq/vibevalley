// 技能: the skills the runtimes on this machine carry, read-only, and VibeValley's own, which
// a profile picks; /settings/skills/<id>, installed:<name> for an installed one, new for a new one.

import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useNavigate } from "react-router";
import type { RuntimeInfo, Skill } from "@vibevalley/protocol";
import { useQuery } from "@tanstack/react-query";
import { useAgents } from "../../data/agents";
import { api, reasonOf } from "../../data/api";
import { useRuntimes } from "../../data/runtimes";
import { RuntimeIcon } from "../../farm/hud/QuotaPill";
import { type InstalledSkill, installedSkills, matches, runtimeName } from "../../rules/skills";
import { Button } from "../../ui/Button";
import { AgentFace } from "../../ui/Face";
import { Field, TextArea, TextInput } from "../../ui/Field";
import { useToast } from "../../ui/Toast";
import { Card, Quiet } from "../kit";

const installedPrefix = "installed:";
export const skillPath = (id?: string) => (id === undefined ? "/settings/skills" : `/settings/skills/${encodeURIComponent(id)}`);

export function useSkills() {
  return useQuery({ queryKey: ["skills"], queryFn: () => api.skill.list() });
}

export function SkillsPage({ id }: { id?: string }) {
  const [query, setQuery] = useState("");
  const skills = useSkills();
  const runtimes = useRuntimes();
  const catalog = runtimes.data ?? [];
  const installed = installedSkills(catalog);
  const own = skills.data ?? [];
  const shownInstalled = id?.startsWith(installedPrefix) ? installed.find((s) => s.name === id.slice(installedPrefix.length)) : undefined;
  const creating = id === "new";
  const selected = creating || shownInstalled ? undefined : (own.find((s) => s.id === id) ?? (installed.length > 0 ? undefined : own[0]));
  const first = id === undefined ? installed[0] : undefined;
  const q = query.trim();
  const list = q ? installed.filter((s) => matches(q, [s.name, s.description, ...s.runtimes.map((x) => runtimeName(catalog, x.runtime))])) : installed;
  const ownShown = q ? own.filter((s) => matches(q, [s.name, s.description, s.body])) : own;
  const count = (shown: number, all: number) => (q ? `${shown} / ${all}` : `${all}`);

  const open = shownInstalled ?? first;
  return (
    <div className="flex h-full min-h-0 flex-col gap-3 overflow-y-auto lg:flex-row lg:overflow-hidden">
      <nav aria-label="技能书" className="flex shrink-0 flex-col gap-2 rounded-lg border border-line bg-page p-2 lg:w-72 lg:overflow-y-auto">
        <h2 className="px-2 pt-1.5 text-base font-semibold">技能书</h2>
        <TextInput aria-label="搜索技能" placeholder="搜名字、说明、农机……" value={query} onChange={(e) => setQuery(e.target.value)} />
        {runtimes.error && <p className="px-2 text-xs text-berry">读不到农机：{reasonOf(runtimes.error)}</p>}
        <h3 className="px-2 pt-2 text-xs font-semibold text-muted">这台电脑上装的 · {count(list.length, installed.length)}</h3>
        {installed.length === 0 && <p className="px-2 text-xs text-muted">农机还没报告装了哪些技能（或者还在读）。</p>}
        {installed.length > 0 && list.length === 0 && <p className="px-2 text-xs text-muted">没有对得上的。</p>}
        <ul className="flex flex-col gap-0.5">
          {list.map((s) => (
            <Entry
              key={s.name}
              to={skillPath(installedPrefix + s.name)}
              on={open?.name === s.name}
              title={s.name}
              detail={s.runtimes.map((x) => runtimeName(catalog, x.runtime)).join("、")}
            />
          ))}
        </ul>
        <div className="flex items-center gap-2 px-2 pt-3">
          <h3 className="flex-1 text-xs font-semibold text-muted">VibeValley 自己的 · {count(ownShown.length, own.length)}</h3>
          <Link to={skillPath("new")} className="inline-flex h-6 items-center rounded-md bg-accent px-2 text-xs text-page hover:bg-leaf">
            新技能
          </Link>
        </div>
        <ul className="flex flex-col gap-0.5">
          {ownShown.map((s) => (
            <Entry key={s.id} to={skillPath(s.id)} on={!creating && selected?.id === s.id} title={s.name} detail={s.description} />
          ))}
        </ul>
      </nav>
      <div className="min-w-0 flex-1 lg:overflow-y-auto">
        {creating ? (
          <SkillEditor key="new" />
        ) : open ? (
          <InstalledCard skill={open} catalog={catalog} />
        ) : selected ? (
          <SkillEditor key={selected.id} skill={selected} />
        ) : (
          <Quiet>还没有技能。</Quiet>
        )}
      </div>
    </div>
  );
}

function Entry({ to, on, title, detail }: { to: string; on: boolean; title: string; detail: string }) {
  return (
    <li>
      <Link to={to} aria-current={on ? "page" : undefined} className={`flex flex-col rounded-md px-2 py-1.5 hover:bg-hover ${on ? "bg-selected" : ""}`}>
        <span className="truncate text-sm font-medium">{title}</span>
        {detail && <span className="truncate text-xs text-muted">{detail}</span>}
      </Link>
    </li>
  );
}

/** Read-only: it lives with the runtime. */
function InstalledCard({ skill, catalog }: { skill: InstalledSkill; catalog: readonly RuntimeInfo[] }) {
  return (
    <Card title={skill.name} className="max-w-3xl">
      <p className="text-xs text-muted">装在农机上的技能：用这些农机的帮工会自己按需加载，不用在档案里勾。要改它，去它的文件里改。</p>
      {skill.description && <p className="text-sm whitespace-pre-wrap">{skill.description}</p>}
      <div className="flex flex-col gap-1.5">
        <h3 className="text-xs font-semibold text-muted">哪些农机有它</h3>
        {skill.runtimes.map((x) => (
          <div key={x.runtime} className="flex items-center gap-2.5 rounded-md bg-hover px-3 py-2">
            <RuntimeIcon runtime={x.runtime} size={28} />
            <span className="w-24 text-sm font-medium">{runtimeName(catalog, x.runtime)}</span>
            <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted" title={x.source}>
              {x.source}
            </span>
          </div>
        ))}
      </div>
    </Card>
  );
}

const empty: Skill = { id: "", name: "", description: "", body: "" };
const same = (a: Skill, b: Skill) => a.name === b.name && a.description === b.description && a.body === b.body;

function SkillEditor({ skill }: { skill?: Skill }) {
  const [draft, setDraft] = useState(skill ?? empty);
  const [sure, setSure] = useState(false);
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();
  const toast = useToast();
  const client = useQueryClient();
  const agents = (useAgents().data ?? []).filter((a) => skill && a.skills.includes(skill.id));
  const dirty = !skill || !same(skill, draft);
  const act = async (f: () => Promise<void>) => {
    setBusy(true);
    try {
      await f();
    } catch (e) {
      toast(reasonOf(e));
    } finally {
      setBusy(false);
    }
  };
  // Deleting a skill takes it off the profiles that carried it, so both lists come back.
  const refresh = () => Promise.all([client.invalidateQueries({ queryKey: ["skills"] }), client.invalidateQueries({ queryKey: ["agents"] })]);
  const save = () =>
    act(async () => {
      const body = { ...draft, name: draft.name.trim() };
      const saved = skill ? await api.skill.save({ id: skill.id, body }) : await api.skill.create({ body });
      await refresh();
      setDraft(saved);
      if (!skill) void navigate(skillPath(saved.id));
    });
  const remove = (s: Skill) =>
    act(async () => {
      await api.skill.delete({ id: s.id });
      await refresh();
      void navigate(skillPath());
    });

  return (
    <Card
      title={draft.name || "新技能"}
      className="max-w-3xl"
      action={
        <div className="flex flex-wrap items-center gap-2">
          {skill &&
            (sure ? (
              <>
                <span className="text-xs text-muted">{agents.length > 0 ? `${agents.length} 个 agent 在用，删掉会从它们身上去掉。` : "删掉？"}</span>
                <Button tone="danger" disabled={busy} onClick={() => remove(skill)}>
                  删除
                </Button>
                <Button onClick={() => setSure(false)}>算了</Button>
              </>
            ) : (
              <Button onClick={() => setSure(true)}>删除</Button>
            ))}
          <Button tone="primary" disabled={busy || !dirty || !draft.name.trim() || !draft.body.trim()} onClick={save}>
            保存
          </Button>
        </div>
      }
    >
      <Field label="名字">
        <TextInput aria-label="技能名字" placeholder="比如：先写测试" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
      </Field>
      <Field label="什么时候用" hint="一句话。按需加载技能的 runtime 先读这句，再决定要不要读正文。">
        <TextInput
          aria-label="技能说明"
          placeholder="改行为之前，先补一个会失败的测试。"
          value={draft.description}
          onChange={(e) => setDraft({ ...draft, description: e.target.value })}
        />
      </Field>
      <Field label="正文" hint="写成给 agent 看的指令（SKILL.md 的正文）。">
        <TextArea
          aria-label="正文"
          rows={14}
          placeholder="改任何行为之前，先写一个能复现问题的测试……"
          value={draft.body}
          onChange={(e) => setDraft({ ...draft, body: e.target.value })}
        />
      </Field>
      <div className="flex flex-col gap-1.5">
        <span className="text-xs font-medium text-muted">谁在用</span>
        {agents.length === 0 ? (
          <p className="text-xs text-muted">还没有 agent 带这个技能。到 agent 的「技能」页签里勾上。</p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {agents.map((a) => (
              <Link
                key={a.id}
                to={`/agents/${encodeURIComponent(a.id)}`}
                className="flex items-center gap-1.5 rounded-md bg-hover py-1 pr-3 pl-1 hover:bg-selected"
              >
                <AgentFace agentId={a.id} look={a.look} size={26} />
                <span className="text-sm font-medium">{a.name}</span>
              </Link>
            ))}
          </div>
        )}
      </div>
    </Card>
  );
}
