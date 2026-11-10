import * as stylex from "@stylexjs/stylex";
import { Array as Arr, Option, Schema } from "effect";
import { createSignal, For, Match, Show, Switch, untrack } from "solid-js";

import { list as listed, t } from "@vibevalley/i18n";
import type { Agent, RuntimeInfo, Skill } from "@vibevalley/protocol";
import * as S from "@vibevalley/protocol/schema";

import { Keyed } from "#/base/dom.tsx";
import { matches } from "#/base/search.ts";
import { api, reasonOf } from "#/infra/api.ts";
import { useForm, type Submission } from "#/infra/form.ts";
import { defineQuery, retryRead, useQueryClient, ready, useAgents, useQuery, useRuntimes } from "#/infra/query.ts";
import { useRouter, Link as A } from "#/infra/router.ts";
import { createAct } from "#/ui/act.ts";
import { Button } from "#/ui/Button.tsx";
import { ConfirmButton } from "#/ui/ConfirmButton.tsx";
import { AgentFace } from "#/ui/Face.tsx";
import { TextArea, TextInput } from "#/ui/Field.tsx";
import { Form, FormField, formControl, formMessages } from "#/ui/Form.tsx";
import { Card, Empty } from "#/ui/layout.tsx";
import { Markdown } from "#/ui/Markdown.tsx";
import { RuntimeIcon } from "#/ui/pixel/RuntimeIcon.tsx";
import { runtimeName } from "#/ui/RuntimeBadge.tsx";

import { type InstalledSkill, installedSkills } from "./quota";
import { SkillInput } from "./skill-form";

const recipeStyles = stylex.create({
  skillsPageDiv: {
    display: "flex",
    height: "100%",
    minHeight: "0",
    flexDirection: {
      default: "column",
      "@media (width>=64rem)": "row",
    },
    gap: "calc(var(--spacing) * 3)",
    overflowY: {
      default: "auto",
      "@media (width>=64rem)": "hidden",
    },
    overflowX: {
      default: null,
      "@media (width>=64rem)": "hidden",
    },
  },
});

const variantStyles = stylex.create({
  skillsPageA: {
    display: "inline-flex",
    height: "calc(var(--spacing) * 6)",
    alignItems: "center",
    borderRadius: "var(--radius-md)",
    backgroundColor: {
      default: "var(--color-accent)",
      "@media (hover:hover)": {
        default: null,
        ":hover": "var(--color-accent-hover)",
      },
    },
    paddingInline: "calc(var(--spacing) * 2)",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--text-xs--line-height)",
    color: "var(--color-page)",
  },
  entryA: {
    display: "flex",
    flexDirection: "column",
    borderRadius: "var(--radius-md)",
    paddingInline: "calc(var(--spacing) * 2)",
    paddingBlock: "calc(var(--spacing) * 1.5)",
  },
  entryAVariant: {
    backgroundColor: {
      default: "var(--color-selected)",
      "@media (hover:hover)": {
        default: null,
        ":hover": "var(--color-hover)",
      },
    },
  },
  entryAVariant2: {
    backgroundColor: {
      default: null,
      "@media (hover:hover)": {
        default: null,
        ":hover": "var(--color-hover)",
      },
    },
  },
  skillEditorA: {
    display: "flex",
    alignItems: "center",
    gap: "calc(var(--spacing) * 1.5)",
    borderRadius: "var(--radius-md)",
    backgroundColor: {
      default: "var(--color-hover)",
      "@media (hover:hover)": {
        default: null,
        ":hover": "var(--color-selected)",
      },
    },
    paddingBlock: "var(--spacing)",
    paddingRight: "calc(var(--spacing) * 3)",
    paddingLeft: "var(--spacing)",
  },
});

