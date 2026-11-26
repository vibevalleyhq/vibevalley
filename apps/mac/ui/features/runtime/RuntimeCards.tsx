import { computed, signal, Text, View, type InputRef } from "nsh";

import { t } from "@vibevalley/i18n";
import {
  type InventoryEntry,
  type McpHostId,
  type McpServerEntry,
  type McpServerListResult,
  type McpTransportKind,
  type RuntimeCapability,
  RuntimeCapabilityValues,
  type RuntimeInfo,
  type RuntimeSettings,
  sessionEffort,
  sessionEnv,
  type SessionView,
  type UsageWindow,
} from "@vibevalley/protocol";
import { same } from "@vibevalley/protocol/rules";

import { createAct } from "../../design/act";
import { Button } from "../../design/Button";
import { KeyValueEditor } from "../../design/Chips";
import { Dialog } from "../../design/Dialog";
import { SettingRow, SettingsGroup } from "../../design/domain/settings";
import { Field, Select, TextInput } from "../../design/Field";
import { Icon } from "../../design/Icon";
import { IconButton } from "../../design/IconButton";
import { Banner, Quiet, Toggle } from "../../design/layout";
import { Segmented } from "../../design/Segmented";
import { Bubble } from "../../design/Tip";
import { toast } from "../../design/toasts";
import { api } from "../../infra/api";
import { variant } from "../../infra/base/dom";
import { momentText, yuan } from "../../infra/base/format";
import { hostApi } from "../../infra/bridge";
import { defineQuery, useQuery, useQueryClient } from "../../infra/query";
import { formatTokens } from "../../infra/sessionRuns";
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

export function mcpHostOf(runtimeId: string): McpHostId | undefined {
  const bare = runtimeId.startsWith("acp:") ? runtimeId.slice(4) : runtimeId;
  if (bare === "antigravity" || bare === "claude" || bare === "codex" || bare === "cursor") return bare;
  return undefined;
}

export const mcpServerListQuery = defineQuery({
  key: (host: McpHostId) => ["runtime", "mcpServer", host],
  fetch: (host: McpHostId, context) => api.runtime.mcpServer.list({ host }, context),
});

export function mcpEntryTarget(entry: McpServerEntry): string {
  if (entry.transport === "stdio") {
    const cmd = entry.command ?? "";
    return entry.args.length > 0 ? `${cmd} ${entry.args.join(" ")}` : cmd;
  }
  return entry.url ?? "";
}

export function mcpEntryDescription(entry: McpServerEntry): string {
  return `${entry.transport} · ${mcpEntryTarget(entry)}`;
}

function splitArgs(raw: string): string[] {
  const trimmed = raw.trim();
  return trimmed ? trimmed.split(/\s+/u) : [];
}

