// What an agent remembers: a profile's shared memory, the orchestrator's memory, and the orchestrator's archive of conversations
// folded away.

import { pagesWording } from "../base/words/pages";
import { createSignal, For, Show } from "solid-js";
import type { JSX } from "@solidjs/web";

import { type Memory, type MemorySourceInfo, orchestratorAgent, memoryKeep } from "@vibevalley/protocol";
import { api, reasonOf } from "../base/api";
import { ago } from "../base/format";
import { toast } from "../ui/toasts";
import { aria, useNow } from "../base/util";
import { useCore } from "../base/frame";
import { queries, ready, useProjects, useQuery } from "../base/query";
import { Button } from "../ui/Button";
import { Select, TextArea, TextInput } from "../ui/Field";
import { Quiet } from "../ui/layout";

/** Notes not tied to a project. */
const everywhere = "*";

const item = "rounded-md border border-line bg-page";

const useMemory = (agent: () => string) => useQuery(() => ({ queryKey: ["memory", agent()], queryFn: () => api.memory.list({ agent: agent() }) }));

function memoryActions(agent: string) {
  const reload = () => queries.invalidateQueries({ queryKey: ["memory", agent] });
  return {
    /** The refusal in words, or undefined once written. */
    write: async (text: string, project?: string) => {
      try {
        await api.memory.create({ agent, body: { text, ...(project ? { project } : {}) } });
        await reload();
        return undefined;
      } catch (e) {
        return reasonOf(e);
      }
    },
    forget: async (id: string) => {
      try {
        await api.memory.delete({ agent, memory: id });
        await reload();
      } catch (e) {
        toast(reasonOf(e));
      }
    },
  };
}

/** A titled part of a panel, its count beside the title. */
export function Section(props: { title: string; count?: number; aside?: JSX.Element; children: JSX.Element }) {
  return (
    <section aria-label={props.title} class="flex flex-col gap-2">
      <header class="flex items-center gap-2">
        <h3 class="text-sm font-semibold">{props.title}</h3>
        <Show when={props.count !== undefined}>
          <span class="text-xs text-muted">{props.count}</span>
        </Show>
        <span class="flex-1" />
        <Show when={props.aside}>
          <span class="text-xs text-muted">{props.aside}</span>
        </Show>
      </header>
      {props.children}
    </section>
  );
}

function Pill(props: { label: string; on: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-pressed={aria(props.on)}
      onClick={() => props.onClick()}
      class={["h-6 cursor-pointer rounded-full px-2.5 text-xs", props.on ? "bg-ink text-page" : "bg-hover hover:bg-selected"]}
    >
      {props.label}
    </button>
  );
}

