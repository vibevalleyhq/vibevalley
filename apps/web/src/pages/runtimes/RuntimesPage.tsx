// 农具: the coding agents on this machine as oar probed them; one's account, what it takes,
// its settings, models and inventories, and the profiles that use it. /runtimes/<id>.

import { useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useState } from "react";
import { Link, useParams } from "react-router";
import {
  type Agent,
  type InventoryEntry,
  type RuntimeCapability,
  RuntimeCapabilityValues,
  type RuntimeInfo,
  type RuntimeSettings,
  sessionEffort,
  sessionEnv,
  type UsageWindow,
} from "@vibevalley/protocol";
import { same } from "@vibevalley/protocol/rules";
import { useWorkAgents } from "../../data/agents";
import { api, reasonOf } from "../../data/api";
import { useRuntimes } from "../../data/runtimes";
import { RuntimeIcon } from "../../farm/hud/QuotaPill";
import { bottleSprite, type Quota, quotaLevel, quotaOf, windowLabel } from "../../farm/hud/rules";
import { yuan } from "../../rules/chat";
import { momentText, wallClockText } from "../../rules/time";
import { Button } from "../../ui/Button";
import { KeyValueEditor } from "../../ui/Chips";
import { AgentFace } from "../../ui/Face";
import { Select, TextInput } from "../../ui/Field";
import { Icon } from "../../ui/Icon";
import { Segmented } from "../../ui/Segmented";
import { useToast } from "../../ui/Toast";
import { Card, ListCard, ListRow, Quiet, Split, Switch } from "../kit";

const capabilityLabel: Record<RuntimeCapability, string> = {
  listModels: "模型列表",
  accountUsage: "账户用量",
  checkUpdate: "检查更新",
  upgrade: "升级",
  skills: "技能清单",
  mcpServers: "MCP 清单",
  tools: "工具清单",
};

const statusOf = (r: RuntimeInfo) => {
  const i = r.installation;
  switch (i.status) {
    case "available":
      return r.settings.enabled ? (i.version ?? "可用") : "已停用";
    // The reason, not just 不支持: for vibevalley it is a missing DeepSeek key, which is the owner's to fix.
    case "unsupported":
      return i.reason || "不支持";
    case "not_found":
      return "没找到";
    case "checking":
      return "检测中…";
  }
};

const levelInk = { plenty: "#5a8234", low: "#e5a93c", gold: "#c8a02e", empty: "#c84a3a", unknown: "#9b7550" } as const;

/** The quota as a row of cells, filled to what is left. */
function Stamina({ quota, cells = 10, width, height }: { quota: Quota; cells?: number; width: number; height: number }) {
  const lit = Math.round(quota.fill * cells);
  return (
    <span
      role="meter"
      aria-label={quota.text}
      aria-valuenow={Math.round(quota.fill * 100)}
      className="inline-flex gap-px rounded-sm bg-bark-800 p-px"
      style={{ width, height }}
    >
      {Array.from({ length: cells }, (_, i) => (
        <span key={i} className="flex-1 rounded-[1px]" style={{ background: i < lit ? levelInk[quota.level] : "#fffaf022" }} />
      ))}
    </span>
  );
}

