import { signal, Text, View, type JSX } from "nsh";

import { t } from "@vibevalley/i18n";
import { type Memory, type MemorySourceInfo, memoryKeep } from "@vibevalley/protocol";
import { omitUndefined } from "@vibevalley/protocol/rules";
import * as S from "@vibevalley/protocol/schema";

import { useNow } from "../../base/dom";
import { ago } from "../../base/format";
import { api, createRequestKey } from "../../infra/api";
import { useCore } from "../../infra/frame";
import { defineQuery, ready, retryRead, useQuery, useQueryClient, useRepos } from "../../infra/query";
import { createAct } from "../../ui/act";
import { Button } from "../../ui/Button";
import { Select, TextArea, TextInput } from "../../ui/Field";
import { Quiet } from "../../ui/layout";
import { CountPill } from "../../ui/Tag";

/** Notes not tied to a repo. */
const everywhere = "*";

const memoryQuery = defineQuery({
  schema: S.MemoryList,
  key: (agent: string) => ["memory", agent],
  fetch: (agent, context) => api.memory.list({ agent }, context),
  ...retryRead,
});
const recallQuery = defineQuery({
  schema: S.RecallPreview,
  key: (a: { agent: string; repo: string; text: string; version: number }) => ["recall", a.agent, a.repo, a.text, a.version],
  fetch: (a, context) => api.memory.recall({ agent: a.agent, repo: a.repo, text: a.text }, context),
  ...retryRead,
});
const useMemory = (agent: () => string) => useQuery(() => memoryQuery(agent()));

/** Forgetting a memory, from either panel: a refusal in the error tone. */
function createForget(agent: () => string) {
  const queries = useQueryClient();
  const act = createAct();
  return (id: string) =>
    void act.run(async () => {
      const at = agent();
      await api.memory.delete({ agent: at, memory: id });
      await queries.invalidate({ key: ["memory", at] });
    });
}

/** A titled part of a panel, its count beside the title. */
function Section(props: { title: string; count?: number; aside?: string | undefined; testid?: string; children: JSX.Element }) {
  return (
    <View accessibilityLabel={props.title} testID={props.testid} class="gap-2">
      <View class="flex-row items-center gap-2">
        <Text role="header" class="text-sm font-semibold text-ink">
          {props.title}
        </Text>
        <If when={props.count !== undefined}>
          <CountPill count={props.count ?? 0} />
        </If>
        <View class="flex-1" />
        <If when={props.aside}>
          <Text class="text-xs text-muted">{props.aside}</Text>
        </If>
      </View>
      {props.children}
    </View>
  );
}

function recalledText(recalled: number, recalledAt: number | undefined, now: number) {
  const n = Math.round(recalled);
  return recalledAt != null && recalledAt !== 0
    ? t("web.memory.memory.recalledLast", { n, last: ago(recalledAt, now) })
    : t("web.memory.memory.recalled", { n });
}

function Pill(props: { label: string; on: boolean; onClick: () => void; testid?: string }) {
  return (
    <View
      role="button"
      testID={props.testid}
      accessibilityState={{ selected: props.on }}
      onPress={() => props.onClick()}
      class={`h-6 justify-center rounded-full border px-2.5 transition duration-120 ease-out focus-visible:outline-2 focus-visible:outline-focus ${
        props.on ? "border-accent bg-selected" : "border-transparent bg-hover hover:bg-selected"
      }`}
    >
      <Text class={`text-xs font-medium ${props.on ? "text-ink" : "text-muted"}`}>{props.label}</Text>
    </View>
  );
}

