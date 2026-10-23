// 农具: the coding agents on this machine as oar probed them; one's account, what it takes,
// its settings, models and inventories, and the profiles that use it. /runtimes/<id>.

import { createMemo, createSignal, For, Match, Show, Switch, untrack } from "solid-js";
import type { JSX } from "@solidjs/web";
import { useQueryClient } from "@tanstack/solid-query";
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
import { api, reasonOf } from "../../data/api";
import { bottleSprite, type Quota, quotaLevel, quotaOf, windowLabel } from "../../rules/quota";
import { yuan } from "../../rules/chat";
import { momentText, wallClockText } from "../../rules/time";
import { toast } from "../../ui/toasts";
import { A } from "../../app/A";
import { Keyed } from "../../app/util";
import { useWorkAgents } from "../../data/agents";
import { ready, useRuntimes } from "../../data/query";
import { RuntimeIcon } from "../../farm/kit/RuntimeIcon";
import { Button } from "../../ui/Button";
import { KeyValueEditor } from "../../ui/Chips";
import { AgentFace } from "../../ui/Face";
import { Select, TextInput } from "../../ui/Field";
import { Icon } from "../../ui/Icon";
import { Segmented } from "../../ui/Segmented";
import { Card, ListCard, ListRow, Quiet, Split, Toggle } from "../kit";

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
function Stamina(props: { quota: Quota; cells?: number; width: number; height: number }) {
  const cells = () => props.cells ?? 10;
  const lit = () => Math.round(props.quota.fill * cells());
  return (
    <span
      role="meter"
      aria-label={props.quota.text}
      aria-valuenow={Math.round(props.quota.fill * 100)}
      class="inline-flex gap-px rounded-sm bg-bark-800 p-px"
      style={{ width: `${props.width}px`, height: `${props.height}px` }}
    >
      <For each={Array.from({ length: cells() }, (_, i) => i)}>
        {(i) => <span class="flex-1 rounded-[1px]" style={{ background: i < lit() ? levelInk[props.quota.level] : "#fffaf022" }} />}
      </For>
    </span>
  );
}

/** `rest` is the path after /runtimes/. */
export function RuntimesPage(props: { rest: string }) {
  const runtimes = useRuntimes();
  const agents = useWorkAgents();
  const list = () => ready(runtimes, []);
  const selected = () => list().find((r) => r.id === props.rest) ?? list()[0];
  return (
    <Show when={!runtimes.error} fallback={<p class="p-8 text-sm text-berry">读不到农机：{reasonOf(runtimes.error)}</p>}>
      <div class="h-full p-3">
        <Split
          list={
            <ListCard title="农具" label="农具列表">
              <li class="px-2.5 pt-1 pb-1.5 text-xs text-muted">机器上的编码 agent</li>
              <For each={list()}>
                {(r) => {
                  const ok = () => r.installation.status === "available";
                  const using = () => agents().filter((a) => a.runtime === r.id).length;
                  const quota = () => quotaOf(r);
                  return (
                    <ListRow
                      to={`/runtimes/${r.id}`}
                      active={selected()?.id === r.id}
                      title={r.preset.label}
                      line={`${statusOf(r)}${using() > 0 ? ` · ${using()} 个 agent` : ""}`}
                      leading={
                        <span class={{ "opacity-50 grayscale": !ok() }}>
                          <RuntimeIcon runtime={r.id} size={36} />
                        </span>
                      }
                      trailing={
                        <span class="flex flex-col items-end gap-1">
                          <span class={["size-2 rounded-full", ok() ? (r.settings.enabled ? "bg-leaf" : "bg-faint") : "bg-berry"]} aria-hidden="true" />
                          <Show when={ok() && quota().level !== "unknown"}>
                            <Stamina quota={quota()} width={60} height={7} />
                          </Show>
                        </span>
                      }
                    />
                  );
                }}
              </For>
            </ListCard>
          }
        >
          <Show when={selected()} fallback={<Quiet>读取中…</Quiet>}>
            {(s) => <Keyed key={s().id}>{() => <Detail info={s()} agents={agents().filter((a) => a.runtime === s().id)} />}</Keyed>}
          </Show>
        </Split>
      </div>
    </Show>
  );
}

