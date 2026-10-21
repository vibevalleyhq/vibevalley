// 项目: the codebases in the work root; 全部 is the whole map, a project its island, its
// deed, what is planted (tokei's count), the tilling calendar of a year's commits and who worked it. /projects/<name>.

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router";
import type { ProjectActivity, ProjectLanguages, ProjectSummary } from "@vibevalley/protocol";
import { useWorkAgents } from "../../data/agents";
import { api, reasonOf } from "../../data/api";
import { useProjects } from "../../data/projects";
import {
  calendarOf,
  type CalendarDay,
  dateText,
  dayText,
  githubRepository,
  growthOf,
  langIcon,
  languageShares,
  number,
  percent,
  since,
  sortProjects,
  streaksOf,
  islandLook,
} from "../../rules/projects";
import { Button } from "../../ui/Button";
import { Dialog } from "../../ui/Dialog";
import { AgentFace } from "../../ui/Face";
import { Field, TextInput } from "../../ui/Field";
import { Icon } from "../../ui/Icon";
import { Segmented } from "../../ui/Segmented";
import { useToast } from "../../ui/Toast";
import { Card, ListCard, ListRow, Quiet } from "../kit";
import { IslandDetail, ProjectMap, useIslands } from "./ProjectMap";

/** A minute at a time: enough for 「3 小时前」. */
function useMinute() {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(t);
  }, []);
  return now;
}

const useSurvey = (project: string | undefined) => ({
  languages: useQuery({
    queryKey: ["project-languages", project],
    queryFn: () => api.project.languages({ id: project! }),
    enabled: !!project,
    placeholderData: (p) => p,
  }),
  activity: useQuery({
    queryKey: ["project-activity", project],
    queryFn: () => api.project.activity({ id: project! }),
    enabled: !!project,
    placeholderData: (p) => p,
  }),
});

export function ProjectsPage() {
  const id = useParams()["*"] || undefined;
  const navigate = useNavigate();
  const now = useMinute();
  const list = useProjects();
  const sorted = sortProjects(list.data ?? []);
  const selected = sorted.find((p) => p.name === (id && decodeURIComponent(id)));
  const islands = useIslands();
  const island = selected && islands.find((i) => i.project === selected.name);
  const [creating, setCreating] = useState(false);
  const menu = (
    <ListCard
      title="项目"
      label="项目列表"
      action={
        <Button icon="button-add" onClick={() => setCreating(true)}>
          新增项目
        </Button>
      }
    >
      <li className="px-2.5 pt-1 pb-1.5 text-xs text-muted">代码库</li>
      {!list.data ? (
        <li className="px-2.5 pb-2 text-sm text-muted">在找……</li>
      ) : sorted.length === 0 ? (
        <li className="px-2.5 pb-2 text-sm text-muted">工作目录下还没有项目。点「新增项目」开一块地，或从 GitHub 下载一个。</li>
      ) : (
        <>
          <ListRow to="/projects" active={!selected} title="全部" line="整张地图：每个项目一座岛" />
          {sorted.map((p) => {
            const growth = growthOf(p.last, now);
            const line = !p.git ? "还不是 git 仓库" : p.last !== undefined ? `${growth.label} · ${since(p.last, now)}` : growth.label;
            return (
              <ListRow
                key={p.name}
                to={`/projects/${encodeURIComponent(p.name)}`}
                active={p === selected}
                title={p.name}
                line={line}
                leading={<Icon name={islandLook(p.name)} size={40} />}
              />
            );
          })}
        </>
      )}
    </ListCard>
  );
  return (
    <div className="flex h-full min-h-0 flex-col gap-3 overflow-y-auto p-3 md:flex-row md:overflow-hidden">
      <div className="max-h-60 shrink-0 overflow-y-auto md:max-h-none md:w-72">{menu}</div>
      <div className="flex min-h-[480px] min-w-0 flex-1 flex-col md:min-h-0">
        {!selected ? (
          <ProjectMap />
        ) : (
          <div className="flex max-w-4xl flex-col gap-3 md:overflow-y-auto">
            {island && <IslandDetail island={island} />}
            <Details key={selected.name} project={selected} now={now} />
          </div>
        )}
      </div>
      <Dialog open={creating} onClose={() => setCreating(false)} title="新增项目">
        <NewProjectForm
          onDone={(made) => {
            setCreating(false);
            if (made) void navigate(`/projects/${encodeURIComponent(made.name)}`);
          }}
        />
      </Dialog>
    </div>
  );
}

function Details({ project, now }: { project: ProjectSummary; now: number }) {
  const survey = useSurvey(project.name);
  return (
    <>
      <Deed project={project} languages={survey.languages} activity={survey.activity} now={now} />
      <Planted languages={survey.languages} />
      <TillingCalendar activity={survey.activity} />
      <Hands activity={survey.activity.data} />
    </>
  );
}

