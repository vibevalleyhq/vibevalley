import { list as listed, t } from "@vibevalley/i18n";
// 技能: the skills the runtimes on this machine carry, read-only, and VibeValley's own, which
// a profile picks; /settings/skills/<id>, installed:<name> for an installed one, new for a new one.

import { createSignal, For, Match, Show, Switch, untrack } from "solid-js";
import { useQueryClient } from "@tanstack/solid-query";
import type { RuntimeInfo, Skill } from "@vibevalley/protocol";
import { api, reasonOf } from "@/base/api";
import { matches } from "@/base/search";
import { type InstalledSkill, installedSkills } from "./skills";
import { runtimeName } from "@/ui/runtimes";
import { ConfirmButton } from "@/ui/ConfirmButton";
import { toast } from "@/ui/toasts";
import { A } from "@/ui/A";
import { useRouter } from "@/base/router";
import { Keyed } from "@/base/util";
import { ready, useAgents, useQuery, useRuntimes } from "@/base/query";
import { RuntimeIcon } from "@/ui/pixel/RuntimeIcon";
import { Button } from "@/ui/Button";
import { AgentFace } from "@/ui/Face";
import { Field, TextArea, TextInput } from "@/ui/Field";
import { Card } from "@/ui/layout";
import { Empty } from "@/ui/Empty";

const installedPrefix = "installed:";
export const skillPath = (id?: string) => (id === undefined ? "/settings/skills" : `/settings/skills/${encodeURIComponent(id)}`);

export const useSkills = () => useQuery(() => ({ queryKey: ["skills"], queryFn: () => api.skill.list() }));

export function SkillsPage(props: { id?: string | undefined }) {
  const router = useRouter();
  const [query, setQuery] = createSignal("");
  const skills = useSkills();
  const runtimes = useRuntimes();
  const catalog = () => ready(runtimes, []);
  const installed = () => installedSkills(catalog());
  const own = () => ready(skills, []);
  const creating = () => props.id === "new";
  const shownInstalled = () =>
    props.id?.startsWith(installedPrefix) === true ? installed().find((s) => s.name === props.id!.slice(installedPrefix.length)) : undefined;
  const selected = () =>
    creating() || shownInstalled() ? undefined : (own().find((s) => s.id === props.id) ?? (installed().length > 0 ? undefined : own()[0]));
  const first = () => (props.id === undefined ? installed()[0] : undefined);
  const q = () => query().trim();
  const list = () =>
    q() ? installed().filter((s) => matches(q(), [s.name, s.description, ...s.runtimes.map((x) => runtimeName(catalog(), x.runtime))])) : installed();
  const ownShown = () => (q() ? own().filter((s) => matches(q(), [s.name, s.description, s.body])) : own());
  const count = (shown: number, all: number) => (q() ? `${shown} / ${all}` : `${all}`);
  const open = () => shownInstalled() ?? first();

  return (
    <div class="flex h-full min-h-0 flex-col gap-3 overflow-y-auto lg:flex-row lg:overflow-hidden">
      <nav
        aria-label={t("web.runtime.library.book")}
        data-testid="skills-book"
        class="flex shrink-0 flex-col gap-2 rounded-lg border border-line bg-page p-2 lg:w-72 lg:overflow-y-auto"
      >
        <h2 class="px-2 pt-1.5 text-base font-semibold">{t("web.runtime.library.book")}</h2>
        <TextInput
          data-testid="skills-search"
          aria-label={t("web.runtime.library.search")}
          placeholder={t("web.runtime.library.searchHint")}
          value={query()}
          onInput={(e) => setQuery(e.currentTarget.value)}
        />
        <Show when={runtimes.error}>
          <p class="px-2 text-xs text-berry">
            {t("web.runtime.library.noRuntimes")}
            {reasonOf(runtimes.error)}
          </p>
        </Show>
        <h3 class="px-2 pt-2 text-xs font-semibold text-muted">{t("web.runtime.library.installed", { count: count(list().length, installed().length) })}</h3>
        <Show when={installed().length === 0}>
          <p class="px-2 text-xs text-muted">{t("web.runtime.library.noneReported")}</p>
        </Show>
        <Show when={installed().length > 0 && list().length === 0}>
          <p class="px-2 text-xs text-muted">{t("web.runtime.library.noMatch")}</p>
        </Show>
        <ul class="flex flex-col gap-0.5">
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
        <div class="flex items-center gap-2 px-2 pt-3">
          <h3 class="flex-1 text-xs font-semibold text-muted">{t("web.runtime.library.own", { count: count(ownShown().length, own().length) })}</h3>
          <A
            href={skillPath("new")}
            data-testid="new-skill"
            class="inline-flex h-6 items-center rounded-md bg-accent px-2 text-xs text-page hover:bg-accent-hover"
          >
            {t("web.runtime.library.newSkill")}
          </A>
        </div>
        <ul class="flex flex-col gap-0.5">
          <For each={ownShown()}>{(s) => <Entry to={skillPath(s.id)} on={!creating() && selected()?.id === s.id} title={s.name} detail={s.description} />}</For>
        </ul>
      </nav>
      <div class="min-w-0 flex-1 lg:overflow-y-auto">
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
        class={["flex flex-col rounded-md px-2 py-1.5 hover:bg-hover", { "bg-selected": props.on }]}
      >
        <span class="truncate text-sm font-medium">{props.title}</span>
        <Show when={props.detail}>
          <span class="truncate text-xs text-muted">{props.detail}</span>
        </Show>
      </A>
    </li>
  );
}