const viewStyles = stylex.create({
  skillCard: { maxWidth: "var(--container-3xl)" },
  skillsBook: {
    display: "flex",
    flexShrink: "0",
    flexDirection: "column",
    gap: "calc(var(--spacing) * 2)",
    borderRadius: "var(--radius-lg)",
    borderStyle: "solid",
    borderWidth: "1px",
    borderColor: "var(--color-line)",
    backgroundColor: "var(--color-page)",
    padding: "calc(var(--spacing) * 2)",
    width: {
      default: null,
      "@media (width>=64rem)": "calc(var(--spacing) * 72)",
    },
    overflowY: {
      default: null,
      "@media (width>=64rem)": "auto",
    },
  },
  skillsPageH2: {
    paddingInline: "calc(var(--spacing) * 2)",
    paddingTop: "calc(var(--spacing) * 1.5)",
    fontSize: "var(--text-base)",
    lineHeight: "var(--text-base--line-height)",
    fontWeight: "var(--font-weight-semibold)",
  },
  skillsPageP: {
    paddingInline: "calc(var(--spacing) * 2)",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--text-xs--line-height)",
    color: "var(--color-berry)",
  },
  skillsPageH3: {
    paddingInline: "calc(var(--spacing) * 2)",
    paddingTop: "calc(var(--spacing) * 2)",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--text-xs--line-height)",
    fontWeight: "var(--font-weight-semibold)",
    color: "var(--color-muted)",
  },
  skillsPageP2: {
    paddingInline: "calc(var(--spacing) * 2)",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--text-xs--line-height)",
    color: "var(--color-muted)",
  },
  skillsPageUl: {
    display: "flex",
    flexDirection: "column",
    gap: "calc(var(--spacing) * .5)",
  },
  skillsPageDiv: {
    display: "flex",
    alignItems: "center",
    gap: "calc(var(--spacing) * 2)",
    paddingInline: "calc(var(--spacing) * 2)",
    paddingTop: "calc(var(--spacing) * 3)",
  },
  skillsPageH32: {
    flex: "1",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--text-xs--line-height)",
    fontWeight: "var(--font-weight-semibold)",
    color: "var(--color-muted)",
  },
  skillsPageDiv2: {
    minWidth: "0",
    flex: "1",
    overflowY: {
      default: null,
      "@media (width>=64rem)": "auto",
    },
  },
  entrySpan: {
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    overflow: "hidden",
    fontSize: "var(--text-sm)",
    lineHeight: "var(--text-sm--line-height)",
    fontWeight: "var(--font-weight-medium)",
  },
  entrySpan2: {
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    overflow: "hidden",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--text-xs--line-height)",
    color: "var(--color-muted)",
  },
  installedCardP: {
    fontSize: "var(--text-xs)",
    lineHeight: "var(--text-xs--line-height)",
    color: "var(--color-muted)",
  },
  installedCardP2: {
    fontSize: "var(--text-sm)",
    lineHeight: "var(--text-sm--line-height)",
    whiteSpace: "pre-wrap",
  },
  installedCardDiv: {
    display: "flex",
    flexDirection: "column",
    gap: "calc(var(--spacing) * 1.5)",
  },
  installedCardH3: {
    fontSize: "var(--text-xs)",
    lineHeight: "var(--text-xs--line-height)",
    fontWeight: "var(--font-weight-semibold)",
    color: "var(--color-muted)",
  },
  installedCardDiv2: {
    display: "flex",
    alignItems: "center",
    gap: "calc(var(--spacing) * 2.5)",
    borderRadius: "var(--radius-md)",
    backgroundColor: "var(--color-hover)",
    paddingInline: "calc(var(--spacing) * 3)",
    paddingBlock: "calc(var(--spacing) * 2)",
  },
  installedCardSpan: {
    width: "calc(var(--spacing) * 24)",
    fontSize: "var(--text-sm)",
    lineHeight: "var(--text-sm--line-height)",
    fontWeight: "var(--font-weight-medium)",
  },
  installedCardSpan2: {
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
  skillEditorDiv: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: "calc(var(--spacing) * 2)",
  },
  skillEditorSpan: {
    fontSize: "var(--text-xs)",
    lineHeight: "var(--text-xs--line-height)",
    fontWeight: "var(--font-weight-medium)",
    color: "var(--color-muted)",
  },
  skillEditorDiv2: {
    display: "flex",
    flexWrap: "wrap",
    gap: "calc(var(--spacing) * 2)",
  },
  skillEditorSpan2: {
    fontSize: "var(--text-sm)",
    lineHeight: "var(--text-sm--line-height)",
    fontWeight: "var(--font-weight-medium)",
  },
});

const installedPrefix = "installed:";
const skillPath = (id?: string) => (id === undefined ? "/settings/skills" : `/settings/skills/${encodeURIComponent(id)}`);

const skillsQuery = defineQuery({
  schema: Schema.mutable(Schema.Array(S.Skill)),
  key: () => ["skills"],
  fetch: (_: void, context) => api.skill.list(context),
  ...retryRead,
});
export const useSkills = () => useQuery(skillsQuery);

