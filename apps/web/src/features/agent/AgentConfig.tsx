import * as stylex from "@stylexjs/stylex";
import { createSignal, For, Match, Show, Switch } from "solid-js";

import { t } from "@vibevalley/i18n";
import {
  type Agent,
  type InventoryEntry,
  type MCPServer,
  type PersonaMode,
  type RuntimeInfo,
  type RuntimeSupport,
  sessionAppendSystemPrompt,
  sessionDisallowedTools,
  sessionEffort,
  sessionEnv,
  sessionMcpServers,
  sessionSystemPrompt,
} from "@vibevalley/protocol";

import { aria } from "#/base/dom.tsx";
import { MemoryPanel } from "#/features/memory/index.ts";
import { useSkills } from "#/features/runtime/index.ts";
import { ready, useRuntimes } from "#/infra/query.ts";
import { Link as A } from "#/infra/router.ts";
import { Button } from "#/ui/Button.tsx";
import { ChipsInput, KeyValueEditor } from "#/ui/Chips.tsx";
import { Select, TextArea, TextInput } from "#/ui/Field.tsx";
import { Icon } from "#/ui/Icon.tsx";
import { Toggle } from "#/ui/layout.tsx";
import { RuntimeIcon } from "#/ui/pixel/RuntimeIcon.tsx";
import { Segmented } from "#/ui/Segmented.tsx";
import { Tabs } from "#/ui/Tabs.tsx";

import { Labeled } from "./AgentLook";

const variantStyles4 = stylex.create({
  supportIcon: {
    marginTop: "var(--spacing)",
  },
});

const variantStyles3 = stylex.create({
  configTabsTextInput: {
    fontFamily: "var(--font-mono)",
  },
  toolsTextInput: {
    width: "calc(var(--spacing) * 28)",
  },
  toolsTextInput2: {
    minWidth: "calc(var(--spacing) * 40)",
    flex: "1",
    fontFamily: "var(--font-mono)",
  },
});

const variantStyles2 = stylex.create({
  skillPickerA: {
    fontSize: "var(--text-xs)",
    lineHeight: "var(--text-xs--line-height)",
    color: "var(--color-muted)",
    textDecorationLine: "underline",
  },
});

const variantStyles = stylex.create({
  configTabsDiv: {
    display: "flex",
    minHeight: "0",
    flex: "1",
    flexDirection: "column",
  },
  configTabsDiv2: {
    display: "flex",
    minHeight: "0",
    flex: "1",
    flexDirection: "column",
    gap: "calc(var(--spacing) * 4)",
    overflowY: "auto",
    padding: "calc(var(--spacing) * 4)",
  },
  runtimeChoiceButton: {
    display: "flex",
    cursor: "pointer",
    alignItems: "center",
    gap: "calc(var(--spacing) * 2)",
    borderRadius: "var(--radius-md)",
    borderStyle: "solid",
    borderWidth: "1px",
    padding: "calc(var(--spacing) * 2)",
    textAlign: "left",
  },
  runtimeChoiceButtonVariant: {
    borderColor: {
      default: "var(--color-ink)",
      "@supports (color:color-mix(in lab, red, red))": "color-mix(in oklab, var(--color-ink) 40%, transparent)",
    },
    backgroundColor: "var(--color-selected)",
  },
  runtimeChoiceButtonVariant2: {
    borderColor: "var(--color-line)",
    backgroundColor: {
      default: null,
      "@media (hover:hover)": {
        default: null,
        ":hover": "var(--color-hover)",
      },
    },
  },
  runtimeChoiceSpan: {},
  runtimeChoiceSpanVariant: {
    opacity: ".5",
    filter: "grayscale(100%)",
  },
  runtimeChoiceSpan2: {
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    overflow: "hidden",
    fontSize: "var(--text-sm)",
    lineHeight: "var(--text-sm--line-height)",
  },
  runtimeChoiceSpanVariant2: {
    fontWeight: "var(--font-weight-semibold)",
  },
  runtimeChoiceSpanVariant3: {
    fontWeight: "var(--font-weight-medium)",
  },
  runtimeChoiceSpan3: {
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    overflow: "hidden",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--text-xs--line-height)",
  },
  runtimeChoiceSpanVariant4: {
    color: "var(--color-muted)",
  },
  runtimeChoiceSpanVariant5: {
    color: "var(--color-berry)",
  },
  skillPickerButton: {
    display: "flex",
    cursor: "pointer",
    alignItems: "flex-start",
    gap: "calc(var(--spacing) * 2.5)",
    borderRadius: "var(--radius-md)",
    borderStyle: "solid",
    borderWidth: "1px",
    padding: "calc(var(--spacing) * 2.5)",
    textAlign: "left",
  },
  skillPickerSpan: {
    marginTop: "calc(var(--spacing) * .5)",
    display: "flex",
    width: "calc(var(--spacing) * 4)",
    height: "calc(var(--spacing) * 4)",
    flexShrink: "0",
    alignItems: "center",
    justifyContent: "center",
    borderRadius: ".25rem",
    borderStyle: "solid",
    borderWidth: "1px",
    backgroundColor: "var(--color-page)",
  },
  skillPickerSpanVariant: {
    borderColor: "var(--color-accent)",
  },
  skillPickerSpanVariant2: {
    borderColor: {
      default: "var(--color-ink)",
      "@supports (color:color-mix(in lab, red, red))": "color-mix(in oklab, var(--color-ink) 25%, transparent)",
    },
  },
  toolsDiv: {
    display: "flex",
    flexDirection: "column",
    gap: "calc(var(--spacing) * 1.5)",
  },
  toolsDivVariant: {
    opacity: ".5",
  },
  inventorySpan: {
    fontFamily: "var(--font-mono)",
    fontSize: "var(--text-sm)",
    lineHeight: "var(--text-sm--line-height)",
  },
  inventorySpanVariant: {
    color: "var(--color-muted)",
    textDecorationLine: "line-through",
  },
});