function McpServerForm(props: { host: McpHostId; initial?: McpServerEntry | undefined; onClose: () => void; onSaved: (result: McpServerListResult) => void }) {
  const initial = untrack(() => props.initial);
  const name = signal(initial?.name ?? "");
  const transport = signal<McpTransportKind>(initial?.transport ?? "stdio");
  const command = signal(initial?.command ?? "");
  const argsText = signal(initial?.args.join(" ") ?? "");
  const env = signal<Record<string, string>>(initial?.env ?? {});
  const url = signal(initial?.url ?? "");
  const headers = signal<Record<string, string>>(initial?.headers ?? {});
  const enabled = signal(initial?.enabled ?? true);
  const error = signal<string | undefined>(undefined);
  const saving = createAct((reason) => error.set(reason));

  const valid = computed(() => {
    if (!name().trim()) return false;
    if (transport() === "stdio") return Boolean(command().trim());
    return Boolean(url().trim());
  });

  const submit = () => {
    if (!valid() || saving.busy()) return;
    error.set(undefined);
    const trimmedName = name().trim();
    const kind = transport();
    void saving.run(async () => {
      const result = await api.runtime.mcpServer.save({
        host: props.host,
        ...(initial ? { previousName: initial.name } : {}),
        name: trimmedName,
        transport: kind,
        ...(kind === "stdio"
          ? { command: command().trim(), args: splitArgs(argsText()), env: env(), headers: {} }
          : { args: [], env: {}, url: url().trim(), headers: headers() }),
        enabled: enabled(),
      });
      props.onSaved(result);
      toast(t("web.runtime.mcpServer.savedToast", { name: trimmedName }));
      props.onClose();
    });
  };

  return (
    <View class="gap-4">
      <If when={error()}>
        {(err) => (
          <Banner tone="bad" size="sm" role="alert" testID="mcp-server-dialog-error">
            {err()}
          </Banner>
        )}
      </If>

      <Field label={t("web.runtime.mcpServer.name")} hint={t("web.runtime.mcpServer.nameHint")}>
        <TextInput
          testID="mcp-server-name"
          accessibilityLabel={t("web.runtime.mcpServer.name")}
          placeholder="context7"
          class="font-mono"
          value={name()}
          onInput={(v) => name.set(v)}
          onSubmit={submit}
        />
      </Field>

      <Field label={t("web.runtime.mcpServer.transport")}>
        <Segmented
          label={t("web.runtime.mcpServer.transport")}
          testid="mcp-server-transport"
          value={transport()}
          options={[
            { value: "stdio", label: "stdio" },
            { value: "streamableHttp", label: "streamableHttp" },
          ]}
          onChange={(next) => transport.set(next)}
        />
      </Field>

      <If
        when={transport() === "stdio"}
        else={
          <>
            <Field label={t("web.runtime.mcpServer.url")}>
              <TextInput
                testID="mcp-server-url"
                accessibilityLabel={t("web.runtime.mcpServer.url")}
                placeholder="https://mcp.example.com/mcp"
                class="font-mono"
                value={url()}
                onInput={(v) => url.set(v)}
                onSubmit={submit}
              />
            </Field>
            <Field label={t("web.runtime.mcpServer.headers")}>
              <KeyValueEditor value={headers()} onChange={(next) => headers.set(next)} />
            </Field>
          </>
        }
      >
        <>
          <Field label={t("web.runtime.mcpServer.command")}>
            <TextInput
              testID="mcp-server-command"
              accessibilityLabel={t("web.runtime.mcpServer.command")}
              placeholder="npx"
              class="font-mono"
              value={command()}
              onInput={(v) => command.set(v)}
              onSubmit={submit}
            />
          </Field>
          <Field label={t("web.runtime.mcpServer.args")} hint={t("web.runtime.mcpServer.argsHint")}>
            <TextInput
              testID="mcp-server-args"
              accessibilityLabel={t("web.runtime.mcpServer.args")}
              placeholder="-y @upstash/context7-mcp"
              class="font-mono"
              value={argsText()}
              onInput={(v) => argsText.set(v)}
              onSubmit={submit}
            />
          </Field>
          <Field label={t("web.runtime.mcpServer.env")}>
            <KeyValueEditor value={env()} onChange={(next) => env.set(next)} />
          </Field>
        </>
      </If>

      <Toggle testid="mcp-server-enabled" label={t("web.runtime.mcpServer.enabled")} checked={enabled()} onChange={(next) => enabled.set(next)} />

      <View class="flex-row items-center justify-end gap-2 border-t border-line pt-3">
        <Button size="compact" tone="quiet" testID="mcp-server-cancel" onPress={() => props.onClose()}>
          {t("web.runtime.mcpServer.cancel")}
        </Button>
        <Button size="compact" tone="primary" testID="mcp-server-save" disabled={!valid() || saving.busy()} onPress={submit}>
          {t("web.runtime.mcpServer.save")}
        </Button>
      </View>
    </View>
  );
}

function ReadonlyInventoryList(props: { entries: InventoryEntry[] | null }) {
  return (
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
                <View class="min-w-0 flex-row items-center justify-between gap-2">
                  <Text class={`min-w-0 flex-1 truncate font-mono text-xs ${e().enabled === false ? "text-muted line-through" : "text-ink"}`}>{e().name}</Text>
                  <If when={e().enabled === false}>
                    <View class="shrink-0 rounded-full bg-hover px-1.5 py-px">
                      <Text class="text-2xs text-faint">{t("web.runtime.mcpServer.disabledTag")}</Text>
                    </View>
                  </If>
                </View>
                <If when={e().description}>
                  <View class="min-w-0" tooltip={<Bubble text={e().description} />}>
                    <Text class="truncate text-2xs text-muted">{e().description}</Text>
                  </View>
                </If>
                <If when={e().source}>
                  <View class="min-w-0" tooltip={<Bubble text={e().source} />}>
                    <Text class="truncate font-mono text-2xs text-faint">{e().source}</Text>
                  </View>
                </If>
              </View>
            )}
          </Each>
        </If>
      )}
    </If>
  );
}