export function SkillsPage(props: { id?: string | undefined }) {
  const router = useRouter();
  const [query, setQuery] = createSignal("");
  const skills = useSkills();
  const runtimes = useRuntimes();
  const catalog = () => ready(runtimes, []);
  const installed = () => installedSkills(catalog());
  const all = (): readonly Skill[] => ready(skills, []);
  const own = () => Arr.filter(all(), (s) => s.builtIn !== true);
  const builtIns = () => Arr.filter(all(), (s) => s.builtIn === true);
  const creating = () => props.id === "new";
  const shownInstalled = () => {
    const id = props.id;
    return id?.startsWith(installedPrefix) === true ? installed().find((s) => s.name === id.slice(installedPrefix.length)) : undefined;
  };
  const shownBuiltIn = () => {
    const id = props.id;
    return creating() || shownInstalled() !== undefined ? undefined : Option.getOrUndefined(Arr.findFirst(builtIns(), (s) => s.id === id));
  };
  const selected = () =>
    creating() || shownInstalled() || shownBuiltIn() !== undefined
      ? undefined
      : (own().find((s) => s.id === props.id) ?? (installed().length > 0 ? undefined : own()[0]));
  const first = () => (props.id === undefined ? installed()[0] : undefined);
  const q = () => query().trim();
  const list = () =>
    q() ? installed().filter((s) => matches(q(), [s.name, s.description, ...s.runtimes.map((x) => runtimeName(catalog(), x.runtime))])) : installed();
  const ownShown = () => (q() ? own().filter((s) => matches(q(), [s.name, s.description, s.body])) : own());
  const builtInShown = () => {
    const text = q();
    return text === "" ? builtIns() : Arr.filter(builtIns(), (s) => matches(text, [s.name, s.description, s.body]));
  };
  const count = (shown: number, all: number) => (q() ? `${shown} / ${all}` : `${all}`);
  const open = () => shownInstalled() ?? first();

  return (
    <div {...stylex.attrs(recipeStyles.skillsPageDiv)}>
      <nav aria-label={t("web.runtime.library.book")} data-testid="skills-book" {...stylex.attrs(viewStyles.skillsBook)}>
        <h2 {...stylex.attrs(viewStyles.skillsPageH2)}>{t("web.runtime.library.book")}</h2>
        <TextInput
          data-testid="skills-search"
          aria-label={t("web.runtime.library.search")}
          placeholder={t("web.runtime.library.searchHint")}
          value={query()}
          onInput={(e) => setQuery(e.currentTarget.value)}
        />
        <Show when={runtimes.error()}>
          <p {...stylex.attrs(viewStyles.skillsPageP)}>
            {t("web.runtime.library.noRuntimes")}
            {reasonOf(runtimes.error())}
          </p>
        </Show>
        <h3 {...stylex.attrs(viewStyles.skillsPageH3)}>{t("web.runtime.library.installed", { count: count(list().length, installed().length) })}</h3>
        <Show when={installed().length === 0}>
          <p {...stylex.attrs(viewStyles.skillsPageP2)}>{t("web.runtime.library.noneReported")}</p>
        </Show>
        <Show when={installed().length > 0 && list().length === 0}>
          <p {...stylex.attrs(viewStyles.skillsPageP2)}>{t("web.runtime.library.noMatch")}</p>
        </Show>
        <ul {...stylex.attrs(viewStyles.skillsPageUl)}>
          <For each={list()}>
            {(s) => (
              <Entry
                to={skillPath(installedPrefix + s.name)}
                on={open()?.name === s.name}
                title={s.name}
                detail={listed(s.runtimes.map((x) => runtimeName(catalog(), x.runtime)))}
              />
            )}
          </For>
        </ul>
        <h3 {...stylex.attrs(viewStyles.skillsPageH3)}>{t("web.runtime.library.builtIn", { count: count(builtInShown().length, builtIns().length) })}</h3>
        <ul {...stylex.attrs(viewStyles.skillsPageUl)} data-testid="built-in-skills">
          <For each={builtInShown()}>{(s) => <Entry to={skillPath(s.id)} on={shownBuiltIn()?.id === s.id} title={s.name} detail={s.description} />}</For>
        </ul>
        <div {...stylex.attrs(viewStyles.skillsPageDiv)}>
          <h3 {...stylex.attrs(viewStyles.skillsPageH32)}>{t("web.runtime.library.own", { count: count(ownShown().length, own().length) })}</h3>
          <A href={skillPath("new")} data-testid="new-skill" {...stylex.attrs(variantStyles.skillsPageA)}>
            {t("web.runtime.library.newSkill")}
          </A>
        </div>
        <ul {...stylex.attrs(viewStyles.skillsPageUl)}>
          <For each={ownShown()}>{(s) => <Entry to={skillPath(s.id)} on={!creating() && selected()?.id === s.id} title={s.name} detail={s.description} />}</For>
        </ul>
      </nav>
      <div {...stylex.attrs(viewStyles.skillsPageDiv2)}>
        <Switch
          fallback={
            <Empty
              icon="skill"
              action={
                <Button icon="add" onClick={() => router.navigate(skillPath("new"))}>
                  {t("web.runtime.library.newSkill")}
                </Button>
              }
            >
              {t("web.runtime.library.noSkills")}
            </Empty>
          }
        >
          <Match when={creating()}>
            <Keyed key="new">{() => <SkillEditor />}</Keyed>
          </Match>
          <Match when={shownBuiltIn()}>{(s) => <BuiltInCard skill={s()} />}</Match>
          <Match when={open()}>{(s) => <InstalledCard skill={s()} catalog={catalog()} />}</Match>
          <Match when={selected()}>{(s) => <Keyed key={s().id}>{() => <SkillEditor skill={s()} />}</Keyed>}</Match>
        </Switch>
      </div>
    </div>
  );
}

