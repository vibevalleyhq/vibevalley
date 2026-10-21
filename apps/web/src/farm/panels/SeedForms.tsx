// Sowing an empty bed and watering a helper's: the sowing form picks the project, offers the project's seeds (its templates and
// recent words) or its queued todos, and who sows; the watering form takes a few words to the helper.

import { useMemo, useRef, useState, type ReactNode } from "react";
import { useNavigate } from "react-router";
import { useQuery } from "@tanstack/react-query";
import type { Issue, ProjectTemplates, Session } from "@vibevalley/protocol";
import { api, reasonOf } from "../../data/api";
import { useWorkAgents } from "../../data/agents";
import { useCore } from "../../data/frame";
import { newSendKey, useProjectNames, writeIssue } from "../../pages/issues/data";
import { AgentFace } from "../../ui/Face";
import { PxButton, PxSegmented, PxTextArea, PxTextInput, SpriteIcon, toasts, ToastType } from "../kit";
import { fire, useFarmCommands } from "../commands";
import { playSound } from "../sound";
import { farm, useFarm } from "../store";

const xs = "text-[12px] text-bark-600";
/** Who picks the helper when the owner does not. */
const byManager = "auto";

/** The project's todos waiting for room, first queued first: the seed bags at its gate. */
export const queuedIn = (issues: readonly Issue[], project: string) =>
  issues.filter((i) => i.project === project && i.status === "todo" && i.queuedAt !== undefined).sort((a, b) => a.queuedAt! - b.queuedAt!);

/** The bag's seeds under the filter: the recent words, and each kind with the templates that match it or its name. */
export function seedsShown(bag: ProjectTemplates | undefined, filter: string) {
  const q = filter.trim().toLowerCase();
  const shown = (title: string) => !q || title.toLowerCase().includes(q);
  return {
    recent: (bag?.recent ?? []).filter(shown),
    kinds: (bag?.kinds ?? []).flatMap((k) => {
      const templates = k.templates.filter((s) => shown(s.title) || shown(k.name));
      return templates.length ? [{ kind: k, templates }] : [];
    }),
  };
}

function Chip({ text, on, onClick }: { text: string; on: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onClick}
      className={`cursor-pointer px-3 py-1 text-[12px] ${on ? "bg-leaf-500 text-cream-50" : "bg-cream-200 text-bark-800 hover:bg-cream-300"}`}
    >
      {text}
    </button>
  );
}

function WhoTile({ active, label, onClick, children }: { active: boolean; label: string; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={active}
      aria-label={label}
      onClick={onClick}
      className={`flex w-16 cursor-pointer flex-col items-center py-1 ${active ? "bg-leaf-300/70" : "hover:bg-cream-200"}`}
    >
      {children}
      <span className="mt-0.5 max-w-[60px] truncate text-[12px] text-bark-800">{label}</span>
    </button>
  );
}

