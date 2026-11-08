import type { JSX } from "@solidjs/web";
import * as stylex from "@stylexjs/stylex";
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
import * as S from "@vibevalley/protocol/schema";

import { variant } from "#/base/dom.tsx";
import { momentText, yuan } from "#/base/format.ts";
import { api } from "#/infra/api.ts";
import { defineColumns, useTable } from "#/infra/table.ts";
import { createAct } from "#/ui/act.ts";
import { Button } from "#/ui/Button.tsx";
import { KeyValueEditor } from "#/ui/Chips.tsx";
import { DataTable, tableCell } from "#/ui/DataTable.tsx";
import { Select, TextInput } from "#/ui/Field.tsx";
import { Icon } from "#/ui/Icon.tsx";
import { Card, Quiet, Toggle } from "#/ui/layout.tsx";
import { SpriteIcon } from "#/ui/pixel/index.ts";
import { Segmented } from "#/ui/Segmented.tsx";
import { Hint } from "#/ui/Tip.tsx";

import { bottleSprite, type Quota, quotaLevel, quotaOf, windowLabel } from "./quota";

const variantStyles4 = stylex.create({
  supportCardIcon: {
    marginTop: "var(--spacing)",
  },
});

const variantStyles3 = stylex.create({
  numberInputTextInput: {
    fontFamily: "var(--font-mono)",
  },
});

const variantStyles2 = stylex.create({
  staminaMeterRoot: {
    display: "inline-flex",
    gap: "1px",
    borderRadius: "var(--radius-sm)",
    backgroundColor: "var(--color-bark-800)",
    padding: "1px",
  },
});

const variantStyles = stylex.create({
  usageDiv: {
    display: "flex",
    minWidth: "0",
    flex: "1",
    flexDirection: "column",
    gap: "calc(var(--spacing) * 2.5)",
  },
  usageP: {
    fontSize: "var(--text-sm)",
    lineHeight: "var(--text-sm--line-height)",
  },
  usagePVariant: {
    color: "var(--wb-berry)",
  },
  usagePVariant2: {},
  supportCardSpan: {
    borderRadius: ".25rem",
    paddingInline: "calc(var(--spacing) * 1.5)",
    paddingBlock: "1px",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--text-xs--line-height)",
  },
  supportCardSpanVariant: {
    backgroundColor: "var(--wb-selected)",
  },
  supportCardSpanVariant2: {
    borderStyle: "solid",
    borderWidth: "1px",
    borderColor: "var(--wb-line)",
    color: "var(--wb-muted)",
    textDecorationLine: "line-through",
  },
  inventoryCardSpan: {
    fontFamily: "var(--font-mono)",
    fontSize: "var(--text-sm)",
    lineHeight: "var(--text-sm--line-height)",
  },
  inventoryCardSpanVariant: {
    color: "var(--wb-muted)",
    textDecorationLine: "line-through",
  },
});