/** Read-only: it lives with the runtime. */
function InstalledCard(props: { skill: InstalledSkill; catalog: readonly RuntimeInfo[] }) {
  return (
    <Card title={props.skill.name} class="max-w-3xl">
      <p class="text-xs text-muted">{t("web.runtime.library.installedNote")}</p>
      <Show when={props.skill.description}>
        <p class="text-sm whitespace-pre-wrap">{props.skill.description}</p>
      </Show>
      <div class="flex flex-col gap-1.5">
        <h3 class="text-xs font-semibold text-muted">{t("web.runtime.library.where")}</h3>
        <For each={props.skill.runtimes}>
          {(x) => (
            <div class="flex items-center gap-2.5 rounded-md bg-hover px-3 py-2">
              <RuntimeIcon runtime={x.runtime} size={28} />
              <span class="w-24 text-sm font-medium">{runtimeName(props.catalog, x.runtime)}</span>
              <span class="min-w-0 flex-1 truncate font-mono text-xs text-muted" title={x.source}>
                {x.source}
              </span>
            </div>
          )}
        </For>
      </div>
    </Card>
  );
}

const empty: Skill = { id: "", name: "", description: "", body: "" };
const same = (a: Skill, b: Skill) => a.name === b.name && a.description === b.description && a.body === b.body;

function SkillEditor(props: { skill?: Skill }) {
  // Keyed by the skill: the draft starts from the one it was opened on.
  const skill = untrack(() => props.skill);
  const [draft, setDraft] = createSignal(skill ?? empty);
  const [busy, setBusy] = createSignal(false);
  const router = useRouter();
  const client = useQueryClient();
  const allAgents = useAgents();
  const agents = () => ready(allAgents, []).filter((a) => skill !== undefined && a.skills.includes(skill.id));
  const dirty = () => !skill || !same(skill, draft());
  const act = async (f: () => Promise<void>) => {
    setBusy(true);
    try {
      await f();
    } catch (e) {
      toast(reasonOf(e));
    } finally {
      setBusy(false);
    }
  };
  // Deleting a skill takes it off the profiles that carried it, so both lists come back.
  const refresh = () => Promise.all([client.invalidateQueries({ queryKey: ["skills"] }), client.invalidateQueries({ queryKey: ["agents"] })]);
  const save = () => {
    const body = { ...draft(), name: draft().name.trim() };
    return act(async () => {
      const saved = skill ? await api.skill.update(body) : await api.skill.create(body);
      await refresh();
      setDraft(saved);
      if (!skill) router.navigate(skillPath(saved.id));
    });
  };
  const remove = (s: Skill) =>
    act(async () => {
      await api.skill.delete({ id: s.id });
      await refresh();
      router.navigate(skillPath());
    });

  return (
    <Card
      title={draft().name || t("web.runtime.library.newSkill")}
      class="max-w-3xl"
      action={
        <div class="flex flex-wrap items-center gap-2">
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
          <Button tone="primary" data-testid="save" disabled={busy() || !dirty() || !draft().name.trim() || !draft().body.trim()} onClick={() => void save()}>
            {t("web.base.form.save")}
          </Button>
        </div>
      }
    >
      <Field label={t("web.runtime.library.name")}>
        <TextInput
          data-testid="skill-name"
          aria-label={t("web.runtime.library.nameLabel")}
          placeholder={t("web.runtime.library.nameHint")}
          value={draft().name}
          onInput={(e) => setDraft({ ...draft(), name: e.currentTarget.value })}
        />
      </Field>
      <Field label={t("web.runtime.library.when")} hint={t("web.runtime.library.whenHint")}>
        <TextInput
          data-testid="skill-description"
          aria-label={t("web.runtime.library.description")}
          placeholder={t("web.runtime.library.descriptionHint")}
          value={draft().description}
          onInput={(e) => setDraft({ ...draft(), description: e.currentTarget.value })}
        />
      </Field>
      <Field label={t("web.runtime.library.body")} hint={t("web.runtime.library.bodyHint")}>
        <TextArea
          data-testid="skill-body"
          aria-label={t("web.runtime.library.body")}
          rows={14}
          placeholder={t("web.runtime.library.bodyExample")}
          value={draft().body}
          onInput={(e) => setDraft({ ...draft(), body: e.currentTarget.value })}
        />
      </Field>
      <div data-testid="skill-users" data-count={agents().length} class="flex flex-col gap-1.5">
        <span class="text-xs font-medium text-muted">{t("web.runtime.library.who")}</span>
        <Show when={agents().length > 0} fallback={<p class="text-xs text-muted">{t("web.runtime.library.nobody")}</p>}>
          <div class="flex flex-wrap gap-2">
            <For each={agents()}>
              {(a) => (
                <A href={`/agents/${encodeURIComponent(a.id)}`} class="flex items-center gap-1.5 rounded-md bg-hover py-1 pr-3 pl-1 hover:bg-selected">
                  <AgentFace agentId={a.id} runtime={a.runtime} look={a.look} size={26} />
                  <span class="text-sm font-medium">{a.name}</span>
                </A>
              )}
            </For>
          </div>
        </Show>
      </div>
    </Card>
  );
}