const viewStyles = stylex.create({
  runtimeChoiceSpan: {
    fontSize: "var(--text-xs)",
    lineHeight: "var(--text-xs--line-height)",
    color: "var(--color-muted)",
  },
  runtimeChoiceDiv: {
    display: "grid",
    gap: "calc(var(--spacing) * 1.5)",
    gridTemplateColumns: {
      default: null,
      "@media (width>=40rem)": "repeat(2,minmax(0,1fr))",
    },
  },
  runtimeChoiceSpan2: {
    display: "flex",
    minWidth: "0",
    flexDirection: "column",
  },
  supportSection: {
    display: "flex",
    flexDirection: "column",
    gap: "calc(var(--spacing) * 1.5)",
    borderRadius: "var(--radius-lg)",
    borderStyle: "solid",
    borderWidth: "1px",
    borderColor: "var(--color-line)",
    padding: "calc(var(--spacing) * 3)",
  },
  supportH3: {
    fontSize: "var(--text-sm)",
    lineHeight: "var(--text-sm--line-height)",
    fontWeight: "var(--font-weight-semibold)",
  },
  supportSpan: {
    fontSize: "var(--text-sm)",
    lineHeight: "var(--text-sm--line-height)",
  },
  supportSpan2: {
    display: "flex",
    alignItems: "flex-start",
    gap: "calc(var(--spacing) * 1.5)",
    fontSize: "var(--text-sm)",
    lineHeight: "var(--text-sm--line-height)",
  },
  supportSpan3: {
    fontSize: "var(--text-sm)",
    lineHeight: "var(--text-sm--line-height)",
    color: "var(--color-muted)",
  },
  supportSpan4: {
    fontFamily: "var(--font-mono)",
    color: "var(--color-ink)",
  },
  skillPickerDiv: {
    display: "flex",
    flexDirection: "column",
    gap: "calc(var(--spacing) * 1.5)",
  },
  skillPickerSpan: {
    display: "flex",
    flexDirection: "column",
  },
  skillPickerSpan2: {
    fontSize: "var(--text-sm)",
    lineHeight: "var(--text-sm--line-height)",
    fontWeight: "var(--font-weight-medium)",
  },
  toolsDiv: {
    display: "flex",
    alignItems: "center",
    gap: "calc(var(--spacing) * 2)",
    borderRadius: "var(--radius-md)",
    borderStyle: "solid",
    borderWidth: "1px",
    borderColor: "var(--color-line)",
    paddingInline: "calc(var(--spacing) * 3)",
    paddingBlock: "calc(var(--spacing) * 2)",
  },
  toolsSpan: {
    borderRadius: ".25rem",
    backgroundColor: "var(--color-selected)",
    paddingInline: "calc(var(--spacing) * 1.5)",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--text-xs--line-height)",
  },
  toolsSpan2: {
    minWidth: "0",
    flex: "1",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    overflow: "hidden",
    fontFamily: "var(--font-mono)",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--text-xs--line-height)",
    color: "var(--color-muted)",
  },
  toolsButton: {
    cursor: "pointer",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--text-xs--line-height)",
    color: {
      default: "var(--color-muted)",
      "@media (hover:hover)": {
        default: null,
        ":hover": "var(--color-berry)",
      },
    },
  },
  toolsDiv2: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: "calc(var(--spacing) * 1.5)",
  },
  toolsDiv3: {
    display: "flex",
    flexWrap: "wrap",
    gap: "var(--spacing)",
    paddingTop: "calc(var(--spacing) * 1.5)",
  },
  toolsButton2: {
    cursor: "pointer",
    borderRadius: ".25rem",
    borderStyle: "solid",
    borderWidth: "1px",
    borderColor: "var(--color-line)",
    backgroundColor: {
      default: "var(--color-page)",
      "@media (hover:hover)": {
        default: null,
        ":hover": "var(--color-hover)",
      },
    },
    paddingInline: "calc(var(--spacing) * 1.5)",
    paddingBlock: "1px",
    fontFamily: "var(--font-mono)",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--text-xs--line-height)",
    color: {
      default: "var(--color-muted)",
      "@media (hover:hover)": {
        default: null,
        ":hover": "var(--color-ink)",
      },
    },
  },
  inventoryUl: {
    display: "flex",
    flexDirection: "column",
    gap: "var(--spacing)",
  },
  inventoryLi: {
    display: "flex",
    alignItems: "baseline",
    gap: "calc(var(--spacing) * 2)",
  },
  inventorySpan: {
    minWidth: "0",
    flex: "1",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    overflow: "hidden",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--text-xs--line-height)",
    color: "var(--color-muted)",
  },
  inventorySpan2: {
    maxWidth: "calc(var(--spacing) * 40)",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    overflow: "hidden",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--text-xs--line-height)",
    color: "var(--color-muted)",
  },
});

