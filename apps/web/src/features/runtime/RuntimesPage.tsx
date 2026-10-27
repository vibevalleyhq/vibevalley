// 农具: the coding agents on this machine as oar probed them; one's account, what it takes,
// its settings, models and inventories, and the profiles that use it. /runtimes/<id>.

import { runtimesWording } from "./words";
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
import { api, reasonOf } from "../../base/api";
import { bottleSprite, type Quota, quotaLevel, quotaOf, windowLabel } from "./quota";
import { momentText, wallClockText, yuan } from "../../base/format";
import { toast } from "../../ui/toasts";
import { A } from "../../ui/A";
import { Keyed } from "../../base/util";
import { useWorkAgents } from "../../base/agents";
import { ready, useRuntimes } from "../../base/query";
import { RuntimeIcon } from "../../ui/pixel/RuntimeIcon";
import { Button } from "../../ui/Button";
import { KeyValueEditor } from "../../ui/Chips";
import { AgentFace } from "../../ui/Face";
import { Select, TextInput } from "../../ui/Field";
import { Icon } from "../../ui/Icon";
import { Segmented } from "../../ui/Segmented";
import { Card, ListCard, ListRow, Quiet, Split, Toggle } from "../../ui/layout";

const capabilityLabel: Record<RuntimeCapability, string> = {
  listModels: runtimesWording().capability.listModels,
  accountUsage: runtimesWording().capability.accountUsage,
  checkUpdate: runtimesWording().capability.checkUpdate,
  upgrade: runtimesWording().capability.upgrade,
  skills: runtimesWording().capability.skills,
  mcpServers: runtimesWording().capability.mcpServers,
  tools: runtimesWording().capability.tools,
};

