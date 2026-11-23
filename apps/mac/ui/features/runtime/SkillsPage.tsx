import { Scroll, signal, Text, View } from "nsh";

import { list as listed, t } from "@vibevalley/i18n";
import type { Agent, RuntimeInfo, Skill } from "@vibevalley/protocol";

import { createAct } from "../../design/act";
import { Button, ButtonLink } from "../../design/Button";
import { ConfirmButton } from "../../design/ConfirmButton";
import { AgentFace } from "../../design/domain/Face";
import { runtimeName } from "../../design/domain/RuntimeBadge";
import { SearchField, TextArea, TextInput } from "../../design/Field";
import { Form, formControl, FormField, formMessages } from "../../design/Form";
import { ActiveBar, Card, Empty, SidebarSection } from "../../design/layout";
import { Markdown } from "../../design/Markdown";
import { RuntimeIcon } from "../../design/pixel/RuntimeIcon";
import { Bubble } from "../../design/Tip";
import { api, reasonOf } from "../../infra/api";
import { Keyed } from "../../infra/base/dom";
import { matches } from "../../infra/base/search";
import { type Submission, useForm } from "../../infra/form";
import { defineQuery, ready, retryRead, useAgents, useQuery, useQueryClient, useRuntimes } from "../../infra/query";
import { Link as A, useRouter } from "../../infra/router";
import { untrack } from "../../infra/solid";
import { type InstalledSkill, installedSkills } from "./quota";
import { SkillInput } from "./skill-form";

const installedPrefix = "installed:";
const skillPath = (id?: string) => (id === undefined ? "/team/skills" : `/team/skills/${encodeURIComponent(id)}`);

const skillsQuery = defineQuery({
  key: () => ["skills"],
  fetch: (_: void, context) => api.skill.list(context),
  ...retryRead,
});
export const useSkills = () => useQuery(skillsQuery);