const styles = stylex.create({
  tabs: {
    borderBottomWidth: 1,
    borderBottomStyle: "solid",
    borderColor: "var(--color-line)",
    paddingInline: "calc(var(--spacing) * 3)",
    paddingBlock: "calc(var(--spacing) * 2)",
  },
});

const noSupport: RuntimeSupport = { steer: false, refused: {}, capabilities: [], inProcess: false };
export const supportOf = (info: RuntimeInfo | undefined) => info?.support ?? noSupport;

type Patch = (a: Agent) => void;
type Tab = "who" | "runtime" | "persona" | "skills" | "tools" | "env" | "memory" | "trajectories";

export function ConfigTabs(props: {
  draft: Agent;
  runtime?: RuntimeInfo | undefined;
  patch: Patch;
  nameTaken: boolean;
  isNew: boolean;
  onTrajectories: () => void;
}) {
  const [tab, setTab] = createSignal<Tab>("who");
  const support = () => supportOf(props.runtime);
  const savedTabs: [Tab, string][] = [
    ["memory", t("web.agent.tab.memory")],
    ["trajectories", t("web.agent.trajectories")],
  ];
  const tabs = (): [Tab, string][] => [
    ["who", t("web.agent.tab.who")],
    ["runtime", t("web.agent.tab.runtime")],
    ["persona", t("web.agent.tab.persona")],
    ["skills", t("web.agent.tab.skills")],
    ["tools", t("web.agent.tab.tools")],
    ["env", t("web.agent.tab.env")],
    ...(props.isNew ? [] : savedTabs),
  ];
  const envRefused = () => support().refused[sessionEnv];
  const draft = () => props.draft;
  return (
    <div {...stylex.attrs(variantStyles.configTabsDiv)}>
      <Tabs
        label={t("web.agent.tabs")}
        value={tab()}
        onChange={(v) => (v === "trajectories" ? props.onTrajectories() : setTab(v))}
        items={tabs().map(([value, label]) => ({ value, label }))}
        styles={styles.tabs}
      />
      <div {...stylex.attrs(variantStyles.configTabsDiv2)}>
        <Switch>
          <Match when={tab() === "who"}>
            <Labeled label={t("web.agent.name")} tip={t("web.agent.nameTip")} error={props.nameTaken ? t("web.agent.nameTaken") : undefined}>
              <TextInput
                data-testid="agent-name"
                aria-label={t("web.agent.name")}
                value={draft().name}
                onInput={(e) => props.patch({ ...draft(), name: e.currentTarget.value })}
              />
            </Labeled>
            <Labeled label={t("web.agent.duty")} tip={t("web.agent.dutyTip")}>
              <TextInput
                data-testid="agent-duty"
                aria-label={t("web.agent.duty")}
                placeholder={t("web.agent.roleHint")}
                value={draft().duty}
                onInput={(e) => props.patch({ ...draft(), duty: e.currentTarget.value })}
              />
            </Labeled>
            <Labeled label={t("web.agent.tags")} tip={t("web.agent.tagsTip")}>
              <ChipsInput
                label={t("web.agent.tags")}
                placeholder={t("web.agent.tagsHint")}
                value={draft().tags}
                onChange={(tags) => props.patch({ ...draft(), tags })}
              />
            </Labeled>
            <Toggle
              label={t("web.agent.enabled")}
              hint={t("web.agent.enabledHint")}
              checked={draft().enabled}
              onChange={(enabled) => props.patch({ ...draft(), enabled })}
            />
          </Match>
          <Match when={tab() === "runtime"}>
            <RuntimeChoice draft={draft()} patch={props.patch} />
            <ModelAndEffort draft={draft()} runtime={props.runtime} patch={props.patch} />
            <Support runtime={draft().runtime} info={props.runtime} />
          </Match>
          <Match when={tab() === "persona"}>
            <Persona draft={draft()} support={support()} patch={props.patch} />
          </Match>
          <Match when={tab() === "skills"}>
            <SkillPicker draft={draft()} runtime={props.runtime} patch={props.patch} />
          </Match>
          <Match when={tab() === "tools"}>
            <Tools draft={draft()} runtime={props.runtime} patch={props.patch} />
          </Match>
          <Match when={tab() === "env"}>
            <Labeled label={t("web.agent.workdir")} tip={t("web.agent.workdirTip")}>
              <TextInput
                aria-label={t("web.agent.workdir")}
                styles={variantStyles3.configTabsTextInput}
                placeholder={t("web.agent.workdirHint")}
                value={draft().workdir}
                onInput={(e) => props.patch({ ...draft(), workdir: e.currentTarget.value })}
              />
            </Labeled>
            <Toggle
              label={t("web.agent.worktree")}
              hint={t("web.agent.worktreeHint")}
              checked={draft().worktree}
              onChange={(worktree) => props.patch({ ...draft(), worktree })}
            />
            <Labeled
              label={t("web.agent.env")}
              hint={envRefused() ?? t("web.agent.envHint")}
              error={envRefused() && Object.keys(draft().env).length > 0 ? envRefused() : undefined}
            >
              <KeyValueEditor value={draft().env} disabled={!!envRefused()} onChange={(env) => props.patch({ ...draft(), env })} />
            </Labeled>
          </Match>
          <Match when={tab() === "memory"}>
            <MemoryPanel agent={draft().id} />
          </Match>
        </Switch>
      </div>
    </div>
  );
}