const viewStyles = stylex.create({
  usageP: {
    fontSize: "var(--text-xs)",
    lineHeight: "var(--text-xs--line-height)",
    color: "var(--wb-warn-ink)",
  },
  usageDiv: {
    display: "flex",
    alignItems: "flex-start",
    gap: "calc(var(--spacing) * 3)",
  },
  usageSpan: {
    display: "flex",
    width: "calc(var(--spacing) * 14)",
    flexShrink: "0",
    flexDirection: "column",
    alignItems: "center",
  },
  usageSpan2: {
    fontSize: "var(--text-sm)",
    lineHeight: "var(--text-sm--line-height)",
  },
  usageP2: {
    fontSize: "var(--text-sm)",
    lineHeight: "var(--text-sm--line-height)",
    color: "var(--wb-muted)",
  },
  windowDiv: {
    display: "flex",
    flexDirection: "column",
    gap: "var(--spacing)",
  },
  windowSpan: {
    display: "flex",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--text-xs--line-height)",
  },
  windowSpan2: {
    flex: "1",
    color: "var(--wb-muted)",
  },
  windowSpan3: {
    fontSize: "var(--text-xs)",
    lineHeight: "var(--text-xs--line-height)",
    color: "var(--wb-muted)",
  },
  supportCardDiv: {
    display: "flex",
    flexDirection: "column",
    gap: "calc(var(--spacing) * 1.5)",
  },
  supportCardSpan: {
    display: "flex",
    alignItems: "flex-start",
    gap: "calc(var(--spacing) * 1.5)",
    fontSize: "var(--text-sm)",
    lineHeight: "var(--text-sm--line-height)",
  },
  supportCardSpan2: {
    paddingTop: "calc(var(--spacing) * 2)",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--text-xs--line-height)",
    fontWeight: "var(--font-weight-medium)",
    color: "var(--wb-muted)",
  },
  supportCardSpan3: {
    fontFamily: "var(--font-mono)",
  },
  supportCardDiv2: {
    display: "flex",
    flexWrap: "wrap",
    gap: "var(--spacing)",
  },
  fieldSpan: {
    display: "flex",
    alignItems: "center",
    gap: "calc(var(--spacing) * 1.5)",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--text-xs--line-height)",
    fontWeight: "var(--font-weight-medium)",
    color: "var(--wb-muted)",
  },
  settingsCardSpan: {
    display: "flex",
    gap: "calc(var(--spacing) * 2)",
  },
  settingsCardDiv: {
    display: "grid",
    gap: "calc(var(--spacing) * 4)",
    gridTemplateColumns: {
      default: null,
      "@media (width>=48rem)": "repeat(2,minmax(0,1fr))",
    },
  },
  settingsCardSpan2: {
    fontSize: "var(--text-sm)",
    lineHeight: "var(--text-sm--line-height)",
    color: "var(--wb-faint)",
  },
  modelsCardSpan: {
    fontFamily: "var(--font-mono)",
    fontSize: "var(--text-sm)",
    lineHeight: "var(--text-sm--line-height)",
  },
  modelsCardSpan2: {
    marginLeft: "calc(var(--spacing) * 2)",
    borderRadius: ".25rem",
    backgroundColor: "var(--wb-ok-soft)",
    paddingInline: "calc(var(--spacing) * 1.5)",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--text-xs--line-height)",
    color: "var(--wb-ok-ink)",
  },
  inventoryCardLi: {
    display: "flex",
    flexDirection: "column",
  },
  inventoryCardSpan: {
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    overflow: "hidden",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--text-xs--line-height)",
    color: "var(--wb-muted)",
  },
});

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
      {...stylex.attrs(variantStyles2.staminaMeterRoot)}
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
            <p {...stylex.attrs(viewStyles.usageP)}>{t("web.runtime.signedOut", { runtime: props.info.preset.label })}</p>
          </Match>
          <Match when={variant(usage(), "status", "unavailable")}>{(u) => <Quiet>{t("web.runtime.unreadable", { why: u().reason })}</Quiet>}</Match>
          <Match when={usage()}>
            <div {...stylex.attrs(viewStyles.usageDiv)}>
              <span {...stylex.attrs(viewStyles.usageSpan)}>
                <SpriteIcon name={bottleSprite(quota())} size={52} />
                <span {...stylex.attrs(viewStyles.usageSpan2)}>{quota().short || "—"}</span>
              </span>
              <div {...stylex.attrs(variantStyles.usageDiv)}>
                <Switch>
                  <Match when={variant(usage(), "status", "balance")}>
                    {(u) => (
                      <>
                        <p {...stylex.attrs(variantStyles.usageP, !u().available ? variantStyles.usagePVariant : variantStyles.usagePVariant2)}>
                          {t("web.runtime.balance", { provider: u().provider, enough: u().available })}
                        </p>
                        <p {...stylex.attrs(viewStyles.usageP2)}>
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
                          <p {...stylex.attrs(viewStyles.usageP2)}>{t("web.runtime.subscription", { tier: u().subscription ?? "" })}</p>
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
    <div {...stylex.attrs(viewStyles.windowDiv)}>
      <span {...stylex.attrs(viewStyles.windowSpan)}>
        <span {...stylex.attrs(viewStyles.windowSpan2)}>{label()}</span>
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
      <Show when={props.window.resetsAt}>
        {(at) => <span {...stylex.attrs(viewStyles.windowSpan3)}>{t("web.runtime.resets", { moment: momentText(at()) })}</span>}
      </Show>
    </div>
  );
}