export function RuntimesPage() {
  const id = useParams()["*"] || undefined;
  const runtimes = useRuntimes();
  const agents = useWorkAgents();
  const list = runtimes.data ?? [];
  const selected = list.find((r) => r.id === id) ?? list[0];
  if (runtimes.error) return <p className="p-8 text-sm text-berry">读不到农机：{reasonOf(runtimes.error)}</p>;
  return (
    <div className="h-full p-3">
      <Split
        list={
          <ListCard title="农具" label="农具列表">
            <li className="px-2.5 pt-1 pb-1.5 text-xs text-muted">机器上的编码 agent</li>
            {list.map((r) => {
              const ok = r.installation.status === "available";
              const using = agents.filter((a) => a.runtime === r.id).length;
              const quota = quotaOf(r);
              return (
                <ListRow
                  key={r.id}
                  to={`/runtimes/${r.id}`}
                  active={selected?.id === r.id}
                  title={r.preset.label}
                  line={`${statusOf(r)}${using > 0 ? ` · ${using} 个 agent` : ""}`}
                  leading={
                    <span className={ok ? "" : "opacity-50 grayscale"}>
                      <RuntimeIcon runtime={r.id} size={36} />
                    </span>
                  }
                  trailing={
                    <span className="flex flex-col items-end gap-1">
                      <span className={`size-2 rounded-full ${ok ? (r.settings.enabled ? "bg-leaf" : "bg-faint") : "bg-berry"}`} aria-hidden />
                      {ok && quota.level !== "unknown" && <Stamina quota={quota} width={60} height={7} />}
                    </span>
                  }
                />
              );
            })}
          </ListCard>
        }
      >
        {!selected ? <Quiet>读取中…</Quiet> : <Detail key={selected.id} info={selected} agents={agents.filter((a) => a.runtime === selected.id)} />}
      </Split>
    </div>
  );
}