function RuntimeChoice(props: { draft: Agent; patch: Patch }) {
  const all = useRuntimes();
  const runtimes = () => ready(all, []);
  const choose = (info: RuntimeInfo) => {
    const f = supportOf(info);
    const cannotTakeSystemPrompt = !!f.refused[sessionAppendSystemPrompt] || !!f.refused[sessionSystemPrompt];
    const d = props.draft;
    // A persona the new runtime can't take as a system prompt goes into each job instead.
    props.patch({
      ...d,
      runtime: info.id,
      model: "",
      effort: "",
      personaMode: d.personaMode !== "prompt" && cannotTakeSystemPrompt ? "prompt" : d.personaMode,
    });
  };
  return (
    <Labeled label={t("web.agent.machine")} tip={t("web.agent.machineTip")}>
      <Show when={runtimes().length > 0} fallback={<span {...stylex.attrs(viewStyles.runtimeChoiceSpan)}>{t("web.agent.readingMachines")}</span>}>
        <div {...stylex.attrs(viewStyles.runtimeChoiceDiv)}>
          <For each={runtimes()}>
            {(info) => {
              const available = () => info.installation.status === "available";
              const ok = () => available() && info.settings.enabled;
              const active = () => props.draft.runtime === info.id;
              const status = () => {
                const inst = info.installation;
                return inst.status === "available"
                  ? info.settings.enabled
                    ? (inst.version ?? t("web.agent.available"))
                    : t("web.agent.disabled")
                  : inst.status === "checking"
                    ? t("web.agent.checking")
                    : t("web.agent.notHere");
              };
              return (
                <button
                  type="button"
                  aria-pressed={aria(active())}
                  aria-label={info.preset.label}
                  onClick={() => choose(info)}
                  {...stylex.attrs(
                    variantStyles.runtimeChoiceButton,
                    active() ? variantStyles.runtimeChoiceButtonVariant : variantStyles.runtimeChoiceButtonVariant2,
                  )}
                >
                  <span {...stylex.attrs(variantStyles.runtimeChoiceSpan, !ok() ? variantStyles.runtimeChoiceSpanVariant : variantStyles.runtimeChoiceSpan)}>
                    <RuntimeIcon runtime={info.id} size={32} />
                  </span>
                  <span {...stylex.attrs(viewStyles.runtimeChoiceSpan2)}>
                    <span
                      {...stylex.attrs(
                        variantStyles.runtimeChoiceSpan2,
                        active() ? variantStyles.runtimeChoiceSpanVariant2 : variantStyles.runtimeChoiceSpanVariant3,
                      )}
                    >
                      {info.preset.label}
                    </span>
                    <span
                      {...stylex.attrs(
                        variantStyles.runtimeChoiceSpan3,
                        ok() ? variantStyles.runtimeChoiceSpanVariant4 : variantStyles.runtimeChoiceSpanVariant5,
                      )}
                    >
                      {status()}
                    </span>
                  </span>
                </button>
              );
            }}
          </For>
        </div>
      </Show>
    </Labeled>
  );
}