type Asked<A> = { data?: A; error: unknown; isFetching: boolean; dataUpdatedAt: number; refetch: () => unknown };

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex min-w-18 flex-col">
      <span className="text-xs text-muted">{label}</span>
      <span className="line-clamp-2 text-sm font-medium">{value}</span>
    </div>
  );
}

function Deed({
  project,
  languages,
  activity,
  now,
}: {
  project: ProjectSummary;
  languages: Asked<ProjectLanguages>;
  activity: Asked<ProjectActivity>;
  now: number;
}) {
  const toast = useToast();
  const growth = growthOf(project.last, now);
  const counted = languages.data;
  const worked = activity.data;
  const lines = counted?.languages.reduce((n, l) => n + l.code + l.comments, 0);
  const crops = counted ? languageShares(counted.languages, undefined).length : undefined;
  const busy = languages.isFetching || activity.isFetching;
  const notCounted = !!languages.error;
  return (
    <section className="flex flex-wrap items-center gap-4 rounded-lg border border-line bg-page p-4">
      <span className="flex size-24 shrink-0 items-center justify-center rounded-lg bg-hover">
        <Icon name={`plot-${growth.crop}`} size={80} label={`长势：${growth.label}`} />
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <h2 className="truncate text-xl font-semibold">{project.name}</h2>
          <span className="rounded bg-leaf-300/50 px-1.5 text-xs">长势 · {growth.label}</span>
        </div>
        <div className="flex flex-wrap gap-x-6 gap-y-2">
          <Stat label="开垦于" value={worked?.first !== undefined ? dateText(worked.first) : worked ? "还没动过土" : "…"} />
          <Stat label="耕作" value={worked ? `${number(worked.total)} 次提交` : "…"} />
          <Stat label="庄稼" value={lines !== undefined ? `${number(lines)} 行` : notCounted ? "没数" : "…"} />
          <Stat label="种了" value={crops !== undefined ? `${crops} 样` : notCounted ? "没数" : "…"} />
        </div>
        <div className="flex items-center gap-1.5">
          <Icon name="button-folder" size={14} />
          <span className="min-w-0 truncate font-mono text-xs text-muted" title={project.path}>
            {project.path}
          </span>
          <button
            type="button"
            title="复制路径"
            aria-label="复制路径"
            className="cursor-pointer rounded p-1 hover:bg-hover"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(project.path);
                toast(`复制好了：${project.path}`);
              } catch {
                toast("复制不了：选中路径自己复制吧。");
              }
            }}
          >
            <Icon name="button-copy" size={14} />
          </button>
        </div>
      </div>
      <div className="flex flex-col items-end gap-1">
        <button
          type="button"
          title={busy ? "在数……" : "重新统计"}
          aria-label="重新统计"
          disabled={busy}
          onClick={() => {
            void languages.refetch();
            void activity.refetch();
          }}
          className="cursor-pointer rounded-md border border-line p-1.5 hover:bg-hover disabled:opacity-50"
        >
          <Icon name="button-refresh" size={16} />
        </button>
        {counted && <span className="text-xs text-muted">{since(counted.at, now)}数过</span>}
      </div>
    </section>
  );
}

/** A thin rounded bar, filled to its share. */
const Bar = ({ share, color }: { share: number; color: string }) => (
  <span className="block h-1.5 overflow-hidden rounded-full bg-hover">
    <span className="block h-full rounded-full" style={{ width: `${Math.min(1, Math.max(0, share)) * 100}%`, background: color }} />
  </span>
);

/** A share wide enough carries its language's picture in the bed. */
const logoInBed = 0.07;