function Detail(props: { info: RuntimeInfo; agents: Agent[] }) {
  const client = useQueryClient();
  const [refreshing, setRefreshing] = createSignal(false);
  const inst = () => props.info.installation;
  const keep = (got: RuntimeInfo) => client.setQueryData<RuntimeInfo[]>(["runtimes"], (all) => all?.map((r) => (r.id === got.id ? got : r)));
  const refresh = async () => {
    const id = props.info.id;
    setRefreshing(true);
    try {
      keep(await api.runtime.refresh({ id }));
    } catch (e) {
      toast(reasonOf(e));
    } finally {
      setRefreshing(false);
    }
  };
  return (
    <div class="flex max-w-4xl flex-col gap-3">
      <div class="flex items-center gap-4 px-1 pt-1 pb-2">
        <span
          class="flex size-18 shrink-0 items-center justify-center rounded-lg border border-line"
          style={{ background: `radial-gradient(70% 70% at 50% 70%, ${props.info.preset.look.hat}33, var(--color-page))` }}
        >
          <span class={{ "opacity-50 grayscale": inst().status !== "available" }}>
            <RuntimeIcon runtime={props.info.id} size={60} />
          </span>
        </span>
        <div class="flex min-w-0 flex-1 flex-col gap-0.5">
          <h2 class="text-xl font-semibold">{props.info.preset.label}</h2>
          <p class="text-sm text-muted">{props.info.preset.blurb}</p>
          <div class="flex flex-wrap items-center gap-2 pt-1 text-xs text-muted">
            <Switch>
              <Match when={inst().status === "available" ? (inst() as Extract<RuntimeInfo["installation"], { status: "available" }>) : undefined}>
                {(i) => (
                  <>
                    <span class="rounded bg-[#e3efd2] px-1.5 text-[#3f6427]">可用 {i().version ?? ""}</span>
                    <span class="font-mono">{i().command}</span>
                    <span>{i().via === "bundled" ? "随 oar 一起装" : "命令行"}</span>
                  </>
                )}
              </Match>
              <Match when={inst().status === "unsupported" ? (inst() as Extract<RuntimeInfo["installation"], { status: "unsupported" }>) : undefined}>
                {(i) => <span class="rounded bg-[#f6ddd8] px-1.5 text-berry">不支持：{i().reason}</span>}
              </Match>
              <Match when={inst().status === "not_found"}>
                <span class="rounded bg-[#f6ddd8] px-1.5 text-berry">这台机器上没找到</span>
              </Match>
            </Switch>
            <Show when={inst().status !== "checking"} fallback={<span>检测中…</span>}>
              <span>检测于 {wallClockText(props.info.checkedAt)}</span>
            </Show>
          </div>
        </div>
        <Button disabled={refreshing()} onClick={() => void refresh()}>
          {refreshing() ? "检测中…" : "重新检测"}
        </Button>
      </div>
      <div class="grid gap-3 md:grid-cols-2">
        <Card title="账户">
          <Usage info={props.info} />
        </Card>
        <FactsCard info={props.info} />
      </div>
      <SettingsCard info={props.info} onSaved={keep} />
      <ModelsCard info={props.info} />
      <div class="grid gap-3 md:grid-cols-3">
        <InventoryCard title="技能" entries={props.info.skills} />
        <InventoryCard title="MCP 服务器" entries={props.info.mcpServers} />
        <InventoryCard title="工具" entries={props.info.tools} />
      </div>
      <Card
        title="用到它的 agent"
        action={
          <A href={`/agents/new?runtime=${encodeURIComponent(props.info.id)}`} class="text-xs text-muted underline hover:text-ink">
            用它捏一个新 agent →
          </A>
        }
      >
        <Show when={props.agents.length > 0} fallback={<Quiet>还没有。</Quiet>}>
          <div class="flex flex-wrap gap-2">
            <For each={props.agents}>
              {(a) => (
                <A
                  href={`/agents/${encodeURIComponent(a.id)}`}
                  class="flex items-center gap-1.5 rounded-md border border-line py-1 pr-3 pl-1 text-sm hover:bg-hover"
                >
                  <AgentFace agentId={a.id} runtime={a.runtime} look={a.look} size={26} />
                  {a.name}
                </A>
              )}
            </For>
          </div>
        </Show>
      </Card>
    </div>
  );
}

