import { computed, signal, Text, View, type InputRef } from "nsh";

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

import { createAct } from "../../design/act";
import { Button } from "../../design/Button";
import { KeyValueEditor } from "../../design/Chips";
import { SettingRow, SettingsGroup } from "../../design/domain/settings";
import { Select, TextInput } from "../../design/Field";
import { Icon } from "../../design/Icon";
import { Quiet } from "../../design/layout";
import { Segmented } from "../../design/Segmented";
import { Bubble } from "../../design/Tip";
import { api } from "../../infra/api";
import { variant } from "../../infra/base/dom";
import { momentText, yuan } from "../../infra/base/format";
import { hostApi } from "../../infra/bridge";
import { createEffect, untrack } from "../../infra/solid";
import { type Quota, quotaLevel, quotaOf, windowLabel } from "./quota";

const staminaTone = {
  plenty: "bg-accent",
  low: "bg-wheat",
  gold: "bg-wheat",
  empty: "bg-berry",
  unknown: "bg-idle",
};

export const capabilityLabel: Record<RuntimeCapability, string> = {
  listModels: t("web.runtime.capability.listModels"),
  accountUsage: t("web.runtime.capability.accountUsage"),
  checkUpdate: t("web.runtime.capability.checkUpdate"),
  upgrade: t("web.runtime.capability.upgrade"),
  skills: t("web.runtime.capability.skills"),
  mcpServers: t("web.runtime.capability.mcpServers"),
  tools: t("web.runtime.capability.tools"),
};

