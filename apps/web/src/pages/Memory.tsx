// What an agent remembers: a profile's shared memory, the manager's
// MEMORY.md, and the manager's archive of conversations folded away.

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useState } from "react";
import { type Memory, type MemoryList, type MemorySourceInfo, managerAgent, memoryKeep } from "@vibevalley/protocol";
import { api, reasonOf } from "../data/api";
import { useCore } from "../data/frame";
import { useProjectNames } from "../data/projects";
import { ago } from "../rules/time";
import { Button } from "../ui/Button";
import { Select, TextArea, TextInput } from "../ui/Field";
import { useToast } from "../ui/Toast";
import { Quiet } from "./kit";

/** Notes not tied to a project. */
const everywhere = "*";

const item = "rounded-md border border-line bg-page";

const useMemory = (agent: string) => useQuery({ queryKey: ["memory", agent], queryFn: () => api.memory.list({ agent }) });

function useMemoryActions(agent: string) {
  const client = useQueryClient();
  const toast = useToast();
  const reload = () => client.invalidateQueries({ queryKey: ["memory", agent] });
  return {
    /** The refusal in words, or undefined once written. */
    write: async (text: string, project?: string) => {
      try {
        await api.memory.create({ agent, body: { text, ...(project ? { project } : {}) } });
        await reload();
        return undefined;
      } catch (e) {
        return reasonOf(e);
      }
    },
    forget: async (id: string) => {
      try {
        await api.memory.delete({ agent, memory: id });
        await reload();
      } catch (e) {
        toast(reasonOf(e));
      }
    },
  };
}

/** A titled part of a panel, its count beside the title. */
export function Section({ title, count, aside, children }: { title: string; count?: number; aside?: ReactNode; children: ReactNode }) {
  return (
    <section aria-label={title} className="flex flex-col gap-2">
      <header className="flex items-center gap-2">
        <h3 className="text-sm font-semibold">{title}</h3>
        {count !== undefined && <span className="text-xs text-muted">{count}</span>}
        <span className="flex-1" />
        {aside && <span className="text-xs text-muted">{aside}</span>}
      </header>
      {children}
    </section>
  );
}

function Pill({ label, on, onClick }: { label: string; on: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onClick}
      className={`h-6 cursor-pointer rounded-full px-2.5 text-xs ${on ? "bg-ink text-page" : "bg-hover hover:bg-selected"}`}
    >
      {label}
    </button>
  );
}

export function MemoryPanel({ agent }: { agent: string }) {
  const [shown, setShown] = useState("");
  const view = useMemory(agent).data;
  const act = useMemoryActions(agent);
  const sessions = new Map((useCore()?.sessions ?? []).map((h) => [h.id, h.name]));
  const now = Date.now();
  const all = view?.memories ?? [];
  const sources = new Map((view?.sources ?? []).map((s) => [s.name, s]));
  const notes = all.filter((m) => m.kind === "note");
  const jobs = all.filter((m) => m.kind === "issue");
  const projects = [...new Set(all.flatMap((m) => (m.project ? [m.project] : [])))].sort();
  const filtered = notes.filter((m) => shown === "" || (shown === everywhere ? m.project === undefined : m.project === shown));
  const whose = (m: Memory) =>
    m.author === "owner" ? "你记的" : m.author === "manager" ? "管家替它记的" : m.session ? `${sessions.get(m.session) ?? m.session} 记的` : "它自己记的";
  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted">
        这个 agent
        派出去的帮工共用一份记性。每一轮开始，和这一轮有关的几条放在它收到的话前面；一轮结束，它在汇报里写的「记住：」那几行，和这件活做到哪了，记进来。
      </p>
      {sources.size > 1 && <Sources sources={[...sources.values()]} />}
      <Section title="手上的活" count={jobs.length}>
        {jobs.length === 0 ? (
          <Quiet>它的帮工还没做完过一轮。</Quiet>
        ) : (
          jobs.map((m) => (
            <div key={m.id} className={`${item} flex overflow-hidden`}>
              <span className="w-[3px] shrink-0 bg-leaf" />
              <div className="flex flex-col gap-0.5 px-3 py-2">
                <span className="flex flex-wrap gap-2 text-xs text-muted">
                  <span className="font-medium text-ink">{m.session ? (sessions.get(m.session) ?? m.session) : "帮工"}</span>
                  <span>{m.project ?? "所有项目"}</span>
                  <span>{ago(m.at, now)}</span>
                </span>
                <span className="text-sm">{m.text}</span>
              </div>
            </div>
          ))
        )}
      </Section>
      <RecallPreview agent={agent} />
      <WriteNote onWrite={act.write} withProject />
      <Section title="记下的" count={notes.length}>
        {projects.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {[["", "全部"] as const, [everywhere, "所有项目"] as const, ...projects.map((p) => [p, p] as const)].map(([value, label]) => (
              <Pill key={value} label={label} on={shown === value} onClick={() => setShown(value)} />
            ))}
          </div>
        )}
        {filtered.length === 0 ? (
          <Quiet>{notes.length > 0 ? "这一栏没有。" : "还没记下什么。帮工在汇报里写「记住：」，或者你在上面替它记。"}</Quiet>
        ) : (
          filtered.map((m) => {
            const src = m.source ? sources.get(m.source) : undefined;
            return src ? (
              <MemoryItem
                key={m.id}
                memory={m}
                onForget={src.canForget ? () => act.forget(m.id) : undefined}
                meta={[`在 ${src.label} 里`, ...(src.canForget ? [] : [`要删到 ${src.label} 里删`])]}
              />
            ) : (
              <MemoryItem
                key={m.id}
                memory={m}
                faded={m.fading === true}
                onForget={() => act.forget(m.id)}
                meta={[
                  m.project ?? "所有项目",
                  whose(m),
                  ago(m.at, now),
                  m.recalled > 0 ? `想起过 ${Math.round(m.recalled)} 次${m.recalledAt ? `，上次 ${ago(m.recalledAt, now)}` : ""}` : "还没想起过",
                ]}
                warning={m.fading ? `快忘了：记满 ${memoryKeep} 条时最先丢` : undefined}
              />
            );
          })
        )}
      </Section>
    </div>
  );
}