type Usage = NonNullable<RuntimeInfo["usage"]>;

function Usage(props: { info: RuntimeInfo }) {
  const quota = () => quotaOf(props.info);
  return (
    <Show
      when={props.info.usage}
      fallback={<Quiet>{props.info.facts.capabilities.includes("accountUsage") ? "装好以后才能读到。" : "这个 runtime 不报告账户用量。"}</Quiet>}
    >
      {(usage) => (
        <Switch>
          <Match when={usage().status === "login_required"}>
            <p class="text-xs text-[#b8682a]">没登录。在这台机器上运行 {props.info.preset.label} 登录一次。</p>
          </Match>
          <Match when={usage().status === "unavailable" ? (usage() as Extract<Usage, { status: "unavailable" }>) : undefined}>
            {(u) => <Quiet>读不到：{u().reason}</Quiet>}
          </Match>
          <Match when={usage()}>
            <div class="flex items-start gap-3">
              <span class="flex w-14 shrink-0 flex-col items-center">
                <Icon name={bottleSprite(quota())} size={52} />
                <span class="text-sm">{quota().short || "—"}</span>
              </span>
              <div class="flex min-w-0 flex-1 flex-col gap-2.5">
                <Switch>
                  <Match when={usage().status === "balance" ? (usage() as Extract<Usage, { status: "balance" }>) : undefined}>
                    {(u) => (
                      <>
                        <p class={["text-sm", { "text-berry": !u().available }]}>
                          按量计费，这里是 {u().provider} 账户余额{u().available ? "。" : "，不够用了。"}
                        </p>
                        <p class="text-sm text-muted">
                          今天帮工花了约 {yuan(props.info.spentToday ?? 0)}
                          {(props.info.settings.dailyBudget ?? 0) > 0 ? `，每日预算 ${yuan(props.info.settings.dailyBudget!)}` : "，没设每日预算"}。
                        </p>
                      </>
                    )}
                  </Match>
                  <Match when={usage().status === "ok" ? (usage() as Extract<Usage, { status: "ok" }>) : undefined}>
                    {(u) => (
                      <>
                        <Show when={u().subscription}>
                          <p class="text-sm text-muted">套餐：{u().subscription}</p>
                        </Show>
                        <For each={u().windows}>{(w) => <Window window={w} />}</For>
                      </>
                    )}
                  </Match>
                </Switch>
              </div>
            </div>
          </Match>
        </Switch>
      )}
    </Show>
  );
}

const pct = (n: number) => String(Math.round(n * 100) / 100);

function Window(props: { window: UsageWindow }) {
  const left = () => 100 - props.window.usedPercent;
  const label = () => windowLabel(props.window.label);
  return (
    <div class="flex flex-col gap-1">
      <span class="flex text-xs">
        <span class="flex-1 text-muted">{label()}</span>剩 {pct(left())}%
      </span>
      <Stamina
        quota={{ level: quotaLevel(left()), fill: left() / 100, short: `${pct(left())}%`, text: `${label()} 剩 ${pct(left())}%` }}
        width={220}
        height={10}
      />
      <Show when={props.window.resetsAt}>{(at) => <span class="text-xs text-muted">{momentText(at())} 重置</span>}</Show>
    </div>
  );
}

function FactsCard(props: { info: RuntimeInfo }) {
  const facts = () => props.info.facts;
  const refused = () => Object.entries(facts().refused);
  return (
    <Card title="能做什么">
      <div class="flex flex-col gap-1.5">
        <span class="flex items-start gap-1.5 text-sm">
          <Icon name={facts().steer ? "mark-check" : "mark-cross"} size={12} class="mt-1" />
          {facts().steer ? "干活时能接话（steer）" : "干活时不能插话，话会排到这一轮之后"}
        </span>
        <span class="text-sm">{facts().inProcess ? "· 跑在 server 进程里（Node SDK）" : "· 作为单独的命令行进程运行"}</span>
        <span class="pt-2 text-xs font-medium text-muted">不接受的开 session 参数</span>
        <Show when={refused().length > 0} fallback={<span class="text-sm">都接受。</span>}>
          <For each={refused()}>
            {([k, v]) => (
              <span class="text-sm">
                <span class="font-mono">{k}</span> <span class="text-xs text-muted">{v}</span>
              </span>
            )}
          </For>
        </Show>
        <span class="pt-2 text-xs font-medium text-muted">oar 提供的查询</span>
        <div class="flex flex-wrap gap-1">
          <For each={RuntimeCapabilityValues}>
            {(c) => (
              <span class={["rounded px-1.5 py-px text-xs", facts().capabilities.includes(c) ? "bg-selected" : "border border-line text-muted line-through"]}>
                {capabilityLabel[c]}
              </span>
            )}
          </For>
        </div>
      </div>
    </Card>
  );
}

