// What an agent remembers: a profile's shared memory, the manager's memory, and the manager's archive of conversations
// folded away.

import { createSignal, For, Show } from "solid-js";
import type { JSX } from "@solidjs/web";

import { type Memory, type MemorySourceInfo, managerAgent, memoryKeep } from "@vibevalley/protocol";
import { api, reasonOf } from "../data/api";
import { ago } from "../rules/time";
import { toast } from "../ui/toasts";
import { aria, useNow } from "../app/util";
import { useCore } from "../data/frame";
import { queries, ready, useProjects, useQuery } from "../data/query";
import { Button } from "../ui/Button";
import { Select, TextArea, TextInput } from "../ui/Field";
import { Quiet } from "./kit";

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
    m.author === "owner" ? "你记的" : m.author === "manager" ? "管家替它记的" : m.session ? `${sessions().get(m.session) ?? m.session} 记的` : "它自己记的";
  return (
    <div class="flex flex-col gap-4">
      <p class="text-sm text-muted">
        这个 agent
        派出去的帮工共用一份记性。每一轮开始，和这一轮有关的几条放在它收到的话前面；一轮结束，它在汇报里写的「记住：」那几行，和这件活做到哪了，记进来。
      </p>
      <Show when={sources().size > 1}>
        <Sources sources={[...sources().values()]} />
      </Show>
      <Section title="手上的活" count={jobs().length}>
        <Show when={jobs().length > 0} fallback={<Quiet>它的帮工还没做完过一轮。</Quiet>}>
          <For each={jobs()} keyed={(m) => m.id}>
            {(m) => (
              <div class={[item, "flex overflow-hidden"]}>
                <span class="w-[3px] shrink-0 bg-leaf" />
                <div class="flex flex-col gap-0.5 px-3 py-2">
                  <span class="flex flex-wrap gap-2 text-xs text-muted">
                    <span class="font-medium text-ink">{m().session ? (sessions().get(m().session!) ?? m().session) : "帮工"}</span>
                    <span>{m().project ?? "所有项目"}</span>
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
      <Section title="记下的" count={notes().length}>
        <Show when={projects().length > 0}>
          <div class="flex flex-wrap gap-1">
            <For each={[["", "全部"] as const, [everywhere, "所有项目"] as const, ...projects().map((p) => [p, p] as const)]}>
              {([value, label]) => <Pill label={label} on={shown() === value} onClick={() => setShown(value)} />}
            </For>
          </div>
        </Show>
        <Show
          when={filtered().length > 0}
          fallback={<Quiet>{notes().length > 0 ? "这一栏没有。" : "还没记下什么。帮工在汇报里写「记住：」，或者你在上面替它记。"}</Quiet>}
        >
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
                        m().project ?? "所有项目",
                        whose(m()),
                        ago(m().at, now()),
                        m().recalled > 0
                          ? `想起过 ${Math.round(m().recalled)} 次${m().recalledAt ? `，上次 ${ago(m().recalledAt!, now())}` : ""}`
                          : "还没想起过",
                      ]}
                      warning={m().fading ? `快忘了：记满 ${memoryKeep} 条时最先丢` : undefined}
                    />
                  }
                >
                  {(s) => (
                    <MemoryItem
                      memory={m()}
                      onForget={s().canForget ? () => void act().forget(m().id) : undefined}
                      meta={[`在 ${s().label} 里`, ...(s().canForget ? [] : [`要删到 ${s().label} 里删`])]}
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
    <Section title="记性从哪来" count={props.sources.filter((s) => s.on).length}>
      <For each={props.sources}>
        {(s) => (
          <div class={[item, "flex flex-wrap items-center gap-x-2 gap-y-0.5 px-3 py-2 text-xs text-muted"]}>
            <span class="text-sm font-medium text-ink">{s.label}</span>
            <span class={s.on ? "text-accent" : "text-berry"}>{s.on ? "在用" : `没接上：${s.off ?? ""}`}</span>
            <Show when={s.on}>
              <span>{s.canList ? "记下的列在下面" : "不在这里列出"}</span>
              <span>{s.canForget ? "能在这里忘掉" : "要删到它那里删"}</span>
              <Show when={s.transcripts}>
                <span>收整段干活的对话</span>
              </Show>
            </Show>
          </div>
        )}
      </For>
      <p class="text-xs text-muted">在开头的「设置」里接上、关掉，或改读写。</p>
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
    <Section title="下回开工会想起" aside={lines().length > 0 && preview() ? `${lines().length} 条 · ${preview()!.chars} / ${preview()!.limit} 字` : undefined}>
      <div class="flex flex-col gap-1.5 sm:flex-row">
        <Select
          class="sm:w-40"
          label="在哪个项目开工"
          placeholder="选项目"
          value={where()}
          options={projects().map((p) => ({ value: p, label: p }))}
          onChange={setProject}
        />
        <TextInput aria-label="这一轮的话" placeholder="这一轮的话（可以不填）" value={text()} onInput={(e) => setText(e.currentTarget.value)} />
      </div>
      <Show when={lines().length > 0} fallback={<Quiet>{where() ? "在这个项目里开工，什么也想不起来。" : "还没有项目。"}</Quiet>}>
        <p class={[item, "px-3 py-2 text-sm whitespace-pre-wrap"]}>{lines().join("\n")}</p>
      </Show>
    </Section>
  );
}