export function SkillsPage(props: { id?: string | undefined }) {
  const router = useRouter();
  const query = signal("");
  const installedOpen = signal(true);
  const builtInOpen = signal(true);
  const ownOpen = signal(true);
  const skills = useSkills();
  const runtimes = useRuntimes();
  const catalog = () => ready(runtimes, []);
  const installed = () => installedSkills(catalog());
  const all = (): readonly Skill[] => ready(skills, []);
  const own = () => all().filter((s) => s.builtIn !== true);
  const builtIns = () => all().filter((s) => s.builtIn === true);
  const creating = () => props.id === "new";
  const shownInstalled = () => {
    const id = props.id;
    return id?.startsWith(installedPrefix) === true ? installed().find((s) => s.name === id.slice(installedPrefix.length)) : undefined;
  };
  const shownBuiltIn = () => {
    const id = props.id;
    return creating() || shownInstalled() !== undefined ? undefined : builtIns().find((s) => s.id === id);
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
    return text === "" ? builtIns() : builtIns().filter((s) => matches(text, [s.name, s.description, s.body]));
  };
  const count = (shown: number, all: number) => (q() ? `${shown} / ${all}` : `${all}`);
  const open = () => shownInstalled() ?? first();

  return (
    <View class="h-full min-h-0 flex-1 gap-3 lg:flex-row">
      <Scroll
        accessibilityLabel={t("web.runtime.library.book")}
        testID="skills-book"
        class="max-h-80 shrink-0 rounded-lg border border-line bg-side lg:max-h-none lg:w-72"
        contentClass="gap-2 p-2.5"
      >
        <Text role="header" class="px-1.5 pt-1 text-base font-semibold text-ink">
          {t("web.runtime.library.book")}
        </Text>
        <SearchField
          testid="skills-search"
          value={query()}
          onInput={(v) => query.set(v)}
          placeholder={t("web.runtime.library.searchHint")}
          label={t("web.runtime.library.search")}
        />
        <If when={runtimes.error()}>
          <Text class="px-1.5 text-xs text-berry">
            {t("web.runtime.library.noRuntimes")}
            {reasonOf(runtimes.error())}
          </Text>
        </If>
        <SidebarSection
          class="pt-2"
          title={t("web.runtime.library.installed", { count: count(list().length, installed().length) })}
          open={installedOpen() || q() !== ""}
          onToggle={() => installedOpen.set(!installedOpen())}
        >
          <If when={installed().length === 0}>
            <Text class="px-2 text-xs text-muted">{t("web.runtime.library.noneReported")}</Text>
          </If>
          <If when={installed().length > 0 && list().length === 0}>
            <Text class="px-2 text-xs text-muted">{t("web.runtime.library.noMatch")}</Text>
          </If>
          <Each of={list()} key={(s) => s.name}>
            {(s) => (
              <Entry
                to={skillPath(installedPrefix + s().name)}
                on={open()?.name === s().name}
                title={s().name}
                detail={listed(s().runtimes.map((x) => runtimeName(catalog(), x.runtime)))}
              />
            )}
          </Each>
        </SidebarSection>
        <SidebarSection
          class="pt-2"
          title={t("web.runtime.library.builtIn", { count: count(builtInShown().length, builtIns().length) })}
          open={builtInOpen() || q() !== ""}
          onToggle={() => builtInOpen.set(!builtInOpen())}
        >
          <View class="gap-0.5" testID="built-in-skills">
            <Each of={builtInShown()} key={(s) => s.id}>
              {(s) => <Entry to={skillPath(s().id)} on={shownBuiltIn()?.id === s().id} title={s().name} detail={s().description} />}
            </Each>
          </View>
        </SidebarSection>
        <SidebarSection
          class="pt-2"
          title={t("web.runtime.library.own", { count: count(ownShown().length, own().length) })}
          open={ownOpen() || q() !== ""}
          onToggle={() => ownOpen.set(!ownOpen())}
          action={
            <ButtonLink href={skillPath("new")} tone="primary" size="compact" icon="add" testID="new-skill">
              {t("web.runtime.library.newSkill")}
            </ButtonLink>
          }
        >
          <Each of={ownShown()} key={(s) => s.id}>
            {(s) => <Entry to={skillPath(s().id)} on={!creating() && selected()?.id === s().id} title={s().name} detail={s().description} />}
          </Each>
        </SidebarSection>
      </Scroll>
      <Scroll class="min-h-0 min-w-0 flex-1">
        <If when={creating()}>
          <Keyed key="new">{() => <SkillEditor />}</Keyed>
        </If>
        <If when={!creating() ? shownBuiltIn() : undefined}>{(s) => <BuiltInCard skill={s()} />}</If>
        <If when={!creating() && !shownBuiltIn() ? open() : undefined}>{(s) => <InstalledCard skill={s()} catalog={catalog()} />}</If>
        <If when={!creating() && !shownBuiltIn() && !open() ? selected() : undefined}>
          {(s) => <Keyed key={s().id}>{() => <SkillEditor skill={s()} />}</Keyed>}
        </If>
        <If when={!creating() && !shownBuiltIn() && !open() && !selected()}>
          <Empty
            icon="skill"
            action={
              <Button tone="primary" icon="add" onPress={() => router.navigate(skillPath("new"))}>
                {t("web.runtime.library.newSkill")}
              </Button>
            }
          >
            {t("web.runtime.library.noSkills")}
          </Empty>
        </If>
      </Scroll>
    </View>
  );
}

function Entry(props: { to: string; on: boolean; title: string; detail: string }) {
  return (
    <A
      href={props.to}
      testID="skill-entry"
      accessibilityState={{ selected: props.on }}
      class={`relative rounded-md px-2 py-1.5 focus-visible:outline-2 focus-visible:outline-focus ${props.on ? "bg-selected" : "hover:bg-hover"}`}
    >
      <If when={props.on}>
        <ActiveBar tall />
      </If>
      <Text class="truncate text-sm font-medium text-ink">{props.title}</Text>
      <If when={props.detail}>
        <Text class="truncate text-xs text-muted">{props.detail}</Text>
      </If>
    </A>
  );
}

/** Read-only: it ships with VibeValley and changes with it. */
function BuiltInCard(props: { skill: Skill }) {
  const allAgents = useAgents();
  const agents = () => {
    const id = props.skill.id;
    return ready(allAgents, []).filter((a) => a.skills.includes(id));
  };
  return (
    <Card title={props.skill.name} class="max-w-3xl">
      <View testID="built-in-skill" class="gap-3">
        <Text class="text-xs text-muted">{t("web.runtime.library.builtInNote")}</Text>
        <If when={props.skill.description !== ""}>
          <Text class="text-sm text-ink">{props.skill.description}</Text>
        </If>
        <Markdown text={props.skill.body} />
        <SkillUsers agents={agents()} />
      </View>
    </Card>
  );
}