export function MemoryPanel(props: { agent: string }) {
  const shown = signal("");
  const viewQuery = useMemory(() => props.agent);
  const view = () => ready(viewQuery, undefined);
  const forget = createForget(() => props.agent);
  const core = useCore();
  const now = useNow();
  const sessions = () => new Map<string, string>((core()?.sessions ?? []).map((h) => [h.id, h.name]));
  const sessionNameOf = (id: string | undefined) => (id === undefined ? t("web.memory.memory.helper") : (sessions().get(id) ?? id));
  const all = () => view()?.memories ?? [];
  const sources = () => new Map((view()?.sources ?? []).map((s) => [s.name, s]));
  const notes = () => all().filter((m) => m.kind === "note");
  const done = () => all().filter((m) => m.kind === "issue");
  const repos = () => [...new Set(all().flatMap((m) => (m.repo ? [m.repo] : [])))].toSorted();
  const filtered = () => notes().filter((m) => shown() === "" || (shown() === everywhere ? m.repo === undefined : m.repo === shown()));
  const whose = (m: Memory) =>
    m.author === "user"
      ? t("web.memory.memory.yours")
      : m.session
        ? t("web.memory.memory.sessions", { name: sessions().get(m.session) ?? m.session })
        : m.author === "agent"
          ? t("web.memory.memory.orchestrators")
          : t("web.memory.memory.own");
  const pills = () => [
    ["", t("web.memory.memory.all")] as const,
    [everywhere, t("web.memory.memory.allRepos")] as const,
    ...repos().map((p) => [p, p] as const),
  ];
  return (
    <View testID="memory-panel" class="gap-4">
      <Text class="text-sm text-muted">{t("web.memory.memory.intro")}</Text>
      <If when={sources().size > 1}>
        <Sources sources={[...sources().values()]} />
      </If>
      <Section title={t("web.memory.memory.issues")} count={done().length} testid="memory-issues">
        <If when={done().length > 0} else={<Quiet>{t("web.memory.memory.noIssues")}</Quiet>}>
          <Each of={done()} key={(m) => m.id}>
            {(m) => (
              <View class="flex-row overflow-hidden rounded-md border border-line bg-page">
                <View class="w-0.75 shrink-0 bg-leaf" />
                <View class="min-w-0 flex-1 gap-0.5 px-3 py-2">
                  <View class="flex-row flex-wrap gap-2">
                    <Text class="text-xs font-medium text-ink">{sessionNameOf(m().session)}</Text>
                    <Text class="text-xs text-muted">{m().repo ?? t("web.memory.memory.allRepos")}</Text>
                    <Text class="text-xs text-muted">{ago(m().at, now())}</Text>
                  </View>
                  <Text class="text-sm text-ink">{m().text}</Text>
                </View>
              </View>
            )}
          </Each>
        </If>
      </Section>
      <RecallPreview agent={props.agent} />
      <WriteNote agent={props.agent} withRepo />
      <Section title={t("web.memory.memory.notes")} count={notes().length} testid="notes">
        <If when={repos().length > 0}>
          <View class="flex-row flex-wrap gap-1">
            <Each of={pills()}>
              {(p) => <Pill testid={`memory-repo-${p()[0] || "all"}`} label={p()[1]} on={shown() === p()[0]} onClick={() => shown.set(p()[0])} />}
            </Each>
          </View>
        </If>
        <If when={filtered().length > 0} else={<Quiet>{notes().length > 0 ? t("web.memory.memory.emptyHere") : t("web.memory.memory.nothing")}</Quiet>}>
          <Each of={filtered()} key={(m) => m.id}>
            {(m) => {
              const src = () => {
                const source = m().source;
                return source ? sources().get(source) : undefined;
              };
              return (
                <If
                  when={src()}
                  else={
                    <MemoryItem
                      memory={m()}
                      faded={m().fading === true}
                      onForget={() => forget(m().id)}
                      meta={[
                        m().repo ?? t("web.memory.memory.allRepos"),
                        whose(m()),
                        ago(m().at, now()),
                        m().recalled > 0 ? recalledText(m().recalled, m().recalledAt, now()) : t("web.memory.memory.neverRecalled"),
                      ]}
                      warning={m().fading ? t("web.memory.memory.fading", { keep: memoryKeep }) : undefined}
                    />
                  }
                >
                  {(s) => (
                    <MemoryItem
                      memory={m()}
                      onForget={s().canForget ? () => forget(m().id) : undefined}
                      meta={[
                        t("web.memory.memory.inSource", { source: s().label }),
                        ...(s().canForget ? [] : [t("web.memory.memory.forgetThere", { source: s().label })]),
                      ]}
                    />
                  )}
                </If>
              );
            }}
          </Each>
        </If>
      </Section>
    </View>
  );
}

