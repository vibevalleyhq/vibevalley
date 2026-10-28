// 模板: every template a profile installs from, the orchestrators' first; a card shows its whole recipe before it is
// installed, and a folder on this machine can be added beside the built-in ones. /agents/templates.

import { agentsWording } from "./words";
import { createSignal, For, Show } from "solid-js";
import { useQueryClient } from "@tanstack/solid-query";
import type { AgentTemplate, RuntimeInfo } from "@vibevalley/protocol";
import { api, reasonOf } from "../../base/api";
import { useRouter } from "../../base/router";
import { aria } from "../../base/util";
import { ready, useAgentTemplates, useRuntimes } from "../../base/query";
import { toast } from "../../ui/toasts";
import { A } from "../../ui/A";
import { Button } from "../../ui/Button";
import { AgentFace, OrchestratorFace } from "../../ui/Face";
import { TextInput } from "../../ui/Field";
import { runtimeName } from "../../ui/runtimes";

export function TemplatesPage() {
  const templates = useAgentTemplates();
  const runtimes = useRuntimes();
  const client = useQueryClient();
  const [path, setPath] = createSignal("");
  const [adding, setAdding] = createSignal(false);
  const sorted = () => [...ready(templates, [])].sort((a, b) => (a.role === b.role ? 0 : a.role === "orchestrator" ? -1 : 1));
  const add = async () => {
    setAdding(true);
    try {
      const got = await api.agent.template.add({ path: path().trim() });
      await client.invalidateQueries({ queryKey: ["agent-templates"] });
      setPath("");
      toast(agentsWording().templates.added(got.name));
    } catch (e) {
      toast(reasonOf(e), "bad");
    } finally {
      setAdding(false);
    }
  };
  return (
    <div class="h-full overflow-y-auto">
      <div class="mx-auto flex max-w-6xl flex-col gap-6 px-4 pt-4 pb-8 sm:px-6">
        <div class="flex flex-col gap-1">
          <A href="/agents" class="text-xs text-muted hover:underline">
            {agentsWording().all}
          </A>
          <h1 class="text-2xl font-semibold">{agentsWording().templates.title}</h1>
          <p class="max-w-2xl text-sm text-muted">{agentsWording().templates.intro}</p>
        </div>
        <form
          class="flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (path().trim()) void add();
          }}
        >
          <TextInput
            aria-label={agentsWording().templates.folder}
            placeholder={agentsWording().templates.folderHint}
            value={path()}
            onInput={(e) => setPath(e.currentTarget.value)}
            class="min-w-0 flex-1"
          />
          <Button type="submit" disabled={adding() || !path().trim()}>
            {agentsWording().templates.add}
          </Button>
        </form>
        <div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <For each={sorted()} keyed={(t) => t.id}>
            {(t) => <TemplateCard template={t()} runtime={ready(runtimes, []).find((r) => r.id === t().runtime)} runtimes={ready(runtimes, [])} />}
          </For>
        </div>
      </div>
    </div>
  );
}

function TemplateCard(props: { template: AgentTemplate; runtime?: RuntimeInfo; runtimes: readonly RuntimeInfo[] }) {
  const [open, setOpen] = createSignal(false);
  const [sure, setSure] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const router = useRouter();
  const client = useQueryClient();
  const t = () => props.template;
  const orchestrator = () => t().role === "orchestrator";
  // An orchestrator runs in the server itself; a helper's runtime may be missing from this machine.
  const here = () => orchestrator() || props.runtime?.installation.status === "available";
  const install = async () => {
    setBusy(true);
    try {
      const made = await api.agent.template.install({ id: t().id });
      await Promise.all([client.invalidateQueries({ queryKey: ["agents"] }), client.invalidateQueries({ queryKey: ["agent-templates"] })]);
      router.navigate(`/agents/${encodeURIComponent(made.id)}`);
    } catch (e) {
      toast(reasonOf(e), "bad");
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    try {
      await api.agent.template.delete({ id: t().id });
      await client.invalidateQueries({ queryKey: ["agent-templates"] });
    } catch (e) {
      toast(reasonOf(e), "bad");
    }
  };
  return (
    <section aria-label={t().name} class="flex flex-col gap-3 rounded-lg border border-line bg-page p-4">
      <div class="flex items-start gap-3">
        <span class="flex size-16 shrink-0 items-center justify-center rounded-lg bg-hover">
          <Show when={orchestrator()} fallback={<AgentFace agentId={t().id} runtime={t().runtime} look={t().look} size={56} />}>
            <OrchestratorFace size={56} look={t().look.orchestrator ?? "farmer"} />
          </Show>
        </span>
        <span class="flex min-w-0 flex-1 flex-col gap-0.5">
          <span class="flex items-center gap-2">
            <span class="truncate text-base font-semibold">{t().name}</span>
            <span class="shrink-0 rounded bg-hover px-1.5 text-xs text-muted">{agentsWording().role[t().role]}</span>
          </span>
          <span class="line-clamp-2 text-sm text-muted">{t().duty}</span>
          <span class={["text-xs", here() ? "text-[#3f6427]" : "text-[#b8682a]"]}>
            {orchestrator()
              ? agentsWording().templates.onServer
              : here()
                ? agentsWording().templates.runsOn(runtimeName(props.runtimes, t().runtime))
                : agentsWording().templates.notHere(runtimeName(props.runtimes, t().runtime))}
          </span>
        </span>
      </div>
      <Show when={open()}>
        <div class="flex flex-col gap-2 rounded-md bg-hover p-3 text-sm">
          <Show when={t().tags.length > 0}>
            <p class="text-muted">
              {agentsWording().tags}
              {agentsWording().colon}
              {t().tags.join("、")}
            </p>
          </Show>
          <p class="text-xs font-medium text-muted">{agentsWording().personaLabel}</p>
          <p class="whitespace-pre-wrap">{t().persona || agentsWording().templates.noPersona}</p>
        </div>
      </Show>
      <div class="mt-auto flex flex-wrap items-center gap-2 border-t border-line pt-3 text-xs text-muted">
        <span class="flex-1">
          {t().installed.length > 0 ? agentsWording().templates.installed(t().installed.length) : ""}
          {t().source === "added" ? agentsWording().templates.addedHere : ""}
        </span>
        <Button aria-expanded={aria(open())} onClick={() => setOpen(!open())}>
          {open() ? agentsWording().templates.fold : agentsWording().templates.look}
        </Button>
        <Show when={t().source === "added"}>
          <Show when={sure()} fallback={<Button onClick={() => setSure(true)}>{agentsWording().remove}</Button>}>
            <Button tone="danger" onClick={() => void remove()}>
              {agentsWording().templates.removeSure}
            </Button>
          </Show>
        </Show>
        <Button tone="primary" disabled={busy()} onClick={() => void install()}>
          {agentsWording().templates.install}
        </Button>
      </div>
    </section>
  );
}