function Entry(props: { to: string; on: boolean; title: string; detail: string }) {
  return (
    <li>
      <A
        href={props.to}
        data-testid="skill-entry"
        aria-current={props.on ? "page" : undefined}
        {...stylex.attrs(variantStyles.entryA, props.on ? variantStyles.entryAVariant : variantStyles.entryAVariant2)}
      >
        <span {...stylex.attrs(viewStyles.entrySpan)}>{props.title}</span>
        <Show when={props.detail}>
          <span {...stylex.attrs(viewStyles.entrySpan2)}>{props.detail}</span>
        </Show>
      </A>
    </li>
  );
}

/** Read-only: it ships with VibeValley and changes with it. */
function BuiltInCard(props: { skill: Skill }) {
  const allAgents = useAgents();
  const agents = () => {
    const id = props.skill.id;
    return Arr.filter(ready(allAgents, []), (a) => a.skills.includes(id));
  };
  return (
    <Card title={props.skill.name} styles={viewStyles.skillCard}>
      <div data-testid="built-in-skill" {...stylex.attrs(viewStyles.installedCardDiv)}>
        <p {...stylex.attrs(viewStyles.installedCardP)}>{t("web.runtime.library.builtInNote")}</p>
        <Show when={props.skill.description !== ""}>
          <p {...stylex.attrs(viewStyles.installedCardP2)}>{props.skill.description}</p>
        </Show>
        <Markdown text={props.skill.body} />
        <SkillUsers agents={agents()} />
      </div>
    </Card>
  );
}

function SkillUsers(props: { agents: readonly Agent[] }) {
  return (
    <div data-testid="skill-users" data-count={props.agents.length} {...stylex.attrs(viewStyles.installedCardDiv)}>
      <span {...stylex.attrs(viewStyles.skillEditorSpan)}>{t("web.runtime.library.who")}</span>
      <Show when={props.agents.length > 0} fallback={<p {...stylex.attrs(viewStyles.installedCardP)}>{t("web.runtime.library.nobody")}</p>}>
        <div {...stylex.attrs(viewStyles.skillEditorDiv2)}>
          <For each={props.agents}>
            {(a) => (
              <A href={`/agents/${encodeURIComponent(a.id)}`} {...stylex.attrs(variantStyles.skillEditorA)}>
                <AgentFace agentId={a.id} runtime={a.runtime} look={a.look} size={26} />
                <span {...stylex.attrs(viewStyles.skillEditorSpan2)}>{a.name}</span>
              </A>
            )}
          </For>
        </div>
      </Show>
    </div>
  );
}

/** Read-only: it lives with the runtime. */
function InstalledCard(props: { skill: InstalledSkill; catalog: readonly RuntimeInfo[] }) {
  return (
    <Card title={props.skill.name} styles={viewStyles.skillCard}>
      <p {...stylex.attrs(viewStyles.installedCardP)}>{t("web.runtime.library.installedNote")}</p>
      <Show when={props.skill.description}>
        <p {...stylex.attrs(viewStyles.installedCardP2)}>{props.skill.description}</p>
      </Show>
      <div {...stylex.attrs(viewStyles.installedCardDiv)}>
        <h3 {...stylex.attrs(viewStyles.installedCardH3)}>{t("web.runtime.library.where")}</h3>
        <For each={props.skill.runtimes}>
          {(x) => (
            <div {...stylex.attrs(viewStyles.installedCardDiv2)}>
              <RuntimeIcon runtime={x.runtime} size={28} />
              <span {...stylex.attrs(viewStyles.installedCardSpan)}>{runtimeName(props.catalog, x.runtime)}</span>
              <span {...stylex.attrs(viewStyles.installedCardSpan2)} title={x.source}>
                {x.source}
              </span>
            </div>
          )}
        </For>
      </div>
    </Card>
  );
}