/** Where its memories live besides the farm's own, and what each lets the panel do. */
function Sources({ sources }: { sources: MemorySourceInfo[] }) {
  return (
    <Section title="记性从哪来" count={sources.filter((s) => s.on).length}>
      {sources.map((s) => (
        <div key={s.name} className={`${item} flex flex-wrap items-center gap-x-2 gap-y-0.5 px-3 py-2 text-xs text-muted`}>
          <span className="text-sm font-medium text-ink">{s.label}</span>
          <span className={s.on ? "text-accent" : "text-berry"}>{s.on ? "在用" : `没接上：${s.off ?? ""}`}</span>
          {s.on && (
            <>
              <span>{s.canList ? "记下的列在下面" : "不在这里列出"}</span>
              <span>{s.canForget ? "能在这里忘掉" : "要删到它那里删"}</span>
              {s.transcripts && <span>收整段干活的对话</span>}
            </>
          )}
        </div>
      ))}
      <p className="text-xs text-muted">在开头的「设置」里接上、关掉，或改读写。</p>
    </Section>
  );
}

/** The pick the server would make, without counting it (memory.recall). */
function RecallPreview({ agent }: { agent: string }) {
  const projects = useProjectNames();
  const [project, setProject] = useState("");
  const [text, setText] = useState("");
  const where = project || projects[0] || "";
  const memory = useMemory(agent).dataUpdatedAt;
  const preview = useQuery({
    queryKey: ["recall", agent, where, text, memory],
    queryFn: () => api.memory.recall({ agent, project: where, text }),
    enabled: where !== "",
  }).data;
  const lines = preview?.lines ?? [];
  return (
    <Section title="下回开工会想起" aside={lines.length > 0 && preview ? `${lines.length} 条 · ${preview.chars} / ${preview.limit} 字` : undefined}>
      <div className="flex flex-col gap-1.5 sm:flex-row">
        <Select
          className="sm:w-40"
          label="在哪个项目开工"
          placeholder="选项目"
          value={where}
          options={projects.map((p) => ({ value: p, label: p }))}
          onChange={setProject}
        />
        <TextInput aria-label="这一轮的话" placeholder="这一轮的话（可以不填）" value={text} onChange={(e) => setText(e.target.value)} />
      </div>
      {lines.length === 0 ? (
        <Quiet>{where ? "在这个项目里开工，什么也想不起来。" : "还没有项目。"}</Quiet>
      ) : (
        <p className={`${item} px-3 py-2 text-sm whitespace-pre-wrap`}>{lines.join("\n")}</p>
      )}
    </Section>
  );
}

export function ManagerMemoryPanel() {
  const view: MemoryList | undefined = useMemory(managerAgent).data;
  const act = useMemoryActions(managerAgent);
  if (!view) return <Quiet>在读管家的记性……</Quiet>;
  const now = Date.now();
  const carried = view.carried ?? view.memories.length;
  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted">管家开工时和每次压缩后读一遍记性；中间记下、忘掉的，它下一句就知道。</p>
      <WriteNote onWrite={(text) => act.write(text)} />
      <Section title="记下的" count={view.memories.length}>
        {view.memories.length === 0 ? (
          <Quiet>还没记下什么。跟管家说「记住……」，或者你在上面替它记。</Quiet>
        ) : (
          view.memories.map((m, i) => (
            <MemoryItem
              key={m.id}
              memory={m}
              faded={i >= carried}
              onForget={() => act.forget(m.id)}
              meta={[m.session === managerAgent ? "管家自己记的" : "你交代的", ago(m.at, now)]}
              warning={i >= carried ? "太旧了，带不进系统提示" : undefined}
            />
          ))
        )}
      </Section>
    </div>
  );
}