function ModelAndEffort(props: { draft: Agent; runtime?: RuntimeInfo | undefined; patch: Patch }) {
  const models = () => props.runtime?.models ?? [];
  const fallback = () => props.runtime?.settings.defaultModel || models().find((m) => m.isDefault)?.id || "";
  const model = () => models().find((m) => m.id === (props.draft.model || fallback()));
  const refusedEffort = () => supportOf(props.runtime).refused[sessionEffort];
  const levels = () => model()?.effortLevels ?? [];
  return (
    <>
      <Labeled label={t("web.agent.model")} hint={models().length === 0 ? t("web.agent.noModels") : undefined}>
        <Select
          label={t("web.agent.model")}
          value={props.draft.model}
          placeholder={fallback() ? t("web.agent.runtimeDefaultModel", { model: fallback() }) : t("web.agent.runtimeDefault")}
          options={models().map((m) => ({
            value: m.id,
            label: m.effortLevels.length > 0 ? t("web.agent.modelLevels", { name: m.name, n: m.effortLevels.length }) : m.name,
          }))}
          onChange={(m) => props.patch({ ...props.draft, model: m, effort: "" })}
        />
      </Labeled>
      <Labeled
        label={t("web.agent.effort")}
        hint={
          refusedEffort() ??
          (levels().length === 0
            ? model()?.name
              ? t("web.agent.noEffortModel", { model: model()?.name ?? "" })
              : t("web.agent.noEffort")
            : t("web.agent.effortDefault"))
        }
      >
        <div>
          <Segmented
            label={t("web.agent.effort")}
            value={props.draft.effort}
            options={[{ value: "", label: t("web.agent.defaultEffort") }, ...levels().map((l) => ({ value: l, label: l, disabled: !!refusedEffort() }))]}
            onChange={(effort) => props.patch({ ...props.draft, effort })}
          />
        </div>
      </Labeled>
    </>
  );
}