function SkillUsers(props: { agents: readonly Agent[] }) {
  return (
    <View testID="skill-users" class="gap-1.5">
      <Text class="text-xs font-medium text-muted">{t("web.runtime.library.who")}</Text>
      <If when={props.agents.length > 0} else={<Text class="text-xs text-muted">{t("web.runtime.library.nobody")}</Text>}>
        <View class="flex-row flex-wrap gap-2">
          <Each of={props.agents} key={(a) => a.id}>
            {(a) => (
              <A href={`/agents/${encodeURIComponent(a().id)}`} class="flex-row items-center gap-1.5 rounded-md bg-hover py-1 pr-3 pl-1 hover:bg-selected">
                <AgentFace agentId={a().id} name={a().name} runtime={a().runtime} look={a().look} size={26} />
                <Text class="text-sm font-medium text-ink">{a().name}</Text>
              </A>
            )}
          </Each>
        </View>
      </If>
    </View>
  );
}

/** Read-only: it lives with the runtime. */
function InstalledCard(props: { skill: InstalledSkill; catalog: readonly RuntimeInfo[] }) {
  return (
    <Card title={props.skill.name} class="max-w-3xl">
      <Text class="text-xs text-muted">{t("web.runtime.library.installedNote")}</Text>
      <If when={props.skill.description}>
        <Text class="text-sm text-ink">{props.skill.description}</Text>
      </If>
      <View class="gap-1.5">
        <Text role="header" class="text-xs font-semibold text-muted">
          {t("web.runtime.library.where")}
        </Text>
        <Each of={props.skill.runtimes} key={(x) => x.runtime}>
          {(x) => (
            <View class="flex-row items-center gap-2.5 rounded-md bg-side px-3 py-2">
              <RuntimeIcon runtime={x().runtime} size={28} />
              <Text class="w-24 shrink-0 truncate text-sm font-medium text-ink">{runtimeName(props.catalog, x().runtime)}</Text>
              <View class="min-w-0 flex-1" tooltip={<If when={x().source}>{(src) => <Bubble text={src()} />}</If>}>
                <Text class="truncate font-mono text-xs text-muted">{x().source ?? ""}</Text>
              </View>
            </View>
          )}
        </Each>
      </View>
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
      {(submit) => (
        <Card
          title={name.value() || t("web.runtime.library.newSkill")}
          class="max-w-3xl"
          action={
            <View class="flex-row flex-wrap items-center gap-2">
              <If when={skill}>
                {(s) => (
                  <ConfirmButton
                    label={t("web.base.form.remove")}
                    question={agents().length > 0 ? t("web.runtime.library.inUse", { n: agents().length }) : t("web.runtime.library.removeIt")}
                    disabled={busy()}
                    testid="delete"
                    onConfirm={() => remove(s())}
                  />
                )}
              </If>
              <Button tone="primary" testID="save" disabled={busy() || form.submitting() || !form.dirty()} onPress={submit}>
                {t("web.base.form.save")}
              </Button>
            </View>
          }
        >
          <FormField field={name} label={t("web.runtime.library.name")}>
            <TextInput
              testID="skill-name"
              accessibilityLabel={t("web.runtime.library.nameLabel")}
              placeholder={t("web.runtime.library.nameHint")}
              {...formControl(name)}
              value={name.value()}
              onInput={(v) => name.setValue(v)}
              onSubmit={submit}
            />
          </FormField>
          <FormField field={description} label={t("web.runtime.library.when")} hint={t("web.runtime.library.whenHint")}>
            <TextInput
              testID="skill-description"
              accessibilityLabel={t("web.runtime.library.description")}
              placeholder={t("web.runtime.library.descriptionHint")}
              {...formControl(description)}
              value={description.value()}
              onInput={(v) => description.setValue(v)}
              onSubmit={submit}
            />
          </FormField>
          <FormField field={body} label={t("web.runtime.library.body")} hint={t("web.runtime.library.bodyHint")}>
            <TextArea
              testID="skill-body"
              accessibilityLabel={t("web.runtime.library.body")}
              rows={14}
              placeholder={t("web.runtime.library.bodyExample")}
              {...formControl(body)}
              value={body.value()}
              onInput={(v) => body.setValue(v)}
            />
          </FormField>
          <SkillUsers agents={agents()} />
        </Card>
      )}
    </Form>
  );
}
