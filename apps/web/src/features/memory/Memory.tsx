import type { JSX } from "@solidjs/web";
import * as stylex from "@stylexjs/stylex";
import { createSignal, For, Show } from "solid-js";

import { t } from "@vibevalley/i18n";
import { type Memory, type MemorySourceInfo, memoryKeep } from "@vibevalley/protocol";
import { omitUndefined } from "@vibevalley/protocol/rules";
import * as S from "@vibevalley/protocol/schema";

import { aria, useNow } from "#/base/dom.tsx";
import { ago } from "#/base/format.ts";
import { api, createRequestKey, reasonOf } from "#/infra/api.ts";
import { useCore } from "#/infra/frame.ts";
import { defineQuery, retryRead, useQueryClient, ready, useRepos, useQuery } from "#/infra/query.ts";
import { createAct } from "#/ui/act.ts";
import { Button } from "#/ui/Button.tsx";
import { Select, TextArea, TextInput } from "#/ui/Field.tsx";
import { Quiet } from "#/ui/layout.tsx";
import { styleProps } from "#/ui/positioner.ts";

const memoryStyles = stylex.create({
  card: {
    display: "flex",
    alignItems: "flex-start",
    gap: "calc(var(--spacing) * 2)",
    borderRadius: "var(--radius-md)",
    borderStyle: "solid",
    borderWidth: "1px",
    borderColor: "var(--wb-line)",
    backgroundColor: "var(--wb-page)",
    paddingInline: "calc(var(--spacing) * 3)",
    paddingBlock: "calc(var(--spacing) * 2)",
  },
  forget: {
    flexShrink: "0",
    cursor: "pointer",
    borderRadius: "var(--radius-md)",
    paddingInline: "calc(var(--spacing) * 2)",
    paddingBlock: "calc(var(--spacing) * .5)",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--text-xs--line-height)",
    color: {
      default: "var(--wb-muted)",
      "@media (hover:hover)": {
        default: null,
        ":hover": "var(--wb-berry)",
      },
    },
    opacity: {
      default: "0",
      ":focus-visible": "1",
      "@media (hover: hover)": {
        default: null,
        [stylex.when.ancestor(":hover")]: 1,
      },
    },
    backgroundColor: {
      default: null,
      "@media (hover:hover)": {
        default: null,
        ":hover": "var(--wb-hover)",
      },
    },
  },
});

const recipeStyles2 = stylex.create({
  archivePanelPre: {
    maxHeight: "calc(var(--spacing) * 96)",
    overflowY: "auto",
    borderTopStyle: "solid",
    borderTopWidth: "1px",
    borderColor: "var(--wb-line)",
    paddingInline: "calc(var(--spacing) * 3)",
    paddingBlock: "calc(var(--spacing) * 2)",
    fontSize: "var(--text-sm)",
    lineHeight: "var(--text-sm--line-height)",
    whiteSpace: "pre-wrap",
    WebkitUserSelect: "text",
    userSelect: "text",
  },
});