/** The text is kept as typed, the number follows it (empty or 0 means none). */
function NumberInput(props: { value?: number; onChange: (n: number | undefined) => void; placeholder: string; label: string }) {
  const [text, setText] = createSignal(untrack(() => (props.value ? String(props.value) : "")));
  return (
    <TextInput
      aria-label={props.label}
      class="font-mono"
      placeholder={props.placeholder}
      inputmode="decimal"
      value={text()}
      onInput={(e) => {
        const typed = e.currentTarget.value;
        setText(typed);
        const n = Number(typed.trim());
        props.onChange(typed.trim() && Number.isFinite(n) && n > 0 ? n : undefined);
      }}
    />
  );
}

function Field(props: { label: string; hint?: string; children: JSX.Element }) {
  return (
    <div class="flex flex-col gap-1">
      <span class="text-xs font-medium text-muted">{props.label}</span>
      {props.children}
      <Show when={props.hint}>
        <span class="text-xs text-faint">{props.hint}</span>
      </Show>
    </div>
  );
}

function SettingsCard(props: { info: RuntimeInfo; onSaved: (got: RuntimeInfo) => void }) {
  // The settings as the server has them now replace the draft; a refetch with the same settings leaves it.
  const saved = createMemo(() => props.info.settings, { equals: same });
  const [draft, setDraft] = createSignal<RuntimeSettings>(() => saved());
  const dirty = () => !same(draft(), props.info.settings);
  const models = () => props.info.models ?? [];
  const model = () => {
    const wanted = draft().defaultModel || models().find((m) => m.isDefault)?.id;
    return models().find((m) => m.id === wanted);
  };
  const refusedEffort = () => props.info.facts.refused[sessionEffort];
  const refusedEnv = () => props.info.facts.refused[sessionEnv];
  const effortHint = () => refusedEffort() ?? ((model()?.effortLevels.length ?? 0) > 0 ? undefined : "这个模型没有推理强度可选。");
  const save = async () => {
    const id = props.info.id;
    const body = draft();
    try {
      props.onSaved(await api.runtime.update({ id, body }));
    } catch (e) {
      toast(reasonOf(e));
    }
  };
  const budgeted = () => props.info.id === "pi" || props.info.id === "vibevalley";
  return (
    <Card
      title="设置"
      action={
        <Show when={dirty()}>
          <span class="flex gap-2">
            <Button onClick={() => setDraft(props.info.settings)}>放弃</Button>
            <Button tone="primary" onClick={() => void save()}>
              保存
            </Button>
          </span>
        </Show>
      }
    >
      <div class="grid gap-4 md:grid-cols-2">
        <Toggle
          label="让 agent 用它"
          hint="停用后，用它的 agent 都派不出去。"
          checked={draft().enabled}
          onChange={(enabled) => setDraft({ ...draft(), enabled })}
        />
        <Field label="命令路径" hint={`对应 oar 的 OAR_${props.info.id.toUpperCase()}_BIN。留空就在 PATH 里找。`}>
          <TextInput
            aria-label="命令路径"
            class="font-mono"
            placeholder="自动查找"
            value={draft().binPath}
            onInput={(e) => setDraft({ ...draft(), binPath: e.currentTarget.value })}
          />
        </Field>
        <Field label="默认模型" hint="agent 没指定模型时用它。">
          <Select
            label="默认模型"
            placeholder="runtime 自己的默认"
            value={draft().defaultModel}
            options={models().map((m) => ({ value: m.id, label: m.name }))}
            onChange={(defaultModel) => setDraft({ ...draft(), defaultModel, defaultEffort: "" })}
          />
        </Field>
        <Field label="默认推理强度" hint={effortHint()}>
          <div>
            <Segmented
              label="默认推理强度"
              value={draft().defaultEffort}
              options={[{ value: "", label: "默认" }, ...(model()?.effortLevels ?? []).map((l) => ({ value: l, label: l, disabled: !!refusedEffort() }))]}
              onChange={(defaultEffort) => setDraft({ ...draft(), defaultEffort })}
            />
          </div>
        </Field>
        <Field
          label="最多同时干活"
          hint="用它的帮工同时干活的上限，服务商限并发时有用。到了上限，新活派不出去，等有人干完。留空只受整个工作区的上限（同时 6 张工单）。"
        >
          <NumberInput
            label="最多同时干活"
            placeholder="不另设"
            value={draft().maxWorking}
            onChange={(n) => {
              const { maxWorking: _, ...rest } = draft();
              setDraft(n === undefined ? rest : { ...rest, maxWorking: n });
            }}
          />
        </Field>
        <Show when={budgeted()}>
          <Field
            label="每日预算（元）"
            hint={`今天已经花了 ${yuan(props.info.spentToday ?? 0)}（按${props.info.id === "pi" ? " pi 的" : "模型的"}价目表估算）。到了预算就不再派新活，正在干的会干完。留空不设上限。`}
          >
            <NumberInput
              label="每日预算"
              placeholder="不设上限"
              value={draft().dailyBudget}
              onChange={(n) => {
                const { dailyBudget: _, ...rest } = draft();
                setDraft(n === undefined ? rest : { ...rest, dailyBudget: n });
              }}
            />
          </Field>
        </Show>
      </div>
      <Field label="环境变量" hint={refusedEnv() ?? "叠加到这个 runtime 的每个 session 上；agent 自己的环境变量优先。"}>
        <KeyValueEditor value={draft().env} disabled={!!refusedEnv()} onChange={(env) => setDraft({ ...draft(), env })} />
      </Field>
    </Card>
  );
}

