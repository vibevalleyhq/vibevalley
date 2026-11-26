import "../infra/polyfill";
import { ErrorBoundary, host, keymap, Scroll, signal, Text, View, type JSX } from "nsh";

import { setLocale, t } from "@vibevalley/i18n";
import type { Changes, Issue, IssueAct, RepoTemplates } from "@vibevalley/protocol";

import { TextArea } from "../design/Field";
import { Icon } from "../design/Icon";
import type { IconName } from "../design/icons";
import { SkeletonLines } from "../design/Skeleton";
import { actionOf, perform } from "../features/issue/model/acts";
import { approveShownChanges } from "../features/issue/model/changes";
import { useIssueChanges } from "../features/issue/model/history";
import { createWriteKey, writeIssue } from "../features/issue/model/write";
import { useWorkAgents } from "../infra/agents";
import { api, newSendKey, reasonOf } from "../infra/api";
import { useBoardSlice, useCollabSlice, useIssue, useSession } from "../infra/frame";
import { readFarmFormParams, readHostLocale } from "../infra/hostParams";
import { ready, useRepos } from "../infra/query";
import { Root } from "../infra/Root";

const close = () => host.post("action", { type: "dismiss_farm_form" });
const route = (path: string) => host.post("action", { type: "global_route", path });

function Words(props: { children: JSX.Element; size?: 16 | 18; tone?: "ink" | "muted" | "onAccent" | "error" }) {
  const sizeClass = props.size === 18 ? "text-lg font-semibold" : props.size === 16 ? "text-base font-medium" : "text-sm";
  const toneClass =
    props.tone === "onAccent" ? "text-page font-medium" : props.tone === "muted" ? "text-muted" : props.tone === "error" ? "text-berry" : "text-ink";
  return <Text class={`font-sans ${sizeClass} ${toneClass}`}>{props.children}</Text>;
}

function Key(props: { title: string; primary?: boolean; disabled?: boolean; id?: string; onPress: () => void }) {
  return (
    <View
      role="button"
      accessibilityLabel={props.title}
      testID={props.id}
      disabled={props.disabled}
      onPress={() => {
        if (props.disabled !== true) props.onPress();
      }}
      class={`rounded-md border px-2.5 py-1.5 shadow-raise ${
        props.primary === true ? "border-accent bg-accent hover:bg-accent-hover" : "border-line bg-elevated hover:border-line-strong hover:bg-hover"
      } ${props.disabled === true ? "opacity-50" : ""}`}
    >
      <Words tone={props.primary === true ? "onAccent" : "ink"}>{props.title}</Words>
    </View>
  );
}

function Buttons(props: { children: JSX.Element }) {
  return <View class="flex-row flex-wrap items-center gap-1.5">{props.children}</View>;
}

function Shell(props: { title: string; icon: IconName; children: JSX.Element }) {
  return (
    <View class="flex-1 gap-3 rounded-xl border border-line-strong bg-page p-4 shadow-float">
      <View class="flex-row items-center gap-2 border-b border-line pb-2.5">
        <Icon name={props.icon} size={18} tone="accent" />
        <View class="flex-1">
          <Words size={18}>{props.title}</Words>
        </View>
        <View
          role="button"
          testID="farm-close"
          accessibilityLabel={t("web.farm.native.close")}
          onPress={close}
          class="size-7 items-center justify-center rounded-md hover:bg-hover"
        >
          <Icon name="close" size={14} tone="muted" />
        </View>
      </View>
      <Scroll class="flex-1" contentClass="gap-2.5 pb-2">
        {props.children}
      </Scroll>
    </View>
  );
}

function FormErrorFallback(props: { readonly error: unknown; readonly reset: () => void }) {
  const detail = () => (props.error instanceof Error ? props.error.message : String(props.error));
  return (
    <Shell title={t("web.farm.menu.issues")} icon="warn">
      <View testID="farm-form-error" class="gap-3 rounded-lg border border-berry bg-bad-soft p-3">
        <Words tone="error">{t("web.base.unreachable")}</Words>
        <Words tone="muted">{detail()}</Words>
        <Buttons>
          <Key id="farm-form-retry" primary title={t("web.farm.sow.retry")} onPress={props.reset} />
          <Key id="farm-form-dismiss" title={t("web.farm.native.close")} onPress={close} />
        </Buttons>
      </View>
    </Shell>
  );
}