/** Where its memories live besides the farm's own, and what each lets the panel do. */
function Sources(props: { sources: MemorySourceInfo[] }) {
  return (
    <Section title={t("web.memory.memory.sources")} count={props.sources.filter((s) => s.on).length} testid="memory-sources">
      <Each of={props.sources}>
        {(s) => (
          <View class="flex-row flex-wrap items-center gap-x-2 gap-y-0.5 rounded-md border border-line bg-page px-3 py-2">
            <Text class="text-sm font-medium text-ink">{s().label}</Text>
            <Text class={`text-xs ${s().on ? "text-accent" : "text-berry"}`}>
              {s().on ? t("web.memory.memory.on") : t("web.memory.memory.off", { why: s().off })}
            </Text>
            <If when={s().on}>
              <Text class="text-xs text-muted">{s().canList ? t("web.memory.memory.listed") : t("web.memory.memory.unlisted")}</Text>
              <Text class="text-xs text-muted">{s().canForget ? t("web.memory.memory.forgettable") : t("web.memory.memory.forgetElsewhere")}</Text>
              <If when={s().transcripts}>
                <Text class="text-xs text-muted">{t("web.memory.memory.transcripts")}</Text>
              </If>
            </If>
          </View>
        )}
      </Each>
      <Text class="text-xs text-muted">{t("web.memory.memory.sourcesNote")}</Text>
    </Section>
  );
}

/** The pick the server would make, without counting it (memory.recall). */
function RecallPreview(props: { agent: string }) {
  const reposQuery = useRepos();
  const repos = () => ready(reposQuery, []).map((p) => p.name);
  const repo = signal("");
  const text = signal("");
  const where = () => repo() || repos()[0] || "";
  const memory = useMemory(() => props.agent);
  const previewQuery = useQuery(() => recallQuery({ agent: props.agent, repo: where(), text: text(), version: memory.snapshot().record?.updatedAt ?? 0 }), {
    enabled: () => where() !== "",
  });
  const preview = () => ready(previewQuery, undefined);
  const lines = () => preview()?.lines ?? [];
  return (
    <Section
      title={t("web.memory.memory.next")}
      testid="recall"
      aside={
        lines().length > 0 && preview()
          ? t("web.memory.memory.preview", { n: lines().length, chars: preview()?.chars ?? 0, limit: preview()?.limit ?? 0 })
          : undefined
      }
    >
      <View class="gap-1.5 sm:flex-row">
        <Select
          class="sm:w-40"
          testid="recall-repo"
          label={t("web.memory.memory.where")}
          placeholder={t("web.memory.memory.pick")}
          value={where()}
          options={repos().map((p) => ({ value: p, label: p }))}
          onChange={(v) => repo.set(v)}
        />
        <TextInput
          testID="recall-words"
          class="flex-1"
          accessibilityLabel={t("web.memory.memory.words")}
          placeholder={t("web.memory.memory.wordsHint")}
          value={text()}
          onInput={(v) => text.set(v)}
        />
      </View>
      <If when={lines().length > 0} else={<Quiet>{where() ? t("web.memory.memory.blank") : t("web.memory.memory.noRepos")}</Quiet>}>
        <View testID="recall-lines" class="rounded-md border border-line bg-page px-3 py-2">
          <Text class="text-sm text-ink">{lines().join("\n")}</Text>
        </View>
      </If>
    </Section>
  );
}

/** Notes belong to the profile; authorship distinguishes the user's words. */
export function OrchestratorMemoryPanel(props: { agent: string }) {
  const viewQuery = useMemory(() => props.agent);
  const view = () => ready(viewQuery, undefined);
  const forget = createForget(() => props.agent);
  const now = useNow();
  return (
    <If when={view()} else={<Quiet>{t("web.memory.memory.orchestratorReading")}</Quiet>}>
      {(v) => (
        <View testID="orchestrator-memory" class="gap-4">
          <Text class="text-sm text-muted">{t("web.memory.memory.orchestratorIntro")}</Text>
          <WriteNote agent={props.agent} />
          <Section title={t("web.memory.memory.notes")} count={v().memories.length} testid="notes">
            <If when={v().memories.length > 0} else={<Quiet>{t("web.memory.memory.orchestratorNothing")}</Quiet>}>
              <Each of={v().memories} key={(m) => m.id}>
                {(m) => (
                  <MemoryItem
                    memory={m()}
                    onForget={() => forget(m().id)}
                    meta={[m().author === "user" ? t("web.memory.memory.told") : t("web.memory.memory.orchestratorOwn"), ago(m().at, now())]}
                  />
                )}
              </Each>
            </If>
          </Section>
        </View>
      )}
    </If>
  );
}