export function SowForm({ station, onDone }: { station: number; onDone: () => void }) {
  const projects = useProjectNames();
  const lastProject = useFarm((s) => s.lastProject);
  const pick = useFarm((s) => s.pick);
  const agents = useWorkAgents().filter((a) => a.enabled);
  const core = useCore();
  const commands = useFarmCommands();
  const navigate = useNavigate();
  const [chosen, setChosen] = useState<string>();
  const [choosing, setChoosing] = useState(false);
  const [pocket, setPocket] = useState<"seeds" | "queued">("seeds");
  const [text, setText] = useState("");
  const [selection, setSelection] = useState<readonly [number, number]>();
  const [filter, setFilter] = useState("");
  const [who, setWho] = useState<string>();
  const [refused, setRefused] = useState<string>();
  const words = useRef<HTMLTextAreaElement>(null);

  // The project last sown in is trusted while the list loads, dropped once the list says it is gone.
  const last = lastProject && (projects.length === 0 || projects.includes(lastProject)) ? lastProject : undefined;
  const project = choosing ? undefined : (chosen ?? last ?? (projects.length === 1 ? projects[0] : undefined));
  const templates = useQuery({ queryKey: ["templates", project], queryFn: () => api.project.templates({ id: project! }), enabled: !!project });
  const queued = useMemo(() => (project ? queuedIn(core?.issues ?? [], project) : []), [core?.issues, project]);
  const sower = who ?? (agents.some((a) => a.id === pick) ? pick : byManager);
  const agentOf = (w: string) => (w === byManager ? undefined : w);
  const canSow = text.trim() !== "";

  if (!project)
    return (
      <div className="flex flex-col">
        <p className="text-[14px] text-bark-900">种在哪个项目？</p>
        <p className={`mt-1 ${xs}`}>这块空地还不属于哪个项目：先挑一个，种子按它的样子给。</p>
        {projects.length === 0 && <p className={`mt-2.5 ${xs}`}>还没有项目：先在工作台的「项目」页开一个。</p>}
        <div className="mt-2.5 flex flex-wrap gap-1.5">
          {projects.map((p) => (
            <Chip
              key={p}
              text={p}
              on={false}
              onClick={() => {
                setChosen(p);
                setChoosing(false);
              }}
            />
          ))}
        </div>
      </div>
    );

  const take = (t: string, blank?: { start: number; end: number }) => {
    setText(t);
    setSelection(blank ? [blank.start, blank.end] : undefined);
    words.current?.focus();
  };
  const sow = () => {
    if (!canSow) return;
    playSound("plant");
    farm.setLastProject(project);
    fire(commands.plant(text, { station, agent: agentOf(sower), project }));
    onDone();
  };
  const write = async () => {
    if (!canSow) return;
    try {
      const got = await writeIssue(text, agentOf(sower) ?? "", project);
      if (got.refused) toasts.add({ type: ToastType.info, title: "先没起草", description: got.refused });
      farm.setLastProject(project);
      onDone();
      void navigate(`/issues/${encodeURIComponent(got.issue.id)}`);
    } catch (e) {
      setRefused(reasonOf(e));
    }
  };
  const start = async (i: Issue) => {
    const got = await commands.startQueued(i.id, station);
    if (got.ok) {
      farm.setLastProject(project);
      playSound("plant");
      onDone();
    } else setRefused(got.text);
  };
  const bag = templates.data;
  const { recent, kinds } = seedsShown(bag, filter);
  const stack = bag?.stack.label ?? "";

  return (
    <div className="flex flex-col">
      <div className="flex items-center gap-2">
        <p className="min-w-0 flex-1 truncate text-[14px] text-bark-900">
          种在 {project}
          {stack && <span className={`ml-2 ${xs}`}>{stack}</span>}
        </p>
        {projects.length > 1 && (
          <PxButton size="sm" onClick={() => setChoosing(true)}>
            换个项目
          </PxButton>
        )}
      </div>
      <div className="mt-2">
        <PxSegmented
          value={pocket}
          options={[
            { value: "seeds", label: "挑种子" },
            { value: "queued", label: queued.length ? `开工待办 ${queued.length}` : "开工待办" },
          ]}
          onChange={setPocket}
        />
      </div>
      <div className="mt-3 flex flex-col">
        {pocket === "queued" ? (
          queued.length === 0 ? (
            <p className={xs}>这个项目没有排着队的待办。院门外的种子袋就是它们。</p>
          ) : (
            <>
              <p className={xs}>排着队等空地的待办，按排上的先后；开工的是这张工单本身，不另写一张。</p>
              <div className="mt-2 flex flex-col gap-1.5">
                {queued.map((i) => (
                  <div key={i.id} className="flex items-center gap-2">
                    <SpriteIcon name="icon-seeds" size={20} />
                    <span className="min-w-0 flex-1 truncate text-[13px] text-bark-800">
                      #{Math.round(i.number)} {i.title}
                    </span>
                    <PxButton size="sm" tone="primary" onClick={() => void start(i)}>
                      开工
                    </PxButton>
                  </div>
                ))}
              </div>
            </>
          )
        ) : (
          <>
            <PxTextInput value={filter} onChange={setFilter} placeholder="筛一筛：bug、测试、依赖……" label="筛种子" />
            {templates.isPending && <p className={`mt-2.5 ${xs}`}>在翻种子袋……</p>}
            {templates.error && <p className="mt-2.5 text-[12px] text-berry">种子袋没拿到：{reasonOf(templates.error)}</p>}
            {recent.length > 0 && (
              <>
                <p className={`mt-2.5 ${xs}`}>最近</p>
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  {recent.map((r) => (
                    <Chip key={r} text={r} on={text === r} onClick={() => take(r)} />
                  ))}
                </div>
              </>
            )}
            {kinds.length > 0 && (
              <>
                <p className={`mt-2.5 ${xs}`}>常见的活</p>
                <div className="mt-1.5 flex flex-col gap-2">
                  {kinds.map(({ kind, templates: rows }) => (
                    <div key={kind.id} className="flex items-start gap-2">
                      <span className="flex w-20 shrink-0 items-center gap-1">
                        <SpriteIcon name={kind.icon} size={28} />
                        <span className="text-[12px] text-bark-800">{kind.name}</span>
                      </span>
                      <div className="flex flex-wrap gap-1.5">
                        {rows.map((s) => (
                          <Chip key={s.id} text={s.title} on={text === s.text} onClick={() => take(s.text, s.blank)} />
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              </>
            )}
            {bag && filter.trim() && recent.length === 0 && kinds.length === 0 && <p className={`mt-2.5 ${xs}`}>没有对得上的种子：在下面自己写。</p>}
            <p className={`mt-2.5 ${xs}`}>自己写</p>
            <div className="mt-1.5">
              <PxTextArea ref={words} value={text} selection={selection} onChange={setText} rows={3} placeholder="要做什么，做到什么程度算完" label="工单" />
            </div>
            <p className={`mt-3 ${xs}`}>谁来种</p>
            <div className="mt-1.5 flex flex-wrap gap-1" role="group" aria-label="谁来种">
              <WhoTile active={sower === byManager} label="管家挑" onClick={() => setWho(byManager)}>
                <span className="flex h-11 w-11 items-center justify-center bg-cream-200 text-[16px] text-bark-600">?</span>
              </WhoTile>
              {agents.map((a) => (
                <WhoTile key={a.id} active={sower === a.id} label={a.name} onClick={() => setWho(a.id)}>
                  <AgentFace agentId={a.id} look={a.look} size={44} />
                </WhoTile>
              ))}
            </div>
            <div className="mt-3 flex items-center gap-2">
              <p className={`min-w-0 flex-1 ${xs}`}>
                管家会把这句话交给帮工，派在 {project} 里；没开工的话会先开工。先起草：帮工读过代码写成工单，你看过再开工。
              </p>
              <PxButton disabled={!canSow} onClick={() => void write()}>
                先起草
              </PxButton>
              <PxButton tone="primary" disabled={!canSow} onClick={sow}>
                播种
              </PxButton>
            </div>
          </>
        )}
        {refused && <p className="mt-1.5 text-[12px] text-berry">{refused}</p>}
      </div>
    </div>
  );
}

const dropsOfAdvice = ["改动小一点", "先别动测试", "做完跟我说一声", "顺便补个测试"];

export function WaterForm({ session, onDone }: { session: Session; onDone: () => void }) {
  const commands = useFarmCommands();
  const [text, setText] = useState("");
  const [sendKey] = useState(newSendKey);
  const [refused, setRefused] = useState<string>();
  const water = async () => {
    if (!text.trim()) return;
    try {
      await commands.water(session, text, sendKey);
      onDone();
    } catch (e) {
      setRefused(reasonOf(e));
    }
  };
  return (
    <div className="flex flex-col">
      <p className="text-[13px] text-bark-800">
        {session.phase._tag === "working" ? "它正在干活，这句话会在下一步之前收到。" : "它现在没在干活，这句话会让它接着干一轮。"}
      </p>
      <p className={`mt-1 ${xs}`}>这句话记在它的工单串里，它回的话也在那儿。</p>
      <p className={`mt-1 ${xs}`}>现在的活：{session.brief}</p>
      <div className="mt-3 flex flex-wrap gap-1.5">
        {dropsOfAdvice.map((s) => (
          <Chip key={s} text={s} on={text === s} onClick={() => setText(s)} />
        ))}
      </div>
      <div className="mt-3 flex items-end gap-2">
        <div className="flex-1">
          <PxTextArea value={text} onChange={setText} rows={2} placeholder="带句话……" label={`给${session.name}带句话`} autoFocus />
        </div>
        <PxButton tone="primary" disabled={!text.trim()} onClick={() => void water()}>
          浇水
        </PxButton>
      </div>
      {refused && <p className="mt-1.5 text-[12px] text-berry">{refused}</p>}
    </div>
  );
}
