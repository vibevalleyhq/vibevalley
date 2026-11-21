import { Scroll, signal, Text, View, type JSX } from "nsh";

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

import { Button } from "../../design/Button";
import { Checkbox } from "../../design/Checkbox";
import { ChipsInput, KeyValueEditor } from "../../design/Chips";
import { Select, TextArea, TextInput } from "../../design/Field";
import { Icon } from "../../design/Icon";
import { Toggle } from "../../design/layout";
import { RuntimeIcon } from "../../design/pixel/RuntimeIcon";
import { Segmented } from "../../design/Segmented";
import { Tabs } from "../../design/Tabs";
import { Bubble } from "../../design/Tip";
import { sortRuntimes } from "../../infra/agents";
import { ready, useRuntimes } from "../../infra/query";
import { Link as A } from "../../infra/router";
import { MemoryPanel } from "../memory";
import { useSkills } from "../runtime/SkillsPage";
import { Labeled } from "./AgentLook";

const noSupport: RuntimeSupport = { steer: false, refused: {}, capabilities: [], inProcess: false };
export const supportOf = (info: RuntimeInfo | undefined) => info?.support ?? noSupport;

type Patch = (a: Agent) => void;
type Tab = "who" | "runtime" | "persona" | "skills" | "tools" | "env" | "memory";

export function ConfigTabs(props: { draft: Agent; runtime?: RuntimeInfo | undefined; patch: Patch; nameTaken: boolean; isNew: boolean }) {
  const tab = signal<Tab>("who");
  const support = () => supportOf(props.runtime);
  const savedTabs: [Tab, string][] = [["memory", t("web.agent.tab.memory")]];
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
    <View class="min-h-0 flex-1">
      <Tabs
        label={t("web.agent.tabs")}
        value={tab()}
        onChange={(v) => tab.set(v)}
        items={tabs().map(([value, label]) => ({ value, label }))}
        class="border-b border-line px-3 py-2"
      />
      <ScrollBody>
        <If when={tab() === "who"}>
          <Labeled label={t("web.agent.name")} tip={t("web.agent.nameTip")} error={props.nameTaken ? t("web.agent.nameTaken") : undefined}>
            <TextInput
              testID="agent-name"
              accessibilityLabel={t("web.agent.name")}
              value={draft().name}
              onInput={(name) => props.patch({ ...draft(), name })}
            />
          </Labeled>
          <Labeled label={t("web.agent.duty")} tip={t("web.agent.dutyTip")}>
            <TextInput
              testID="agent-duty"
              accessibilityLabel={t("web.agent.duty")}
              placeholder={t("web.agent.roleHint")}
              value={draft().duty}
              onInput={(duty) => props.patch({ ...draft(), duty })}
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
        </If>
        <If when={tab() === "runtime"}>
          <RuntimeChoice draft={draft()} patch={props.patch} />
          <ModelAndEffort draft={draft()} runtime={props.runtime} patch={props.patch} />
          <Support runtime={draft().runtime} info={props.runtime} />
        </If>
        <If when={tab() === "persona"}>
          <Persona draft={draft()} support={support()} patch={props.patch} />
        </If>
        <If when={tab() === "skills"}>
          <SkillPicker draft={draft()} runtime={props.runtime} patch={props.patch} />
        </If>
        <If when={tab() === "tools"}>
          <Tools draft={draft()} runtime={props.runtime} patch={props.patch} />
        </If>
        <If when={tab() === "env"}>
          <Labeled label={t("web.agent.workdir")} tip={t("web.agent.workdirTip")}>
            <TextInput
              accessibilityLabel={t("web.agent.workdir")}
              class="font-mono"
              placeholder={t("web.agent.workdirHint")}
              value={draft().workdir}
              onInput={(workdir) => props.patch({ ...draft(), workdir })}
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
        </If>
        <If when={tab() === "memory"}>
          <MemoryPanel agent={draft().id} />
        </If>
      </ScrollBody>
    </View>
  );
}

function ScrollBody(props: { children: JSX.Element }) {
  return (
    <Scroll class="min-h-0 flex-1" contentClass="gap-4 p-4">
      {props.children}
    </Scroll>
  );
}

