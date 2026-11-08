import * as stylex from "@stylexjs/stylex";
import { createSignal, For, Show } from "solid-js";

import { list, t } from "@vibevalley/i18n";
import type { AgentTemplate, RuntimeInfo } from "@vibevalley/protocol";

import { aria } from "#/base/dom.tsx";
import { api } from "#/infra/api.ts";
import { useQueryClient, ready, useAgentTemplates, useRuntimes } from "#/infra/query.ts";
import { useRouter, Link as A } from "#/infra/router.ts";
import { createAct } from "#/ui/act.ts";
import { Button } from "#/ui/Button.tsx";
import { ConfirmButton } from "#/ui/ConfirmButton.tsx";
import { AgentFace, OrchestratorFace } from "#/ui/Face.tsx";
import { TextInput } from "#/ui/Field.tsx";
import { runtimeName } from "#/ui/RuntimeBadge.tsx";
import { Hint } from "#/ui/Tip.tsx";
import { toast } from "#/ui/toasts.ts";

const viewStyles = stylex.create({
  templatesPageDiv: {
    height: "100%",
    overflowY: "auto",
  },
  templatesPageDiv2: {
    display: "flex",
    flexDirection: "column",
    gap: "calc(var(--spacing) * 6)",
    paddingInline: "calc(var(--spacing) * 4)",
    paddingTop: "calc(var(--spacing) * 4)",
    paddingBottom: "calc(var(--spacing) * 8)",
  },
  templatesPageDiv3: {
    display: "flex",
    flexDirection: "column",
    gap: "var(--spacing)",
  },
  templatesPageDiv4: {
    display: "flex",
    alignItems: "center",
    gap: "calc(var(--spacing) * 1.5)",
  },
  templatesPageH1: {
    fontSize: "var(--text-2xl)",
    lineHeight: "var(--text-2xl--line-height)",
    fontWeight: "var(--font-weight-semibold)",
  },
  templatesPageForm: {
    display: "flex",
    alignItems: "center",
    gap: "calc(var(--spacing) * 2)",
  },
  templatesPageDiv5: {
    display: "grid",
    gap: "calc(var(--spacing) * 3)",
    gridTemplateColumns: {
      default: null,
      "@media (width>=40rem)": "repeat(2,minmax(0,1fr))",
      "@media (width>=64rem)": "repeat(3,minmax(0,1fr))",
      "@media (width>=96rem)": "repeat(4,minmax(0,1fr))",
    },
  },
  template: {
    display: "flex",
    flexDirection: "column",
    gap: "calc(var(--spacing) * 3)",
    borderRadius: "var(--radius-lg)",
    borderStyle: "solid",
    borderWidth: "1px",
    borderColor: "var(--wb-line)",
    backgroundColor: "var(--wb-page)",
    padding: "calc(var(--spacing) * 4)",
  },
  templateCardDiv: {
    display: "flex",
    alignItems: "flex-start",
    gap: "calc(var(--spacing) * 3)",
  },
  templateCardSpan: {
    display: "flex",
    width: "calc(var(--spacing) * 16)",
    height: "calc(var(--spacing) * 16)",
    flexShrink: "0",
    alignItems: "center",
    justifyContent: "center",
    borderRadius: "var(--radius-lg)",
    backgroundColor: "var(--wb-hover)",
  },
  templateCardSpan2: {
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    overflow: "hidden",
    fontSize: "var(--text-base)",
    lineHeight: "var(--text-base--line-height)",
    fontWeight: "var(--font-weight-semibold)",
  },
  templateCardSpan3: {
    flexShrink: "0",
    borderRadius: ".25rem",
    backgroundColor: "var(--wb-hover)",
    paddingInline: "calc(var(--spacing) * 1.5)",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--text-xs--line-height)",
    color: "var(--wb-muted)",
  },
  templatePersona: {
    display: "flex",
    flexDirection: "column",
    gap: "calc(var(--spacing) * 2)",
    borderRadius: "var(--radius-md)",
    backgroundColor: "var(--wb-hover)",
    padding: "calc(var(--spacing) * 3)",
    fontSize: "var(--text-sm)",
    lineHeight: "var(--text-sm--line-height)",
  },
  templateCardP: {
    color: "var(--wb-muted)",
  },
  templateCardP2: {
    fontSize: "var(--text-xs)",
    lineHeight: "var(--text-xs--line-height)",
    fontWeight: "var(--font-weight-medium)",
    color: "var(--wb-muted)",
  },
  templateCardP3: {
    whiteSpace: "pre-wrap",
  },
  templateCardDiv2: {
    marginTop: "auto",
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: "calc(var(--spacing) * 2)",
    borderTopStyle: "solid",
    borderTopWidth: "1px",
    borderColor: "var(--wb-line)",
    paddingTop: "calc(var(--spacing) * 3)",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--text-xs--line-height)",
    color: "var(--wb-muted)",
  },
  templateCardSpan4: {
    flex: "1",
  },
});