export function ArchivePanel() {
  const [query, setQuery] = useState("");
  const [asked, setAsked] = useState<string>();
  const [open, setOpen] = useState<{ name: string; text: string }>();
  const listing = useQuery({ queryKey: ["archive", asked ?? ""], queryFn: () => api.manager.listArchive(asked ? { q: asked } : {}) });
  const now = Date.now();
  const show = async (name: string) => {
    if (open?.name === name) return setOpen(undefined);
    let text: string;
    try {
      text = await api.manager.getArchive({ name });
    } catch (e) {
      text = reasonOf(e);
    }
    setOpen({ name, text });
  };
  const files = listing.data?.files;
  const hits = listing.data?.hits ?? [];
  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted">
        对话太长时，管家把前面的部分压成一段摘要，原文一字不改地存在这里。摘要里缺了细节，它自己会用 search_archive 来翻；你也可以在这里翻。
      </p>
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (query.trim()) setAsked(query.trim());
        }}
      >
        <TextInput aria-label="在旧账里搜" placeholder="搜一个词" value={query} onChange={(e) => setQuery(e.target.value)} />
        <Button type="submit" icon="button-search" disabled={!query.trim()}>
          搜
        </Button>
      </form>
      {hits.length > 0 && (
        <Section title="搜到的" count={hits.length}>
          {hits.map((h) => (
            <div key={`${h.file}:${h.line}`} className={`${item} flex flex-col gap-0.5 px-3 py-2`}>
              <span className="font-mono text-xs text-muted">
                {h.file}:{Math.round(h.line)}
              </span>
              <span className="text-sm">{h.text}</span>
            </div>
          ))}
        </Section>
      )}
      <Section title="压掉的对话" count={files?.length ?? 0}>
        {!files ? (
          <Quiet>{listing.error ? reasonOf(listing.error) : "在读……"}</Quiet>
        ) : files.length === 0 ? (
          <Quiet>还没有：管家的对话还没长到要压缩。</Quiet>
        ) : (
          files.map((f) => (
            <div key={f.name} className={`${item} overflow-hidden`}>
              <button
                type="button"
                aria-expanded={open?.name === f.name}
                onClick={() => show(f.name)}
                className="flex w-full cursor-pointer items-center gap-2 px-3 py-2 text-left hover:bg-hover"
              >
                <span className="min-w-0 flex-1 truncate font-mono text-sm">{f.name}</span>
                <span className="text-xs text-muted">
                  {ago(f.at, now)} · {Math.round(f.chars)} 字
                </span>
              </button>
              {open?.name === f.name && (
                <pre className="max-h-96 overflow-y-auto border-t border-line px-3 py-2 text-sm whitespace-pre-wrap select-text">{open.text}</pre>
              )}
            </div>
          ))
        )}
      </Section>
    </div>
  );
}

function WriteNote({ onWrite, withProject = false }: { onWrite: (text: string, project?: string) => Promise<string | undefined>; withProject?: boolean }) {
  const [text, setText] = useState("");
  const [project, setProject] = useState("");
  const [error, setError] = useState<string>();
  const projects = useProjectNames();
  const write = async () => {
    const refused = await onWrite(text, project.trim() || undefined);
    setError(refused);
    if (!refused) setText("");
  };
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs font-medium text-muted">替它记一条</span>
      <TextArea
        aria-label="替它记一条"
        rows={2}
        placeholder={withProject ? "比如：clock-in 的测试用 pnpm test，别用 npm" : "比如：提交信息写中文；周末别派夜班"}
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      <div className="flex items-center gap-2 pt-1">
        {withProject ? (
          <>
            <TextInput
              aria-label="项目"
              className="font-mono"
              placeholder="项目（可以不填）"
              list="memory-projects"
              value={project}
              onChange={(e) => setProject(e.target.value)}
            />
            <datalist id="memory-projects">
              {projects.map((p) => (
                <option key={p} value={p} />
              ))}
            </datalist>
          </>
        ) : (
          <span className="flex-1" />
        )}
        <Button tone="primary" disabled={!text.trim()} onClick={write}>
          记下
        </Button>
      </div>
      {error ? (
        <span className="text-xs text-berry">{error}</span>
      ) : (
        <span className="text-xs text-faint">{withProject ? "写成下次一看就懂的一句话。项目留空就是所有项目都用得上。" : "写成下次一看就懂的一句话。"}</span>
      )}
    </div>
  );
}

function MemoryItem({
  memory,
  onForget,
  meta,
  faded = false,
  warning,
}: {
  memory: Memory;
  onForget?: () => void;
  meta: string[];
  faded?: boolean;
  warning?: string;
}) {
  return (
    <div className={`${item} group flex items-start gap-2 px-3 py-2 ${faded ? "opacity-60" : ""}`}>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-sm">{memory.text}</span>
        <span className="flex flex-wrap gap-x-2 text-xs text-muted">
          {meta.map((m) => (
            <span key={m}>{m}</span>
          ))}
          {warning && <span className="text-[#b8682a]">{warning}</span>}
        </span>
      </div>
      {onForget && (
        <button
          type="button"
          onClick={onForget}
          className="shrink-0 cursor-pointer rounded-md px-2 py-0.5 text-xs text-muted opacity-0 group-hover:opacity-100 hover:bg-hover hover:text-berry focus-visible:opacity-100"
        >
          忘掉
        </button>
      )}
    </div>
  );
}