/** What it takes comes with runtime.list: until then, nothing is said rather than a guess. */
function Support(props: { runtime: string; info?: RuntimeInfo | undefined }) {
  const support = () => supportOf(props.info);
  return (
    <section {...stylex.attrs(viewStyles.supportSection)}>
      <h3 {...stylex.attrs(viewStyles.supportH3)}>{t("web.agent.can", { runtime: props.info ? props.info.preset.label : props.runtime })}</h3>
      <Show when={props.info} fallback={<span {...stylex.attrs(viewStyles.supportSpan)}>{t("web.agent.readingMachines")}</span>}>
        <span {...stylex.attrs(viewStyles.supportSpan2)}>
          <Icon name={support().steer ? "check" : "cross"} size={12} styles={[variantStyles4.supportIcon]} />
          {support().steer ? t("web.agent.steer") : t("web.agent.noSteer")}
        </span>
        <span {...stylex.attrs(viewStyles.supportSpan)}>{support().inProcess ? t("web.agent.inProcess") : t("web.agent.ownProcess")}</span>
        <For each={Object.entries(support().refused)}>
          {([option, reason]) => (
            <span {...stylex.attrs(viewStyles.supportSpan3)}>
              {t("web.agent.refuses")}
              <span {...stylex.attrs(viewStyles.supportSpan4)}>{option}</span>
              {t("web.agent.colon")}
              {reason}
            </span>
          )}
        </For>
      </Show>
    </section>
  );
}

const personaModes: { value: PersonaMode; label: string; detail: string; option?: string }[] = [
  { value: "append", label: t("web.agent.persona.append.label"), detail: t("web.agent.persona.append.detail"), option: sessionAppendSystemPrompt },
  { value: "replace", label: t("web.agent.persona.replace.label"), detail: t("web.agent.persona.replace.detail"), option: sessionSystemPrompt },
  { value: "prompt", label: t("web.agent.persona.prompt.label"), detail: t("web.agent.persona.prompt.detail") },
];

function Persona(props: { draft: Agent; support: RuntimeSupport; patch: Patch }) {
  const mode = () => personaModes.find((m) => m.value === props.draft.personaMode);
  return (
    <>
      <Labeled label={t("web.agent.tab.persona")} tip={t("web.agent.personaTip")}>
        <TextArea
          data-testid="agent-persona"
          aria-label={t("web.agent.tab.persona")}
          rows={9}
          placeholder={t("web.agent.personaHint")}
          value={props.draft.persona}
          onInput={(e) => props.patch({ ...props.draft, persona: e.currentTarget.value })}
        />
      </Labeled>
      <Labeled label={t("web.agent.personaMode")} hint={mode()?.detail}>
        <div>
          <Segmented
            label={t("web.agent.personaMode")}
            value={props.draft.personaMode}
            options={personaModes.map((m) => ({
              value: m.value,
              label: m.label,
              disabled: !!m.option && !!props.support.refused[m.option],
              title: m.option ? props.support.refused[m.option] : undefined,
            }))}
            onChange={(personaMode) => props.patch({ ...props.draft, personaMode })}
          />
        </div>
      </Labeled>
    </>
  );
}

