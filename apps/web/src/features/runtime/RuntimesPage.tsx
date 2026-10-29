import { Meter } from "@vibevalley/base-ui";
import { variant, Keyed } from "@/base/util";
import { t } from "@vibevalley/i18n";
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
import { api, reasonOf } from "@/base/api";
import { bottleSprite, type Quota, quotaLevel, quotaOf, windowLabel } from "./quota";
import { momentText, wallClockText, yuan } from "@/base/format";
import { toast } from "@/ui/toasts";
import { A } from "@/ui/A";
import { useWorkAgents } from "@/base/agents";
import { ready, useRuntimes } from "@/base/query";
import { RuntimeIcon } from "@/ui/pixel/RuntimeIcon";
import { Button } from "@/ui/Button";
import { KeyValueEditor } from "@/ui/Chips";
import { AgentFace } from "@/ui/Face";
import { Select, TextInput } from "@/ui/Field";
import { Icon } from "@/ui/Icon";
import { SpriteIcon } from "@/ui/pixel";
import { Segmented } from "@/ui/Segmented";
import { Card, ListCard, ListRow, Quiet, Split, Toggle } from "@/ui/layout";
import { Hint } from "@/ui/Tip";

const capabilityLabel: Record<RuntimeCapability, string> = {
  listModels: t("web.runtime.capability.listModels"),
  accountUsage: t("web.runtime.capability.accountUsage"),
  checkUpdate: t("web.runtime.capability.checkUpdate"),
  upgrade: t("web.runtime.capability.upgrade"),
  skills: t("web.runtime.capability.skills"),
  mcpServers: t("web.runtime.capability.mcpServers"),
  tools: t("web.runtime.capability.tools"),
};

const statusOf = (r: RuntimeInfo) => {
  const i = r.installation;
  switch (i.status) {
    case "available":
      return r.settings.enabled ? (i.version ?? t("web.runtime.available")) : t("web.runtime.disabled");
    // The reason, not just 不支持: for vibevalley it is a missing DeepSeek key, which is the owner's to fix.
    case "unsupported":
      return i.reason || t("web.runtime.unsupported");
    case "not_found":
      return t("web.runtime.notFound");
    case "checking":
      return t("web.runtime.checking");
  }
};

/** A cell's colour by how much is left: the palette's, so the bar follows the theme. */
const levelInk = { plenty: "bg-accent", low: "bg-wheat", gold: "bg-wheat", empty: "bg-berry", unknown: "bg-bark" } as const;

