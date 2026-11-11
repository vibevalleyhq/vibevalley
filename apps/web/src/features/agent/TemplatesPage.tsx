import * as stylex from "@stylexjs/stylex";
import { Array as Arr, Option } from "effect";
import { createSignal, For, Show } from "solid-js";

import { list, t } from "@vibevalley/i18n";
import type { AgentTemplate, RuntimeInfo } from "@vibevalley/protocol";

import { aria } from "#/base/dom.tsx";
import { useSkills } from "#/features/runtime/index.ts";
import { api } from "#/infra/api.ts";
import { useQueryClient, ready, useAgentTemplates, useRuntimes } from "#/infra/query.ts";
import { useRouter, Link as A } from "#/infra/router.ts";
import { createAct } from "#/ui/act.ts";
import { Button } from "#/ui/Button.tsx";
import { ConfirmButton } from "#/ui/ConfirmButton.tsx";
import { AgentFace, OrchestratorFace } from "#/ui/domain/Face.tsx";
import { runtimeName } from "#/ui/domain/RuntimeBadge.tsx";
import { TextInput } from "#/ui/Field.tsx";
import { Hint } from "#/ui/Tip.tsx";
import { toast } from "#/ui/toasts.ts";

const styles = stylex.create({
  templatesPageTextInput: {
    minWidth: "0",
    flex: "1",
  },
  templatesPageA: {
    fontSize: "var(--text-xs)",
    lineHeight: "var(--leading-xs)",
    color: "var(--color-muted)",
    textDecorationLine: {
      default: null,
      "@media (hover:hover)": {
        default: null,
        ":hover": "underline",
      },
    },
  },
  templateCardSpan: {
    display: "flex",
    minWidth: "0",
    flex: "1",
    flexDirection: "column",
    gap: "0.125rem",
  },
  templateCardSpan2: {
    WebkitLineClamp: "2",
    WebkitBoxOrient: "vertical",
    display: "-webkit-box",
    overflow: "hidden",
    fontSize: "var(--text-sm)",
    lineHeight: "var(--leading-sm)",
    color: "var(--color-muted)",
  },
  templateCardSpan3: {
    fontSize: "var(--text-xs)",
    lineHeight: "var(--leading-xs)",
  },
  templateCardSpanTone: {
    color: "var(--color-muted)",
  },
  templateCardSpanAlt: {
    color: "var(--color-warn-ink)",
  },
  templatesPageDiv: {
    height: "100%",
    overflowY: "auto",
  },
  templatesPageDiv2: {
    display: "flex",
    flexDirection: "column",
    gap: "1.5rem",
    paddingInline: "1rem",
    paddingTop: "1rem",
    paddingBottom: "2rem",
  },
  templatesPageDiv3: {
    display: "flex",
    flexDirection: "column",
    gap: "0.25rem",
  },
  templatesPageDiv4: {
    display: "flex",
    alignItems: "center",
    gap: "0.375rem",
  },
  templatesPageH1: {
    fontSize: "var(--text-2xl)",
    lineHeight: "var(--leading-2xl)",
    fontWeight: "var(--font-weight-semibold)",
  },
  templatesPageForm: {
    display: "flex",
    alignItems: "center",
    gap: "0.5rem",
  },
  templatesPageDiv5: {
    display: "grid",
    gap: "0.75rem",
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
    gap: "0.75rem",
    borderRadius: "var(--radius-lg)",
    borderStyle: "solid",
    borderWidth: "1px",
    borderColor: "var(--color-line)",
    backgroundColor: "var(--color-page)",
    padding: "1rem",
  },
  templateCardDiv: {
    display: "flex",
    alignItems: "flex-start",
    gap: "0.75rem",
  },
  templateCardSpan4: {
    display: "flex",
    width: "4rem",
    height: "4rem",
    flexShrink: "0",
    alignItems: "center",
    justifyContent: "center",
    borderRadius: "var(--radius-lg)",
    backgroundColor: "var(--color-hover)",
  },
  templateCardSpan22: {
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    overflow: "hidden",
    fontSize: "var(--text-base)",
    lineHeight: "var(--leading-base)",
    fontWeight: "var(--font-weight-semibold)",
  },
  templateCardSpan32: {
    flexShrink: "0",
    borderRadius: "var(--radius-sm)",
    backgroundColor: "var(--color-hover)",
    paddingInline: "0.375rem",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--leading-xs)",
    color: "var(--color-muted)",
  },
  templatePersona: {
    display: "flex",
    flexDirection: "column",
    gap: "0.5rem",
    borderRadius: "var(--radius-md)",
    backgroundColor: "var(--color-hover)",
    padding: "0.75rem",
    fontSize: "var(--text-sm)",
    lineHeight: "var(--leading-sm)",
  },
  templateCardP: {
    color: "var(--color-muted)",
  },
  templateCardP2: {
    fontSize: "var(--text-xs)",
    lineHeight: "var(--leading-xs)",
    fontWeight: "var(--font-weight-medium)",
    color: "var(--color-muted)",
  },
  templateCardP3: {
    whiteSpace: "pre-wrap",
  },
  templateCardDiv2: {
    marginTop: "auto",
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: "0.5rem",
    borderTopStyle: "solid",
    borderTopWidth: "1px",
    borderColor: "var(--color-line)",
    paddingTop: "0.75rem",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--leading-xs)",
    color: "var(--color-muted)",
  },
  templateCardSpan42: {
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
    <div {...stylex.attrs(styles.templatesPageDiv)}>
      <div {...stylex.attrs(styles.templatesPageDiv2)}>
        <div {...stylex.attrs(styles.templatesPageDiv3)}>
          <A href="/agents" {...stylex.attrs(styles.templatesPageA)}>
            {t("web.agent.all")}
          </A>
          <div {...stylex.attrs(styles.templatesPageDiv4)}>
            <h1 {...stylex.attrs(styles.templatesPageH1)}>{t("web.agent.templates.title")}</h1>
            <Hint text={t("web.agent.templates.intro")} />
          </div>
        </div>
        <form
          {...stylex.attrs(styles.templatesPageForm)}
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
            styles={styles.templatesPageTextInput}
          />
          <Button type="submit" data-testid="template-add" disabled={adding.busy() || !path().trim()}>
            {t("web.agent.templates.add")}
          </Button>
        </form>
        <div {...stylex.attrs(styles.templatesPageDiv5)}>
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
  const library = useSkills();
  // The built-in skills it ticks, by their names; an id the library doesn't have (an added template's typo) shows as itself.
  const skills = () =>
    Arr.map(template().skills, (id) =>
      Option.getOrElse(
        Arr.findFirst(ready(library, []), (s) => s.id === id),
        () => ({ id, name: id, description: "" }),
      ),
    );
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
      {...stylex.attrs(styles.template)}
    >
      <div {...stylex.attrs(styles.templateCardDiv)}>
        <span {...stylex.attrs(styles.templateCardSpan4)}>
          <Show when={orchestrator()} fallback={<AgentFace agentId={template().id} runtime={template().runtime} look={template().look} size={56} />}>
            <OrchestratorFace size={56} look={template().look.orchestrator ?? "farmer"} />
          </Show>
        </span>
        <span {...stylex.attrs(styles.templateCardSpan)}>
          <span {...stylex.attrs(styles.templatesPageForm)}>
            <span {...stylex.attrs(styles.templateCardSpan22)}>{template().name}</span>
            <span {...stylex.attrs(styles.templateCardSpan32)}>{t(`web.agent.role.${template().role}`)}</span>
          </span>
          <span {...stylex.attrs(styles.templateCardSpan2)}>{template().duty}</span>
          <Show when={skills().length > 0}>
            <span data-testid="template-skills" {...stylex.attrs(styles.templateCardSpan2)}>
              {t("web.agent.templates.skills", { skills: list(Arr.map(skills(), (s) => s.name)) })}
            </span>
          </Show>
          <span {...stylex.attrs(styles.templateCardSpan3, here() ? styles.templateCardSpanTone : styles.templateCardSpanAlt)}>
            {orchestrator()
              ? t("web.agent.templates.onServer")
              : here()
                ? t("web.agent.templates.runsOn", { runtime: runtimeName(props.runtimes, template().runtime) })
                : t("web.agent.templates.notHere", { runtime: runtimeName(props.runtimes, template().runtime) })}
          </span>
        </span>
      </div>
      <Show when={open()}>
        <div data-testid="template-persona" {...stylex.attrs(styles.templatePersona)}>
          <Show when={template().tags.length > 0}>
            <p {...stylex.attrs(styles.templateCardP)}>
              {t("web.agent.tags")}
              {t("web.agent.colon")}
              {list(template().tags)}
            </p>
          </Show>
          <For each={skills()}>
            {(s) => (
              <p data-testid="template-skill" {...stylex.attrs(styles.templateCardP)}>
                {t("web.agent.templates.skill", { name: s.name, description: s.description })}
              </p>
            )}
          </For>
          <p {...stylex.attrs(styles.templateCardP2)}>{t("web.agent.personaLabel")}</p>
          <p {...stylex.attrs(styles.templateCardP3)}>{template().persona || t("web.agent.templates.noPersona")}</p>
        </div>
      </Show>
      <div {...stylex.attrs(styles.templateCardDiv2)}>
        <span {...stylex.attrs(styles.templateCardSpan42)}>
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
