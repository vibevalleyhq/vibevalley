import type { JSX } from "@solidjs/web";
import { createMemo, createSignal, For, Match, Show, Switch, untrack } from "solid-js";

import { Meter } from "@vibevalley/base-ui";
import { t } from "@vibevalley/i18n";
import {
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

import { variant } from "#/base/dom.tsx";
import { momentText, yuan } from "#/base/format.ts";
import { api } from "#/infra/api.ts";
import { createAct } from "#/ui/act.ts";
import { Button } from "#/ui/Button.tsx";
import { KeyValueEditor } from "#/ui/Chips.tsx";
import { Select, TextInput } from "#/ui/Field.tsx";
import { Icon } from "#/ui/Icon.tsx";
import { Card, Quiet, Toggle } from "#/ui/layout.tsx";
import { SpriteIcon } from "#/ui/pixel/index.ts";
import { Segmented } from "#/ui/Segmented.tsx";
import { Hint } from "#/ui/Tip.tsx";

import { bottleSprite, type Quota, quotaLevel, quotaOf, windowLabel } from "./quota";

const capabilityLabel: Record<RuntimeCapability, string> = {
  listModels: t("web.runtime.capability.listModels"),
  accountUsage: t("web.runtime.capability.accountUsage"),
  checkUpdate: t("web.runtime.capability.checkUpdate"),
  upgrade: t("web.runtime.capability.upgrade"),
  skills: t("web.runtime.capability.skills"),
  mcpServers: t("web.runtime.capability.mcpServers"),
  tools: t("web.runtime.capability.tools"),
};

/** A cell's colour by how much is left: the palette's, so the bar follows the theme. */
const levelInk = { plenty: "bg-accent", low: "bg-wheat", gold: "bg-wheat", empty: "bg-berry", unknown: "bg-bark" } as const;

/** The quota as a row of cells, filled to what is left. */
export function Stamina(props: { quota: Quota; cells?: number; width: number; height: number }) {
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
        {(i) => <span class={["flex-1 rounded-xs", i < lit() ? levelInk[props.quota.level] : "bg-line"]} />}
      </For>
    </Meter.Root>
  );
}

export function Usage(props: { info: RuntimeInfo }) {
  const quota = () => quotaOf(props.info);
  return (
    <Show
      when={props.info.usage}
      fallback={<Quiet>{props.info.support.capabilities.includes("accountUsage") ? t("web.runtime.afterInstall") : t("web.runtime.noUsage")}</Quiet>}
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
                            ? t("web.runtime.spentTodayBudget", { spent: yuan(props.info.spentToday ?? 0), budget: yuan(props.info.settings.dailyBudget ?? 0) })
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

export function SupportCard(props: { info: RuntimeInfo }) {
  const support = () => props.info.support;
  const refused = () => Object.entries(support().refused);
  return (
    <Card title={t("web.runtime.can")}>
      <div class="flex flex-col gap-1.5">
        <span class="flex items-start gap-1.5 text-sm">
          <Icon name={support().steer ? "check" : "cross"} size={12} class="mt-1" />
          {support().steer ? t("web.runtime.steer") : t("web.runtime.noSteer")}
        </span>
        <span class="text-sm">{support().inProcess ? t("web.runtime.inProcess") : t("web.runtime.ownProcess")}</span>
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
              <span class={["rounded px-1.5 py-px text-xs", support().capabilities.includes(c) ? "bg-selected" : "border border-line text-muted line-through"]}>
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
  const [text, setText] = createSignal(untrack(() => (props.value != null && props.value !== 0 ? String(props.value) : "")));
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

export function SettingsCard(props: { info: RuntimeInfo; onSaved: (got: RuntimeInfo) => void }) {
  // The settings as the server has them now replace the draft; a refetch with the same settings leaves it.
  const saved = createMemo(() => props.info.settings, { equals: same });
  const [draft, setDraft] = createSignal<RuntimeSettings>(() => saved());
  const dirty = () => !same(draft(), props.info.settings);
  const models = () => props.info.models ?? [];
  const model = () => {
    const wanted = draft().defaultModel || models().find((m) => m.isDefault)?.id;
    return models().find((m) => m.id === wanted);
  };
  const refusedEffort = () => props.info.support.refused[sessionEffort];
  const refusedEnv = () => props.info.support.refused[sessionEnv];
  const effortHint = () => refusedEffort() ?? ((model()?.effortLevels.length ?? 0) > 0 ? undefined : t("web.runtime.noEffort"));
  const saving = createAct();
  const save = () => {
    const id = props.info.id;
    const body = draft();
    const saved = props.onSaved;
    return saving.run(async () => saved(await api.runtime.setting.update({ id, ...body })));
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
            <Button tone="primary" data-testid="save" disabled={saving.busy()} onClick={() => void save()}>
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

export function ModelsCard(props: { info: RuntimeInfo }) {
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

export function InventoryCard(props: { title: string; entries: InventoryEntry[] | null }) {
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
        <Match when={props.entries?.length === 0}>
          <Quiet>{t("web.runtime.none")}</Quiet>
        </Match>
      </Switch>
    </Card>
  );
}