function McpInventoryCard(props: {
  title: string;
  host: McpHostId;
  fallbackEntries: InventoryEntry[] | null;
  onSynced?: ((host: McpHostId, servers: readonly McpServerEntry[]) => void) | undefined;
}) {
  const client = useQueryClient();
  const query = useQuery(() => mcpServerListQuery(props.host));
  const error = signal<string | undefined>(undefined);
  const busyName = signal<string | undefined>(undefined);
  const dialogState = signal<{ open: boolean; editing?: McpServerEntry | undefined }>({ open: false });
  const act = createAct((reason) => error.set(reason));

  const servers = computed(() => query.data()?.servers);
  const countNote = computed(() => {
    const list = servers();
    if (list) return String(list.length);
    return props.fallbackEntries ? String(props.fallbackEntries.length) : undefined;
  });

  const applyResult = (result: McpServerListResult) => {
    client.setData(mcpServerListQuery(result.host), () => ({ value: result }));
    props.onSynced?.(result.host, result.servers);
  };

  const toggleServer = (entry: McpServerEntry, nextEnabled: boolean) => {
    if (act.busy()) return;
    error.set(undefined);
    busyName.set(entry.name);
    void act
      .run(async () => {
        const result = await api.runtime.mcpServer.toggle({ host: props.host, name: entry.name, enabled: nextEnabled });
        applyResult(result);
        toast(t("web.runtime.mcpServer.toggledToast", { name: entry.name, enabled: nextEnabled }));
      })
      .finally(() => {
        if (busyName() === entry.name) busyName.set(undefined);
      });
  };

  const removeServer = (entry: McpServerEntry) => {
    if (act.busy()) return;
    error.set(undefined);
    busyName.set(entry.name);
    void act
      .run(async () => {
        const result = await api.runtime.mcpServer.remove({ host: props.host, name: entry.name });
        applyResult(result);
        toast(t("web.runtime.mcpServer.removedToast", { name: entry.name }));
      })
      .finally(() => {
        if (busyName() === entry.name) busyName.set(undefined);
      });
  };

  return (
    <>
      <SettingsGroup
        title={props.title}
        note={countNote()}
        testid="runtime-mcp-card"
        action={
          <IconButton
            icon="add"
            size={14}
            label={t("web.runtime.mcpServer.add")}
            testid="mcp-server-add"
            onClick={() => {
              error.set(undefined);
              dialogState.set({ open: true });
            }}
          />
        }
      >
        <If when={error()}>
          {(err) => (
            <Banner tone="bad" size="sm" role="alert" testID="mcp-server-error" edge>
              {err()}
            </Banner>
          )}
        </If>
        <If when={servers()} else={<ReadonlyInventoryList entries={props.fallbackEntries} />}>
          {(list) => (
            <If
              when={list().length > 0}
              else={
                <View class="px-3.5 py-3">
                  <Quiet>{t("web.runtime.none")}</Quiet>
                </View>
              }
            >
              <Each of={list()} key={(s) => `${s.host}:${s.name}`}>
                {(s, i) => {
                  const target = () => mcpEntryTarget(s());
                  const rowBusy = () => busyName() === s().name;
                  return (
                    <View
                      testID={`mcp-server-row-${s().name}`}
                      class={`min-w-0 gap-1 px-3.5 py-2.5 ${i() === list().length - 1 ? "" : "border-b border-line"}`}
                    >
                      <View class="min-w-0 flex-row items-center justify-between gap-2">
                        <View class="min-w-0 flex-1 flex-row items-center gap-1.5">
                          <Text class={`min-w-0 truncate font-mono text-xs font-medium ${s().enabled ? "text-ink" : "text-muted line-through"}`}>
                            {s().name}
                          </Text>
                          <View class="shrink-0 rounded-sm bg-hover px-1.5 py-px">
                            <Text class="font-mono text-2xs text-muted">{s().transport === "streamableHttp" ? "http" : "stdio"}</Text>
                          </View>
                        </View>
                        <View class="shrink-0 flex-row items-center gap-1">
                          <Toggle
                            bare
                            testid={`mcp-server-toggle-${s().name}`}
                            ariaLabel={t("web.runtime.mcpServer.toggle", { name: s().name })}
                            checked={s().enabled}
                            disabled={rowBusy()}
                            onChange={(next) => toggleServer(s(), next)}
                          />
                          <IconButton
                            icon="edit"
                            size={12}
                            label={t("web.runtime.mcpServer.edit", { name: s().name })}
                            testid={`mcp-server-edit-${s().name}`}
                            disabled={act.busy()}
                            onClick={() => {
                              error.set(undefined);
                              dialogState.set({ open: true, editing: s() });
                            }}
                          />
                          <IconButton
                            icon="delete"
                            size={12}
                            label={t("web.runtime.mcpServer.remove", { name: s().name })}
                            testid={`mcp-server-remove-${s().name}`}
                            disabled={rowBusy()}
                            onClick={() => removeServer(s())}
                          />
                        </View>
                      </View>
                      <If when={target()}>
                        <View class="min-w-0" tooltip={<Bubble text={target()} />}>
                          <Text class="truncate font-mono text-2xs text-muted">{target()}</Text>
                        </View>
                      </If>
                      <View class="min-w-0 flex-row items-center justify-between gap-2">
                        <View class="min-w-0 flex-1" tooltip={<Bubble text={s().configPath} />}>
                          <Text class="truncate font-mono text-2xs text-faint">{s().configPath}</Text>
                        </View>
                        <Text class={`shrink-0 text-2xs ${s().enabled ? "text-ok-ink" : "text-faint"}`}>
                          {s().enabled ? t("web.runtime.mcpServer.enabledTag") : t("web.runtime.mcpServer.disabledTag")}
                        </Text>
                      </View>
                    </View>
                  );
                }}
              </Each>
            </If>
          )}
        </If>
      </SettingsGroup>

      <Dialog
        open={dialogState().open}
        onClose={() => dialogState.set({ open: false })}
        title={dialogState().editing ? t("web.runtime.mcpServer.editTitle") : t("web.runtime.mcpServer.addTitle")}
        size="md"
        testid="mcp-server-dialog"
      >
        <If when={dialogState().open}>
          <McpServerForm host={props.host} initial={dialogState().editing} onClose={() => dialogState.set({ open: false })} onSaved={applyResult} />
        </If>
      </Dialog>
    </>
  );
}

