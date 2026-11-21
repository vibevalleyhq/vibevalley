import { signal, Text, View, type JSX, type InputRef } from "nsh";

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
import * as S from "@vibevalley/protocol/schema";

import { hostApi } from "../../../../bridge";
import { createEffect, untrack } from "../../../solid";
import { variant } from "../../base/dom";
import { momentText, yuan } from "../../base/format";
import { api } from "../../infra/api";
import { defineColumns, useTable } from "../../infra/table";
import { createAct } from "../../ui/act";
import { Button } from "../../ui/Button";
import { KeyValueEditor } from "../../ui/Chips";
import { DataTable, tableCell } from "../../ui/DataTable";
import { Select, TextInput } from "../../ui/Field";
import { Icon } from "../../ui/Icon";
import { Card, Quiet, Toggle } from "../../ui/layout";
import { SpriteOr } from "../../ui/pixel/icons";
import { Segmented } from "../../ui/Segmented";
import { Bubble, Hint } from "../../ui/Tip";
import { mix } from "../../ui/tone";
import { bottleSprite, type Quota, quotaLevel, quotaOf, windowLabel } from "./quota";

const toneChoices1 = {
  plenty: "bg-accent",
  low: "bg-wheat",
  gold: "bg-wheat",
  empty: "bg-berry",
  unknown: "bg-bark",
};

const capabilityLabel: Record<RuntimeCapability, string> = {
  listModels: t("web.runtime.capability.listModels"),
  accountUsage: t("web.runtime.capability.accountUsage"),
  checkUpdate: t("web.runtime.capability.checkUpdate"),
  upgrade: t("web.runtime.capability.upgrade"),
  skills: t("web.runtime.capability.skills"),
  mcpServers: t("web.runtime.capability.mcpServers"),
  tools: t("web.runtime.capability.tools"),
};

/** The quota as a row of cells, filled to what is left. */
export function Stamina(props: { quota: Quota; cells?: number; width?: number; height: number }) {
  const cells = () => props.cells ?? 10;
  const lit = () => Math.round(props.quota.fill * cells());
  return (
    <View
      role="progressbar"
      accessibilityLabel={props.quota.text}
      accessibilityValue={{ min: 0, max: 100, now: Math.round(props.quota.fill * 100) }}
      class={`flex-row gap-px rounded-sm bg-bark-800 p-px ${props.width === undefined ? "w-full max-w-56" : ""}`}
      style={{ ...(props.width !== undefined ? { width: props.width } : {}), height: props.height }}
    >
      <Each of={Array.from({ length: cells() }, (_, i) => i)}>
        {(i) => (
          <View
            class={`flex-1 rounded-xs ${i() < lit() ? toneChoices1[props.quota.level] : ""}`}
            style={i() < lit() ? undefined : { backgroundColor: mix("paper", 0.18) }}
          />
        )}
      </Each>
    </View>
  );
}

/** The account's bottle: a vial in bark, filled from the bottom to what is left. */
function Bottle(props: { quota: Quota; size: number }) {
  const fill = () => (props.quota.level === "unknown" ? 0 : Math.max(0.04, Math.min(1, props.quota.fill)));
  return (
    <View class="items-center" style={{ width: props.size, height: props.size }}>
      <View class="h-1.5 w-3 rounded-t-xs bg-bark-800" />
      <View class="w-7 flex-1 justify-end overflow-hidden rounded-md border-2 border-bark-800 bg-line">
        <View class={toneChoices1[props.quota.level]} style={{ height: `${fill() * 100}%` }} />
      </View>
    </View>
  );
}