function SkillPicker(props: { draft: Agent; runtime?: RuntimeInfo | undefined; patch: Patch }) {
  const all = useSkills();
  const toggle = (id: string) => {
    const d = props.draft;
    props.patch({ ...d, skills: d.skills.includes(id) ? d.skills.filter((s) => s !== id) : [...d.skills, id] });
  };
  return (
    <>
      <Labeled
        label={t("web.agent.library")}
        tip={t("web.agent.libraryTip")}
        aside={
          <A href="/settings/skills" {...stylex.attrs(variantStyles2.skillPickerA)}>
            {t("web.agent.manageLibrary")}
          </A>
        }
      >
        <div {...stylex.attrs(viewStyles.skillPickerDiv)}>
          <For each={ready(all, [])}>
            {(s) => {
              const on = () => props.draft.skills.includes(s.id);
              return (
                <button
                  type="button"
                  role="checkbox"
                  aria-checked={aria(on())}
                  aria-label={s.name}
                  onClick={() => toggle(s.id)}
                  {...stylex.attrs(
                    variantStyles.skillPickerButton,
                    on() ? variantStyles.runtimeChoiceButtonVariant : variantStyles.runtimeChoiceButtonVariant2,
                  )}
                >
                  <span {...stylex.attrs(variantStyles.skillPickerSpan, on() ? variantStyles.skillPickerSpanVariant : variantStyles.skillPickerSpanVariant2)}>
                    <Show when={on()}>
                      <Icon name="check" size={12} />
                    </Show>
                  </span>
                  <span {...stylex.attrs(viewStyles.skillPickerSpan)}>
                    <span {...stylex.attrs(viewStyles.skillPickerSpan2)}>{s.name}</span>
                    <span {...stylex.attrs(viewStyles.runtimeChoiceSpan)}>{s.description}</span>
                  </span>
                </button>
              );
            }}
          </For>
        </div>
      </Labeled>
      <Labeled label={t("web.agent.ownSkills", { runtime: props.runtime?.preset.label ?? props.draft.runtime })} tip={t("web.agent.ownSkillsTip")}>
        <Inventory entries={props.runtime?.skills ?? null} />
      </Labeled>
    </>
  );
}

const mcpTarget = (s: MCPServer) => (s.type === "stdio" ? [s.command, ...s.args].join(" ") : s.url);