export function InventoryCard(props: {
  title: string;
  entries: InventoryEntry[] | null;
  mcpHost?: McpHostId | undefined;
  onMcpServersSynced?: ((host: McpHostId, servers: readonly McpServerEntry[]) => void) | undefined;
}) {
  return (
    <If
      when={props.mcpHost}
      else={
        <SettingsGroup title={props.title} note={props.entries ? String(props.entries.length) : undefined}>
          <ReadonlyInventoryList entries={props.entries} />
        </SettingsGroup>
      }
    >
      {(host) => <McpInventoryCard title={props.title} host={host()} fallbackEntries={props.entries} onSynced={props.onMcpServersSynced} />}
    </If>
  );
}

export interface RuntimeSessionSummary {
  sessionsCount: number;
  recentRunsCount: number;
  failedCount: number;
  totalErrors: number;
  retriedCount: number;
  totalRetries: number;
  failureRatePct: number;
  retryRatePct: number;
  totalTokens: number;
  totalCny: number;
  hasCost: boolean;
}

export function summarizeRuntimeSessions(sessions: readonly SessionView[]): RuntimeSessionSummary {
  let recentRunsCount = 0;
  let failedCount = 0;
  let totalErrors = 0;
  let retriedCount = 0;
  let totalRetries = 0;
  let totalTokens = 0;
  let totalCny = 0;
  let hasCost = false;

  for (const s of sessions) {
    recentRunsCount += Math.max(s.runs, s.lastRun !== undefined ? 1 : 0);
    const failed = s.phase._tag === "failed" || s.lastRun?.outcome === "failed";
    if (failed) failedCount += 1;
    totalErrors += Math.max(s.telemetry?.runErrors ?? 0, failed ? 1 : 0);

    const activeRetry = s.phase._tag === "working" && s.phase.retry !== undefined;
    const retries = Math.max(s.telemetry?.llmRetries ?? 0, activeRetry ? 1 : 0);
    if (retries > 0) retriedCount += 1;
    totalRetries += retries;

    const telTokens = s.telemetry
      ? s.telemetry.inputTokens +
        s.telemetry.cacheReadTokens +
        (s.telemetry.cacheWriteTokens ?? 0) +
        s.telemetry.outputTokens +
        (s.telemetry.reasoningTokens ?? 0)
      : 0;
    totalTokens += Math.max(s.spent?.tokens ?? 0, s.lastRun?.spent?.tokens ?? 0, telTokens);

    const cny = s.spent?.cny ?? s.lastRun?.spent?.cny;
    if (cny !== undefined) {
      totalCny += cny;
      hasCost = true;
    }
  }

  const sessionsCount = sessions.length;
  return {
    sessionsCount,
    recentRunsCount,
    failedCount,
    totalErrors,
    retriedCount,
    totalRetries,
    failureRatePct: sessionsCount > 0 ? Math.round((failedCount / sessionsCount) * 100) : 0,
    retryRatePct: sessionsCount > 0 ? Math.round((retriedCount / sessionsCount) * 100) : 0,
    totalTokens,
    totalCny,
    hasCost,
  };
}