function Sow() {
  const { repo, station } = readFarmFormParams();
  const agents = useWorkAgents(true);
  const repos = useRepos();
  const who = signal("");
  const words = signal("");
  const busy = signal(false);
  const error = signal("");
  const seeds = signal<RepoTemplates | undefined>(undefined);
  const kind = signal("");
  const collab = useCollabSlice();
  const channel = () => collab()?.chat?.channels.find((c) => c.default)?.id;
  const writeKey = createWriteKey();
  let message: { input: string; agent: string; channel: string; key: string } | undefined;
  const editsKept = signal(false);
  const load = async () => {
    if (!repo) return;
    try {
      error.set("");
      seeds.set(await api.repo.template.list({ id: repo }));
    } catch (e) {
      error.set(reasonOf(e));
    }
  };
  void load();
  const send = async (draft: boolean) => {
    const input = words().trim();
    if (!repo || !input || busy()) return;
    const id = channel();
    if (!draft && !id) return;
    const agent = who();
    editsKept.set(false);
    busy.set(true);
    error.set("");
    try {
      if (draft) {
        const result = await writeIssue(input, agent, repo, writeKey.for(input, agent, repo));
        writeKey.used();
        if (words().trim() === input && who() === agent) route(`/issues/${encodeURIComponent(result.issue.id)}`);
        else editsKept.set(true);
      } else if (id) {
        if (!message || message.input !== input || message.agent !== agent || message.channel !== id)
          message = { input, agent, channel: id, key: newSendKey() };
        await api.channel.message.send({ id, repo, station, text: input, sendKey: message.key, ...(agent ? { agent } : {}) });
        message = undefined;
        if (words().trim() === input && who() === agent) close();
        else editsKept.set(true);
      }
    } catch (e) {
      error.set(reasonOf(e));
    } finally {
      busy.set(false);
    }
  };
  return (
    <Shell title={t("web.farm.panel.sow", { plot: station + 1 })} icon="add">
      <If when={editsKept()}>
        <View class="rounded-lg border border-line bg-warn-soft px-3 py-2">
          <Words>{t("web.issue.new.editsKept")}</Words>
        </View>
      </If>
      <If
        when={repo}
        else={
          <View class="gap-2.5 rounded-lg border border-line bg-side p-3">
            <Words>{t("web.farm.sow.homeless")}</Words>
            <Words tone="muted">{ready(repos, []).length > 0 ? t("web.farm.sow.toMap") : t("web.farm.sow.noRepos")}</Words>
            <Buttons>
              <Key title={ready(repos, []).length > 0 ? t("web.farm.menu.repos") : t("web.farm.sow.makeRepo")} onPress={() => route("/repos")} />
            </Buttons>
          </View>
        }
      >
        <Words tone="muted">{t("web.farm.sow.plantIn", { repo })}</Words>
        <If when={seeds()}>
          {(bag) => (
            <>
              <If when={bag().recent.length}>
                <Words tone="muted">{t("web.farm.sow.recent")}</Words>
                <Buttons>
                  <Each of={bag().recent}>{(text) => <Key title={text()} onPress={() => words.set(text())} />}</Each>
                </Buttons>
              </If>
              <If when={bag().kinds.some((k) => k.templates.length > 0)}>
                <Words tone="muted">{t("web.farm.sow.kinds")}</Words>
                <Buttons>
                  <Each of={bag().kinds.filter((k) => k.templates.length > 0)}>
                    {(k) => <Key title={k().name} primary={kind() === k().id} onPress={() => kind.set(k().id)} />}
                  </Each>
                </Buttons>
                <Buttons>
                  <Each of={(bag().kinds.find((k) => k.id === kind()) ?? bag().kinds.find((k) => k.templates.length > 0))?.templates ?? []}>
                    {(seed) => <Key title={seed().title} onPress={() => words.set(seed().text)} />}
                  </Each>
                </Buttons>
              </If>
            </>
          )}
        </If>
        <Words tone="muted">{t("web.farm.sow.own")}</Words>
        <TextArea value={words()} onInput={(v) => words.set(v)} placeholder={t("web.farm.sow.jobHint")} rows={3} testID="sow-text" />
        <Words tone="muted">{t("web.farm.sow.who")}</Words>
        <Buttons>
          <Key title={t("web.farm.sow.orchestratorPicks")} primary={!who()} onPress={() => who.set("")} />
          <Each of={agents()}>{(a) => <Key title={a().name} primary={who() === a().id} onPress={() => who.set(a().id)} />}</Each>
        </Buttons>
        <Words tone="muted">{t("web.farm.sow.how", { repo })}</Words>
        <Buttons>
          <Key id="sow-draft" title={t("web.farm.sow.draft")} disabled={busy() || !words().trim()} onPress={() => void send(true)} />
          <Key id="sow-start" title={t("web.farm.sow.start")} primary disabled={busy() || !words().trim() || !channel()} onPress={() => void send(false)} />
        </Buttons>
      </If>
      <If when={error()}>
        {(e) => (
          <View class="gap-2 rounded-lg border border-berry bg-bad-soft px-3 py-2">
            <Words tone="error">{e()}</Words>
            <If when={!seeds() && repo}>
              <Buttons>
                <Key title={t("web.farm.sow.retry")} onPress={() => void load()} />
              </Buttons>
            </If>
          </View>
        )}
      </If>
    </Shell>
  );
}