function WriteNote(props: { agent: string; withRepo?: boolean }) {
  const queries = useQueryClient();
  const text = signal("");
  const repo = signal("");
  const error = signal<string | undefined>(undefined);
  const reposQuery = useRepos();
  // A refusal shows under the box, where the words are; the key stays until a note went in, so a retry is that note.
  const act = createAct((e) => error.set(e));
  const key = createRequestKey();
  const write = async () => {
    const agent = props.agent;
    const words = text();
    const at = props.withRepo === true ? repo().trim() || undefined : undefined;
    error.set(undefined);
    const done = await act.run(async () => {
      await api.memory.create(omitUndefined({ agent, text: words, repo: at, requestKey: key.now() }));
      key.used();
      await queries.invalidate({ key: ["memory", agent] });
      return true;
    });
    if (done === true) text.set("");
  };
  const suggested = () => {
    const typed = repo().trim().toLowerCase();
    return ready(reposQuery, [])
      .map((p) => p.name)
      .filter((name) => name.toLowerCase() !== typed && (typed === "" || name.toLowerCase().includes(typed)))
      .slice(0, 6);
  };
  return (
    <View class="gap-1">
      <Text class="text-xs font-medium text-muted">{t("web.memory.memory.note")}</Text>
      <TextArea
        testID="note-input"
        accessibilityLabel={t("web.memory.memory.note")}
        rows={2}
        placeholder={props.withRepo === true ? t("web.memory.memory.noteRepo") : t("web.memory.memory.noteOrchestrator")}
        value={text()}
        onInput={(v) => text.set(v)}
      />
      <If
        when={props.withRepo === true}
        else={
          <View class="flex-row items-center justify-between gap-3 pt-1">
            <View class="min-w-0 flex-1">
              <If when={error()} else={<Text class="text-xs text-faint">{t("web.memory.memory.noteHint")}</Text>}>
                <Text testID="note-error" class="text-xs text-berry">
                  {error()}
                </Text>
              </If>
            </View>
            <Button tone="primary" testID="note-write" class="shrink-0" disabled={!text().trim() || act.busy()} onPress={() => void write()}>
              {t("web.base.write")}
            </Button>
          </View>
        }
      >
        <View class="flex-row items-center gap-2 pt-1">
          <TextInput
            testID="note-repo"
            class="flex-1 font-mono"
            wide={false}
            accessibilityLabel={t("web.memory.memory.repo")}
            placeholder={t("web.memory.memory.repoHint")}
            value={repo()}
            onInput={(v) => repo.set(v)}
          />
          <Button tone="primary" testID="note-write" class="shrink-0" disabled={!text().trim() || act.busy()} onPress={() => void write()}>
            {t("web.base.write")}
          </Button>
        </View>
        <If when={suggested().length > 0}>
          <View class="flex-row flex-wrap gap-1">
            <Each of={suggested()}>
              {(name) => (
                <View
                  role="button"
                  testID={`note-repo-${name()}`}
                  onPress={() => repo.set(name())}
                  class="rounded-sm px-1.5 py-0.5 focus-visible:outline-2 focus-visible:outline-focus hover:bg-hover"
                >
                  <Text class="font-mono text-2xs text-muted">{name()}</Text>
                </View>
              )}
            </Each>
          </View>
        </If>
        <If when={error()} else={<Text class="text-xs text-faint">{t("web.memory.memory.noteHintRepo")}</Text>}>
          <Text testID="note-error" class="text-xs text-berry">
            {error()}
          </Text>
        </If>
      </If>
    </View>
  );
}

function MemoryItem(props: { memory: Memory; onForget?: (() => void) | undefined; meta: string[]; faded?: boolean; warning?: string | undefined }) {
  const hovered = signal(false);
  return (
    <View
      testID={`memory-${props.memory.id}`}
      onMouseEnter={() => hovered.set(true)}
      onMouseLeave={() => hovered.set(false)}
      class="flex-row items-start gap-2 rounded-md border border-line bg-page px-3 py-2"
    >
      <View class="min-w-0 flex-1 gap-0.5">
        <Text class={`text-sm ${props.faded === true ? "text-muted" : "text-ink"}`}>{props.memory.text}</Text>
        <View class="flex-row flex-wrap gap-x-2">
          <Each of={props.meta}>{(m) => <Text class="text-xs text-muted">{m()}</Text>}</Each>
          <If when={props.warning}>
            <Text class="text-xs text-warn-ink">{props.warning}</Text>
          </If>
        </View>
      </View>
      <If when={props.onForget}>
        <View
          role="button"
          testID="forget"
          accessibilityLabel={t("web.memory.memory.forget")}
          onPress={() => props.onForget?.()}
          style={{ opacity: hovered() ? 1 : 0 }}
          class="shrink-0 rounded-md px-2 py-0.5 hover:bg-hover"
        >
          <Text class="text-xs text-muted hover:text-berry">{t("web.memory.memory.forget")}</Text>
        </View>
      </If>
    </View>
  );
}