function Planted({ languages }: { languages: Asked<ProjectLanguages> }) {
  const shares = languages.data ? languageShares(languages.data.languages) : [];
  let body;
  if (languages.error && !languages.data) body = <NotCounted reason={reasonOf(languages.error)} />;
  else if (!languages.data) body = <div className="h-12 rounded-md bg-hover" />;
  else if (shares.length === 0) body = <Quiet>这块地还空着：没有数得出来的代码。</Quiet>;
  else
    body = (
      <>
        {/* The bed itself, soil under the crops: it keeps the farm's brown. */}
        <div
          role="img"
          aria-label={shares.map((s) => `${s.label} ${percent(s.share)}`).join("，")}
          className="flex h-14 overflow-hidden rounded-md bg-[#7a5a3a] p-1"
        >
          {shares.map((s) => (
            <span
              key={s.id + s.label}
              title={`${s.label} · ${percent(s.share)}`}
              className="flex min-w-1 items-center justify-center"
              style={{ flexGrow: Math.max(1, Math.round(s.share * 10000)), background: s.color }}
            >
              {s.share >= logoInBed && <Icon name={langIcon(s.id)} size={36} />}
            </span>
          ))}
        </div>
        <div className="grid gap-x-6 gap-y-2 sm:grid-cols-2">
          {shares.map((s) => (
            <div key={s.id + s.label} className="flex items-center gap-3">
              <Icon name={langIcon(s.id)} size={32} />
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <span className="flex text-sm">
                  <span className="min-w-0 flex-1 truncate font-medium">{s.label}</span>
                  <span className="text-muted">{percent(s.share)}</span>
                </span>
                <Bar share={s.share < 0.02 ? 0.02 : s.share} color={s.color} />
                <span className="text-xs text-muted">
                  {number(s.lines)} 行 · {number(s.files)} 个文件
                </span>
              </div>
            </div>
          ))}
        </div>
      </>
    );
  return (
    <Card title="种了什么" action={<span className="text-xs text-muted">按行数，不算空行 · tokei 数的</span>}>
      {body}
    </Card>
  );
}

function NotCounted({ reason }: { reason: string }) {
  const install = reason.includes("brew install tokei");
  const code = (t: string) => <code className="rounded bg-selected px-1.5 py-px font-mono text-sm">{t}</code>;
  return (
    <div className="flex flex-col gap-2 rounded-lg bg-hover p-3 text-sm">
      <p>{install ? "数庄稼要用 tokei，这台机器上还没有。" : reason}</p>
      {install && (
        <p className="text-muted">
          在终端里装一个：{code("brew install tokei")}（或 {code("cargo install tokei")}），装好点上面的「重新统计」。
        </p>
      )}
    </div>
  );
}

const levelName = ["空地", "撒了种", "发了芽", "长了叶", "开了花"];
const tile = 12;
const tileGap = 3;

function TillingCalendar({ activity }: { activity: Asked<ProjectActivity> }) {
  const [pointed, setPointed] = useState<CalendarDay>();
  const worked = activity.data;
  const today = new Date().toDateString();
  const calendar = useMemo(() => calendarOf(worked?.days ?? [], new Date()), [worked, today]);
  const streaks = useMemo(() => streaksOf(calendar), [calendar]);
  const aside = <span className="text-xs text-muted">过去一年 · 一格一天，提交越多长得越高</span>;
  if (activity.error && !worked)
    return (
      <Card title="耕作日历" action={aside}>
        <p className="text-sm">{reasonOf(activity.error)}</p>
      </Card>
    );
  const busiest = streaks.busiest;
  const line =
    pointed && !pointed.future
      ? `${dayText(pointed.at)} · ${pointed.commits > 0 ? `${pointed.commits} 次提交，${levelName[pointed.level]}` : "没动土"}`
      : busiest
        ? `最忙的一天：${dayText(new Date(`${busiest.day}T12:00`))}，${busiest.commits} 次提交`
        : " ";
  return (
    <Card title="耕作日历" action={aside}>
      <div className="grid grid-cols-4 gap-6">
        <Stat label="一年里" value={worked ? `${number(streaks.total)} 次提交` : "…"} />
        <Stat label="动过土的日子" value={worked ? `${streaks.days} 天` : "…"} />
        <Stat label="最长连着干" value={worked ? `${streaks.longest} 天` : "…"} />
        <Stat label="最近连着干" value={worked ? `${streaks.current} 天` : "…"} />
      </div>
      <div className="overflow-x-auto pb-1">
        <div className="min-w-[704px]">
          <div className="relative h-4" style={{ width: 20 + calendar.weeks.length * (tile + tileGap) }}>
            {calendar.months.map((m) => (
              <span key={m.week} className="absolute top-0 text-xs text-muted" style={{ left: 20 + tileGap + m.week * (tile + tileGap) }}>
                {m.label}
              </span>
            ))}
          </div>
          <div
            role="img"
            aria-label={worked ? `过去一年 ${streaks.total} 次提交，${streaks.days} 天动过土` : "在读提交"}
            className="mt-1 flex"
            onMouseLeave={() => setPointed(undefined)}
          >
            <div className="flex w-5 flex-col" style={{ gap: tileGap }}>
              {["", "一", "", "三", "", "五", ""].map((d, i) => (
                <span key={i} className="flex items-center text-[10px] leading-none text-muted" style={{ height: tile }}>
                  {d}
                </span>
              ))}
            </div>
            {calendar.weeks.map((week, w) => (
              <div key={w} className="flex flex-col" style={{ gap: tileGap, marginLeft: tileGap }}>
                {week.map((d) => (
                  <span key={d.day} onMouseEnter={() => setPointed(d)} style={{ opacity: d.future ? 0 : worked ? 1 : 0.5 }}>
                    <Icon name={`day-${d.level}`} size={tile} />
                  </span>
                ))}
              </div>
            ))}
          </div>
        </div>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-xs text-muted">{line}</span>
        <span className="flex items-center gap-1 text-xs text-muted">
          少
          {levelName.map((n, l) => (
            <span key={l} title={n}>
              <Icon name={`day-${l}`} size={tile} />
            </span>
          ))}
          多
        </span>
      </div>
    </Card>
  );
}