function Work(props: { kind: string; issue: () => Issue }) {
  const words = signal("");
  const busy = signal(false);
  const error = signal("");
  const { session: targetSession, issue: targetIssue } = readFarmFormParams();
  const slot = useSession(() => targetSession);
  const target = useIssue(() => targetIssue);
  const sinceTree = signal<string | undefined>(undefined);
  const changes = useIssueChanges(
    () => props.issue().id,
    () => props.kind !== "water",
    sinceTree,
  );
  let submission: { act: IssueAct; text: string; key: string } | undefined;
  const submit = async (act: IssueAct, text = words().trim(), shown?: Changes) => {
    if (busy() || ((act === "tell" || act === "answer") && !text)) return;
    const issue = target();
    const action = issue && actionOf(issue, act);
    if (!issue || !action) {
      error.set(t("web.farm.water.moved"));
      return;
    }
    busy.set(true);
    try {
      if (!submission || submission.act !== act || submission.text !== text) submission = { act, text, key: newSendKey() };
      const approved = shown ? await approveShownChanges(issue, shown) : undefined;
      await perform(issue, action, text, submission.key, approved?.revision);
      close();
    } catch (e) {
      error.set(reasonOf(e));
      if (shown?.revision && sinceTree() !== shown.revision.tree) sinceTree.set(shown.revision.tree);
      else if (shown) await changes.refetch();
    } finally {
      busy.set(false);
    }
  };
  const name = () => slot()?.name ?? "";
  const actionKeys = () => props.issue().stage.acts.map((a) => a.act);
  return (
    <Shell
      title={
        props.kind === "water"
          ? t("web.farm.panel.water", { name: name() })
          : props.kind === "harvest"
            ? t("web.farm.panel.harvest", { name: name() })
            : t("web.farm.plotOf", { name: name() })
      }
      icon={props.kind === "water" ? "chat" : props.kind === "harvest" ? "check" : "info"}
    >
      <View class="gap-1 rounded-lg border border-line bg-side p-3">
        <Words size={16}>
          #{props.issue().number} {props.issue().title}
        </Words>
        <If when={props.issue().repo}>{(repo) => <Words tone="muted">{t("web.farm.harvest.repo", { repo: repo() })}</Words>}</If>
      </View>
      <If when={props.kind === "inspect" && actionKeys().includes("answer")}>
        <Each of={props.issue().questions}>
          {(ask) => (
            <View class="gap-2 rounded-lg border border-line bg-side p-3">
              <Words>{ask().question}</Words>
              <Buttons>
                <Each of={ask().options}>
                  {(option) => <Key id="plot-answer-option" title={option()} disabled={busy()} onPress={() => void submit("answer", option())} />}
                </Each>
              </Buttons>
            </View>
          )}
        </Each>
        <TextArea testID="plot-answer-words" value={words()} onInput={(v) => words.set(v)} placeholder={t("web.issue.detail.sayIt")} />
        <Buttons>
          <Key id="plot-answer" primary title={t("web.issue.detail.answer")} disabled={busy() || !words().trim()} onPress={() => void submit("answer")} />
        </Buttons>
      </If>
      <If when={props.kind === "water"}>
        <Words tone="muted">{slot()?.phase._tag === "working" ? t("web.farm.water.working") : t("web.farm.water.idle")}</Words>
        <Words tone="muted">{t("web.farm.water.thread")}</Words>
        <Buttons>
          <Each of={[0, 1, 2, 3] as const}>
            {(i) => <Key title={t(`web.farm.water.drops.${i()}`)} onPress={() => words.set(t(`web.farm.water.drops.${i()}`))} />}
          </Each>
        </Buttons>
        <TextArea testID="water-words" value={words()} onInput={(v) => words.set(v)} placeholder={t("web.farm.water.hint")} />
        <Buttons>
          <Key
            id="water-send"
            primary
            title={t("web.farm.water.water")}
            disabled={!words().trim() || busy() || !actionKeys().includes("tell")}
            onPress={() => void submit("tell")}
          />
        </Buttons>
      </If>
      <If when={props.kind !== "water"}>
        <If when={ready(changes, undefined)}>
          {(change) => (
            <View class="gap-2 rounded-lg border border-line bg-side p-3">
              <Words>
                {change().branch} → {change().base}
              </Words>
              <Words tone="muted">{t("web.farm.harvest.counts", { commits: change().commits.length, files: change().files.length })}</Words>
              <Each of={change().files}>
                {(file) => (
                  <Words tone="muted">
                    {file().status} {file().path}
                  </Words>
                )}
              </Each>
              <If when={change().sinceReview?.length}>
                <Words>{t("web.issue.changes.sinceReview")}</Words>
                <Each of={change().sinceReview ?? []}>
                  {(file) => (
                    <Words tone="muted">
                      {file().status} {file().path}
                    </Words>
                  )}
                </Each>
              </If>
              <Buttons>
                <If when={actionKeys().includes("complete")}>
                  <Key
                    id="harvest-take"
                    primary
                    title={
                      change().commits.length > 0 || change().files.length > 0
                        ? t("web.farm.harvest.take", { base: change().base })
                        : t("web.farm.harvest.letGo")
                    }
                    disabled={busy()}
                    onPress={() => void submit("complete", "", change())}
                  />
                </If>
                <If when={actionKeys().includes("resolve")}>
                  <Key title={t("web.farm.harvest.resolve")} disabled={busy()} onPress={() => void submit("resolve")} />
                </If>
              </Buttons>
            </View>
          )}
        </If>
        <If when={changes.error()}>
          {(e) => (
            <View class="rounded-lg border border-berry bg-bad-soft px-3 py-2">
              <Words tone="error">{reasonOf(e())}</Words>
            </View>
          )}
        </If>
        <Buttons>
          <Key title={t("web.farm.hud.workbench")} onPress={() => route(`/issues/${encodeURIComponent(props.issue().id)}`)} />
        </Buttons>
      </If>
      <If when={error()}>
        {(e) => (
          <View class="rounded-lg border border-berry bg-bad-soft px-3 py-2">
            <Words tone="error">{e()}</Words>
          </View>
        )}
      </If>
    </Shell>
  );
}