const statusOf = (r: RuntimeInfo) => {
  const i = r.installation;
  switch (i.status) {
    case "available":
      return r.settings.enabled ? (i.version ?? runtimesWording().available) : runtimesWording().disabled;
    // The reason, not just 不支持: for vibevalley it is a missing DeepSeek key, which is the owner's to fix.
    case "unsupported":
      return i.reason || runtimesWording().unsupported;
    case "not_found":
      return runtimesWording().notFound;
    case "checking":
      return runtimesWording().checking;
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
    <Show
      when={!runtimes.error}
      fallback={
        <p class="p-8 text-sm text-berry">
          {runtimesWording().noRuntimes}
          {reasonOf(runtimes.error)}
        </p>
      }
    >
      <div class="h-full p-3">
        <Split
          list={
            <ListCard title={runtimesWording().title} label={runtimesWording().list}>
              <li class="px-2.5 pt-1 pb-1.5 text-xs text-muted">{runtimesWording().intro}</li>
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
                      line={`${statusOf(r)}${using() > 0 ? runtimesWording().usedBy(using()) : ""}`}
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
          <Show when={selected()} fallback={<Quiet>{runtimesWording().reading}</Quiet>}>
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
                    <span class="rounded bg-[#e3efd2] px-1.5 text-[#3f6427]">
                      {runtimesWording().available} {i().version ?? ""}
                    </span>
                    <span class="font-mono">{i().command}</span>
                    <span>{i().via === "bundled" ? runtimesWording().bundled : runtimesWording().commandLine}</span>
                  </>
                )}
              </Match>
              <Match when={inst().status === "unsupported" ? (inst() as Extract<RuntimeInfo["installation"], { status: "unsupported" }>) : undefined}>
                {(i) => <span class="rounded bg-[#f6ddd8] px-1.5 text-berry">{runtimesWording().unsupportedWhy(i().reason)}</span>}
              </Match>
              <Match when={inst().status === "not_found"}>
                <span class="rounded bg-[#f6ddd8] px-1.5 text-berry">{runtimesWording().notHere}</span>
              </Match>
            </Switch>
            <Show when={inst().status !== "checking"} fallback={<span>{runtimesWording().checking}</span>}>
              <span>{runtimesWording().checkedAt(wallClockText(props.info.checkedAt))}</span>
            </Show>
          </div>
        </div>
        <Button disabled={refreshing()} onClick={() => void refresh()}>
          {refreshing() ? runtimesWording().checking : runtimesWording().recheck}
        </Button>
      </div>
      <div class="grid gap-3 md:grid-cols-2">
        <Card title={runtimesWording().account}>
          <Usage info={props.info} />
        </Card>
        <FactsCard info={props.info} />
      </div>
      <SettingsCard info={props.info} onSaved={keep} />
      <ModelsCard info={props.info} />
      <div class="grid gap-3 md:grid-cols-3">
        <InventoryCard title={runtimesWording().skills} entries={props.info.skills} />
        <InventoryCard title={runtimesWording().mcp} entries={props.info.mcpServers} />
        <InventoryCard title={runtimesWording().tools} entries={props.info.tools} />
      </div>
      <Card
        title={runtimesWording().agents}
        action={
          <A href={`/agents/new?runtime=${encodeURIComponent(props.info.id)}`} class="text-xs text-muted underline hover:text-ink">
            {runtimesWording().makeAgent}
          </A>
        }
      >
        <Show when={props.agents.length > 0} fallback={<Quiet>{runtimesWording().noneYet}</Quiet>}>
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
      fallback={<Quiet>{props.info.facts.capabilities.includes("accountUsage") ? runtimesWording().afterInstall : runtimesWording().noUsage}</Quiet>}
    >
      {(usage) => (
        <Switch>
          <Match when={usage().status === "login_required"}>
            <p class="text-xs text-[#b8682a]">{runtimesWording().signedOut(props.info.preset.label)}</p>
          </Match>
          <Match when={usage().status === "unavailable" ? (usage() as Extract<Usage, { status: "unavailable" }>) : undefined}>
            {(u) => <Quiet>{runtimesWording().unreadable(u().reason)}</Quiet>}
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
                        <p class={["text-sm", { "text-berry": !u().available }]}>{runtimesWording().balance(u().provider, u().available)}</p>
                        <p class="text-sm text-muted">
                          {runtimesWording().spentToday(
                            yuan(props.info.spentToday ?? 0),
                            (props.info.settings.dailyBudget ?? 0) > 0 ? yuan(props.info.settings.dailyBudget!) : undefined,
                          )}
                        </p>
                      </>
                    )}
                  </Match>
                  <Match when={usage().status === "ok" ? (usage() as Extract<Usage, { status: "ok" }>) : undefined}>
                    {(u) => (
                      <>
                        <Show when={u().subscription}>
                          <p class="text-sm text-muted">{runtimesWording().subscription(u().subscription ?? "")}</p>
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
        <span class="flex-1 text-muted">{label()}</span>
        {runtimesWording().left(pct(left()))}
      </span>
      <Stamina
        quota={{ level: quotaLevel(left()), fill: left() / 100, short: `${pct(left())}%`, text: runtimesWording().windowLeft(label(), pct(left())) }}
        width={220}
        height={10}
      />
      <Show when={props.window.resetsAt}>{(at) => <span class="text-xs text-muted">{runtimesWording().resets(momentText(at()))}</span>}</Show>
    </div>
  );
}

function FactsCard(props: { info: RuntimeInfo }) {
  const facts = () => props.info.facts;
  const refused = () => Object.entries(facts().refused);
  return (
    <Card title={runtimesWording().can}>
      <div class="flex flex-col gap-1.5">
        <span class="flex items-start gap-1.5 text-sm">
          <Icon name={facts().steer ? "mark-check" : "mark-cross"} size={12} class="mt-1" />
          {facts().steer ? runtimesWording().steer : runtimesWording().noSteer}
        </span>
        <span class="text-sm">{facts().inProcess ? runtimesWording().inProcess : runtimesWording().ownProcess}</span>
        <span class="pt-2 text-xs font-medium text-muted">{runtimesWording().refused}</span>
        <Show when={refused().length > 0} fallback={<span class="text-sm">{runtimesWording().acceptsAll}</span>}>
          <For each={refused()}>
            {([k, v]) => (
              <span class="text-sm">
                <span class="font-mono">{k}</span> <span class="text-xs text-muted">{v}</span>
              </span>
            )}
          </For>
        </Show>
        <span class="pt-2 text-xs font-medium text-muted">{runtimesWording().queries}</span>
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
  const effortHint = () => refusedEffort() ?? ((model()?.effortLevels.length ?? 0) > 0 ? undefined : runtimesWording().noEffort);
  const save = async () => {
    const id = props.info.id;
    const body = draft();
    try {
      props.onSaved(await api.runtime.setting.update({ id, ...body }));
    } catch (e) {
      toast(reasonOf(e));
    }
  };
  const budgeted = () => props.info.id === "pi" || props.info.id === "vibevalley";
  return (
    <Card
      title={runtimesWording().settings}
      action={
        <Show when={dirty()}>
          <span class="flex gap-2">
            <Button onClick={() => setDraft(props.info.settings)}>{runtimesWording().discard}</Button>
            <Button tone="primary" onClick={() => void save()}>
              {runtimesWording().save}
            </Button>
          </span>
        </Show>
      }
    >
      <div class="grid gap-4 md:grid-cols-2">
        <Toggle
          label={runtimesWording().enabled}
          hint={runtimesWording().enabledHint}
          checked={draft().enabled}
          onChange={(enabled) => setDraft({ ...draft(), enabled })}
        />
        <Field label={runtimesWording().binPath} hint={runtimesWording().binPathHint(props.info.id.toUpperCase())}>
          <TextInput
            aria-label={runtimesWording().binPath}
            class="font-mono"
            placeholder={runtimesWording().auto}
            value={draft().binPath}
            onInput={(e) => setDraft({ ...draft(), binPath: e.currentTarget.value })}
          />
        </Field>
        <Field label={runtimesWording().defaultModel} hint={runtimesWording().defaultModelHint}>
          <Select
            label={runtimesWording().defaultModel}
            placeholder={runtimesWording().ownDefault}
            value={draft().defaultModel}
            options={models().map((m) => ({ value: m.id, label: m.name }))}
            onChange={(defaultModel) => setDraft({ ...draft(), defaultModel, defaultEffort: "" })}
          />
        </Field>
        <Field label={runtimesWording().defaultEffort} hint={effortHint()}>
          <div>
            <Segmented
              label={runtimesWording().defaultEffort}
              value={draft().defaultEffort}
              options={[
                { value: "", label: runtimesWording().default },
                ...(model()?.effortLevels ?? []).map((l) => ({ value: l, label: l, disabled: !!refusedEffort() })),
              ]}
              onChange={(defaultEffort) => setDraft({ ...draft(), defaultEffort })}
            />
          </div>
        </Field>
        <Field label={runtimesWording().maxWorking} hint={runtimesWording().maxWorkingHint}>
          <NumberInput
            label={runtimesWording().maxWorking}
            placeholder={runtimesWording().noLimit}
            value={draft().maxWorking}
            onChange={(n) => {
              const { maxWorking: _, ...rest } = draft();
              setDraft(n === undefined ? rest : { ...rest, maxWorking: n });
            }}
          />
        </Field>
        <Show when={budgeted()}>
          <Field label={runtimesWording().budget} hint={runtimesWording().budgetHint(yuan(props.info.spentToday ?? 0), props.info.id === "pi")}>
            <NumberInput
              label={runtimesWording().budgetLabel}
              placeholder={runtimesWording().unlimited}
              value={draft().dailyBudget}
              onChange={(n) => {
                const { dailyBudget: _, ...rest } = draft();
                setDraft(n === undefined ? rest : { ...rest, dailyBudget: n });
              }}
            />
          </Field>
        </Show>
      </div>
      <Field label={runtimesWording().env} hint={refusedEnv() ?? runtimesWording().envHint}>
        <KeyValueEditor value={draft().env} disabled={!!refusedEnv()} onChange={(env) => setDraft({ ...draft(), env })} />
      </Field>
    </Card>
  );
}

function ModelsCard(props: { info: RuntimeInfo }) {
  return (
    <Card
      title={runtimesWording().models}
      action={<Show when={props.info.models}>{(m) => <span class="text-sm text-muted">{runtimesWording().modelCount(m().length)}</span>}</Show>}
    >
      <Show
        when={props.info.models}
        fallback={<Quiet>{props.info.installation.status === "available" ? runtimesWording().noModels : runtimesWording().afterInstall}</Quiet>}
      >
        {(models) => (
          <table class="w-full text-left">
            <thead>
              <tr class="text-xs font-medium text-muted">
                <th class="pb-2 font-medium">{runtimesWording().models}</th>
                <th class="pb-2 font-medium">{runtimesWording().effort}</th>
              </tr>
            </thead>
            <tbody>
              <For each={models()}>
                {(m) => (
                  <tr class="border-t border-line">
                    <td class="py-1.5">
                      <span class="font-mono text-sm">{m.id}</span>
                      <Show when={m.isDefault}>
                        <span class="ml-2 rounded bg-[#e3efd2] px-1.5 text-xs text-[#3f6427]">{runtimesWording().default}</span>
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
          <Quiet>{runtimesWording().unreported}</Quiet>
        </Match>
        <Match when={props.entries!.length === 0}>
          <Quiet>{runtimesWording().none}</Quiet>
        </Match>
      </Switch>
    </Card>
  );
}
