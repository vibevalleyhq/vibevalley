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
import { A } from "#/ui/A.tsx";
import { Button } from "#/ui/Button.tsx";
import { ChipsInput, KeyValueEditor } from "#/ui/Chips.tsx";
import { Select, TextArea, TextInput } from "#/ui/Field.tsx";
import { Icon } from "#/ui/Icon.tsx";
import { Toggle } from "#/ui/layout.tsx";
import { RuntimeIcon } from "#/ui/pixel/RuntimeIcon.tsx";
import { Segmented } from "#/ui/Segmented.tsx";
import { Tabs } from "#/ui/Tabs.tsx";

import { Labeled } from "./AgentLook";

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
    <div class="flex min-h-0 flex-1 flex-col">
      <Tabs
        label={t("web.agent.tabs")}
        value={tab()}
        onChange={(v) => (v === "trajectories" ? props.onTrajectories() : setTab(v))}
        items={tabs().map(([value, label]) => ({ value, label }))}
        class="border-b border-line px-3 py-2"
      />
      <div class="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
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
                class="font-mono"
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
      <Show when={runtimes().length > 0} fallback={<span class="text-xs text-muted">{t("web.agent.readingMachines")}</span>}>
        <div class="grid gap-1.5 sm:grid-cols-2">
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
                  class={[
                    "flex cursor-pointer items-center gap-2 rounded-md border p-2 text-left",
                    active() ? "border-ink/40 bg-selected" : "border-line hover:bg-hover",
                  ]}
                >
                  <span class={{ "opacity-50 grayscale": !ok() }}>
                    <RuntimeIcon runtime={info.id} size={32} />
                  </span>
                  <span class="flex min-w-0 flex-col">
                    <span class={["truncate text-sm", active() ? "font-semibold" : "font-medium"]}>{info.preset.label}</span>
                    <span class={["truncate text-xs", ok() ? "text-muted" : "text-berry"]}>{status()}</span>
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
    <section class="flex flex-col gap-1.5 rounded-lg border border-line p-3">
      <h3 class="text-sm font-semibold">{t("web.agent.can", { runtime: props.info ? props.info.preset.label : props.runtime })}</h3>
      <Show when={props.info} fallback={<span class="text-sm">{t("web.agent.readingMachines")}</span>}>
        <span class="flex items-start gap-1.5 text-sm">
          <Icon name={support().steer ? "check" : "cross"} size={12} class="mt-1" />
          {support().steer ? t("web.agent.steer") : t("web.agent.noSteer")}
        </span>
        <span class="text-sm">{support().inProcess ? t("web.agent.inProcess") : t("web.agent.ownProcess")}</span>
        <For each={Object.entries(support().refused)}>
          {([option, reason]) => (
            <span class="text-sm text-muted">
              {t("web.agent.refuses")}
              <span class="font-mono text-ink">{option}</span>
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
          <A href="/settings/skills" class="text-xs text-muted underline">
            {t("web.agent.manageLibrary")}
          </A>
        }
      >
        <div class="flex flex-col gap-1.5">
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
                  class={[
                    "flex cursor-pointer items-start gap-2.5 rounded-md border p-2.5 text-left",
                    on() ? "border-ink/40 bg-selected" : "border-line hover:bg-hover",
                  ]}
                >
                  <span class={["mt-0.5 flex size-4 shrink-0 items-center justify-center rounded border bg-page", on() ? "border-accent" : "border-ink/25"]}>
                    <Show when={on()}>
                      <Icon name="check" size={12} />
                    </Show>
                  </span>
                  <span class="flex flex-col">
                    <span class="text-sm font-medium">{s.name}</span>
                    <span class="text-xs text-muted">{s.description}</span>
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
        <div class={["flex flex-col gap-1.5", { "opacity-50": !!mcpRefused() }]}>
          <For each={props.draft.mcpServers}>
            {(s) => (
              <div class="flex items-center gap-2 rounded-md border border-line px-3 py-2">
                <span class="rounded bg-selected px-1.5 text-xs">{s.type}</span>
                <span class="text-sm font-medium">{s.name}</span>
                <span class="min-w-0 flex-1 truncate font-mono text-xs text-muted">{mcpTarget(s)}</span>
                <button
                  type="button"
                  disabled={!!mcpRefused()}
                  aria-label={t("web.agent.removeNamed", { name: s.name })}
                  onClick={() => props.patch({ ...props.draft, mcpServers: props.draft.mcpServers.filter((x) => x.name !== s.name) })}
                  class="cursor-pointer text-xs text-muted hover:text-berry"
                >
                  {t("web.agent.remove")}
                </button>
              </div>
            )}
          </For>
          <div class="flex flex-wrap items-center gap-1.5">
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
              class="w-28"
              value={name()}
              onInput={(e) => setName(e.currentTarget.value)}
            />
            <TextInput
              aria-label={t("web.agent.mcpTarget")}
              disabled={!!mcpRefused()}
              placeholder={type() === "stdio" ? "npx -y @scope/server" : "https://…/mcp"}
              class="min-w-40 flex-1 font-mono"
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
            <div class="flex flex-wrap gap-1 pt-1.5">
              <For each={tools().filter((tool) => !props.draft.disallowedTools.includes(tool.name))}>
                {(tool) => (
                  <button
                    type="button"
                    onClick={() => props.patch({ ...props.draft, disallowedTools: [...props.draft.disallowedTools, tool.name] })}
                    class="cursor-pointer rounded border border-line bg-page px-1.5 py-px font-mono text-xs text-muted hover:bg-hover hover:text-ink"
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
        <ul class="flex flex-col gap-1">
          <For each={props.entries}>
            {(e) => (
              <li class="flex items-baseline gap-2">
                <span class={["font-mono text-sm", { "text-muted line-through": e.enabled === false }]}>{e.name}</span>
                <span class="min-w-0 flex-1 truncate text-xs text-muted">{e.description}</span>
                <Show when={e.source}>
                  <span class="max-w-40 truncate text-xs text-muted">{e.source}</span>
                </Show>
              </li>
            )}
          </For>
        </ul>
      }
    >
      <Match when={!props.entries}>
        <span class="text-xs text-muted">{t("web.agent.unreported")}</span>
      </Match>
      <Match when={props.entries?.length === 0}>
        <span class="text-xs text-muted">{t("web.agent.none")}</span>
      </Match>
    </Switch>
  );
}