export function Usage(props: { info: RuntimeInfo; terminalDirectory?: string | undefined }) {
  const quota = () => quotaOf(props.info);
  return (
    <If
      when={
        props.info.installation.status === "unsupported" && props.info.installation.signInCommand ? ({ status: "login_required" } as const) : props.info.usage
      }
      else={<Quiet>{props.info.support.capabilities.includes("accountUsage") ? t("web.runtime.afterInstall") : t("web.runtime.noUsage")}</Quiet>}
    >
      {(usage) => (
        <If
          when={usage().status !== "login_required"}
          else={
            <View class="items-start gap-2">
              <Text class="text-sm text-warn-ink">{t("web.runtime.signedOut", { runtime: props.info.preset.label })}</Text>
              <If when={props.terminalDirectory}>
                {(cwd) => (
                  <Button testID="runtime-sign-in-terminal" onPress={() => void hostApi.openTerminal({ cwd: cwd(), title: props.info.preset.label })}>
                    {t("web.runtime.signInTerminal")}
                  </Button>
                )}
              </If>
            </View>
          }
        >
          <If
            when={variant(usage(), "status", "unavailable")}
            else={
              <View class="flex-row items-start gap-3">
                <View class="w-14 shrink-0 items-center gap-1">
                  <SpriteOr name={bottleSprite(quota())} size={52}>
                    <Bottle quota={quota()} size={52} />
                  </SpriteOr>
                  <Text class="text-sm font-medium tabular-nums text-ink">{quota().short || "—"}</Text>
                </View>
                <View class="min-w-0 flex-1 gap-2.5">
                  <If when={variant(usage(), "status", "balance")}>
                    {(u) => (
                      <>
                        <Text class={`text-sm ${!u().available ? "text-berry" : "text-ink"}`}>
                          {t("web.runtime.balance", { provider: u().provider, enough: u().available })}
                        </Text>
                        <Text class="text-sm tabular-nums text-muted">
                          {(props.info.settings.dailyBudget ?? 0) > 0
                            ? t("web.runtime.spentTodayBudget", { spent: yuan(props.info.spentToday ?? 0), budget: yuan(props.info.settings.dailyBudget ?? 0) })
                            : t("web.runtime.spentToday", { spent: yuan(props.info.spentToday ?? 0) })}
                        </Text>
                      </>
                    )}
                  </If>
                  <If when={variant(usage(), "status", "ok")}>
                    {(u) => (
                      <>
                        <If when={u().subscription}>
                          <Text class="text-sm text-muted">{t("web.runtime.subscription", { tier: u().subscription ?? "" })}</Text>
                        </If>
                        <Each of={u().windows}>{(w) => <Window window={w()} />}</Each>
                      </>
                    )}
                  </If>
                </View>
              </View>
            }
          >
            {(u) => <Quiet>{t("web.runtime.unreadable", { why: u().reason })}</Quiet>}
          </If>
        </If>
      )}
    </If>
  );
}

const pct = (n: number) => String(Math.round(n * 100) / 100);

function Window(props: { window: UsageWindow }) {
  const left = () => 100 - props.window.usedPercent;
  const label = () => windowLabel(props.window.label);
  return (
    <View class="gap-1">
      <View class="flex-row items-baseline gap-2">
        <Text class="min-w-0 flex-1 truncate text-xs text-muted">{label()}</Text>
        <Text class="text-xs font-medium tabular-nums text-ink">{t("web.runtime.left", { pct: pct(left()) })}</Text>
      </View>
      <Stamina
        quota={{
          level: quotaLevel(left()),
          fill: left() / 100,
          short: `${pct(left())}%`,
          text: t("web.runtime.windowLeft", { label: label(), pct: pct(left()) }),
        }}
        height={10}
      />
      <If when={props.window.resetsAt}>
        {(at) => <Text class="text-xs tabular-nums text-muted">{t("web.runtime.resets", { moment: momentText(at()) })}</Text>}
      </If>
    </View>
  );
}

export function SupportCard(props: { info: RuntimeInfo }) {
  const support = () => props.info.support;
  const refused = () => Object.entries(support().refused);
  return (
    <Card title={t("web.runtime.can")}>
      <View class="gap-1.5">
        <View class="flex-row items-start gap-1.5">
          <View class="mt-1">
            <Icon name={support().steer ? "check" : "cross"} size={12} />
          </View>
          <Text class="text-sm text-ink">{support().steer ? t("web.runtime.steer") : t("web.runtime.noSteer")}</Text>
        </View>
        <Text class="text-sm text-ink">{support().inProcess ? t("web.runtime.inProcess") : t("web.runtime.ownProcess")}</Text>
        <Text class="pt-2 text-xs font-medium text-muted">{t("web.runtime.refused")}</Text>
        <If when={refused().length > 0} else={<Text class="text-sm text-ink">{t("web.runtime.acceptsAll")}</Text>}>
          <Each of={refused()}>
            {(entry) => (
              <Text class="text-sm text-ink">
                <Text class="font-mono">{entry()[0]}</Text> <Text class="text-xs text-muted">{entry()[1]}</Text>
              </Text>
            )}
          </Each>
        </If>
        <Text class="pt-2 text-xs font-medium text-muted">{t("web.runtime.queries")}</Text>
        <View class="flex-row flex-wrap gap-1.5">
          <Each of={RuntimeCapabilityValues}>
            {(c) => (
              <View class={`rounded-sm px-1.5 py-0.5 ${support().capabilities.includes(c()) ? "bg-selected" : "bg-hover"}`}>
                <Text class={`text-xs ${support().capabilities.includes(c()) ? "font-medium text-ink" : "text-faint line-through"}`}>
                  {capabilityLabel[c()]}
                </Text>
              </View>
            )}
          </Each>
        </View>
      </View>
    </Card>
  );
}