export function RuntimeRunStatsCard(props: { sessions: readonly SessionView[] }) {
  const summary = computed(() => summarizeRuntimeSessions(props.sessions));
  return (
    <SettingsGroup
      title={t("web.runtime.stats.title")}
      testid="runtime-run-stats"
      note={summary().sessionsCount > 0 ? t("web.runtime.stats.sessions", { n: summary().sessionsCount }) : undefined}
    >
      <If
        when={summary().sessionsCount > 0}
        else={
          <View class="px-4 py-3.5">
            <Quiet>{t("web.runtime.stats.empty")}</Quiet>
          </View>
        }
      >
        <SettingRow label={t("web.runtime.stats.runs")}>
          <Text testID="runtime-stats-runs" class="font-mono text-xs font-medium text-ink">
            {String(summary().recentRunsCount)}
          </Text>
        </SettingRow>
        <SettingRow
          label={t("web.runtime.stats.failureRate")}
          hint={t("web.runtime.stats.failuresDetail", { failed: summary().failedCount, errors: summary().totalErrors })}
        >
          <Text
            testID="runtime-stats-failure-rate"
            class={summary().failedCount > 0 ? "font-mono text-xs font-medium text-berry" : "font-mono text-xs text-ink"}
          >
            {`${summary().failureRatePct}%`}
          </Text>
        </SettingRow>
        <SettingRow
          label={t("web.runtime.stats.retryRate")}
          hint={t("web.runtime.stats.retriesDetail", { retried: summary().retriedCount, retries: summary().totalRetries })}
        >
          <Text
            testID="runtime-stats-retry-rate"
            class={summary().retriedCount > 0 ? "font-mono text-xs font-medium text-warn-ink" : "font-mono text-xs text-ink"}
          >
            {`${summary().retryRatePct}%`}
          </Text>
        </SettingRow>
        <SettingRow label={t("web.runtime.stats.cumulativeSpend")} last>
          <View testID="runtime-stats-usage" class="flex-row items-center gap-2">
            <If when={summary().totalTokens > 0}>
              <Text class="font-mono text-xs text-ink">{`${formatTokens(summary().totalTokens)} tok`}</Text>
            </If>
            <If when={summary().hasCost}>
              <Text class="font-mono text-xs font-medium text-ink">{yuan(summary().totalCny)}</Text>
            </If>
            <If when={summary().totalTokens === 0 && !summary().hasCost}>
              <Text class="font-mono text-xs text-muted">—</Text>
            </If>
          </View>
        </SettingRow>
      </If>
    </SettingsGroup>
  );
}