function RuntimeChoice(props: { draft: Agent; patch: Patch }) {
  const all = useRuntimes();
  const runtimes = () => sortRuntimes(ready(all, []));
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
      <If when={runtimes().length > 0} else={<Text class="text-xs text-muted">{t("web.agent.readingMachines")}</Text>}>
        <View class="grid gap-1.5 sm:grid-cols-2">
          <Each of={runtimes()} key={(r) => r.id}>
            {(info) => {
              const available = () => info().installation.status === "available";
              const ok = () => available() && info().settings.enabled;
              const active = () => props.draft.runtime === info().id;
              const status = () => {
                const inst = info().installation;
                if (inst.status === "unsupported" && inst.signInCommand) return t("web.runtime.quota.signedOut");
                if (inst.status === "unsupported") return inst.reason || t("web.runtime.unsupported");
                return inst.status === "available"
                  ? info().settings.enabled
                    ? (inst.version ?? t("web.agent.available"))
                    : t("web.agent.disabled")
                  : inst.status === "checking"
                    ? t("web.agent.checking")
                    : t("web.agent.notHere");
              };
              return (
                <View
                  role="button"
                  testID={`runtime-${info().id}`}
                  accessibilityState={{ selected: active() }}
                  accessibilityLabel={info().preset.label}
                  onPress={() => choose(info())}
                  class={`flex-row items-center gap-2 rounded-md border p-2 transition duration-120 ease-out focus-visible:outline-2 focus-visible:outline-focus ${
                    active() ? "border-accent bg-selected" : "border-line hover:border-faint hover:bg-hover"
                  }`}
                >
                  <View style={{ opacity: ok() ? 1 : 0.5 }}>
                    <RuntimeIcon runtime={info().id} size={32} />
                  </View>
                  <View class="min-w-0 flex-1">
                    <Text class="truncate text-sm font-medium text-ink">{info().preset.label}</Text>
                    <Text class={`truncate text-xs ${ok() ? "text-muted" : "text-berry"}`}>{status()}</Text>
                  </View>
                </View>
              );
            }}
          </Each>
        </View>
      </If>
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
        <Segmented
          label={t("web.agent.effort")}
          value={props.draft.effort}
          options={[{ value: "", label: t("web.agent.defaultEffort") }, ...levels().map((l) => ({ value: l, label: l, disabled: !!refusedEffort() }))]}
          onChange={(effort) => props.patch({ ...props.draft, effort })}
        />
      </Labeled>
    </>
  );
}