function Detail({ info, agents }: { info: RuntimeInfo; agents: Agent[] }) {
  const client = useQueryClient();
  const toast = useToast();
  const [refreshing, setRefreshing] = useState(false);
  const inst = info.installation;
  const keep = (got: RuntimeInfo) => client.setQueryData<RuntimeInfo[]>(["runtimes"], (all) => all?.map((r) => (r.id === got.id ? got : r)));
  const refresh = async () => {
    setRefreshing(true);
    try {
      keep(await api.runtime.refresh({ id: info.id }));
    } catch (e) {
      toast(reasonOf(e));
    } finally {
      setRefreshing(false);
    }
  };
  return (
    <div className="flex max-w-4xl flex-col gap-3">
      <div className="flex items-center gap-4 px-1 pt-1 pb-2">
        <span
          className="flex size-18 shrink-0 items-center justify-center rounded-lg border border-line"
          style={{ background: `radial-gradient(70% 70% at 50% 70%, ${info.preset.look.hat}33, var(--color-page))` }}
        >
          <span className={inst.status === "available" ? "" : "opacity-50 grayscale"}>
            <RuntimeIcon runtime={info.id} size={60} />
          </span>
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <h2 className="text-xl font-semibold">{info.preset.label}</h2>
          <p className="text-sm text-muted">{info.preset.blurb}</p>
          <div className="flex flex-wrap items-center gap-2 pt-1 text-xs text-muted">
            {inst.status === "available" && (
              <>
                <span className="rounded bg-[#e3efd2] px-1.5 text-[#3f6427]">可用 {inst.version ?? ""}</span>
                <span className="font-mono">{inst.command}</span>
                <span>{inst.via === "bundled" ? "随 oar 一起装" : "命令行"}</span>
              </>
            )}
            {inst.status === "unsupported" && <span className="rounded bg-[#f6ddd8] px-1.5 text-berry">不支持：{inst.reason}</span>}
            {inst.status === "not_found" && <span className="rounded bg-[#f6ddd8] px-1.5 text-berry">这台机器上没找到</span>}
            {inst.status === "checking" ? <span>检测中…</span> : <span>检测于 {wallClockText(info.checkedAt)}</span>}
          </div>
        </div>
        <Button disabled={refreshing} onClick={refresh}>
          {refreshing ? "检测中…" : "重新检测"}
        </Button>
      </div>
      <div className="grid gap-3 md:grid-cols-2">
        <Card title="账户">
          <Usage info={info} />
        </Card>
        <FactsCard info={info} />
      </div>
      <SettingsCard info={info} onSaved={keep} />
      <ModelsCard info={info} />
      <div className="grid gap-3 md:grid-cols-3">
        <InventoryCard title="技能" entries={info.skills} />
        <InventoryCard title="MCP 服务器" entries={info.mcpServers} />
        <InventoryCard title="工具" entries={info.tools} />
      </div>
      <Card
        title="用到它的 agent"
        action={
          <Link to={`/agents/new?runtime=${encodeURIComponent(info.id)}`} className="text-xs text-muted underline hover:text-ink">
            用它捏一个新 agent →
          </Link>
        }
      >
        {agents.length === 0 ? (
          <Quiet>还没有。</Quiet>
        ) : (
          <div className="flex flex-wrap gap-2">
            {agents.map((a) => (
              <Link
                key={a.id}
                to={`/agents/${encodeURIComponent(a.id)}`}
                className="flex items-center gap-1.5 rounded-md border border-line py-1 pr-3 pl-1 text-sm hover:bg-hover"
              >
                <AgentFace agentId={a.id} look={a.look} size={26} />
                {a.name}
              </Link>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}

function Usage({ info }: { info: RuntimeInfo }) {
  const usage = info.usage;
  if (!usage) return <Quiet>{info.facts.capabilities.includes("accountUsage") ? "装好以后才能读到。" : "这个 runtime 不报告账户用量。"}</Quiet>;
  if (usage.status === "login_required") return <p className="text-xs text-[#b8682a]">没登录。在这台机器上运行 {info.preset.label} 登录一次。</p>;
  if (usage.status === "unavailable") return <Quiet>读不到：{usage.reason}</Quiet>;
  const quota = quotaOf(info);
  return (
    <div className="flex items-start gap-3">
      <span className="flex w-14 shrink-0 flex-col items-center">
        <Icon name={bottleSprite(quota)} size={52} />
        <span className="text-sm">{quota.short || "—"}</span>
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-2.5">
        {usage.status === "balance" ? (
          <>
            <p className={`text-sm ${usage.available ? "" : "text-berry"}`}>
              按量计费，这里是 {usage.provider} 账户余额{usage.available ? "。" : "，不够用了。"}
            </p>
            <p className="text-sm text-muted">
              今天帮工花了约 {yuan(info.spentToday ?? 0)}
              {(info.settings.dailyBudget ?? 0) > 0 ? `，每日预算 ${yuan(info.settings.dailyBudget!)}` : "，没设每日预算"}。
            </p>
          </>
        ) : (
          <>
            {usage.subscription && <p className="text-sm text-muted">套餐：{usage.subscription}</p>}
            {usage.windows.map((w) => (
              <Window key={w.label} window={w} />
            ))}
          </>
        )}
      </div>
    </div>
  );
}

const pct = (n: number) => String(Math.round(n * 100) / 100);

function Window({ window: w }: { window: UsageWindow }) {
  const left = 100 - w.usedPercent;
  const label = windowLabel(w.label);
  return (
    <div className="flex flex-col gap-1">
      <span className="flex text-xs">
        <span className="flex-1 text-muted">{label}</span>剩 {pct(left)}%
      </span>
      <Stamina quota={{ level: quotaLevel(left), fill: left / 100, short: `${pct(left)}%`, text: `${label} 剩 ${pct(left)}%` }} width={220} height={10} />
      {w.resetsAt !== null && <span className="text-xs text-muted">{momentText(w.resetsAt)} 重置</span>}
    </div>
  );
}

function FactsCard({ info }: { info: RuntimeInfo }) {
  const facts = info.facts;
  const refused = Object.entries(facts.refused);
  return (
    <Card title="能做什么">
      <div className="flex flex-col gap-1.5">
        <span className="flex items-start gap-1.5 text-sm">
          <Icon name={facts.steer ? "mark-check" : "mark-cross"} size={12} className="mt-1" />
          {facts.steer ? "干活时能接话（steer）" : "干活时不能插话，话会排到这一轮之后"}
        </span>
        <span className="text-sm">{facts.inProcess ? "· 跑在 server 进程里（Node SDK）" : "· 作为单独的命令行进程运行"}</span>
        <span className="pt-2 text-xs font-medium text-muted">不接受的开 session 参数</span>
        {refused.length === 0 ? (
          <span className="text-sm">都接受。</span>
        ) : (
          refused.map(([k, v]) => (
            <span key={k} className="text-sm">
              <span className="font-mono">{k}</span> <span className="text-xs text-muted">{v}</span>
            </span>
          ))
        )}
        <span className="pt-2 text-xs font-medium text-muted">oar 提供的查询</span>
        <div className="flex flex-wrap gap-1">
          {RuntimeCapabilityValues.map((c) => {
            const has = facts.capabilities.includes(c);
            return (
              <span key={c} className={`rounded px-1.5 py-px text-xs ${has ? "bg-selected" : "border border-line text-muted line-through"}`}>
                {capabilityLabel[c]}
              </span>
            );
          })}
        </div>
      </div>
    </Card>
  );
}

/** The text is kept as typed, the number follows it (empty or 0 means none). */
function NumberInput({
  value,
  onChange,
  placeholder,
  label,
}: {
  value?: number;
  onChange: (n: number | undefined) => void;
  placeholder: string;
  label: string;
}) {
  const [text, setText] = useState(value ? String(value) : "");
  return (
    <TextInput
      aria-label={label}
      className="font-mono"
      placeholder={placeholder}
      inputMode="decimal"
      value={text}
      onChange={(e) => {
        setText(e.target.value);
        const n = Number(e.target.value.trim());
        onChange(e.target.value.trim() && Number.isFinite(n) && n > 0 ? n : undefined);
      }}
    />
  );
}

function SettingsCard({ info, onSaved }: { info: RuntimeInfo; onSaved: (got: RuntimeInfo) => void }) {
  const [draft, setDraft] = useState<RuntimeSettings>(info.settings);
  const [base, setBase] = useState(info.settings);
  const toast = useToast();
  // The settings as the server has them now replace the draft.
  if (!same(base, info.settings)) {
    setBase(info.settings);
    setDraft(info.settings);
  }
  const dirty = !same(draft, info.settings);
  const models = info.models ?? [];
  const wanted = draft.defaultModel || models.find((m) => m.isDefault)?.id;
  const model = models.find((m) => m.id === wanted);
  const refusedEffort = info.facts.refused[sessionEffort];
  const refusedEnv = info.facts.refused[sessionEnv];
  const effortHint = refusedEffort ?? ((model?.effortLevels.length ?? 0) > 0 ? undefined : "这个模型没有推理强度可选。");
  const save = async () => {
    try {
      onSaved(await api.runtime.update({ id: info.id, body: draft }));
    } catch (e) {
      toast(reasonOf(e));
    }
  };
  const field = (label: string, hint: string | undefined, control: ReactNode) => (
    <div className="flex flex-col gap-1">
      <span className="text-xs font-medium text-muted">{label}</span>
      {control}
      {hint && <span className="text-xs text-faint">{hint}</span>}
    </div>
  );
  return (
    <Card
      title="设置"
      action={
        dirty && (
          <span className="flex gap-2">
            <Button onClick={() => setDraft(info.settings)}>放弃</Button>
            <Button tone="primary" onClick={save}>
              保存
            </Button>
          </span>
        )
      }
    >
      <div className="grid gap-4 md:grid-cols-2">
        <Switch
          label="让 agent 用它"
          hint="停用后，用它的 agent 都派不出去。"
          checked={draft.enabled}
          onChange={(enabled) => setDraft({ ...draft, enabled })}
        />
        {field(
          "命令路径",
          `对应 oar 的 OAR_${info.id.toUpperCase()}_BIN。留空就在 PATH 里找。`,
          <TextInput
            aria-label="命令路径"
            className="font-mono"
            placeholder="自动查找"
            value={draft.binPath}
            onChange={(e) => setDraft({ ...draft, binPath: e.target.value })}
          />,
        )}
        {field(
          "默认模型",
          "agent 没指定模型时用它。",
          <Select
            label="默认模型"
            placeholder="runtime 自己的默认"
            value={draft.defaultModel}
            options={models.map((m) => ({ value: m.id, label: m.name }))}
            onChange={(defaultModel) => setDraft({ ...draft, defaultModel, defaultEffort: "" })}
          />,
        )}
        {field(
          "默认推理强度",
          effortHint,
          <div>
            <Segmented
              label="默认推理强度"
              value={draft.defaultEffort}
              options={[{ value: "", label: "默认" }, ...(model?.effortLevels ?? []).map((l) => ({ value: l, label: l, disabled: !!refusedEffort }))]}
              onChange={(defaultEffort) => setDraft({ ...draft, defaultEffort })}
            />
          </div>,
        )}
        {field(
          "最多同时干活",
          "用它的帮工同时干活的上限，服务商限并发时有用。到了上限，新活派不出去，等有人干完。留空只受农场自己的上限（6 块地）。",
          <NumberInput
            label="最多同时干活"
            placeholder="不另设"
            value={draft.maxWorking}
            onChange={(n) => {
              const { maxWorking: _, ...rest } = draft;
              setDraft(n === undefined ? rest : { ...rest, maxWorking: n });
            }}
          />,
        )}
        {(info.id === "pi" || info.id === "vibevalley") &&
          field(
            "每日预算（元）",
            `今天已经花了 ${yuan(info.spentToday ?? 0)}（按${info.id === "pi" ? " pi 的" : "模型的"}价目表估算）。到了预算就不再派新活，正在干的会干完。留空不设上限。`,
            <NumberInput
              label="每日预算"
              placeholder="不设上限"
              value={draft.dailyBudget}
              onChange={(n) => {
                const { dailyBudget: _, ...rest } = draft;
                setDraft(n === undefined ? rest : { ...rest, dailyBudget: n });
              }}
            />,
          )}
      </div>
      {field(
        "环境变量",
        refusedEnv ?? "叠加到这个 runtime 的每个 session 上；agent 自己的环境变量优先。",
        <KeyValueEditor value={draft.env} disabled={!!refusedEnv} onChange={(env) => setDraft({ ...draft, env })} />,
      )}
    </Card>
  );
}

function ModelsCard({ info }: { info: RuntimeInfo }) {
  const models = info.models;
  return (
    <Card title="模型" action={models && <span className="text-sm text-muted">{models.length} 个</span>}>
      {!models ? (
        <Quiet>{info.installation.status === "available" ? "这个 runtime 不报告模型列表。" : "装好以后才能读到。"}</Quiet>
      ) : (
        <table className="w-full text-left">
          <thead>
            <tr className="text-xs font-medium text-muted">
              <th className="pb-2 font-medium">模型</th>
              <th className="pb-2 font-medium">推理强度</th>
            </tr>
          </thead>
          <tbody>
            {models.map((m) => (
              <tr key={m.id} className="border-t border-line">
                <td className="py-1.5">
                  <span className="font-mono text-sm">{m.id}</span>
                  {m.isDefault && <span className="ml-2 rounded bg-[#e3efd2] px-1.5 text-xs text-[#3f6427]">默认</span>}
                </td>
                <td className="py-1.5 text-sm text-muted">{m.effortLevels.length === 0 ? "—" : m.effortLevels.join(" · ")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}

function InventoryCard({ title, entries }: { title: string; entries: InventoryEntry[] | null }) {
  return (
    <Card title={title} action={entries && <span className="text-sm text-muted">{entries.length}</span>}>
      {!entries ? (
        <Quiet>不报告。</Quiet>
      ) : entries.length === 0 ? (
        <Quiet>没有。</Quiet>
      ) : (
        <ul className="flex flex-col gap-1">
          {entries.map((e) => (
            <li key={e.name} className="flex flex-col">
              <span className={`font-mono text-sm ${e.enabled === false ? "text-muted line-through" : ""}`}>{e.name}</span>
              {e.description && <span className="truncate text-xs text-muted">{e.description}</span>}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