export function SupportCard(props: { info: RuntimeInfo }) {
  const support = () => props.info.support;
  const refused = () => Object.entries(support().refused);
  return (
    <Card title={t("web.runtime.can")}>
      <div {...stylex.attrs(viewStyles.supportCardDiv)}>
        <span {...stylex.attrs(viewStyles.supportCardSpan)}>
          <Icon name={support().steer ? "check" : "cross"} size={12} styles={[variantStyles4.supportCardIcon]} />
          {support().steer ? t("web.runtime.steer") : t("web.runtime.noSteer")}
        </span>
        <span {...stylex.attrs(viewStyles.usageSpan2)}>{support().inProcess ? t("web.runtime.inProcess") : t("web.runtime.ownProcess")}</span>
        <span {...stylex.attrs(viewStyles.supportCardSpan2)}>{t("web.runtime.refused")}</span>
        <Show when={refused().length > 0} fallback={<span {...stylex.attrs(viewStyles.usageSpan2)}>{t("web.runtime.acceptsAll")}</span>}>
          <For each={refused()}>
            {([k, v]) => (
              <span {...stylex.attrs(viewStyles.usageSpan2)}>
                <span {...stylex.attrs(viewStyles.supportCardSpan3)}>{k}</span> <span {...stylex.attrs(viewStyles.windowSpan3)}>{v}</span>
              </span>
            )}
          </For>
        </Show>
        <span {...stylex.attrs(viewStyles.supportCardSpan2)}>{t("web.runtime.queries")}</span>
        <div {...stylex.attrs(viewStyles.supportCardDiv2)}>
          <For each={RuntimeCapabilityValues}>
            {(c) => (
              <span
                {...stylex.attrs(
                  variantStyles.supportCardSpan,
                  support().capabilities.includes(c) ? variantStyles.supportCardSpanVariant : variantStyles.supportCardSpanVariant2,
                )}
              >
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
      styles={variantStyles3.numberInputTextInput}
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
    <div {...stylex.attrs(viewStyles.windowDiv)}>
      <span {...stylex.attrs(viewStyles.fieldSpan)}>
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
          <span {...stylex.attrs(viewStyles.settingsCardSpan)}>
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
      <div {...stylex.attrs(viewStyles.settingsCardDiv)}>
        <Toggle
          label={t("web.runtime.enabled")}
          tip={t("web.runtime.enabledHint")}
          checked={draft().enabled}
          onChange={(enabled) => setDraft({ ...draft(), enabled })}
        />
        <Field label={t("web.runtime.binPath")} hint={t("web.runtime.binPathHint", { id: props.info.id.toUpperCase() })}>
          <TextInput
            aria-label={t("web.runtime.binPath")}
            styles={variantStyles3.numberInputTextInput}
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
          <Show when={(model()?.effortLevels.length ?? 0) > 0} fallback={<span {...stylex.attrs(viewStyles.settingsCardSpan2)}>—</span>}>
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
          <span {...stylex.attrs(viewStyles.modelsCardSpan)}>{value()}</span>
          <Show when={model().isDefault}>
            <span {...stylex.attrs(viewStyles.modelsCardSpan2)}>{t("web.runtime.default")}</span>
          </Show>
        </>
      ),
    ),
    effort: tableCell(
      effort,
      () => t("web.runtime.effort"),
      (value) => <span {...stylex.attrs(viewStyles.usageP2)}>{value() || "—"}</span>,
    ),
  };
  return (
    <Card
      title={t("web.runtime.models")}
      action={
        <Show when={props.info.models}>{(m) => <span {...stylex.attrs(viewStyles.usageP2)}>{t("web.runtime.modelCount", { n: m().length })}</span>}</Show>
      }
    >
      <Show
        when={props.info.models}
        fallback={<Quiet>{props.info.installation.status === "available" ? t("web.runtime.noModels") : t("web.runtime.afterInstall")}</Quiet>}
      >
        <DataTable table={table} cells={cells} caption={t("web.runtime.models")} columnControls testid="runtime-models" />
      </Show>
    </Card>
  );
}

export function InventoryCard(props: { title: string; entries: InventoryEntry[] | null }) {
  return (
    <Card title={props.title} action={<Show when={props.entries}>{(e) => <span {...stylex.attrs(viewStyles.usageP2)}>{e().length}</span>}</Show>}>
      <Switch
        fallback={
          <ul {...stylex.attrs(viewStyles.windowDiv)}>
            <For each={props.entries}>
              {(e) => (
                <li {...stylex.attrs(viewStyles.inventoryCardLi)}>
                  <span
                    {...stylex.attrs(
                      variantStyles.inventoryCardSpan,
                      e.enabled === false ? variantStyles.inventoryCardSpanVariant : variantStyles.usagePVariant2,
                    )}
                  >
                    {e.name}
                  </span>
                  <Show when={e.description}>
                    <span {...stylex.attrs(viewStyles.inventoryCardSpan)}>{e.description}</span>
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