/** What it takes comes with runtime.list: until then, nothing is said rather than a guess. */
function Support(props: { runtime: string; info?: RuntimeInfo | undefined }) {
  const support = () => supportOf(props.info);
  return (
    <View class="gap-1.5 rounded-lg bg-side p-3">
      <Text role="header" class="text-sm font-semibold text-ink">
        {t("web.agent.can", { runtime: props.info ? props.info.preset.label : props.runtime })}
      </Text>
      <If when={props.info} else={<Text class="text-sm text-ink">{t("web.agent.readingMachines")}</Text>}>
        <View class="flex-row items-start gap-1.5">
          <View class="mt-1">
            <Icon name={support().steer ? "check" : "cross"} size={12} />
          </View>
          <Text class="text-sm text-ink">{support().steer ? t("web.agent.steer") : t("web.agent.noSteer")}</Text>
        </View>
        <Text class="text-sm text-ink">{support().inProcess ? t("web.agent.inProcess") : t("web.agent.ownProcess")}</Text>
        <Each of={Object.entries(support().refused)}>
          {(entry) => (
            <Text class="text-sm text-muted">
              {t("web.agent.refuses")}
              <Text class="font-mono text-ink">{entry()[0]}</Text>
              {t("web.agent.colon")}
              {entry()[1]}
            </Text>
          )}
        </Each>
      </If>
    </View>
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
          testID="agent-persona"
          accessibilityLabel={t("web.agent.tab.persona")}
          rows={9}
          placeholder={t("web.agent.personaHint")}
          value={props.draft.persona}
          onInput={(persona) => props.patch({ ...props.draft, persona })}
        />
      </Labeled>
      <Labeled label={t("web.agent.personaMode")} hint={mode()?.detail}>
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
          <A href="/team/skills">
            <Text class="text-xs text-muted underline">{t("web.agent.manageLibrary")}</Text>
          </A>
        }
      >
        <View class="gap-1.5">
          <Each of={ready(all, [])} key={(s) => s.id}>
            {(s) => {
              const on = () => props.draft.skills.includes(s().id);
              return (
                <View
                  class={`flex-row items-start gap-2.5 rounded-md border p-2.5 transition duration-120 ease-out ${
                    on() ? "border-accent bg-selected" : "border-line hover:border-faint hover:bg-hover"
                  }`}
                >
                  <Checkbox testid={`skill-${s().id}`} checked={on()} onChange={() => toggle(s().id)} label={s().name} class="mt-0.5" />
                  <View
                    role="button"
                    accessibilityLabel={s().name}
                    onPress={() => toggle(s().id)}
                    class="min-w-0 flex-1 rounded-xs focus-visible:outline-2 focus-visible:outline-focus"
                  >
                    <Text class="text-sm font-medium text-ink">
                      {s().name}
                      <If when={s().builtIn === true}>
                        <Text testID="built-in-mark" class="text-xs font-normal text-muted">
                          {` · ${t("web.runtime.library.builtInTag")}`}
                        </Text>
                      </If>
                    </Text>
                    <Text class="text-xs text-muted">{s().description}</Text>
                  </View>
                </View>
              );
            }}
          </Each>
        </View>
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
  const type = signal<"stdio" | "http">("stdio");
  const name = signal("");
  const target = signal("");
  const add = () => {
    const n = name().trim();
    const wanted = target().trim();
    if (!n || !wanted) return;
    const [command = "", ...args] = wanted.split(/\s+/u);
    const server: MCPServer = type() === "stdio" ? { type: "stdio", name: n, command, args, env: {} } : { type: "http", name: n, url: wanted, headers: {} };
    props.patch({ ...props.draft, mcpServers: [...props.draft.mcpServers.filter((s) => s.name !== n), server] });
    name.set("");
    target.set("");
  };
  return (
    <>
      <Labeled
        label={t("web.agent.mcp")}
        hint={mcpRefused() ?? t("web.agent.mcpHint")}
        error={mcpRefused() && props.draft.mcpServers.length > 0 ? mcpRefused() : undefined}
      >
        <View class={`gap-1.5 ${mcpRefused() ? "opacity-50" : ""}`}>
          <Each of={props.draft.mcpServers} key={(s) => s.name}>
            {(s) => (
              <View class="flex-row items-center gap-2 rounded-md bg-side px-3 py-2">
                <View class="rounded-sm bg-selected px-1.5 py-0.5">
                  <Text class="font-mono text-2xs font-medium text-ink">{s().type}</Text>
                </View>
                <Text class="text-sm font-medium text-ink">{s().name}</Text>
                <View class="min-w-0 flex-1" tooltip={<Bubble text={mcpTarget(s())} />}>
                  <Text class="truncate font-mono text-xs text-muted">{mcpTarget(s())}</Text>
                </View>
                <View
                  role="button"
                  disabled={!!mcpRefused()}
                  accessibilityLabel={t("web.agent.removeNamed", { name: s().name })}
                  onPress={() => props.patch({ ...props.draft, mcpServers: props.draft.mcpServers.filter((x) => x.name !== s().name) })}
                  class="group rounded-sm px-1.5 py-0.5 transition duration-120 ease-out hover:bg-hover"
                >
                  <Text class="text-xs text-muted group-hover:text-berry">{t("web.agent.remove")}</Text>
                </View>
              </View>
            )}
          </Each>
          <View class="flex-row flex-wrap items-center gap-1.5">
            <Segmented
              label={t("web.agent.mcpKind")}
              value={type()}
              options={[
                { value: "stdio", label: "stdio" },
                { value: "http", label: "http" },
              ]}
              onChange={(v) => type.set(v)}
            />
            <TextInput
              accessibilityLabel={t("web.agent.mcpName")}
              disabled={!!mcpRefused()}
              placeholder={t("web.agent.name")}
              wide={false}
              class="h-7 w-28"
              value={name()}
              onInput={(v) => name.set(v)}
            />
            <TextInput
              accessibilityLabel={t("web.agent.mcpTarget")}
              disabled={!!mcpRefused()}
              placeholder={type() === "stdio" ? "npx -y @scope/server" : "https://…/mcp"}
              wide={false}
              class="h-7 min-w-40 flex-1 font-mono"
              value={target()}
              onInput={(v) => target.set(v)}
              onSubmit={add}
            />
            <Button disabled={!!mcpRefused() || !name().trim() || !target().trim()} onPress={add}>
              {t("web.agent.add")}
            </Button>
          </View>
        </View>
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
        <If when={!toolsRefused() ? props.runtime?.tools : undefined}>
          {(tools) => (
            <View class="flex-row flex-wrap gap-1 pt-1.5">
              <Each of={tools().filter((tool) => !props.draft.disallowedTools.includes(tool.name))} key={(tool) => tool.name}>
                {(tool) => (
                  <View
                    role="button"
                    onPress={() => props.patch({ ...props.draft, disallowedTools: [...props.draft.disallowedTools, tool().name] })}
                    class="group rounded-sm border border-line bg-page px-1.5 py-0.5 transition duration-120 ease-out hover:bg-hover"
                  >
                    <Text class="font-mono text-xs text-muted group-hover:text-ink">{`+ ${tool().name}`}</Text>
                  </View>
                )}
              </Each>
            </View>
          )}
        </If>
      </Labeled>
      <Labeled label={t("web.agent.ownMcp", { runtime: props.runtime?.preset.label ?? props.draft.runtime })} tip={t("web.agent.ownMcpTip")}>
        <Inventory entries={props.runtime?.mcpServers ?? null} />
      </Labeled>
    </>
  );
}

function Inventory(props: { entries: InventoryEntry[] | null }) {
  return (
    <If when={props.entries} else={<Text class="text-xs text-muted">{t("web.agent.unreported")}</Text>}>
      {(entries) => (
        <If when={entries().length > 0} else={<Text class="text-xs text-muted">{t("web.agent.none")}</Text>}>
          <View class="gap-1">
            <Each of={entries()}>
              {(e) => (
                <View class="flex-row items-baseline gap-2">
                  <Text class={`font-mono text-sm ${e().enabled === false ? "text-muted line-through" : "text-ink"}`}>{e().name}</Text>
                  <View class="min-w-0 flex-1" tooltip={e().description ? <Bubble text={e().description} /> : undefined}>
                    <Text class="truncate text-xs text-muted">{e().description}</Text>
                  </View>
                  <If when={e().source}>
                    {(src) => (
                      <View class="max-w-40 shrink-0" tooltip={<Bubble text={src()} />}>
                        <Text class="truncate font-mono text-xs text-faint">{src()}</Text>
                      </View>
                    )}
                  </If>
                </View>
              )}
            </Each>
          </View>
        </If>
      )}
    </If>
  );
}