export function ManagerMemoryPanel() {
  const viewQuery = useMemory(() => managerAgent);
  const view = () => ready(viewQuery, undefined);
  const act = memoryActions(managerAgent);
  const now = useNow();
  return (
    <Show when={view()} fallback={<Quiet>在读管家的记性……</Quiet>}>
      {(v) => {
        const carried = () => v().carried ?? v().memories.length;
        return (
          <div class="flex flex-col gap-4">
            <p class="text-sm text-muted">管家开工时和每次压缩后读一遍记性；中间记下、忘掉的，它下一句就知道。</p>
            <WriteNote onWrite={(text) => act.write(text)} />
            <Section title="记下的" count={v().memories.length}>
              <Show when={v().memories.length > 0} fallback={<Quiet>还没记下什么。跟管家说「记住……」，或者你在上面替它记。</Quiet>}>
                <For each={v().memories} keyed={(m) => m.id}>
                  {(m, i) => (
                    <MemoryItem
                      memory={m()}
                      faded={i() >= carried()}
                      onForget={() => void act.forget(m().id)}
                      meta={[m().session === managerAgent ? "管家自己记的" : "你交代的", ago(m().at, now())]}
                      warning={i() >= carried() ? "太旧了，带不进系统提示" : undefined}
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
    queryFn: () => api.manager.listArchive(asked() ? { q: asked() } : {}),
  }));
  const now = useNow();
  const show = async (name: string) => {
    if (open()?.name === name) return setOpen(undefined);
    let text: string;
    try {
      text = await api.manager.getArchive({ name });
    } catch (e) {
      text = reasonOf(e);
    }
    setOpen({ name, text });
  };
  const data = () => ready(listing, undefined);
  const hits = () => data()?.hits ?? [];
  return (
    <div class="flex flex-col gap-4">
      <p class="text-sm text-muted">
        对话太长时，管家把前面的部分压成一段摘要，原文一字不改地存在这里。摘要里缺了细节，它自己会用 search_archive 来翻；你也可以在这里翻。
      </p>
      <form
        class="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (query().trim()) setAsked(query().trim());
        }}
      >
        <TextInput aria-label="在旧账里搜" placeholder="搜一个词" value={query()} onInput={(e) => setQuery(e.currentTarget.value)} />
        <Button type="submit" icon="button-search" disabled={!query().trim()}>
          搜
        </Button>
      </form>
      <Show when={hits().length > 0}>
        <Section title="搜到的" count={hits().length}>
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
      <Section title="压掉的对话" count={data()?.files.length ?? 0}>
        <Show when={data()?.files} fallback={<Quiet>{listing.error ? reasonOf(listing.error) : "在读……"}</Quiet>}>
          {(files) => (
            <Show when={files().length > 0} fallback={<Quiet>还没有：管家的对话还没长到要压缩。</Quiet>}>
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
                        {ago(f().at, now())} · {Math.round(f().chars)} 字
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
      <span class="text-xs font-medium text-muted">替它记一条</span>
      <TextArea
        aria-label="替它记一条"
        rows={2}
        placeholder={props.withProject ? "比如：clock-in 的测试用 pnpm test，别用 npm" : "比如：提交信息写中文；周末别派夜班"}
        value={text()}
        onInput={(e) => setText(e.currentTarget.value)}
      />
      <div class="flex items-center gap-2 pt-1">
        <Show when={props.withProject} fallback={<span class="flex-1" />}>
          <TextInput
            aria-label="项目"
            class="font-mono"
            placeholder="项目（可以不填）"
            list="memory-projects"
            value={project()}
            onInput={(e) => setProject(e.currentTarget.value)}
          />
          <datalist id="memory-projects">
            <For each={ready(projectsQuery, [])}>{(p) => <option value={p.name} />}</For>
          </datalist>
        </Show>
        <Button tone="primary" disabled={!text().trim()} onClick={() => void write()}>
          记下
        </Button>
      </div>
      <Show
        when={error()}
        fallback={
          <span class="text-xs text-faint">
            {props.withProject ? "写成下次一看就懂的一句话。项目留空就是所有项目都用得上。" : "写成下次一看就懂的一句话。"}
          </span>
        }
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
          忘掉
        </button>
      </Show>
    </div>
  );
}