/** The text is kept as typed, the number follows it (empty or 0 means none). */
function NumberInput(props: { value?: number | undefined; onChange: (n: number | undefined) => void; placeholder: string; label: string; testid?: string }) {
  const text = signal(untrack(() => (props.value != null && props.value !== 0 ? String(props.value) : "")));
  return (
    <TextInput
      testID={props.testid}
      accessibilityLabel={props.label}
      class="font-mono"
      placeholder={props.placeholder}
      value={text()}
      onInput={(typed) => {
        text.set(typed);
        const n = Number(typed.trim());
        props.onChange(typed.trim() && Number.isFinite(n) && n > 0 ? n : undefined);
      }}
    />
  );
}

function Field(props: { label: string; hint?: string | undefined; children: JSX.Element }) {
  return (
    <View class="gap-1">
      <View class="flex-row items-center gap-1.5">
        <Text class="text-xs font-medium text-muted">{props.label}</Text>
        <If when={props.hint}>{(h) => <Hint text={h()} />}</If>
      </View>
      {props.children}
    </View>
  );
}

export function SettingsCard(props: { info: RuntimeInfo; onSaved: (got: RuntimeInfo) => void; pathRef: (node: InputRef) => void }) {
  const draft = signal<RuntimeSettings>(untrack(() => props.info.settings));
  // The settings as the server has them now replace the draft; a refetch with the same settings leaves it.
  let saved = untrack(() => props.info.settings);
  createEffect(
    () => props.info.settings,
    (now) => {
      if (!same(now, saved)) {
        saved = now;
        draft.set(now);
      }
    },
  );
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
    const onSaved = props.onSaved;
    return saving.run(async () => onSaved(await api.runtime.setting.update({ id, ...body })));
  };
  const budgeted = () => props.info.id === "pi" || props.info.id === "vibevalley";
  return (
    <Card
      title={t("web.runtime.settings")}
      action={
        <If when={dirty()}>
          <View class="flex-row gap-2">
            <Button tone="quiet" testID="discard" onPress={() => draft.set(props.info.settings)}>
              {t("web.runtime.discard")}
            </Button>
            <Button tone="primary" testID="save" disabled={saving.busy()} onPress={() => void save()}>
              {t("web.runtime.save")}
            </Button>
          </View>
        </If>
      }
    >
      <View class="grid gap-4 md:grid-cols-2">
        <Toggle
          label={t("web.runtime.enabled")}
          tip={t("web.runtime.enabledHint")}
          checked={draft().enabled}
          onChange={(enabled) => draft.set({ ...draft(), enabled })}
        />
        <Field label={t("web.runtime.binPath")} hint={t("web.runtime.binPathHint", { id: props.info.id.toUpperCase() })}>
          <TextInput
            accessibilityLabel={t("web.runtime.binPath")}
            ref={props.pathRef}
            testID="runtime-bin-path"
            class="font-mono"
            placeholder={t("web.runtime.auto")}
            value={draft().binPath}
            onInput={(binPath) => draft.set({ ...draft(), binPath })}
          />
        </Field>
        <Field label={t("web.runtime.defaultModel")} hint={t("web.runtime.defaultModelHint")}>
          <Select
            label={t("web.runtime.defaultModel")}
            placeholder={t("web.runtime.ownDefault")}
            value={draft().defaultModel}
            options={models().map((m) => ({ value: m.id, label: m.name }))}
            onChange={(defaultModel) => draft.set({ ...draft(), defaultModel, defaultEffort: "" })}
          />
        </Field>
        <Field label={t("web.runtime.defaultEffort")} hint={effortHint()}>
          <If when={(model()?.effortLevels.length ?? 0) > 0} else={<Text class="text-sm text-faint">—</Text>}>
            <Segmented
              label={t("web.runtime.defaultEffort")}
              value={draft().defaultEffort}
              options={[
                { value: "", label: t("web.runtime.default") },
                ...(model()?.effortLevels ?? []).map((l) => ({ value: l, label: l, disabled: !!refusedEffort() })),
              ]}
              onChange={(defaultEffort) => draft.set({ ...draft(), defaultEffort })}
            />
          </If>
        </Field>
        <Field label={t("web.runtime.maxWorking")} hint={t("web.runtime.maxWorkingHint")}>
          <NumberInput
            label={t("web.runtime.maxWorking")}
            testid="max-working"
            placeholder={t("web.runtime.noLimit")}
            value={draft().maxWorking}
            onChange={(n) => {
              const { maxWorking: _, ...rest } = draft();
              draft.set(n === undefined ? rest : { ...rest, maxWorking: n });
            }}
          />
        </Field>
        <If when={budgeted()}>
          <Field label={t("web.runtime.budget")} hint={t("web.runtime.budgetHint", { spent: yuan(props.info.spentToday ?? 0), pi: props.info.id === "pi" })}>
            <NumberInput
              label={t("web.runtime.budgetLabel")}
              placeholder={t("web.runtime.unlimited")}
              value={draft().dailyBudget}
              onChange={(n) => {
                const { dailyBudget: _, ...rest } = draft();
                draft.set(n === undefined ? rest : { ...rest, dailyBudget: n });
              }}
            />
          </Field>
        </If>
      </View>
      <Field label={t("web.runtime.env")} hint={refusedEnv() ?? t("web.runtime.envHint")}>
        <KeyValueEditor value={draft().env} disabled={!!refusedEnv()} onChange={(env) => draft.set({ ...draft(), env })} />
      </Field>
    </Card>
  );
}