const recipeStyles = stylex.create({
  memoryPanelDiv: {
    display: "flex",
    overflow: "hidden",
    borderRadius: "var(--radius-md)",
    borderStyle: "solid",
    borderWidth: "1px",
    borderColor: "var(--color-line)",
    backgroundColor: "var(--color-page)",
  },
  sourcesDiv: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    columnGap: "calc(var(--spacing) * 2)",
    rowGap: "calc(var(--spacing) * .5)",
    borderRadius: "var(--radius-md)",
    borderStyle: "solid",
    borderWidth: "1px",
    borderColor: "var(--color-line)",
    backgroundColor: "var(--color-page)",
    paddingInline: "calc(var(--spacing) * 3)",
    paddingBlock: "calc(var(--spacing) * 2)",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--text-xs--line-height)",
    color: "var(--color-muted)",
  },
  recallPreviewP: {
    borderRadius: "var(--radius-md)",
    borderStyle: "solid",
    borderWidth: "1px",
    borderColor: "var(--color-line)",
    backgroundColor: "var(--color-page)",
    paddingInline: "calc(var(--spacing) * 3)",
    paddingBlock: "calc(var(--spacing) * 2)",
    fontSize: "var(--text-sm)",
    lineHeight: "var(--text-sm--line-height)",
    whiteSpace: "pre-wrap",
  },
  archivePanelDiv: {
    display: "flex",
    flexDirection: "column",
    gap: "calc(var(--spacing) * .5)",
    borderRadius: "var(--radius-md)",
    borderStyle: "solid",
    borderWidth: "1px",
    borderColor: "var(--color-line)",
    backgroundColor: "var(--color-page)",
    paddingInline: "calc(var(--spacing) * 3)",
    paddingBlock: "calc(var(--spacing) * 2)",
  },
  archivePanelDiv2: {
    overflow: "hidden",
    borderRadius: "var(--radius-md)",
    borderStyle: "solid",
    borderWidth: "1px",
    borderColor: "var(--color-line)",
    backgroundColor: "var(--color-page)",
  },
});

const variantStyles2 = stylex.create({
  writeNoteTextInput: {
    fontFamily: "var(--font-mono)",
  },
});

const variantStyles = stylex.create({
  pillButton: {
    height: "calc(var(--spacing) * 6)",
    cursor: "pointer",
    borderRadius: "2147483647px",
    paddingInline: "calc(var(--spacing) * 2.5)",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--text-xs--line-height)",
  },
  pillButtonVariant: {
    backgroundColor: "var(--color-ink)",
    color: "var(--color-page)",
  },
  pillButtonVariant2: {
    backgroundColor: {
      default: "var(--color-hover)",
      "@media (hover:hover)": {
        default: null,
        ":hover": "var(--color-selected)",
      },
    },
  },
  sourcesSpan: {},
  sourcesSpanVariant: {
    color: "var(--color-accent)",
  },
  sourcesSpanVariant2: {
    color: "var(--color-berry)",
  },
  memoryItemSpan: {
    fontSize: "var(--text-sm)",
    lineHeight: "var(--text-sm--line-height)",
  },
  memoryItemSpanVariant: {
    color: "var(--color-muted)",
  },
});