export function TemplatesPage() {
  const templates = useAgentTemplates();
  const runtimes = useRuntimes();
  const client = useQueryClient();
  const [path, setPath] = createSignal("");
  const adding = createAct();
  const sorted = () => [...ready(templates, [])].toSorted((a, b) => (a.role === b.role ? 0 : a.role === "orchestrator" ? -1 : 1));
  const add = () => {
    const at = path().trim();
    return adding.run(async () => {
      const got = await api.agent.template.add({ path: at });
      await client.invalidate({ prefix: ["agent-templates"] });
      setPath("");
      toast(t("web.agent.templates.added", { name: got.name }));
    });
  };
  return (
    <div {...stylex.attrs(viewStyles.templatesPageDiv)}>
      <div {...stylex.attrs(viewStyles.templatesPageDiv2)}>
        <div {...stylex.attrs(viewStyles.templatesPageDiv3)}>
          <A href="/agents" class="text-xs text-muted hover:underline">
            {t("web.agent.all")}
          </A>
          <div {...stylex.attrs(viewStyles.templatesPageDiv4)}>
            <h1 {...stylex.attrs(viewStyles.templatesPageH1)}>{t("web.agent.templates.title")}</h1>
            <Hint text={t("web.agent.templates.intro")} />
          </div>
        </div>
        <form
          {...stylex.attrs(viewStyles.templatesPageForm)}
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
          <Button type="submit" data-testid="template-add" disabled={adding.busy() || !path().trim()}>
            {t("web.agent.templates.add")}
          </Button>
        </form>
        <div {...stylex.attrs(viewStyles.templatesPageDiv5)}>
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
  const act = createAct();
  const router = useRouter();
  const client = useQueryClient();
  const template = () => props.template;
  const orchestrator = () => template().role === "orchestrator";
  // An orchestrator runs in the server itself; a helper's runtime may be missing from this machine.
  const here = () => orchestrator() || props.runtime?.installation.status === "available";
  const install = () => {
    const id = template().id;
    return act.run(async () => {
      const made = await api.agent.template.install({ id });
      await Promise.all([client.invalidate({ prefix: ["agents"] }), client.invalidate({ prefix: ["agent-templates"] })]);
      router.navigate(`/agents/${encodeURIComponent(made.id)}`);
    });
  };
  const remove = () => {
    const id = template().id;
    return act.run(async () => {
      await api.agent.template.delete({ id });
      await client.invalidate({ prefix: ["agent-templates"] });
    });
  };
  return (
    <section
      aria-label={template().name}
      data-testid="template"
      data-key={template().id}
      data-installed={template().installed.length}
      data-source={template().source}
      {...stylex.attrs(viewStyles.template)}
    >
      <div {...stylex.attrs(viewStyles.templateCardDiv)}>
        <span {...stylex.attrs(viewStyles.templateCardSpan)}>
          <Show when={orchestrator()} fallback={<AgentFace agentId={template().id} runtime={template().runtime} look={template().look} size={56} />}>
            <OrchestratorFace size={56} look={template().look.orchestrator ?? "farmer"} />
          </Show>
        </span>
        <span class="flex min-w-0 flex-1 flex-col gap-0.5">
          <span {...stylex.attrs(viewStyles.templatesPageForm)}>
            <span {...stylex.attrs(viewStyles.templateCardSpan2)}>{template().name}</span>
            <span {...stylex.attrs(viewStyles.templateCardSpan3)}>{t(`web.agent.role.${template().role}`)}</span>
          </span>
          <span class="line-clamp-2 text-sm text-muted">{template().duty}</span>
          <span class={["text-xs", here() ? "text-muted" : "text-warn-ink"]}>
            {orchestrator()
              ? t("web.agent.templates.onServer")
              : here()
                ? t("web.agent.templates.runsOn", { runtime: runtimeName(props.runtimes, template().runtime) })
                : t("web.agent.templates.notHere", { runtime: runtimeName(props.runtimes, template().runtime) })}
          </span>
        </span>
      </div>
      <Show when={open()}>
        <div data-testid="template-persona" {...stylex.attrs(viewStyles.templatePersona)}>
          <Show when={template().tags.length > 0}>
            <p {...stylex.attrs(viewStyles.templateCardP)}>
              {t("web.agent.tags")}
              {t("web.agent.colon")}
              {list(template().tags)}
            </p>
          </Show>
          <p {...stylex.attrs(viewStyles.templateCardP2)}>{t("web.agent.personaLabel")}</p>
          <p {...stylex.attrs(viewStyles.templateCardP3)}>{template().persona || t("web.agent.templates.noPersona")}</p>
        </div>
      </Show>
      <div {...stylex.attrs(viewStyles.templateCardDiv2)}>
        <span {...stylex.attrs(viewStyles.templateCardSpan4)}>
          {template().installed.length > 0 ? t("web.agent.templates.installed", { n: template().installed.length }) : ""}
          {template().source === "added" ? t("web.agent.templates.addedHere") : ""}
        </span>
        <Button data-testid="template-look" aria-expanded={aria(open())} onClick={() => setOpen(!open())}>
          {open() ? t("web.agent.templates.fold") : t("web.agent.templates.look")}
        </Button>
        <Show when={template().source === "added"}>
          <ConfirmButton label={t("web.agent.remove")} confirm={t("web.agent.templates.removeSure")} onConfirm={remove} />
        </Show>
        <Button data-testid="template-install" disabled={act.busy()} onClick={() => void install()}>
          {t("web.agent.templates.install")}
        </Button>
      </div>
    </section>
  );
}
