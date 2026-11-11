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

const styles = stylex.create({
  staminaSpan: {
    flex: "1",
    borderRadius: "var(--radius-xs)",
  },
  staminaSpanState: {
    backgroundColor: "var(--wb-line)",
  },
  staminaSpanState2: {
    backgroundColor: "var(--wb-accent)",
  },
  staminaSpanState3: {
    backgroundColor: "var(--wb-wheat)",
  },
  staminaSpanState4: {
    backgroundColor: "var(--wb-berry)",
  },
  staminaSpanState5: {
    backgroundColor: "var(--wb-bark)",
  },
  supportCardIcon: {
    marginTop: "0.25rem",
  },
  numberInputTextInput: {
    fontFamily: "var(--font-mono)",
  },
  staminaMeterRoot: {
    display: "inline-flex",
    gap: "1px",
    borderRadius: "var(--radius-sm)",
    backgroundColor: "var(--color-bark-800)",
    padding: "1px",
  },
  usageDiv: {
    display: "flex",
    minWidth: "0",
    flex: "1",
    flexDirection: "column",
    gap: "0.625rem",
  },
  usageP: {
    fontSize: "var(--text-sm)",
    lineHeight: "var(--leading-sm)",
  },
  usagePTone: {
    color: "var(--color-berry)",
  },
  usagePAlt: {},
  supportCardSpan: {
    borderRadius: "var(--radius-sm)",
    paddingInline: "0.375rem",
    paddingBlock: "1px",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--leading-xs)",
  },
  supportCardSpanTone: {
    backgroundColor: "var(--color-selected)",
  },
  supportCardSpanAlt: {
    borderStyle: "solid",
    borderWidth: "1px",
    borderColor: "var(--color-line)",
    color: "var(--color-muted)",
    textDecorationLine: "line-through",
  },
  inventoryCardSpan: {
    fontFamily: "var(--font-mono)",
    fontSize: "var(--text-sm)",
    lineHeight: "var(--leading-sm)",
  },
  inventoryCardSpanTone: {
    color: "var(--color-muted)",
    textDecorationLine: "line-through",
  },
  usageP2: {
    fontSize: "var(--text-xs)",
    lineHeight: "var(--leading-xs)",
    color: "var(--color-warn-ink)",
  },
  usageDiv2: {
    display: "flex",
    alignItems: "flex-start",
    gap: "0.75rem",
  },
  usageSpan: {
    display: "flex",
    width: "3.5rem",
    flexShrink: "0",
    flexDirection: "column",
    alignItems: "center",
  },
  usageSpan2: {
    fontSize: "var(--text-sm)",
    lineHeight: "var(--leading-sm)",
  },
  usageP22: {
    fontSize: "var(--text-sm)",
    lineHeight: "var(--leading-sm)",
    color: "var(--color-muted)",
  },
  windowDiv: {
    display: "flex",
    flexDirection: "column",
    gap: "0.25rem",
  },
  windowSpan: {
    display: "flex",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--leading-xs)",
  },
  windowSpan2: {
    flex: "1",
    color: "var(--color-muted)",
  },
  windowSpan3: {
    fontSize: "var(--text-xs)",
    lineHeight: "var(--leading-xs)",
    color: "var(--color-muted)",
  },
  supportCardDiv: {
    display: "flex",
    flexDirection: "column",
    gap: "0.375rem",
  },
  supportCardSpan2: {
    display: "flex",
    alignItems: "flex-start",
    gap: "0.375rem",
    fontSize: "var(--text-sm)",
    lineHeight: "var(--leading-sm)",
  },
  supportCardSpan22: {
    paddingTop: "0.5rem",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--leading-xs)",
    fontWeight: "var(--font-weight-medium)",
    color: "var(--color-muted)",
  },
  supportCardSpan3: {
    fontFamily: "var(--font-mono)",
  },
  supportCardDiv2: {
    display: "flex",
    flexWrap: "wrap",
    gap: "0.25rem",
  },
  fieldSpan: {
    display: "flex",
    alignItems: "center",
    gap: "0.375rem",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--leading-xs)",
    fontWeight: "var(--font-weight-medium)",
    color: "var(--color-muted)",
  },
  settingsCardSpan: {
    display: "flex",
    gap: "0.5rem",
  },
  settingsCardDiv: {
    display: "grid",
    gap: "1rem",
    gridTemplateColumns: {
      default: null,
      "@media (width>=48rem)": "repeat(2,minmax(0,1fr))",
    },
  },
  settingsCardSpan2: {
    fontSize: "var(--text-sm)",
    lineHeight: "var(--leading-sm)",
    color: "var(--color-faint)",
  },
  modelsCardSpan: {
    fontFamily: "var(--font-mono)",
    fontSize: "var(--text-sm)",
    lineHeight: "var(--leading-sm)",
  },
  modelsCardSpan2: {
    marginLeft: "0.5rem",
    borderRadius: "var(--radius-sm)",
    backgroundColor: "var(--color-ok-soft)",
    paddingInline: "0.375rem",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--leading-xs)",
    color: "var(--color-ok-ink)",
  },
  inventoryCardLi: {
    display: "flex",
    flexDirection: "column",
  },
  inventoryCardSpan2: {
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    overflow: "hidden",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--leading-xs)",
    color: "var(--color-muted)",
  },
});
const toneChoices1 = {
  plenty: styles.staminaSpanState2,
  low: styles.staminaSpanState3,
  gold: styles.staminaSpanState3,
  empty: styles.staminaSpanState4,
  unknown: styles.staminaSpanState5,
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

/** A cell's colour by how much is left: the palette's, so the bar follows the theme. */

/** The quota as a row of cells, filled to what is left. */
export function Stamina(props: { quota: Quota; cells?: number; width: number; height: number }) {
  const cells = () => props.cells ?? 10;
  const lit = () => Math.round(props.quota.fill * cells());
  return (
    <Meter.Root
      value={Math.round(props.quota.fill * 100)}
      aria-label={props.quota.text}
      {...stylex.attrs(styles.staminaMeterRoot)}
      style={{ width: `${props.width}px`, height: `${props.height}px` }}
    >
      <For each={Array.from({ length: cells() }, (_, i) => i)}>
        {(i) => <span {...stylex.attrs(styles.staminaSpan, i < lit() ? toneChoices1[props.quota.level] : styles.staminaSpanState)} />}
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
            <p {...stylex.attrs(styles.usageP2)}>{t("web.runtime.signedOut", { runtime: props.info.preset.label })}</p>
          </Match>
          <Match when={variant(usage(), "status", "unavailable")}>{(u) => <Quiet>{t("web.runtime.unreadable", { why: u().reason })}</Quiet>}</Match>
          <Match when={usage()}>
            <div {...stylex.attrs(styles.usageDiv2)}>
              <span {...stylex.attrs(styles.usageSpan)}>
                <SpriteIcon name={bottleSprite(quota())} size={52} />
                <span {...stylex.attrs(styles.usageSpan2)}>{quota().short || "—"}</span>
              </span>
              <div {...stylex.attrs(styles.usageDiv)}>
                <Switch>
                  <Match when={variant(usage(), "status", "balance")}>
                    {(u) => (
                      <>
                        <p {...stylex.attrs(styles.usageP, !u().available ? styles.usagePTone : styles.usagePAlt)}>
                          {t("web.runtime.balance", { provider: u().provider, enough: u().available })}
                        </p>
                        <p {...stylex.attrs(styles.usageP22)}>
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
                          <p {...stylex.attrs(styles.usageP22)}>{t("web.runtime.subscription", { tier: u().subscription ?? "" })}</p>
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
    <div {...stylex.attrs(styles.windowDiv)}>
      <span {...stylex.attrs(styles.windowSpan)}>
        <span {...stylex.attrs(styles.windowSpan2)}>{label()}</span>
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
        {(at) => <span {...stylex.attrs(styles.windowSpan3)}>{t("web.runtime.resets", { moment: momentText(at()) })}</span>}
      </Show>
    </div>
  );
}

export function SupportCard(props: { info: RuntimeInfo }) {
  const support = () => props.info.support;
  const refused = () => Object.entries(support().refused);
  return (
    <Card title={t("web.runtime.can")}>
      <div {...stylex.attrs(styles.supportCardDiv)}>
        <span {...stylex.attrs(styles.supportCardSpan2)}>
          <Icon name={support().steer ? "check" : "cross"} size={12} styles={[styles.supportCardIcon]} />
          {support().steer ? t("web.runtime.steer") : t("web.runtime.noSteer")}
        </span>
        <span {...stylex.attrs(styles.usageSpan2)}>{support().inProcess ? t("web.runtime.inProcess") : t("web.runtime.ownProcess")}</span>
        <span {...stylex.attrs(styles.supportCardSpan22)}>{t("web.runtime.refused")}</span>
        <Show when={refused().length > 0} fallback={<span {...stylex.attrs(styles.usageSpan2)}>{t("web.runtime.acceptsAll")}</span>}>
          <For each={refused()}>
            {([k, v]) => (
              <span {...stylex.attrs(styles.usageSpan2)}>
                <span {...stylex.attrs(styles.supportCardSpan3)}>{k}</span> <span {...stylex.attrs(styles.windowSpan3)}>{v}</span>
              </span>
            )}
          </For>
        </Show>
        <span {...stylex.attrs(styles.supportCardSpan22)}>{t("web.runtime.queries")}</span>
        <div {...stylex.attrs(styles.supportCardDiv2)}>
          <For each={RuntimeCapabilityValues}>
            {(c) => (
              <span {...stylex.attrs(styles.supportCardSpan, support().capabilities.includes(c) ? styles.supportCardSpanTone : styles.supportCardSpanAlt)}>
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
      styles={styles.numberInputTextInput}
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
    <div {...stylex.attrs(styles.windowDiv)}>
      <span {...stylex.attrs(styles.fieldSpan)}>
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
          <span {...stylex.attrs(styles.settingsCardSpan)}>
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
      <div {...stylex.attrs(styles.settingsCardDiv)}>
        <Toggle
          label={t("web.runtime.enabled")}
          tip={t("web.runtime.enabledHint")}
          checked={draft().enabled}
          onChange={(enabled) => setDraft({ ...draft(), enabled })}
        />
        <Field label={t("web.runtime.binPath")} hint={t("web.runtime.binPathHint", { id: props.info.id.toUpperCase() })}>
          <TextInput
            aria-label={t("web.runtime.binPath")}
            styles={styles.numberInputTextInput}
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
          <Show when={(model()?.effortLevels.length ?? 0) > 0} fallback={<span {...stylex.attrs(styles.settingsCardSpan2)}>—</span>}>
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
          <span {...stylex.attrs(styles.modelsCardSpan)}>{value()}</span>
          <Show when={model().isDefault}>
            <span {...stylex.attrs(styles.modelsCardSpan2)}>{t("web.runtime.default")}</span>
          </Show>
        </>
      ),
    ),
    effort: tableCell(
      effort,
      () => t("web.runtime.effort"),
      (value) => <span {...stylex.attrs(styles.usageP22)}>{value() || "—"}</span>,
    ),
  };
  return (
    <Card
      title={t("web.runtime.models")}
      action={<Show when={props.info.models}>{(m) => <span {...stylex.attrs(styles.usageP22)}>{t("web.runtime.modelCount", { n: m().length })}</span>}</Show>}
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
    <Card title={props.title} action={<Show when={props.entries}>{(e) => <span {...stylex.attrs(styles.usageP22)}>{e().length}</span>}</Show>}>
      <Switch
        fallback={
          <ul {...stylex.attrs(styles.windowDiv)}>
            <For each={props.entries}>
              {(e) => (
                <li {...stylex.attrs(styles.inventoryCardLi)}>
                  <span {...stylex.attrs(styles.inventoryCardSpan, e.enabled === false ? styles.inventoryCardSpanTone : styles.usagePAlt)}>{e.name}</span>
                  <Show when={e.description}>
                    <span {...stylex.attrs(styles.inventoryCardSpan2)}>{e.description}</span>
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