export function ModelsCard(props: { info: RuntimeInfo }) {
  const column = defineColumns(S.ModelEntry);
  const name = column("name", { value: (model) => model.id, compare: (a, b) => a.localeCompare(b), hideable: false });
  const effort = column("effort", { value: (model) => model.effortLevels.join(" · "), compare: (a, b) => a.localeCompare(b) });
  const table = useTable({ mode: "local", rows: () => props.info.models ?? [], rowId: (model) => model.id, columns: [name, effort] });
  const cells = {
    name: tableCell(
      name,
      () => t("web.runtime.models"),
      (value, model) => (
        <>
          <Text class="font-mono text-sm text-ink">{value()}</Text>
          <If when={model().isDefault}>
            <View class="ml-2 rounded-sm bg-ok-soft px-1.5 py-0.5">
              <Text class="text-xs font-medium text-ok-ink">{t("web.runtime.default")}</Text>
            </View>
          </If>
        </>
      ),
    ),
    effort: tableCell(
      effort,
      () => t("web.runtime.effort"),
      (value) => <Text class="text-sm text-muted">{value() || "—"}</Text>,
    ),
  };
  return (
    <Card
      title={t("web.runtime.models")}
      action={<If when={props.info.models}>{(m) => <Text class="text-sm tabular-nums text-muted">{t("web.runtime.modelCount", { n: m().length })}</Text>}</If>}
    >
      <If
        when={props.info.models}
        else={<Quiet>{props.info.installation.status === "available" ? t("web.runtime.noModels") : t("web.runtime.afterInstall")}</Quiet>}
      >
        <DataTable table={table} cells={cells} caption={t("web.runtime.models")} columnControls testid="runtime-models" />
      </If>
    </Card>
  );
}

export function InventoryCard(props: { title: string; entries: InventoryEntry[] | null }) {
  return (
    <Card title={props.title} action={<If when={props.entries}>{(e) => <Text class="text-sm tabular-nums text-muted">{String(e().length)}</Text>}</If>}>
      <If when={props.entries} else={<Quiet>{t("web.runtime.unreported")}</Quiet>}>
        {(entries) => (
          <If when={entries().length > 0} else={<Quiet>{t("web.runtime.none")}</Quiet>}>
            <View class="gap-1.5">
              <Each of={entries()}>
                {(e) => (
                  <View class="min-w-0">
                    <Text class={`truncate font-mono text-sm ${e().enabled === false ? "text-muted line-through" : "text-ink"}`}>{e().name}</Text>
                    <If when={e().description}>
                      <View class="min-w-0" tooltip={<Bubble text={e().description} />}>
                        <Text class="truncate text-xs text-muted">{e().description}</Text>
                      </View>
                    </If>
                  </View>
                )}
              </Each>
            </View>
          </If>
        )}
      </If>
    </Card>
  );
}