function Tools(props: { draft: Agent; runtime?: RuntimeInfo | undefined; patch: Patch }) {
  const support = () => supportOf(props.runtime);
  const mcpRefused = () => support().refused[sessionMcpServers];
  const toolsRefused = () => support().refused[sessionDisallowedTools];
  const [type, setType] = createSignal<"stdio" | "http">("stdio");
  const [name, setName] = createSignal("");
  const [target, setTarget] = createSignal("");
  const add = () => {
    const n = name().trim();
    const wanted = target().trim();
    if (!n || !wanted) return;
    const [command = "", ...args] = wanted.split(/\s+/u);
    const server: MCPServer = type() === "stdio" ? { type: "stdio", name: n, command, args, env: {} } : { type: "http", name: n, url: wanted, headers: {} };
    props.patch({ ...props.draft, mcpServers: [...props.draft.mcpServers.filter((s) => s.name !== n), server] });
    setName("");
    setTarget("");
  };
  return (
    <>
      <Labeled
        label={t("web.agent.mcp")}
        hint={mcpRefused() ?? t("web.agent.mcpHint")}
        error={mcpRefused() && props.draft.mcpServers.length > 0 ? mcpRefused() : undefined}
      >
        <div {...stylex.attrs(variantStyles.toolsDiv, mcpRefused() ? variantStyles.toolsDivVariant : variantStyles.runtimeChoiceSpan)}>
          <For each={props.draft.mcpServers}>
            {(s) => (
              <div {...stylex.attrs(viewStyles.toolsDiv)}>
                <span {...stylex.attrs(viewStyles.toolsSpan)}>{s.type}</span>
                <span {...stylex.attrs(viewStyles.skillPickerSpan2)}>{s.name}</span>
                <span {...stylex.attrs(viewStyles.toolsSpan2)}>{mcpTarget(s)}</span>
                <button
                  type="button"
                  disabled={!!mcpRefused()}
                  aria-label={t("web.agent.removeNamed", { name: s.name })}
                  onClick={() => props.patch({ ...props.draft, mcpServers: props.draft.mcpServers.filter((x) => x.name !== s.name) })}
                  {...stylex.attrs(viewStyles.toolsButton)}
                >
                  {t("web.agent.remove")}
                </button>
              </div>
            )}
          </For>
          <div {...stylex.attrs(viewStyles.toolsDiv2)}>
            <Segmented
              label={t("web.agent.mcpKind")}
              value={type()}
              options={[
                { value: "stdio", label: "stdio" },
                { value: "http", label: "http" },
              ]}
              onChange={setType}
            />
            <TextInput
              aria-label={t("web.agent.mcpName")}
              disabled={!!mcpRefused()}
              placeholder={t("web.agent.name")}
              styles={variantStyles3.toolsTextInput}
              value={name()}
              onInput={(e) => setName(e.currentTarget.value)}
            />
            <TextInput
              aria-label={t("web.agent.mcpTarget")}
              disabled={!!mcpRefused()}
              placeholder={type() === "stdio" ? "npx -y @scope/server" : "https://…/mcp"}
              styles={variantStyles3.toolsTextInput2}
              value={target()}
              onInput={(e) => setTarget(e.currentTarget.value)}
            />
            <Button disabled={!!mcpRefused() || !name().trim() || !target().trim()} onClick={add}>
              {t("web.agent.add")}
            </Button>
          </div>
        </div>
      </Labeled>
      <Labeled
        label={t("web.agent.disallowed")}
        hint={toolsRefused() ?? t("web.agent.disallowedHint")}
        error={toolsRefused() && props.draft.disallowedTools.length > 0 ? toolsRefused() : undefined}
      >
        <ChipsInput
          label={t("web.agent.disallowed")}
          placeholder={t("web.agent.disallowedExample")}
          disabled={!!toolsRefused()}
          value={props.draft.disallowedTools}
          onChange={(disallowedTools) => props.patch({ ...props.draft, disallowedTools })}
        />
        <Show when={!toolsRefused() ? props.runtime?.tools : undefined}>
          {(tools) => (
            <div {...stylex.attrs(viewStyles.toolsDiv3)}>
              <For each={tools().filter((tool) => !props.draft.disallowedTools.includes(tool.name))}>
                {(tool) => (
                  <button
                    type="button"
                    onClick={() => props.patch({ ...props.draft, disallowedTools: [...props.draft.disallowedTools, tool.name] })}
                    {...stylex.attrs(viewStyles.toolsButton2)}
                  >
                    + {tool.name}
                  </button>
                )}
              </For>
            </div>
          )}
        </Show>
      </Labeled>
      <Labeled label={t("web.agent.ownMcp", { runtime: props.runtime?.preset.label ?? props.draft.runtime })} tip={t("web.agent.ownMcpTip")}>
        <Inventory entries={props.runtime?.mcpServers ?? null} />
      </Labeled>
    </>
  );
}

function Inventory(props: { entries: InventoryEntry[] | null }) {
  return (
    <Switch
      fallback={
        <ul {...stylex.attrs(viewStyles.inventoryUl)}>
          <For each={props.entries}>
            {(e) => (
              <li {...stylex.attrs(viewStyles.inventoryLi)}>
                <span
                  {...stylex.attrs(variantStyles.inventorySpan, e.enabled === false ? variantStyles.inventorySpanVariant : variantStyles.runtimeChoiceSpan)}
                >
                  {e.name}
                </span>
                <span {...stylex.attrs(viewStyles.inventorySpan)}>{e.description}</span>
                <Show when={e.source}>
                  <span {...stylex.attrs(viewStyles.inventorySpan2)}>{e.source}</span>
                </Show>
              </li>
            )}
          </For>
        </ul>
      }
    >
      <Match when={!props.entries}>
        <span {...stylex.attrs(viewStyles.runtimeChoiceSpan)}>{t("web.agent.unreported")}</span>
      </Match>
      <Match when={props.entries?.length === 0}>
        <span {...stylex.attrs(viewStyles.runtimeChoiceSpan)}>{t("web.agent.none")}</span>
      </Match>
    </Switch>
  );
}