const empty = { name: "", description: "", body: "" };

function SkillEditor(props: { skill?: Skill }) {
  // Keyed by the skill: the draft starts from the one it was opened on.
  const skill = untrack(() => props.skill);
  let savedId = skill?.id;
  const act = createAct();
  const busy = act.busy;
  const router = useRouter();
  const client = useQueryClient();
  const allAgents = useAgents();
  const agents = () => ready(allAgents, []).filter((a) => skill !== undefined && a.skills.includes(skill.id));
  const refresh = () => Promise.all([client.invalidate({ prefix: ["skills"] }), client.invalidate({ prefix: ["agents"] })]);
  const form = useForm({
    schema: SkillInput,
    defaultValues: skill ? { name: skill.name, description: skill.description, body: skill.body } : empty,
    messages: formMessages,
    onSubmit: async (value, attempt): Promise<Submission<Skill>> => {
      const result = await act.attempt(() => (savedId ? api.skill.update({ ...value, id: savedId }) : api.skill.create({ ...value, id: "" })));
      if (result.kind === "accepted") {
        savedId = result.receipt.id;
        const reset = form.reset(
          { name: result.receipt.name, description: result.receipt.description, body: result.receipt.body },
          { ifRevision: attempt.revision },
        );
        const savedRevision = untrack(form.revision);
        await refresh();
        if (!skill && reset && untrack(form.revision) === savedRevision) router.navigate(skillPath(result.receipt.id));
      }
      return result;
    },
  });
  const name = form.field(["name"]);
  const description = form.field(["description"]);
  const body = form.field(["body"]);
  const remove = (s: Skill) =>
    act.run(async () => {
      await api.skill.delete({ id: s.id });
      await refresh();
      router.navigate(skillPath());
    });

  return (
    <Form form={form} testid="skill-form">
      <Card
        title={name.value() || t("web.runtime.library.newSkill")}
        styles={viewStyles.skillCard}
        action={
          <div {...stylex.attrs(viewStyles.skillEditorDiv)}>
            <Show when={skill}>
              {(s) => (
                <ConfirmButton
                  label={t("web.base.form.remove")}
                  question={agents().length > 0 ? t("web.runtime.library.inUse", { n: agents().length }) : t("web.runtime.library.removeIt")}
                  disabled={busy()}
                  testid="delete"
                  onConfirm={() => remove(s())}
                />
              )}
            </Show>
            <Button type="submit" tone="primary" data-testid="save" disabled={busy() || form.submitting() || !form.dirty()}>
              {t("web.base.form.save")}
            </Button>
          </div>
        }
      >
        <FormField field={name} label={t("web.runtime.library.name")}>
          <TextInput
            data-testid="skill-name"
            aria-label={t("web.runtime.library.nameLabel")}
            placeholder={t("web.runtime.library.nameHint")}
            {...formControl(name)}
            value={name.value()}
            onInput={(e) => name.setValue(e.currentTarget.value)}
          />
        </FormField>
        <FormField field={description} label={t("web.runtime.library.when")} hint={t("web.runtime.library.whenHint")}>
          <TextInput
            data-testid="skill-description"
            aria-label={t("web.runtime.library.description")}
            placeholder={t("web.runtime.library.descriptionHint")}
            {...formControl(description)}
            value={description.value()}
            onInput={(e) => description.setValue(e.currentTarget.value)}
          />
        </FormField>
        <FormField field={body} label={t("web.runtime.library.body")} hint={t("web.runtime.library.bodyHint")}>
          <TextArea
            data-testid="skill-body"
            aria-label={t("web.runtime.library.body")}
            rows={14}
            placeholder={t("web.runtime.library.bodyExample")}
            {...formControl(body)}
            value={body.value()}
            onInput={(e) => body.setValue(e.currentTarget.value)}
          />
        </FormField>
        <SkillUsers agents={agents()} />
      </Card>
    </Form>
  );
}