/** The quota as a row of cells, filled to what is left. */
function Stamina(props: { quota: Quota; cells?: number; width: number; height: number }) {
  const cells = () => props.cells ?? 10;
  const lit = () => Math.round(props.quota.fill * cells());
  return (
    <Meter.Root
      value={Math.round(props.quota.fill * 100)}
      aria-label={props.quota.text}
      class="inline-flex gap-px rounded-sm bg-bark-800 p-px"
      style={{ width: `${props.width}px`, height: `${props.height}px` }}
    >
      <For each={Array.from({ length: cells() }, (_, i) => i)}>
        {(i) => <span class={["flex-1 rounded-xs", i < lit() ? levelInk[props.quota.level] : "bg-on-rail/13"]} />}
      </For>
    </Meter.Root>
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
          {t("web.runtime.noRuntimes")}
          {reasonOf(runtimes.error)}
        </p>
      }
    >
      <div class="h-full p-3">
        <Split
          list={
            <ListCard title={t("web.runtime.title")} label={t("web.runtime.list")} testid="runtimes">
              <li class="px-2.5 pt-1 pb-1.5 text-xs text-muted">{t("web.runtime.intro")}</li>
              <For each={list()}>
                {(r) => {
                  const ok = () => r.installation.status === "available";
                  const using = () => agents().filter((a) => a.runtime === r.id).length;
                  const quota = () => quotaOf(r);
                  return (
                    <ListRow
                      to={`/runtimes/${r.id}`}
                      item={r.id}
                      active={selected()?.id === r.id}
                      title={r.preset.label}
                      line={`${statusOf(r)}${using() > 0 ? t("web.runtime.usedBy", { n: using() }) : ""}`}
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
          <Show when={selected()} fallback={<Quiet>{t("web.runtime.reading")}</Quiet>}>
            {(s) => <Keyed key={s().id}>{() => <Detail info={s()} agents={agents().filter((a) => a.runtime === s().id)} />}</Keyed>}
          </Show>
        </Split>
      </div>
    </Show>
  );
}

export function Detail(props: { info: RuntimeInfo; agents: Agent[] }) {
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
              <Match when={variant(inst(), "status", "available")}>
                {(i) => (
                  <>
                    <span class="rounded bg-ok-soft px-1.5 text-ok-ink">
                      {t("web.runtime.available")} {i().version ?? ""}
                    </span>
                    <span class="font-mono">{i().command}</span>
                    <span>{i().via === "bundled" ? t("web.runtime.bundled") : t("web.runtime.commandLine")}</span>
                  </>
                )}
              </Match>
              <Match when={variant(inst(), "status", "unsupported")}>
                {(i) => <span class="rounded bg-bad-soft px-1.5 text-berry">{t("web.runtime.unsupportedWhy", { why: i().reason })}</span>}
              </Match>
              <Match when={inst().status === "not_found"}>
                <span class="rounded bg-bad-soft px-1.5 text-berry">{t("web.runtime.notHere")}</span>
              </Match>
            </Switch>
            <Show when={inst().status !== "checking"} fallback={<span>{t("web.runtime.checking")}</span>}>
              <span>{t("web.runtime.checkedAt", { clock: wallClockText(props.info.checkedAt) })}</span>
            </Show>
          </div>
        </div>
        <Button disabled={refreshing()} onClick={() => void refresh()}>
          {refreshing() ? t("web.runtime.checking") : t("web.runtime.recheck")}
        </Button>
      </div>
      <div class="grid gap-3 md:grid-cols-2">
        <Card title={t("web.runtime.account")}>
          <Usage info={props.info} />
        </Card>
        <FactsCard info={props.info} />
      </div>
      <SettingsCard info={props.info} onSaved={keep} />
      <ModelsCard info={props.info} />
      <div class="grid gap-3 md:grid-cols-3">
        <InventoryCard title={t("web.runtime.skills")} entries={props.info.skills} />
        <InventoryCard title={t("web.runtime.mcp")} entries={props.info.mcpServers} />
        <InventoryCard title={t("web.runtime.tools")} entries={props.info.tools} />
      </div>
      <Card
        title={t("web.runtime.agents")}
        action={
          <A href={`/agents/new?runtime=${encodeURIComponent(props.info.id)}`} data-testid="new-agent" class="text-xs text-muted underline hover:text-ink">
            {t("web.runtime.makeAgent")}
          </A>
        }
      >
        <Show when={props.agents.length > 0} fallback={<Quiet>{t("web.runtime.noneYet")}</Quiet>}>
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
      fallback={<Quiet>{props.info.facts.capabilities.includes("accountUsage") ? t("web.runtime.afterInstall") : t("web.runtime.noUsage")}</Quiet>}
    >
      {(usage) => (
        <Switch>
          <Match when={usage().status === "login_required"}>
            <p class="text-xs text-warn-ink">{t("web.runtime.signedOut", { runtime: props.info.preset.label })}</p>
          </Match>
          <Match when={variant(usage(), "status", "unavailable")}>{(u) => <Quiet>{t("web.runtime.unreadable", { why: u().reason })}</Quiet>}</Match>
          <Match when={usage()}>
            <div class="flex items-start gap-3">
              <span class="flex w-14 shrink-0 flex-col items-center">
                <SpriteIcon name={bottleSprite(quota())} size={52} />
                <span class="text-sm">{quota().short || "—"}</span>
              </span>
              <div class="flex min-w-0 flex-1 flex-col gap-2.5">
                <Switch>
                  <Match when={variant(usage(), "status", "balance")}>
                    {(u) => (
                      <>
                        <p class={["text-sm", { "text-berry": !u().available }]}>
                          {t("web.runtime.balance", { provider: u().provider, enough: u().available })}
                        </p>
                        <p class="text-sm text-muted">
                          {(props.info.settings.dailyBudget ?? 0) > 0
                            ? t("web.runtime.spentTodayBudget", { spent: yuan(props.info.spentToday ?? 0), budget: yuan(props.info.settings.dailyBudget!) })
                            : t("web.runtime.spentToday", { spent: yuan(props.info.spentToday ?? 0) })}
                        </p>
                      </>
                    )}
                  </Match>
                  <Match when={variant(usage(), "status", "ok")}>
                    {(u) => (
                      <>
                        <Show when={u().subscription}>
                          <p class="text-sm text-muted">{t("web.runtime.subscription", { tier: u().subscription ?? "" })}</p>
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
        {t("web.runtime.left", { pct: pct(left()) })}
      </span>
      <Stamina
        quota={{
          level: quotaLevel(left()),
          fill: left() / 100,
          short: `${pct(left())}%`,
          text: t("web.runtime.windowLeft", { label: label(), pct: pct(left()) }),
        }}
        width={220}
        height={10}
      />
      <Show when={props.window.resetsAt}>{(at) => <span class="text-xs text-muted">{t("web.runtime.resets", { moment: momentText(at()) })}</span>}</Show>
    </div>
  );
}

function FactsCard(props: { info: RuntimeInfo }) {
  const facts = () => props.info.facts;
  const refused = () => Object.entries(facts().refused);
  return (
    <Card title={t("web.runtime.can")}>
      <div class="flex flex-col gap-1.5">
        <span class="flex items-start gap-1.5 text-sm">
          <Icon name={facts().steer ? "check" : "cross"} size={12} class="mt-1" />
          {facts().steer ? t("web.runtime.steer") : t("web.runtime.noSteer")}
        </span>
        <span class="text-sm">{facts().inProcess ? t("web.runtime.inProcess") : t("web.runtime.ownProcess")}</span>
        <span class="pt-2 text-xs font-medium text-muted">{t("web.runtime.refused")}</span>
        <Show when={refused().length > 0} fallback={<span class="text-sm">{t("web.runtime.acceptsAll")}</span>}>
          <For each={refused()}>
            {([k, v]) => (
              <span class="text-sm">
                <span class="font-mono">{k}</span> <span class="text-xs text-muted">{v}</span>
              </span>
            )}
          </For>
        </Show>
        <span class="pt-2 text-xs font-medium text-muted">{t("web.runtime.queries")}</span>
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
function NumberInput(props: { value?: number | undefined; onChange: (n: number | undefined) => void; placeholder: string; label: string; testid?: string }) {
  const [text, setText] = createSignal(untrack(() => (props.value ? String(props.value) : "")));
  return (
    <TextInput
      data-testid={props.testid}
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

function Field(props: { label: string; hint?: string | undefined; children: JSX.Element }) {
  return (
    <div class="flex flex-col gap-1">
      <span class="flex items-center gap-1.5 text-xs font-medium text-muted">
        {props.label}
        <Show when={props.hint}>{(h) => <Hint text={h()} />}</Show>
      </span>
      {props.children}
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
  const effortHint = () => refusedEffort() ?? ((model()?.effortLevels.length ?? 0) > 0 ? undefined : t("web.runtime.noEffort"));
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
      title={t("web.runtime.settings")}
      action={
        <Show when={dirty()}>
          <span class="flex gap-2">
            <Button data-testid="discard" onClick={() => setDraft(props.info.settings)}>
              {t("web.runtime.discard")}
            </Button>
            <Button tone="primary" data-testid="save" onClick={() => void save()}>
              {t("web.runtime.save")}
            </Button>
          </span>
        </Show>
      }
    >
      <div class="grid gap-4 md:grid-cols-2">
        <Toggle
          label={t("web.runtime.enabled")}
          tip={t("web.runtime.enabledHint")}
          checked={draft().enabled}
          onChange={(enabled) => setDraft({ ...draft(), enabled })}
        />
        <Field label={t("web.runtime.binPath")} hint={t("web.runtime.binPathHint", { id: props.info.id.toUpperCase() })}>
          <TextInput
            aria-label={t("web.runtime.binPath")}
            class="font-mono"
            placeholder={t("web.runtime.auto")}
            value={draft().binPath}
            onInput={(e) => setDraft({ ...draft(), binPath: e.currentTarget.value })}
          />
        </Field>
        <Field label={t("web.runtime.defaultModel")} hint={t("web.runtime.defaultModelHint")}>
          <Select
            label={t("web.runtime.defaultModel")}
            placeholder={t("web.runtime.ownDefault")}
            value={draft().defaultModel}
            options={models().map((m) => ({ value: m.id, label: m.name }))}
            onChange={(defaultModel) => setDraft({ ...draft(), defaultModel, defaultEffort: "" })}
          />
        </Field>
        <Field label={t("web.runtime.defaultEffort")} hint={effortHint()}>
          <Show when={(model()?.effortLevels.length ?? 0) > 0} fallback={<span class="text-sm text-faint">—</span>}>
            <Segmented
              label={t("web.runtime.defaultEffort")}
              value={draft().defaultEffort}
              options={[
                { value: "", label: t("web.runtime.default") },
                ...(model()?.effortLevels ?? []).map((l) => ({ value: l, label: l, disabled: !!refusedEffort() })),
              ]}
              onChange={(defaultEffort) => setDraft({ ...draft(), defaultEffort })}
            />
          </Show>
        </Field>
        <Field label={t("web.runtime.maxWorking")} hint={t("web.runtime.maxWorkingHint")}>
          <NumberInput
            label={t("web.runtime.maxWorking")}
            testid="max-working"
            placeholder={t("web.runtime.noLimit")}
            value={draft().maxWorking}
            onChange={(n) => {
              const { maxWorking: _, ...rest } = draft();
              setDraft(n === undefined ? rest : { ...rest, maxWorking: n });
            }}
          />
        </Field>
        <Show when={budgeted()}>
          <Field label={t("web.runtime.budget")} hint={t("web.runtime.budgetHint", { spent: yuan(props.info.spentToday ?? 0), pi: props.info.id === "pi" })}>
            <NumberInput
              label={t("web.runtime.budgetLabel")}
              placeholder={t("web.runtime.unlimited")}
              value={draft().dailyBudget}
              onChange={(n) => {
                const { dailyBudget: _, ...rest } = draft();
                setDraft(n === undefined ? rest : { ...rest, dailyBudget: n });
              }}
            />
          </Field>
        </Show>
      </div>
      <Field label={t("web.runtime.env")} hint={refusedEnv() ?? t("web.runtime.envHint")}>
        <KeyValueEditor value={draft().env} disabled={!!refusedEnv()} onChange={(env) => setDraft({ ...draft(), env })} />
      </Field>
    </Card>
  );
}

function ModelsCard(props: { info: RuntimeInfo }) {
  return (
    <Card
      title={t("web.runtime.models")}
      action={<Show when={props.info.models}>{(m) => <span class="text-sm text-muted">{t("web.runtime.modelCount", { n: m().length })}</span>}</Show>}
    >
      <Show
        when={props.info.models}
        fallback={<Quiet>{props.info.installation.status === "available" ? t("web.runtime.noModels") : t("web.runtime.afterInstall")}</Quiet>}
      >
        {(models) => (
          <table class="w-full text-left">
            <thead>
              <tr class="text-xs font-medium text-muted">
                <th class="pb-2 font-medium">{t("web.runtime.models")}</th>
                <th class="pb-2 font-medium">{t("web.runtime.effort")}</th>
              </tr>
            </thead>
            <tbody>
              <For each={models()}>
                {(m) => (
                  <tr class="border-t border-line">
                    <td class="py-1.5">
                      <span class="font-mono text-sm">{m.id}</span>
                      <Show when={m.isDefault}>
                        <span class="ml-2 rounded bg-ok-soft px-1.5 text-xs text-ok-ink">{t("web.runtime.default")}</span>
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
          <Quiet>{t("web.runtime.unreported")}</Quiet>
        </Match>
        <Match when={props.entries!.length === 0}>
          <Quiet>{t("web.runtime.none")}</Quiet>
        </Match>
      </Switch>
    </Card>
  );
}
