import "../polyfill";
import { host, keymap, Scroll, signal, Text, View, type JSX } from "nsh";

import { setLocale, t } from "@vibevalley/i18n";
import type { Changes, Issue, IssueAct, RepoTemplates } from "@vibevalley/protocol";

import { Root } from "../web/app/Root";
import { actionOf, perform } from "../web/features/issue/model/acts";
import { approveShownChanges } from "../web/features/issue/model/changes";
import { useIssueChanges } from "../web/features/issue/model/history";
import { createWriteKey, writeIssue } from "../web/features/issue/model/write";
import { useWorkAgents } from "../web/infra/agents";
import { api, newSendKey, reasonOf } from "../web/infra/api";
import { useBridge } from "../web/infra/bridged";
import { useCore } from "../web/infra/frame";
import { ready, useRepos } from "../web/infra/query";
import { TextArea } from "../web/ui/Field";
import { SpriteIcon } from "../web/ui/pixel/icons";

const close = () => host.post("action", { type: "dismiss_farm_form" });
const route = (path: string) => host.post("action", { type: "global_route", path });
const pixelFont = "Fusion Pixel 12px Prop zh-Hans";

function Words(props: { children: JSX.Element; size?: number }) {
  return <Text style={{ fontFamily: pixelFont, fontSize: props.size ?? 13, color: "#46301d" }}>{props.children}</Text>;
}

function Key(props: { title: string; primary?: boolean; disabled?: boolean; id?: string; onPress: () => void }) {
  return (
    <View
      role="button"
      accessibilityLabel={props.title}
      testID={props.id}
      disabled={props.disabled}
      onPress={props.onPress}
      style={{
        backgroundColor: props.primary ? "#b4cb7c" : "#eedcb2",
        borderWidth: 2,
        borderColor: "#67482d",
        paddingHorizontal: 8,
        paddingVertical: 4,
        opacity: props.disabled ? 0.5 : 1,
      }}
    >
      <Words>{props.title}</Words>
    </View>
  );
}

function Buttons(props: { children: JSX.Element }) {
  return <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6, alignItems: "center" }}>{props.children}</View>;
}

function Shell(props: { title: string; icon: string; children: JSX.Element }) {
  return (
    <View class="flex-1" style={{ backgroundColor: "#f7e8c4", borderWidth: 2, borderColor: "#2f1f13", padding: 16, gap: 12 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 7 }}>
        <SpriteIcon name={props.icon} size={24} />
        <View class="flex-1">
          <Words size={18}>{props.title}</Words>
        </View>
        <View role="button" testID="farm-close" accessibilityLabel={t("web.farm.native.close")} onPress={close}>
          <SpriteIcon name="button-close" size={18} />
        </View>
      </View>
      <Scroll style={{ flex: 1 }} contentStyle={{ gap: 8, paddingBottom: 8 }}>
        {props.children}
      </Scroll>
    </View>
  );
}

function Sow() {
  const repo = String(host.params.repo ?? "");
  const station = Number(host.params.station);
  const agents = useWorkAgents(true);
  const repos = useRepos();
  const who = signal("");
  const words = signal("");
  const busy = signal(false);
  const error = signal("");
  const seeds = signal<RepoTemplates | undefined>(undefined);
  const kind = signal("");
  const core = useCore();
  const channel = () => core()?.chat?.channels.find((c) => c.default)?.id;
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
    <Shell title={t("web.farm.panel.sow", { plot: station + 1 })} icon="icon-seeds">
      <If when={editsKept()}>
        <Words>{t("web.issue.new.editsKept")}</Words>
      </If>
      <If
        when={repo}
        else={
          <>
            <Words>{t("web.farm.sow.homeless")}</Words>
            <Words>{ready(repos, []).length ? t("web.farm.sow.toMap") : t("web.farm.sow.noRepos")}</Words>
            <If when={ready(repos, []).length > 0} else={<Key title={t("web.farm.sow.makeRepo")} onPress={() => route("/repos")} />}>
              <Key title={t("web.farm.native.map")} onPress={() => route("/map")} />
            </If>
          </>
        }
      >
        <Words>{t("web.farm.sow.plantIn", { repo })}</Words>
        <If when={seeds()}>
          {(bag) => (
            <>
              <If when={bag().recent.length}>
                <Words>{t("web.farm.sow.recent")}</Words>
                <Buttons>
                  <Each of={bag().recent}>{(text) => <Key title={text()} onPress={() => words.set(text())} />}</Each>
                </Buttons>
              </If>
              <If when={bag().kinds.some((k) => k.templates.length)}>
                <Words>{t("web.farm.sow.kinds")}</Words>
                <Buttons>
                  <Each of={bag().kinds.filter((k) => k.templates.length)}>
                    {(k) => <Key title={k().name} primary={kind() === k().id} onPress={() => kind.set(k().id)} />}
                  </Each>
                </Buttons>
                <Buttons>
                  <Each of={(bag().kinds.find((k) => k.id === kind()) ?? bag().kinds.find((k) => k.templates.length))?.templates ?? []}>
                    {(seed) => <Key title={seed().title} onPress={() => words.set(seed().text)} />}
                  </Each>
                </Buttons>
              </If>
            </>
          )}
        </If>
        <Words>{t("web.farm.sow.own")}</Words>
        <TextArea value={words()} onInput={words.set} placeholder={t("web.farm.sow.jobHint")} rows={3} testID="sow-text" />
        <Words>{t("web.farm.sow.who")}</Words>
        <Buttons>
          <Key title={t("web.farm.sow.orchestratorPicks")} primary={!who()} onPress={() => who.set("")} />
          <Each of={agents()}>{(a) => <Key title={a().name} primary={who() === a().id} onPress={() => who.set(a().id)} />}</Each>
        </Buttons>
        <Words>{t("web.farm.sow.how", { repo })}</Words>
        <Buttons>
          <Key id="sow-draft" title={t("web.farm.sow.draft")} disabled={busy() || !words().trim()} onPress={() => void send(true)} />
          <Key id="sow-start" title={t("web.farm.sow.start")} primary disabled={busy() || !words().trim() || !channel()} onPress={() => void send(false)} />
        </Buttons>
      </If>
      <If when={error()}>
        {(e) => (
          <>
            <Words>{e()}</Words>
            <If when={!seeds() && repo}>
              <Key title={t("web.farm.sow.retry")} onPress={() => void load()} />
            </If>
          </>
        )}
      </If>
    </Shell>
  );
}