const viewStyles = stylex.create({
  sectionSection: {
    display: "flex",
    flexDirection: "column",
    gap: "calc(var(--spacing) * 2)",
  },
  sectionHeader: {
    display: "flex",
    alignItems: "center",
    gap: "calc(var(--spacing) * 2)",
  },
  sectionH3: {
    fontSize: "var(--text-sm)",
    lineHeight: "var(--text-sm--line-height)",
    fontWeight: "var(--font-weight-semibold)",
  },
  sectionSpan: {
    fontSize: "var(--text-xs)",
    lineHeight: "var(--text-xs--line-height)",
    color: "var(--color-muted)",
  },
  sectionSpan2: {
    flex: "1",
  },
  memoryPanelDiv: {
    display: "flex",
    flexDirection: "column",
    gap: "calc(var(--spacing) * 4)",
  },
  memoryPanelP: {
    fontSize: "var(--text-sm)",
    lineHeight: "var(--text-sm--line-height)",
    color: "var(--color-muted)",
  },
  memoryPanelSpan: {
    width: "3px",
    flexShrink: "0",
    backgroundColor: "var(--color-leaf)",
  },
  memoryPanelDiv2: {
    display: "flex",
    flexDirection: "column",
    gap: "calc(var(--spacing) * .5)",
    paddingInline: "calc(var(--spacing) * 3)",
    paddingBlock: "calc(var(--spacing) * 2)",
  },
  memoryPanelSpan2: {
    display: "flex",
    flexWrap: "wrap",
    gap: "calc(var(--spacing) * 2)",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--text-xs--line-height)",
    color: "var(--color-muted)",
  },
  memoryPanelSpan3: {
    fontWeight: "var(--font-weight-medium)",
    color: "var(--color-ink)",
  },
  memoryPanelSpan4: {
    fontSize: "var(--text-sm)",
    lineHeight: "var(--text-sm--line-height)",
  },
  memoryPanelDiv3: {
    display: "flex",
    flexWrap: "wrap",
    gap: "var(--spacing)",
  },
  sourcesSpan: {
    fontSize: "var(--text-sm)",
    lineHeight: "var(--text-sm--line-height)",
    fontWeight: "var(--font-weight-medium)",
    color: "var(--color-ink)",
  },
  recallPreviewDiv: {
    display: "flex",
    flexDirection: {
      default: "column",
      "@media (width>=40rem)": "row",
    },
    gap: "calc(var(--spacing) * 1.5)",
  },
  archivePanelForm: {
    display: "flex",
    gap: "calc(var(--spacing) * 2)",
  },
  archivePanelSpan: {
    fontFamily: "var(--font-mono)",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--text-xs--line-height)",
    color: "var(--color-muted)",
  },
  archivePanelButton: {
    display: "flex",
    width: "100%",
    cursor: "pointer",
    alignItems: "center",
    gap: "calc(var(--spacing) * 2)",
    paddingInline: "calc(var(--spacing) * 3)",
    paddingBlock: "calc(var(--spacing) * 2)",
    textAlign: "left",
    backgroundColor: {
      default: null,
      "@media (hover:hover)": {
        default: null,
        ":hover": "var(--color-hover)",
      },
    },
  },
  archivePanelSpan2: {
    minWidth: "0",
    flex: "1",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    overflow: "hidden",
    fontFamily: "var(--font-mono)",
    fontSize: "var(--text-sm)",
    lineHeight: "var(--text-sm--line-height)",
  },
  writeNoteDiv: {
    display: "flex",
    flexDirection: "column",
    gap: "var(--spacing)",
  },
  writeNoteSpan: {
    fontSize: "var(--text-xs)",
    lineHeight: "var(--text-xs--line-height)",
    fontWeight: "var(--font-weight-medium)",
    color: "var(--color-muted)",
  },
  writeNoteDiv2: {
    display: "flex",
    alignItems: "center",
    gap: "calc(var(--spacing) * 2)",
    paddingTop: "var(--spacing)",
  },
  writeNoteSpan2: {
    fontSize: "var(--text-xs)",
    lineHeight: "var(--text-xs--line-height)",
    color: "var(--color-faint)",
  },
  writeNoteSpan3: {
    fontSize: "var(--text-xs)",
    lineHeight: "var(--text-xs--line-height)",
    color: "var(--color-berry)",
  },
  memoryItemDiv: {
    display: "flex",
    minWidth: "0",
    flex: "1",
    flexDirection: "column",
    gap: "calc(var(--spacing) * .5)",
  },
  memoryItemSpan: {
    display: "flex",
    flexWrap: "wrap",
    columnGap: "calc(var(--spacing) * 2)",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--text-xs--line-height)",
    color: "var(--color-muted)",
  },
  memoryItemSpan2: {
    color: "var(--color-warn-ink)",
  },
});

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
const archiveQuery = defineQuery({
  schema: S.ArchiveListing,
  key: (a: { agent: string; q: string }) => ["archive", a.agent, a.q],
  fetch: (a, context) => api.orchestrator.archive.list(omitUndefined({ agent: a.agent, q: a.q || undefined }), context),
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
function Section(props: { title: string; count?: number; aside?: JSX.Element; testid?: string; children: JSX.Element }) {
  return (
    <section aria-label={props.title} data-testid={props.testid} data-count={props.count} {...stylex.attrs(viewStyles.sectionSection)}>
      <header {...stylex.attrs(viewStyles.sectionHeader)}>
        <h3 {...stylex.attrs(viewStyles.sectionH3)}>{props.title}</h3>
        <Show when={props.count !== undefined}>
          <span {...stylex.attrs(viewStyles.sectionSpan)}>{props.count}</span>
        </Show>
        <span {...stylex.attrs(viewStyles.sectionSpan2)} />
        <Show when={props.aside}>
          <span {...stylex.attrs(viewStyles.sectionSpan)}>{props.aside}</span>
        </Show>
      </header>
      {props.children}
    </section>
  );
}

function recalledText(recalled: number, recalledAt: number | undefined, now: number) {
  const n = Math.round(recalled);
  return recalledAt != null && recalledAt !== 0
    ? t("web.memory.memory.recalledLast", { n, last: ago(recalledAt, now) })
    : t("web.memory.memory.recalled", { n });
}

function Pill(props: { label: string; on: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-pressed={aria(props.on)}
      onClick={() => props.onClick()}
      {...stylex.attrs(variantStyles.pillButton, props.on ? variantStyles.pillButtonVariant : variantStyles.pillButtonVariant2)}
    >
      {props.label}
    </button>
  );
}

export function MemoryPanel(props: { agent: string }) {
  const [shown, setShown] = createSignal("");
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
    m.author === "owner"
      ? t("web.memory.memory.yours")
      : m.session
        ? t("web.memory.memory.sessions", { name: sessions().get(m.session) ?? m.session })
        : m.author === "agent"
          ? t("web.memory.memory.orchestrators")
          : t("web.memory.memory.own");
  return (
    <div {...stylex.attrs(viewStyles.memoryPanelDiv)}>
      <p {...stylex.attrs(viewStyles.memoryPanelP)}>{t("web.memory.memory.intro")}</p>
      <Show when={sources().size > 1}>
        <Sources sources={[...sources().values()]} />
      </Show>
      <Section title={t("web.memory.memory.issues")} count={done().length}>
        <Show when={done().length > 0} fallback={<Quiet>{t("web.memory.memory.noIssues")}</Quiet>}>
          <For each={done()} keyed={(m) => m.id}>
            {(m) => (
              <div {...stylex.attrs(recipeStyles.memoryPanelDiv)}>
                <span {...stylex.attrs(viewStyles.memoryPanelSpan)} />
                <div {...stylex.attrs(viewStyles.memoryPanelDiv2)}>
                  <span {...stylex.attrs(viewStyles.memoryPanelSpan2)}>
                    <span {...stylex.attrs(viewStyles.memoryPanelSpan3)}>{sessionNameOf(m().session)}</span>
                    <span>{m().repo ?? t("web.memory.memory.allRepos")}</span>
                    <span>{ago(m().at, now())}</span>
                  </span>
                  <span {...stylex.attrs(viewStyles.memoryPanelSpan4)}>{m().text}</span>
                </div>
              </div>
            )}
          </For>
        </Show>
      </Section>
      <RecallPreview agent={props.agent} />
      <WriteNote agent={props.agent} withRepo />
      <Section title={t("web.memory.memory.notes")} count={notes().length}>
        <Show when={repos().length > 0}>
          <div {...stylex.attrs(viewStyles.memoryPanelDiv3)}>
            <For
              each={[["", t("web.memory.memory.all")] as const, [everywhere, t("web.memory.memory.allRepos")] as const, ...repos().map((p) => [p, p] as const)]}
            >
              {([value, label]) => <Pill label={label} on={shown() === value} onClick={() => setShown(value)} />}
            </For>
          </div>
        </Show>
        <Show when={filtered().length > 0} fallback={<Quiet>{notes().length > 0 ? t("web.memory.memory.emptyHere") : t("web.memory.memory.nothing")}</Quiet>}>
          <For each={filtered()} keyed={(m) => m.id}>
            {(m) => {
              const src = () => {
                const source = m().source;
                return source ? sources().get(source) : undefined;
              };
              return (
                <Show
                  when={src()}
                  fallback={
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
                </Show>
              );
            }}
          </For>
        </Show>
      </Section>
    </div>
  );
}

/** Where its memories live besides the farm's own, and what each lets the panel do. */
function Sources(props: { sources: MemorySourceInfo[] }) {
  return (
    <Section title={t("web.memory.memory.sources")} count={props.sources.filter((s) => s.on).length}>
      <For each={props.sources}>
        {(s) => (
          <div {...stylex.attrs(recipeStyles.sourcesDiv)}>
            <span {...stylex.attrs(viewStyles.sourcesSpan)}>{s.label}</span>
            <span {...stylex.attrs(variantStyles.sourcesSpan, s.on ? variantStyles.sourcesSpanVariant : variantStyles.sourcesSpanVariant2)}>
              {s.on ? t("web.memory.memory.on") : t("web.memory.memory.off", { why: s.off })}
            </span>
            <Show when={s.on}>
              <span>{s.canList ? t("web.memory.memory.listed") : t("web.memory.memory.unlisted")}</span>
              <span>{s.canForget ? t("web.memory.memory.forgettable") : t("web.memory.memory.forgetElsewhere")}</span>
              <Show when={s.transcripts}>
                <span>{t("web.memory.memory.transcripts")}</span>
              </Show>
            </Show>
          </div>
        )}
      </For>
      <p {...stylex.attrs(viewStyles.sectionSpan)}>{t("web.memory.memory.sourcesNote")}</p>
    </Section>
  );
}

const selectStyles = stylex.create({ scope: { width: { default: null, "@media (width >= 40rem)": "calc(var(--spacing) * 40)" } } });

/** The pick the server would make, without counting it (memory.recall). */
function RecallPreview(props: { agent: string }) {
  const reposQuery = useRepos();
  const repos = () => ready(reposQuery, []).map((p) => p.name);
  const [repo, setRepo] = createSignal("");
  const [text, setText] = createSignal("");
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
      aside={
        lines().length > 0 && preview()
          ? t("web.memory.memory.preview", { n: lines().length, chars: preview()?.chars ?? 0, limit: preview()?.limit ?? 0 })
          : undefined
      }
    >
      <div {...stylex.attrs(viewStyles.recallPreviewDiv)}>
        <Select
          styles={selectStyles.scope}
          label={t("web.memory.memory.where")}
          placeholder={t("web.memory.memory.pick")}
          value={where()}
          options={repos().map((p) => ({ value: p, label: p }))}
          onChange={setRepo}
        />
        <TextInput
          aria-label={t("web.memory.memory.words")}
          placeholder={t("web.memory.memory.wordsHint")}
          value={text()}
          onInput={(e) => setText(e.currentTarget.value)}
        />
      </div>
      <Show when={lines().length > 0} fallback={<Quiet>{where() ? t("web.memory.memory.blank") : t("web.memory.memory.noRepos")}</Quiet>}>
        <p {...stylex.attrs(recipeStyles.recallPreviewP)}>{lines().join("\n")}</p>
      </Show>
    </Section>
  );
}

/** Notes belong to the profile; authorship distinguishes the owner's words. */
export function OrchestratorMemoryPanel(props: { agent: string }) {
  const viewQuery = useMemory(() => props.agent);
  const view = () => ready(viewQuery, undefined);
  const forget = createForget(() => props.agent);
  const now = useNow();
  return (
    <Show when={view()} fallback={<Quiet>{t("web.memory.memory.orchestratorReading")}</Quiet>}>
      {(v) => (
        <div {...stylex.attrs(viewStyles.memoryPanelDiv)}>
          <p {...stylex.attrs(viewStyles.memoryPanelP)}>{t("web.memory.memory.orchestratorIntro")}</p>
          <WriteNote agent={props.agent} />
          <Section title={t("web.memory.memory.notes")} count={v().memories.length} testid="notes">
            <Show when={v().memories.length > 0} fallback={<Quiet>{t("web.memory.memory.orchestratorNothing")}</Quiet>}>
              <For each={v().memories} keyed={(m) => m.id}>
                {(m) => (
                  <MemoryItem
                    memory={m()}
                    onForget={() => forget(m().id)}
                    meta={[m().author === "owner" ? t("web.memory.memory.told") : t("web.memory.memory.orchestratorOwn"), ago(m().at, now())]}
                  />
                )}
              </For>
            </Show>
          </Section>
        </div>
      )}
    </Show>
  );
}

/** An orchestrator's folded conversation, by its profile id. */
export function ArchivePanel(props: { agent: string }) {
  const [query, setQuery] = createSignal("");
  const [asked, setAsked] = createSignal<string>();
  const [open, setOpen] = createSignal<{ name: string; text: string }>();
  const listing = useQuery(() => archiveQuery({ agent: props.agent, q: asked() ?? "" }));
  const now = useNow();
  const show = async (name: string) => {
    if (open()?.name === name) return setOpen(undefined);
    let text: string;
    try {
      text = await api.orchestrator.archive.get({ agent: props.agent, name });
    } catch (e) {
      text = reasonOf(e);
    }
    setOpen({ name, text });
  };
  const data = () => ready(listing, undefined);
  const hits = () => data()?.hits ?? [];
  return (
    <div {...stylex.attrs(viewStyles.memoryPanelDiv)}>
      <p {...stylex.attrs(viewStyles.memoryPanelP)}>{t("web.memory.memory.archiveIntro")}</p>
      <form
        {...stylex.attrs(viewStyles.archivePanelForm)}
        onSubmit={(e) => {
          e.preventDefault();
          if (query().trim()) setAsked(query().trim());
        }}
      >
        <TextInput
          aria-label={t("web.memory.memory.search")}
          placeholder={t("web.memory.memory.searchHint")}
          value={query()}
          onInput={(e) => setQuery(e.currentTarget.value)}
        />
        <Button type="submit" icon="search" disabled={!query().trim()}>
          {t("web.memory.memory.find")}
        </Button>
      </form>
      <Show when={hits().length > 0}>
        <Section title={t("web.memory.memory.found")} count={hits().length}>
          <For each={hits()}>
            {(h) => (
              <div {...stylex.attrs(recipeStyles.archivePanelDiv)}>
                <span {...stylex.attrs(viewStyles.archivePanelSpan)}>
                  {h.file}:{Math.round(h.line)}
                </span>
                <span {...stylex.attrs(viewStyles.memoryPanelSpan4)}>{h.text}</span>
              </div>
            )}
          </For>
        </Section>
      </Show>
      <Section title={t("web.memory.memory.compacted")} count={data()?.files.length ?? 0} testid="archive">
        <Show when={data()?.files} fallback={<Quiet>{listing.error() ? reasonOf(listing.error()) : t("web.base.reading")}</Quiet>}>
          {(files) => (
            <Show when={files().length > 0} fallback={<Quiet>{t("web.memory.memory.noArchive")}</Quiet>}>
              <For each={files()} keyed={(f) => f.name}>
                {(f) => (
                  <div {...stylex.attrs(recipeStyles.archivePanelDiv2)}>
                    <button
                      type="button"
                      aria-expanded={aria(open()?.name === f().name)}
                      onClick={() => void show(f().name)}
                      {...stylex.attrs(viewStyles.archivePanelButton)}
                    >
                      <span {...stylex.attrs(viewStyles.archivePanelSpan2)}>{f().name}</span>
                      <span {...stylex.attrs(viewStyles.sectionSpan)}>
                        {ago(f().at, now())} · {t("web.memory.memory.chars", { n: Math.round(f().chars) })}
                      </span>
                    </button>
                    <Show when={open()?.name === f().name}>
                      <pre {...stylex.attrs(recipeStyles2.archivePanelPre)}>{open()?.text}</pre>
                    </Show>
                  </div>
                )}
              </For>
            </Show>
          )}
        </Show>
      </Section>
    </div>
  );
}

function WriteNote(props: { agent: string; withRepo?: boolean }) {
  const queries = useQueryClient();
  const [text, setText] = createSignal("");
  const [repo, setRepo] = createSignal("");
  const [error, setError] = createSignal<string>();
  const reposQuery = useRepos();
  // A refusal shows under the box, where the words are; the key stays until a note went in, so a retry is that note.
  const act = createAct(setError);
  const key = createRequestKey();
  const write = async () => {
    const agent = props.agent;
    const words = text();
    const at = props.withRepo === true ? repo().trim() || undefined : undefined;
    setError(undefined);
    const done = await act.run(async () => {
      await api.memory.create(omitUndefined({ agent, text: words, repo: at, requestKey: key.now() }));
      key.used();
      await queries.invalidate({ key: ["memory", agent] });
      return true;
    });
    if (done === true) setText("");
  };
  return (
    <div {...stylex.attrs(viewStyles.writeNoteDiv)}>
      <span {...stylex.attrs(viewStyles.writeNoteSpan)}>{t("web.memory.memory.note")}</span>
      <TextArea
        data-testid="note-input"
        aria-label={t("web.memory.memory.note")}
        rows={2}
        placeholder={props.withRepo === true ? t("web.memory.memory.noteRepo") : t("web.memory.memory.noteOrchestrator")}
        value={text()}
        onInput={(e) => setText(e.currentTarget.value)}
      />
      <div {...stylex.attrs(viewStyles.writeNoteDiv2)}>
        <Show when={props.withRepo} fallback={<span {...stylex.attrs(viewStyles.sectionSpan2)} />}>
          <TextInput
            aria-label={t("web.memory.memory.repo")}
            styles={variantStyles2.writeNoteTextInput}
            placeholder={t("web.memory.memory.repoHint")}
            list="memory-repos"
            value={repo()}
            onInput={(e) => setRepo(e.currentTarget.value)}
          />
          <datalist id="memory-repos">
            <For each={ready(reposQuery, [])}>{(p) => <option value={p.name} />}</For>
          </datalist>
        </Show>
        <Button tone="primary" data-testid="note-write" disabled={!text().trim() || act.busy()} onClick={() => void write()}>
          {t("web.base.write")}
        </Button>
      </div>
      <Show
        when={error()}
        fallback={
          <span {...stylex.attrs(viewStyles.writeNoteSpan2)}>
            {props.withRepo === true ? t("web.memory.memory.noteHintRepo") : t("web.memory.memory.noteHint")}
          </span>
        }
      >
        <span {...stylex.attrs(viewStyles.writeNoteSpan3)}>{error()}</span>
      </Show>
    </div>
  );
}

export function MemoryItem(props: { memory: Memory; onForget?: (() => void) | undefined; meta: string[]; faded?: boolean; warning?: string | undefined }) {
  return (
    <div
      data-testid="memory"
      data-key={props.memory.id}
      {...styleProps([stylex.defaultMarker(), memoryStyles.card])}
      data-faded={props.faded === true ? "" : undefined}
    >
      <div {...stylex.attrs(viewStyles.memoryItemDiv)}>
        <span {...stylex.attrs(variantStyles.memoryItemSpan, !(props.faded !== true) ? variantStyles.memoryItemSpanVariant : variantStyles.sourcesSpan)}>
          {props.memory.text}
        </span>
        <span {...stylex.attrs(viewStyles.memoryItemSpan)}>
          <For each={props.meta}>{(m) => <span>{m}</span>}</For>
          <Show when={props.warning}>
            <span {...stylex.attrs(viewStyles.memoryItemSpan2)}>{props.warning}</span>
          </Show>
        </span>
      </div>
      <Show when={props.onForget}>
        <button type="button" data-testid="forget" onClick={() => props.onForget?.()} {...styleProps(memoryStyles.forget)}>
          {t("web.memory.memory.forget")}
        </button>
      </Show>
    </div>
  );
}