function Content() {
  const { issue: issueId, kind } = readFarmFormParams();
  if (kind === "sow") return <Sow />;
  const board = useBoardSlice();
  const issue = useIssue(() => issueId);
  return (
    <If
      when={issue()}
      else={
        <Shell title={t("web.farm.menu.issues")} icon="issues">
          <If
            when={board() !== undefined}
            else={
              <View testID="farm-form-loading" class="gap-2 rounded-lg border border-line bg-side p-3">
                <Words tone="muted">{t("web.farm.native.loading")}</Words>
                <SkeletonLines rows={3} surface="side" />
              </View>
            }
          >
            <View class="gap-2.5 rounded-lg border border-line bg-side p-3">
              <Words tone="muted">{t("web.farm.water.moved")}</Words>
              <Buttons>
                <Key title={t("web.farm.hud.workbench")} onPress={() => route("/issues")} />
              </Buttons>
            </View>
          </If>
        </Shell>
      }
    >
      {(item) => <Work kind={kind} issue={item} />}
    </If>
  );
}

function FarmFormBody() {
  setLocale(readHostLocale());
  keymap.bind("escape", close, { when: "always" });
  return (
    <Root>
      <Content />
    </Root>
  );
}

export function FarmForm() {
  return (
    <ErrorBoundary fallback={(err, reset) => <FormErrorFallback error={err} reset={reset} />}>
      <FarmFormBody />
    </ErrorBoundary>
  );
}