function Work(props: { kind: string; issue: () => Issue }) {
  const words = signal("");
  const busy = signal(false);
  const error = signal("");
  const core = useCore();
  const slot = () => core()?.sessions.find((s) => s.id === host.params.session);
  const target = () => core()?.issues.find((i) => i.id === host.params.issue);
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
      icon={props.kind === "water" ? "icon-water" : props.kind === "harvest" ? "icon-harvest" : "icon-hand"}
    >
      <Words size={16}>
        #{props.issue().number} {props.issue().title}
      </Words>
      <If when={props.issue().repo}>{(repo) => <Words>{t("web.farm.harvest.repo", { repo: repo() })}</Words>}</If>
      <If when={props.kind === "inspect" && actionKeys().includes("answer")}>
        <Each of={props.issue().questions}>
          {(ask) => (
            <>
              <Words>{ask().question}</Words>
              <Buttons>
                <Each of={ask().options}>
                  {(option) => <Key id="plot-answer-option" title={option()} disabled={busy()} onPress={() => void submit("answer", option())} />}
                </Each>
              </Buttons>
            </>
          )}
        </Each>
        <TextArea testID="plot-answer-words" value={words()} onInput={words.set} placeholder={t("web.issue.detail.sayIt")} />
        <Key id="plot-answer" primary title={t("web.issue.detail.answer")} disabled={busy() || !words().trim()} onPress={() => void submit("answer")} />
      </If>
      <If when={props.kind === "water"}>
        <Words>{slot()?.phase._tag === "working" ? t("web.farm.water.working") : t("web.farm.water.idle")}</Words>
        <Words>{t("web.farm.water.thread")}</Words>
        <Buttons>
          <Each of={[0, 1, 2, 3] as const}>
            {(i) => <Key title={t(`web.farm.water.drops.${i()}`)} onPress={() => words.set(t(`web.farm.water.drops.${i()}`))} />}
          </Each>
        </Buttons>
        <TextArea testID="water-words" value={words()} onInput={words.set} placeholder={t("web.farm.water.hint")} />
        <Key
          id="water-send"
          primary
          title={t("web.farm.water.water")}
          disabled={!words().trim() || busy() || !actionKeys().includes("tell")}
          onPress={() => void submit("tell")}
        />
      </If>
      <If when={props.kind !== "water"}>
        <If when={ready(changes, undefined)}>
          {(change) => (
            <>
              <Words>
                {change().branch} → {change().base}
              </Words>
              <Words>{t("web.farm.harvest.counts", { commits: change().commits.length, files: change().files.length })}</Words>
              <Each of={change().files}>
                {(file) => (
                  <Words>
                    {file().status} {file().path}
                  </Words>
                )}
              </Each>
              <If when={change().sinceReview?.length}>
                <Words>{t("web.issue.changes.sinceReview")}</Words>
                <Each of={change().sinceReview ?? []}>
                  {(file) => (
                    <Words>
                      {file().status} {file().path}
                    </Words>
                  )}
                </Each>
              </If>
              <If when={actionKeys().includes("complete")}>
                <Key
                  id="harvest-take"
                  primary
                  title={change().commits.length || change().files.length ? t("web.farm.harvest.take", { base: change().base }) : t("web.farm.harvest.letGo")}
                  disabled={busy()}
                  onPress={() => void submit("complete", "", change())}
                />
              </If>
              <If when={actionKeys().includes("resolve")}>
                <Key title={t("web.farm.harvest.resolve")} disabled={busy()} onPress={() => void submit("resolve")} />
              </If>
            </>
          )}
        </If>
        <If when={changes.error()}>{(e) => <Words>{reasonOf(e())}</Words>}</If>
        <Key title={t("web.farm.hud.workbench")} onPress={() => route(`/issues/${encodeURIComponent(props.issue().id)}`)} />
      </If>
      <If when={error()}>{(e) => <Words>{e()}</Words>}</If>
    </Shell>
  );
}

function Content() {
  const core = useCore();
  const issue = () => core()?.issues.find((i) => i.id === host.params.issue);
  if (host.params.kind === "sow") return <Sow />;
  return (
    <If
      when={issue()}
      else={
        <Shell title={t("web.farm.menu.issues")} icon="icon-tasks">
          <Words>{t("web.farm.water.moved")}</Words>
        </Shell>
      }
    >
      {(item) => <Work kind={String(host.params.kind)} issue={item} />}
    </If>
  );
}

export function FarmForm() {
  setLocale(host.params.locale === "en" ? "en" : "zh");
  useBridge();
  keymap.bind("escape", close, { when: "always" });
  return (
    <Root>
      <Content />
    </Root>
  );
}