/** Quota progress bar rendered as crisp segmented cells matching Linear's usage meters. */
function Stamina(props: { quota: Quota; cells?: number; width?: number; height: number }) {
  const cells = () => props.cells ?? 10;
  const lit = () => Math.round(props.quota.fill * cells());
  return (
    <View
      role="progressbar"
      accessibilityLabel={props.quota.text}
      accessibilityValue={{ min: 0, max: 100, now: Math.round(props.quota.fill * 100) }}
      class={`flex-row gap-0.5 rounded-full bg-hover p-0.5 ${props.width === undefined ? "w-full max-w-64" : ""}`}
      style={{ ...(props.width !== undefined ? { width: props.width } : {}), height: props.height }}
    >
      <Each of={Array.from({ length: cells() }, (_, i) => i)} key={(i) => i}>
        {(i) => <View class={`flex-1 rounded-full ${i() < lit() ? staminaTone[props.quota.level] : "bg-side"}`} />}
      </Each>
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
      else={
        <View class="px-4 py-3.5">
          <Quiet>{props.info.support.capabilities.includes("accountUsage") ? t("web.runtime.afterInstall") : t("web.runtime.noUsage")}</Quiet>
        </View>
      }
    >
      {(usage) => (
        <If
          when={usage().status !== "login_required"}
          else={
            <View class="flex-row flex-wrap items-center justify-between gap-3 px-4 py-3">
              <View class="min-w-0 flex-1 flex-row items-center gap-2">
                <Icon name="warn" size={14} tone="warn-ink" />
                <Text class="min-w-0 flex-1 text-xs leading-relaxed text-warn-ink">{t("web.runtime.signedOut", { runtime: props.info.preset.label })}</Text>
              </View>
              <If when={props.terminalDirectory}>
                {(cwd) => (
                  <Button
                    size="compact"
                    testID="runtime-sign-in-terminal"
                    onPress={() => void hostApi.openTerminal({ cwd: cwd(), title: props.info.preset.label })}
                  >
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
              <View>
                <If when={variant(usage(), "status", "balance")}>
                  {(u) => (
                    <View class="flex-row flex-wrap items-center justify-between gap-4 px-4 py-3">
                      <View class="min-w-0 flex-1 gap-0.5">
                        <Text class={`text-sm font-medium ${!u().available ? "text-berry" : "text-ink"}`}>
                          {t("web.runtime.balance", { provider: u().provider, enough: u().available })}
                        </Text>
                        <Text class="text-xs tabular-nums text-muted">
                          {(props.info.settings.dailyBudget ?? 0) > 0
                            ? t("web.runtime.spentTodayBudget", { spent: yuan(props.info.spentToday ?? 0), budget: yuan(props.info.settings.dailyBudget ?? 0) })
                            : t("web.runtime.spentToday", { spent: yuan(props.info.spentToday ?? 0) })}
                        </Text>
                      </View>
                      <View class="shrink-0 rounded-md border border-line bg-side px-2.5 py-1">
                        <Text class="font-mono text-sm font-semibold tabular-nums text-ink">{quota().short || "—"}</Text>
                      </View>
                    </View>
                  )}
                </If>
                <If when={variant(usage(), "status", "ok")}>
                  {(u) => (
                    <>
                      <If when={u().subscription}>
                        <View class={`flex-row items-center justify-between gap-4 px-4 py-3 ${u().windows.length > 0 ? "border-b border-line" : ""}`}>
                          <Text class="text-xs font-medium text-muted">{t("web.runtime.subscription", { tier: u().subscription ?? "" })}</Text>
                          <View class="rounded-full bg-ok-soft px-2 py-0.5">
                            <Text class="font-mono text-2xs font-medium tabular-nums text-ok-ink">{quota().short || "—"}</Text>
                          </View>
                        </View>
                      </If>
                      <Each of={u().windows} key={(w) => w.label}>
                        {(w, i) => <Window window={w()} last={i() === u().windows.length - 1} />}
                      </Each>
                    </>
                  )}
                </If>
              </View>
            }
          >
            {(u) => (
              <View class="px-4 py-3.5">
                <Quiet>{t("web.runtime.unreadable", { why: u().reason })}</Quiet>
              </View>
            )}
          </If>
        </If>
      )}
    </If>
  );
}

const pct = (n: number) => String(Math.round(n * 100) / 100);

function Window(props: { window: UsageWindow; last: boolean }) {
  const left = () => 100 - props.window.usedPercent;
  const label = () => windowLabel(props.window.label);
  return (
    <View class={`gap-2 px-4 py-3 ${props.last ? "" : "border-b border-line"}`}>
      <View class="flex-row items-center justify-between gap-2">
        <View class="min-w-0 flex-1 flex-row items-baseline gap-2">
          <Text class="truncate text-sm font-medium text-ink">{label()}</Text>
          <If when={props.window.resetsAt}>
            {(at) => <Text class="shrink-0 text-xs tabular-nums text-faint">{t("web.runtime.resets", { moment: momentText(at()) })}</Text>}
          </If>
        </View>
        <Text class="shrink-0 font-mono text-xs font-medium tabular-nums text-ink">{t("web.runtime.left", { pct: pct(left()) })}</Text>
      </View>
      <Stamina
        quota={{
          level: quotaLevel(left()),
          fill: left() / 100,
          short: `${pct(left())}%`,
          text: t("web.runtime.windowLeft", { label: label(), pct: pct(left()) }),
        }}
        height={8}
      />
    </View>
  );
}

export function SupportCard(props: { info: RuntimeInfo }) {
  const support = () => props.info.support;
  const refused = computed(() => Object.entries(support().refused));
  const capabilitySet = computed(() => new Set(support().capabilities));
  return (
    <SettingsGroup title={t("web.runtime.can")}>
      <View class="gap-1.5 border-b border-line px-3.5 py-3">
        <View class="flex-row items-start gap-2">
          <View class="mt-0.5 shrink-0">
            <Icon name={support().steer ? "check" : "cross"} size={12} tone={support().steer ? "leaf" : "muted"} />
          </View>
          <Text class="min-w-0 flex-1 text-xs leading-relaxed text-ink">{support().steer ? t("web.runtime.steer") : t("web.runtime.noSteer")}</Text>
        </View>
        <Text class="text-xs text-muted">{support().inProcess ? t("web.runtime.inProcess") : t("web.runtime.ownProcess")}</Text>
      </View>
      <View class="gap-1.5 border-b border-line px-3.5 py-3">
        <Text class="text-2xs font-semibold text-faint">{t("web.runtime.refused")}</Text>
        <If when={refused().length > 0} else={<Text class="text-xs text-muted">{t("web.runtime.acceptsAll")}</Text>}>
          <Each of={refused()} key={(entry) => entry[0]}>
            {(entry) => (
              <Text class="text-xs text-ink">
                <Text class="font-mono">{entry()[0]}</Text> <Text class="text-muted">{entry()[1]}</Text>
              </Text>
            )}
          </Each>
        </If>
      </View>
      <View class="gap-2 px-3.5 py-3">
        <Text class="text-2xs font-semibold text-faint">{t("web.runtime.queries")}</Text>
        <View class="flex-row flex-wrap gap-1.5">
          <Each of={RuntimeCapabilityValues} key={(c) => c}>
            {(c) => (
              <View class={`rounded-md px-2 py-0.5 ${capabilitySet().has(c()) ? "bg-selected" : "bg-hover"}`}>
                <Text class={`text-2xs ${capabilitySet().has(c()) ? "font-medium text-ink" : "text-faint line-through"}`}>{capabilityLabel[c()]}</Text>
              </View>
            )}
          </Each>
        </View>
      </View>
    </SettingsGroup>
  );
}

/** The text is kept as typed, the number follows it (empty or 0 means none). */
function NumberInput(props: {
  value?: number | undefined;
  onChange: (n: number | undefined) => void;
  placeholder: string;
  label: string;
  testid?: string;
  class?: string;
}) {
  const text = signal(untrack(() => (props.value != null && props.value !== 0 ? String(props.value) : "")));
  return (
    <TextInput
      testID={props.testid}
      accessibilityLabel={props.label}
      class={`font-mono ${props.class ?? ""}`}
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
  const dirty = computed(() => !same(draft(), props.info.settings));
  const models = computed(() => props.info.models ?? []);
  const model = computed(() => {
    const wanted = draft().defaultModel || models().find((m) => m.isDefault)?.id;
    return models().find((m) => m.id === wanted);
  });
  const refusedEffort = computed(() => props.info.support.refused[sessionEffort]);
  const refusedEnv = computed(() => props.info.support.refused[sessionEnv]);
  const effortHint = computed(() => refusedEffort() ?? ((model()?.effortLevels.length ?? 0) > 0 ? undefined : t("web.runtime.noEffort")));
  const modelOptions = computed(() => models().map((m) => ({ value: m.id, label: m.name })));
  const effortOptions = computed(() => [
    { value: "", label: t("web.runtime.default") },
    ...(model()?.effortLevels ?? []).map((l) => ({ value: l, label: l, disabled: !!refusedEffort() })),
  ]);
  const saving = createAct();
  const save = () => {
    const id = props.info.id;
    const body = draft();
    const onSaved = props.onSaved;
    return saving.run(async () => onSaved(await api.runtime.setting.update({ id, ...body })));
  };
  const budgeted = () => props.info.id === "pi" || props.info.id === "vibevalley";
  return (
    <SettingsGroup
      title={t("web.runtime.settings")}
      action={
        <If when={dirty()}>
          <View class="flex-row items-center gap-1.5">
            <Button size="compact" tone="quiet" testID="discard" onPress={() => draft.set(props.info.settings)}>
              {t("web.runtime.discard")}
            </Button>
            <Button size="compact" tone="primary" testID="save" disabled={saving.busy()} onPress={() => void save()}>
              {t("web.runtime.save")}
            </Button>
          </View>
        </If>
      }
    >
      <SettingRow label={t("web.runtime.binPath")} hint={t("web.runtime.binPathHint", { id: props.info.id.toUpperCase() })}>
        <View class="w-60 max-w-full">
          <TextInput
            accessibilityLabel={t("web.runtime.binPath")}
            ref={props.pathRef}
            testID="runtime-bin-path"
            class="font-mono"
            placeholder={t("web.runtime.auto")}
            value={draft().binPath}
            onInput={(binPath) => draft.set({ ...draft(), binPath })}
          />
        </View>
      </SettingRow>
      <SettingRow label={t("web.runtime.defaultModel")} hint={t("web.runtime.defaultModelHint")}>
        <Select
          label={t("web.runtime.defaultModel")}
          class="w-60 max-w-full"
          placeholder={t("web.runtime.ownDefault")}
          value={draft().defaultModel}
          options={modelOptions()}
          onChange={(defaultModel) => draft.set({ ...draft(), defaultModel, defaultEffort: "" })}
        />
      </SettingRow>
      <SettingRow label={t("web.runtime.defaultEffort")} hint={effortHint()}>
        <If when={(model()?.effortLevels.length ?? 0) > 0} else={<Text class="text-xs text-faint">—</Text>}>
          <Segmented
            label={t("web.runtime.defaultEffort")}
            value={draft().defaultEffort}
            options={effortOptions()}
            onChange={(defaultEffort) => draft.set({ ...draft(), defaultEffort })}
          />
        </If>
      </SettingRow>
      <SettingRow label={t("web.runtime.maxWorking")} hint={t("web.runtime.maxWorkingHint")}>
        <View class="w-40 max-w-full">
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
        </View>
      </SettingRow>
      <If when={budgeted()}>
        <SettingRow label={t("web.runtime.budget")} hint={t("web.runtime.budgetHint", { spent: yuan(props.info.spentToday ?? 0), pi: props.info.id === "pi" })}>
          <View class="w-40 max-w-full">
            <NumberInput
              label={t("web.runtime.budgetLabel")}
              placeholder={t("web.runtime.unlimited")}
              value={draft().dailyBudget}
              onChange={(n) => {
                const { dailyBudget: _, ...rest } = draft();
                draft.set(n === undefined ? rest : { ...rest, dailyBudget: n });
              }}
            />
          </View>
        </SettingRow>
      </If>
      <SettingRow label={t("web.runtime.env")} hint={refusedEnv() ?? t("web.runtime.envHint")} wide last>
        <View class="w-full">
          <KeyValueEditor value={draft().env} disabled={!!refusedEnv()} onChange={(env) => draft.set({ ...draft(), env })} />
        </View>
      </SettingRow>
    </SettingsGroup>
  );
}

export function ModelsCard(props: { info: RuntimeInfo }) {
  const models = computed(() => props.info.models ?? []);
  return (
    <SettingsGroup title={t("web.runtime.models")} note={props.info.models ? t("web.runtime.modelCount", { n: props.info.models.length }) : undefined}>
      <If
        when={props.info.models && props.info.models.length > 0}
        else={
          <View class="px-4 py-3.5">
            <Quiet>{props.info.installation.status === "available" ? t("web.runtime.noModels") : t("web.runtime.afterInstall")}</Quiet>
          </View>
        }
      >
        <View testID="runtime-models" accessibilityLabel={t("web.runtime.models")}>
          <View class="flex-row items-center justify-between gap-4 border-b border-line bg-side px-4 py-2">
            <Text class="text-2xs font-semibold text-faint">{t("web.runtime.models")}</Text>
            <Text class="text-2xs font-semibold text-faint">{t("web.runtime.effort")}</Text>
          </View>
          <Each of={models()} key={(m) => m.id}>
            {(m, i) => (
              <View class={`min-h-11 flex-row items-center justify-between gap-4 px-4 py-2.5 ${i() === models().length - 1 ? "" : "border-b border-line"}`}>
                <View class="min-w-0 flex-1 flex-row items-center gap-2">
                  <Text class="truncate font-mono text-xs text-ink">{m().id}</Text>
                  <If when={m().isDefault}>
                    <View class="shrink-0 rounded-full bg-ok-soft px-2 py-px">
                      <Text class="text-2xs font-medium text-ok-ink">{t("web.runtime.default")}</Text>
                    </View>
                  </If>
                </View>
                <Text class="shrink-0 text-xs text-muted">{m().effortLevels.join(" · ") || "—"}</Text>
              </View>
            )}
          </Each>
        </View>
      </If>
    </SettingsGroup>
  );
}

export function InventoryCard(props: { title: string; entries: InventoryEntry[] | null }) {
  return (
    <SettingsGroup title={props.title} note={props.entries ? String(props.entries.length) : undefined}>
      <If
        when={props.entries}
        else={
          <View class="px-3.5 py-3">
            <Quiet>{t("web.runtime.unreported")}</Quiet>
          </View>
        }
      >
        {(entries) => (
          <If
            when={entries().length > 0}
            else={
              <View class="px-3.5 py-3">
                <Quiet>{t("web.runtime.none")}</Quiet>
              </View>
            }
          >
            <Each of={entries()} key={(e) => `${e.name}:${e.source ?? ""}`}>
              {(e, i) => (
                <View class={`min-w-0 gap-0.5 px-3.5 py-2.5 ${i() === entries().length - 1 ? "" : "border-b border-line"}`}>
                  <Text class={`truncate font-mono text-xs ${e().enabled === false ? "text-muted line-through" : "text-ink"}`}>{e().name}</Text>
                  <If when={e().description}>
                    <View class="min-w-0" tooltip={<Bubble text={e().description} />}>
                      <Text class="truncate text-2xs text-muted">{e().description}</Text>
                    </View>
                  </If>
                </View>
              )}
            </Each>
          </If>
        )}
      </If>
    </SettingsGroup>
  );
}