export function MemoryPanel(props: { agent: string }) {
  const [shown, setShown] = createSignal("");
  const viewQuery = useMemory(() => props.agent);
  const view = () => ready(viewQuery, undefined);
  const act = () => memoryActions(props.agent);
  const core = useCore();
  const now = useNow();
  const sessions = () => new Map((core()?.sessions ?? []).map((h) => [h.id, h.name]));
  const all = () => view()?.memories ?? [];
  const sources = () => new Map((view()?.sources ?? []).map((s) => [s.name, s]));
  const notes = () => all().filter((m) => m.kind === "note");
  const jobs = () => all().filter((m) => m.kind === "issue");
  const projects = () => [...new Set(all().flatMap((m) => (m.project ? [m.project] : [])))].sort();
  const filtered = () => notes().filter((m) => shown() === "" || (shown() === everywhere ? m.project === undefined : m.project === shown()));
  const whose = (m: Memory) =>
    m.author === "owner"
      ? pagesWording().memory.yours
      : m.author === "orchestrator"
        ? pagesWording().memory.orchestrators
        : m.session
          ? pagesWording().memory.sessions(sessions().get(m.session) ?? m.session)
          : pagesWording().memory.own;
  return (
    <div class="flex flex-col gap-4">
      <p class="text-sm text-muted">{pagesWording().memory.intro}</p>
      <Show when={sources().size > 1}>
        <Sources sources={[...sources().values()]} />
      </Show>
      <Section title={pagesWording().memory.jobs} count={jobs().length}>
        <Show when={jobs().length > 0} fallback={<Quiet>{pagesWording().memory.noJobs}</Quiet>}>
          <For each={jobs()} keyed={(m) => m.id}>
            {(m) => (
              <div class={[item, "flex overflow-hidden"]}>
                <span class="w-[3px] shrink-0 bg-leaf" />
                <div class="flex flex-col gap-0.5 px-3 py-2">
                  <span class="flex flex-wrap gap-2 text-xs text-muted">
                    <span class="font-medium text-ink">{m().session ? (sessions().get(m().session!) ?? m().session) : pagesWording().memory.helper}</span>
                    <span>{m().project ?? pagesWording().memory.allProjects}</span>
                    <span>{ago(m().at, now())}</span>
                  </span>
                  <span class="text-sm">{m().text}</span>
                </div>
              </div>
            )}
          </For>
        </Show>
      </Section>
      <RecallPreview agent={props.agent} />
      <WriteNote onWrite={(text, project) => act().write(text, project)} withProject />
      <Section title={pagesWording().memory.notes} count={notes().length}>
        <Show when={projects().length > 0}>
          <div class="flex flex-wrap gap-1">
            <For
              each={[
                ["", pagesWording().memory.all] as const,
                [everywhere, pagesWording().memory.allProjects] as const,
                ...projects().map((p) => [p, p] as const),
              ]}
            >
              {([value, label]) => <Pill label={label} on={shown() === value} onClick={() => setShown(value)} />}
            </For>
          </div>
        </Show>
        <Show when={filtered().length > 0} fallback={<Quiet>{notes().length > 0 ? pagesWording().memory.emptyHere : pagesWording().memory.nothing}</Quiet>}>
          <For each={filtered()} keyed={(m) => m.id}>
            {(m) => {
              const src = () => (m().source ? sources().get(m().source!) : undefined);
              return (
                <Show
                  when={src()}
                  fallback={
                    <MemoryItem
                      memory={m()}
                      faded={m().fading === true}
                      onForget={() => void act().forget(m().id)}
                      meta={[
                        m().project ?? pagesWording().memory.allProjects,
                        whose(m()),
                        ago(m().at, now()),
                        m().recalled > 0
                          ? pagesWording().memory.recalled(Math.round(m().recalled), m().recalledAt ? ago(m().recalledAt!, now()) : undefined)
                          : pagesWording().memory.neverRecalled,
                      ]}
                      warning={m().fading ? pagesWording().memory.fading(memoryKeep) : undefined}
                    />
                  }
                >
                  {(s) => (
                    <MemoryItem
                      memory={m()}
                      onForget={s().canForget ? () => void act().forget(m().id) : undefined}
                      meta={[pagesWording().memory.inSource(s().label), ...(s().canForget ? [] : [pagesWording().memory.forgetThere(s().label)])]}
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
    <Section title={pagesWording().memory.sources} count={props.sources.filter((s) => s.on).length}>
      <For each={props.sources}>
        {(s) => (
          <div class={[item, "flex flex-wrap items-center gap-x-2 gap-y-0.5 px-3 py-2 text-xs text-muted"]}>
            <span class="text-sm font-medium text-ink">{s.label}</span>
            <span class={s.on ? "text-accent" : "text-berry"}>{s.on ? pagesWording().memory.on : pagesWording().memory.off(s.off ?? "")}</span>
            <Show when={s.on}>
              <span>{s.canList ? pagesWording().memory.listed : pagesWording().memory.unlisted}</span>
              <span>{s.canForget ? pagesWording().memory.forgettable : pagesWording().memory.forgetElsewhere}</span>
              <Show when={s.transcripts}>
                <span>{pagesWording().memory.transcripts}</span>
              </Show>
            </Show>
          </div>
        )}
      </For>
      <p class="text-xs text-muted">{pagesWording().memory.sourcesNote}</p>
    </Section>
  );
}

/** The pick the server would make, without counting it (memory.recall). */
function RecallPreview(props: { agent: string }) {
  const projectsQuery = useProjects();
  const projects = () => ready(projectsQuery, []).map((p) => p.name);
  const [project, setProject] = createSignal("");
  const [text, setText] = createSignal("");
  const where = () => project() || projects()[0] || "";
  const memory = useMemory(() => props.agent);
  const previewQuery = useQuery(() => ({
    queryKey: ["recall", props.agent, where(), text(), memory.dataUpdatedAt],
    queryFn: () => api.memory.recall({ agent: props.agent, project: where(), text: text() }),
    enabled: where() !== "",
  }));
  const preview = () => ready(previewQuery, undefined);
  const lines = () => preview()?.lines ?? [];
  return (
    <Section
      title={pagesWording().memory.next}
      aside={lines().length > 0 && preview() ? pagesWording().memory.preview(lines().length, preview()!.chars, preview()!.limit) : undefined}
    >
      <div class="flex flex-col gap-1.5 sm:flex-row">
        <Select
          class="sm:w-40"
          label={pagesWording().memory.where}
          placeholder={pagesWording().memory.pick}
          value={where()}
          options={projects().map((p) => ({ value: p, label: p }))}
          onChange={setProject}
        />
        <TextInput
          aria-label={pagesWording().memory.words}
          placeholder={pagesWording().memory.wordsHint}
          value={text()}
          onInput={(e) => setText(e.currentTarget.value)}
        />
      </div>
      <Show when={lines().length > 0} fallback={<Quiet>{where() ? pagesWording().memory.blank : pagesWording().memory.noProjects}</Quiet>}>
        <p class={[item, "px-3 py-2 text-sm whitespace-pre-wrap"]}>{lines().join("\n")}</p>
      </Show>
    </Section>
  );
}

export function OrchestratorMemoryPanel() {
  const viewQuery = useMemory(() => orchestratorAgent);
  const view = () => ready(viewQuery, undefined);
  const act = memoryActions(orchestratorAgent);
  const now = useNow();
  return (
    <Show when={view()} fallback={<Quiet>{pagesWording().memory.orchestratorReading}</Quiet>}>
      {(v) => {
        const carried = () => v().carried ?? v().memories.length;
        return (
          <div class="flex flex-col gap-4">
            <p class="text-sm text-muted">{pagesWording().memory.orchestratorIntro}</p>
            <WriteNote onWrite={(text) => act.write(text)} />
            <Section title={pagesWording().memory.notes} count={v().memories.length}>
              <Show when={v().memories.length > 0} fallback={<Quiet>{pagesWording().memory.orchestratorNothing}</Quiet>}>
                <For each={v().memories} keyed={(m) => m.id}>
                  {(m, i) => (
                    <MemoryItem
                      memory={m()}
                      faded={i() >= carried()}
                      onForget={() => void act.forget(m().id)}
                      meta={[m().session === orchestratorAgent ? pagesWording().memory.orchestratorOwn : pagesWording().memory.told, ago(m().at, now())]}
                      warning={i() >= carried() ? pagesWording().memory.tooOld : undefined}
                    />
                  )}
                </For>
              </Show>
            </Section>
          </div>
        );
      }}
    </Show>
  );
}

export function ArchivePanel() {
  const [query, setQuery] = createSignal("");
  const [asked, setAsked] = createSignal<string>();
  const [open, setOpen] = createSignal<{ name: string; text: string }>();
  const listing = useQuery(() => ({
    queryKey: ["archive", asked() ?? ""],
    queryFn: () => api.orchestrator.listArchive(asked() ? { q: asked() } : {}),
  }));
  const now = useNow();
  const show = async (name: string) => {
    if (open()?.name === name) return setOpen(undefined);
    let text: string;
    try {
      text = await api.orchestrator.getArchive({ name });
    } catch (e) {
      text = reasonOf(e);
    }
    setOpen({ name, text });
  };
  const data = () => ready(listing, undefined);
  const hits = () => data()?.hits ?? [];
  return (
    <div class="flex flex-col gap-4">
      <p class="text-sm text-muted">{pagesWording().memory.archiveIntro}</p>
      <form
        class="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (query().trim()) setAsked(query().trim());
        }}
      >
        <TextInput
          aria-label={pagesWording().memory.search}
          placeholder={pagesWording().memory.searchHint}
          value={query()}
          onInput={(e) => setQuery(e.currentTarget.value)}
        />
        <Button type="submit" icon="button-search" disabled={!query().trim()}>
          {pagesWording().memory.find}
        </Button>
      </form>
      <Show when={hits().length > 0}>
        <Section title={pagesWording().memory.found} count={hits().length}>
          <For each={hits()}>
            {(h) => (
              <div class={[item, "flex flex-col gap-0.5 px-3 py-2"]}>
                <span class="font-mono text-xs text-muted">
                  {h.file}:{Math.round(h.line)}
                </span>
                <span class="text-sm">{h.text}</span>
              </div>
            )}
          </For>
        </Section>
      </Show>
      <Section title={pagesWording().memory.compacted} count={data()?.files.length ?? 0}>
        <Show when={data()?.files} fallback={<Quiet>{listing.error ? reasonOf(listing.error) : pagesWording().reading}</Quiet>}>
          {(files) => (
            <Show when={files().length > 0} fallback={<Quiet>{pagesWording().memory.noArchive}</Quiet>}>
              <For each={files()} keyed={(f) => f.name}>
                {(f) => (
                  <div class={[item, "overflow-hidden"]}>
                    <button
                      type="button"
                      aria-expanded={aria(open()?.name === f().name)}
                      onClick={() => void show(f().name)}
                      class="flex w-full cursor-pointer items-center gap-2 px-3 py-2 text-left hover:bg-hover"
                    >
                      <span class="min-w-0 flex-1 truncate font-mono text-sm">{f().name}</span>
                      <span class="text-xs text-muted">
                        {ago(f().at, now())} · {pagesWording().memory.chars(Math.round(f().chars))}
                      </span>
                    </button>
                    <Show when={open()?.name === f().name}>
                      <pre class="max-h-96 overflow-y-auto border-t border-line px-3 py-2 text-sm whitespace-pre-wrap select-text">{open()!.text}</pre>
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

function WriteNote(props: { onWrite: (text: string, project?: string) => Promise<string | undefined>; withProject?: boolean }) {
  const [text, setText] = createSignal("");
  const [project, setProject] = createSignal("");
  const [error, setError] = createSignal<string>();
  const projectsQuery = useProjects();
  const write = async () => {
    const refused = await props.onWrite(text(), project().trim() || undefined);
    setError(refused);
    if (!refused) setText("");
  };
  return (
    <div class="flex flex-col gap-1">
      <span class="text-xs font-medium text-muted">{pagesWording().memory.note}</span>
      <TextArea
        aria-label={pagesWording().memory.note}
        rows={2}
        placeholder={props.withProject ? pagesWording().memory.noteProject : pagesWording().memory.noteOrchestrator}
        value={text()}
        onInput={(e) => setText(e.currentTarget.value)}
      />
      <div class="flex items-center gap-2 pt-1">
        <Show when={props.withProject} fallback={<span class="flex-1" />}>
          <TextInput
            aria-label={pagesWording().memory.project}
            class="font-mono"
            placeholder={pagesWording().memory.projectHint}
            list="memory-projects"
            value={project()}
            onInput={(e) => setProject(e.currentTarget.value)}
          />
          <datalist id="memory-projects">
            <For each={ready(projectsQuery, [])}>{(p) => <option value={p.name} />}</For>
          </datalist>
        </Show>
        <Button tone="primary" disabled={!text().trim()} onClick={() => void write()}>
          {pagesWording().write}
        </Button>
      </div>
      <Show
        when={error()}
        fallback={<span class="text-xs text-faint">{props.withProject ? pagesWording().memory.noteHintProject : pagesWording().memory.noteHint}</span>}
      >
        <span class="text-xs text-berry">{error()}</span>
      </Show>
    </div>
  );
}

function MemoryItem(props: { memory: Memory; onForget?: () => void; meta: string[]; faded?: boolean; warning?: string }) {
  return (
    <div class={[item, "group flex items-start gap-2 px-3 py-2", { "opacity-60": !!props.faded }]}>
      <div class="flex min-w-0 flex-1 flex-col gap-0.5">
        <span class="text-sm">{props.memory.text}</span>
        <span class="flex flex-wrap gap-x-2 text-xs text-muted">
          <For each={props.meta}>{(m) => <span>{m}</span>}</For>
          <Show when={props.warning}>
            <span class="text-[#b8682a]">{props.warning}</span>
          </Show>
        </span>
      </div>
      <Show when={props.onForget}>
        <button
          type="button"
          onClick={() => props.onForget?.()}
          class="shrink-0 cursor-pointer rounded-md px-2 py-0.5 text-xs text-muted opacity-0 group-hover:opacity-100 hover:bg-hover hover:text-berry focus-visible:opacity-100"
        >
          {pagesWording().memory.forget}
        </button>
      </Show>
    </div>
  );
}
