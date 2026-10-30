// 模板: every template a profile installs from, the orchestrators' first; a card shows its whole recipe before it is
// installed, and a folder on this machine can be added beside the built-in ones. /agents/templates.

import { list, t } from "@vibevalley/i18n";

import { createSignal, For, Show } from "solid-js";
import { useQueryClient } from "@tanstack/solid-query";
import type { AgentTemplate, RuntimeInfo } from "@vibevalley/protocol";
import { api, reasonOf } from "@/base/api";
import { useRouter } from "@/base/router";
import { aria } from "@/base/util";
import { ready, useAgentTemplates, useRuntimes } from "@/base/query";
import { toast } from "@/ui/toasts";
import { ConfirmButton } from "@/ui/ConfirmButton";
import { A } from "@/ui/A";
import { Hint } from "@/ui/Tip";
import { Button } from "@/ui/Button";
import { AgentFace, OrchestratorFace } from "@/ui/Face";
import { TextInput } from "@/ui/Field";
import { runtimeName } from "@/ui/runtimes";

export function TemplatesPage() {
  const templates = useAgentTemplates();
  const runtimes = useRuntimes();
  const client = useQueryClient();
  const [path, setPath] = createSignal("");
  const [adding, setAdding] = createSignal(false);
  const sorted = () => [...ready(templates, [])].toSorted((a, b) => (a.role === b.role ? 0 : a.role === "orchestrator" ? -1 : 1));
  const add = async () => {
    setAdding(true);
    try {
      const got = await api.agent.template.add({ path: path().trim() });
      await client.invalidateQueries({ queryKey: ["agent-templates"] });
      setPath("");
      toast(t("web.agent.templates.added", { name: got.name }));
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
            {t("web.agent.all")}
          </A>
          <div class="flex items-center gap-1.5">
            <h1 class="text-2xl font-semibold">{t("web.agent.templates.title")}</h1>
            <Hint text={t("web.agent.templates.intro")} />
          </div>
        </div>
        <form
          class="flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (path().trim()) void add();
          }}
        >
          <TextInput
            data-testid="template-folder"
            aria-label={t("web.agent.templates.folder")}
            placeholder={t("web.agent.templates.folderHint")}
            value={path()}
            onInput={(e) => setPath(e.currentTarget.value)}
            class="min-w-0 flex-1"
          />
          <Button type="submit" data-testid="template-add" disabled={adding() || !path().trim()}>
            {t("web.agent.templates.add")}
          </Button>
        </form>
        <div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <For each={sorted()} keyed={(template) => template.id}>
            {(template) => (
              <TemplateCard template={template()} runtime={ready(runtimes, []).find((r) => r.id === template().runtime)} runtimes={ready(runtimes, [])} />
            )}
          </For>
        </div>
      </div>
    </div>
  );
}

function TemplateCard(props: { template: AgentTemplate; runtime?: RuntimeInfo | undefined; runtimes: readonly RuntimeInfo[] }) {
  const [open, setOpen] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const router = useRouter();
  const client = useQueryClient();
  const template = () => props.template;
  const orchestrator = () => template().role === "orchestrator";
  // An orchestrator runs in the server itself; a helper's runtime may be missing from this machine.
  const here = () => orchestrator() || props.runtime?.installation.status === "available";
  const install = async () => {
    setBusy(true);
    try {
      const made = await api.agent.template.install({ id: template().id });
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
      await api.agent.template.delete({ id: template().id });
      await client.invalidateQueries({ queryKey: ["agent-templates"] });
    } catch (e) {
      toast(reasonOf(e), "bad");
    }
  };
  return (
    <section
      aria-label={template().name}
      data-testid="template"
      data-key={template().id}
      data-installed={template().installed.length}
      data-source={template().source}
      class="flex flex-col gap-3 rounded-lg border border-line bg-page p-4"
    >
      <div class="flex items-start gap-3">
        <span class="flex size-16 shrink-0 items-center justify-center rounded-lg bg-hover">
          <Show when={orchestrator()} fallback={<AgentFace agentId={template().id} runtime={template().runtime} look={template().look} size={56} />}>
            <OrchestratorFace size={56} look={template().look.orchestrator ?? "farmer"} />
          </Show>
        </span>
        <span class="flex min-w-0 flex-1 flex-col gap-0.5">
          <span class="flex items-center gap-2">
            <span class="truncate text-base font-semibold">{template().name}</span>
            <span class="shrink-0 rounded bg-hover px-1.5 text-xs text-muted">{t(`web.agent.role.${template().role}`)}</span>
          </span>
          <span class="line-clamp-2 text-sm text-muted">{template().duty}</span>
          <span class={["text-xs", here() ? "text-ok-ink" : "text-warn-ink"]}>
            {orchestrator()
              ? t("web.agent.templates.onServer")
              : here()
                ? t("web.agent.templates.runsOn", { runtime: runtimeName(props.runtimes, template().runtime) })
                : t("web.agent.templates.notHere", { runtime: runtimeName(props.runtimes, template().runtime) })}
          </span>
        </span>
      </div>
      <Show when={open()}>
        <div data-testid="template-persona" class="flex flex-col gap-2 rounded-md bg-hover p-3 text-sm">
          <Show when={template().tags.length > 0}>
            <p class="text-muted">
              {t("web.agent.tags")}
              {t("web.agent.colon")}
              {list(template().tags)}
            </p>
          </Show>
          <p class="text-xs font-medium text-muted">{t("web.agent.personaLabel")}</p>
          <p class="whitespace-pre-wrap">{template().persona || t("web.agent.templates.noPersona")}</p>
        </div>
      </Show>
      <div class="mt-auto flex flex-wrap items-center gap-2 border-t border-line pt-3 text-xs text-muted">
        <span class="flex-1">
          {template().installed.length > 0 ? t("web.agent.templates.installed", { n: template().installed.length }) : ""}
          {template().source === "added" ? t("web.agent.templates.addedHere") : ""}
        </span>
        <Button data-testid="template-look" aria-expanded={aria(open())} onClick={() => setOpen(!open())}>
          {open() ? t("web.agent.templates.fold") : t("web.agent.templates.look")}
        </Button>
        <Show when={template().source === "added"}>
          <ConfirmButton label={t("web.agent.remove")} confirm={t("web.agent.templates.removeSure")} onConfirm={remove} />
        </Show>
        <Button tone="primary" data-testid="template-install" disabled={busy()} onClick={() => void install()}>
          {t("web.agent.templates.install")}
        </Button>
      </div>
    </section>
  );
}