function ModelsCard(props: { info: RuntimeInfo }) {
  return (
    <Card title="模型" action={<Show when={props.info.models}>{(m) => <span class="text-sm text-muted">{m().length} 个</span>}</Show>}>
      <Show
        when={props.info.models}
        fallback={<Quiet>{props.info.installation.status === "available" ? "这个 runtime 不报告模型列表。" : "装好以后才能读到。"}</Quiet>}
      >
        {(models) => (
          <table class="w-full text-left">
            <thead>
              <tr class="text-xs font-medium text-muted">
                <th class="pb-2 font-medium">模型</th>
                <th class="pb-2 font-medium">推理强度</th>
              </tr>
            </thead>
            <tbody>
              <For each={models()}>
                {(m) => (
                  <tr class="border-t border-line">
                    <td class="py-1.5">
                      <span class="font-mono text-sm">{m.id}</span>
                      <Show when={m.isDefault}>
                        <span class="ml-2 rounded bg-[#e3efd2] px-1.5 text-xs text-[#3f6427]">默认</span>
                      </Show>
                    </td>
                    <td class="py-1.5 text-sm text-muted">{m.effortLevels.length === 0 ? "—" : m.effortLevels.join(" · ")}</td>
                  </tr>
                )}
              </For>
            </tbody>
          </table>
        )}
      </Show>
    </Card>
  );
}

function InventoryCard(props: { title: string; entries: InventoryEntry[] | null }) {
  return (
    <Card title={props.title} action={<Show when={props.entries}>{(e) => <span class="text-sm text-muted">{e().length}</span>}</Show>}>
      <Switch
        fallback={
          <ul class="flex flex-col gap-1">
            <For each={props.entries}>
              {(e) => (
                <li class="flex flex-col">
                  <span class={["font-mono text-sm", { "text-muted line-through": e.enabled === false }]}>{e.name}</span>
                  <Show when={e.description}>
                    <span class="truncate text-xs text-muted">{e.description}</span>
                  </Show>
                </li>
              )}
            </For>
          </ul>
        }
      >
        <Match when={!props.entries}>
          <Quiet>不报告。</Quiet>
        </Match>
        <Match when={props.entries!.length === 0}>
          <Quiet>没有。</Quiet>
        </Match>
      </Switch>
    </Card>
  );
}