const hands = 8;

function Hands({ activity }: { activity?: ProjectActivity }) {
  const agents = useWorkAgents();
  const authors = activity?.authors ?? [];
  if (authors.length === 0) return null;
  const top = authors[0]!.commits > 0 ? authors[0]!.commits : 1;
  const rest = authors.slice(hands).reduce((n, a) => n + a.commits, 0);
  return (
    <Card title="谁来干过活" action={<span className="text-xs text-muted">过去一年的提交</span>}>
      <div className="grid gap-2.5 sm:grid-cols-2">
        {authors.slice(0, hands).map((author) => {
          const agent = agents.find((a) => a.name === author.name);
          return (
            <div key={author.name} className="flex items-center gap-3">
              {agent ? (
                <AgentFace agentId={agent.id} look={agent.look} size={32} />
              ) : (
                <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-selected text-sm font-medium">
                  {[...author.name][0] ?? ""}
                </span>
              )}
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <span className="flex text-sm">
                  <span className="min-w-0 flex-1 truncate font-medium">{author.name}</span>
                  <span className="text-xs text-muted">{number(author.commits)} 次</span>
                </span>
                <Bar share={author.commits / top} color="#74a046" />
              </div>
            </div>
          );
        })}
      </div>
      {rest > 0 && (
        <p className="text-xs text-muted">
          还有 {authors.length - hands} 位，一共 {number(rest)} 次。
        </p>
      )}
    </Card>
  );
}

/** The name follows the repository's until it is typed by hand; what would be refused is the server's answer. */
function NewProjectForm({ onDone }: { onDone: (made?: ProjectSummary) => void }) {
  const client = useQueryClient();
  const [importing, setImporting] = useState<"new" | "github">("github");
  const [github, setGithub] = useState("");
  const [name, setName] = useState("");
  const [named, setNamed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const request = { name: name.trim(), ...(importing === "github" ? { github: github.trim() } : {}) };
  const ready = !busy && name.trim() !== "" && (importing === "new" || github.trim() !== "");
  const submit = async () => {
    if (!ready) return;
    setBusy(true);
    setError(undefined);
    try {
      const problem = (await api.project.check({ body: request })).problem;
      if (problem) {
        setError(problem);
        return;
      }
      const made = await api.project.create({ body: request });
      await client.invalidateQueries({ queryKey: ["projects"] });
      onDone(made);
    } catch (e) {
      setError(reasonOf(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <div>
        <Segmented
          label="怎么来"
          value={importing}
          options={[
            { value: "new", label: "开一块新地", disabled: busy },
            { value: "github", label: "去别人家看看", disabled: busy },
          ]}
          onChange={(v) => {
            setImporting(v);
            setError(undefined);
          }}
        />
      </div>
      {importing === "github" && (
        <Field label="GitHub 地址" hint="公开仓库的主页地址。下载到本地后，就能查看项目和安排帮工。">
          <TextInput
            autoFocus
            aria-label="GitHub 地址"
            disabled={busy}
            placeholder="https://github.com/botiverse/raft-source"
            value={github}
            onChange={(e) => {
              setGithub(e.target.value);
              if (!named) setName(githubRepository(e.target.value)?.name ?? "");
              setError(undefined);
            }}
          />
        </Field>
      )}
      <Field label="项目名" hint="保存在工作目录里；已有同名项目不会被覆盖。">
        <TextInput
          aria-label="项目名"
          disabled={busy}
          placeholder="比如 raft-source"
          value={name}
          onChange={(e) => {
            setNamed(true);
            setName(e.target.value);
            setError(undefined);
          }}
        />
      </Field>
      {error && (
        <p role="alert" className="text-sm text-berry">
          {error}
        </p>
      )}
      {busy && <p className="text-sm text-muted">{importing === "github" ? "正在下载仓库… 大仓库需要多等一会儿，最多 3 分钟。" : "正在开地…"}</p>}
      <div className="flex justify-end gap-2 pt-2">
        <Button disabled={busy} onClick={() => onDone()}>
          取消
        </Button>
        <Button type="submit" tone="primary" disabled={!ready}>
          {busy ? "进行中…" : importing === "github" ? "下载到农场" : "创建项目"}
        </Button>
      </div>
    </form>
  );
}
