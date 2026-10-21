// Sowing an empty bed and watering a helper's: the sowing form picks the project, offers the project's seeds (its
// templates and recent words) or its queued todos, and who sows; the watering form takes a few words to the helper.

import { createMemo, createSignal, For, Match, Show, Switch } from "solid-js";
import type { JSX } from "@solidjs/web";
import { useQuery } from "@tanstack/solid-query";
import { type Issue, managerAgent, type ProjectTemplates, type Session } from "@vibevalley/protocol";
import { api, reasonOf } from "../../data/api";
import { fire } from "../commands";
import { playSound } from "../sound";
import { farm } from "../store";
import { newSendKey, writeIssue } from "../../pages/issues/write";
import { queuedIn } from "../../rules/projects";
import { aria } from "../../app/util";
import { useRouter } from "../../app/router";
import { useCore } from "../../data/frame";
import { ready, useAgents, useProjects } from "../../data/query";
import { AgentFace } from "../../ui/Face";
import { PxButton, PxSegmented, PxTextArea, PxTextInput, SpriteIcon, toasts, ToastType } from "../kit";
import { commands, useFarm } from "../state";

const xs = "text-[12px] text-bark-600";
/** Who picks the helper when the owner does not. */
const byManager = "auto";

/** The bag's seeds under the filter: the recent words, and each kind with the templates that match it or its name. */
function seedsShown(bag: ProjectTemplates | undefined, filter: string) {
  const q = filter.trim().toLowerCase();
  const shown = (title: string) => !q || title.toLowerCase().includes(q);
  return {
    recent: (bag?.recent ?? []).filter(shown),
    kinds: (bag?.kinds ?? []).flatMap((k) => {
      const templates = k.templates.filter((s) => shown(s.title) || shown(k.name));
      return templates.length ? [{ kind: k, templates }] : [];
    }),
  };
}

function Chip(props: { text: string; on: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-pressed={aria(props.on)}
      onClick={() => props.onClick()}
      class={["cursor-pointer px-3 py-1 text-[12px]", props.on ? "bg-leaf-500 text-cream-50" : "bg-cream-200 text-bark-800 hover:bg-cream-300"]}
    >
      {props.text}
    </button>
  );
}

function WhoTile(props: { active: boolean; label: string; onClick: () => void; children: JSX.Element }) {
  return (
    <button
      type="button"
      aria-pressed={aria(props.active)}
      aria-label={props.label}
      onClick={() => props.onClick()}
      class={["flex w-16 cursor-pointer flex-col items-center py-1", props.active ? "bg-leaf-300/70" : "hover:bg-cream-200"]}
    >
      {props.children}
      <span class="mt-0.5 max-w-[60px] truncate text-[12px] text-bark-800">{props.label}</span>
    </button>
  );
}

export function SowForm(props: { station: number; onDone: () => void }) {
  const projectsQuery = useProjects();
  const projects = () => ready(projectsQuery, []).map((p) => p.name);
  const lastProject = useFarm((s) => s.lastProject);
  const pick = useFarm((s) => s.pick);
  const agentsQuery = useAgents();
  const agents = () => ready(agentsQuery, []).filter((a) => a.id !== managerAgent && a.enabled);
  const core = useCore();
  const router = useRouter();
  const [chosen, setChosen] = createSignal<string>();
  const [choosing, setChoosing] = createSignal(false);
  const [pocket, setPocket] = createSignal<"seeds" | "queued">("seeds");
  const [text, setText] = createSignal("");
  const [selection, setSelection] = createSignal<readonly [number, number]>();
  const [filter, setFilter] = createSignal("");
  const [who, setWho] = createSignal<string>();
  const [refused, setRefused] = createSignal<string>();
  let words: HTMLTextAreaElement | undefined;

  // The project last sown in is trusted while the list loads, dropped once the list says it is gone.
  const project = () => {
    const last = lastProject() && (projects().length === 0 || projects().includes(lastProject()!)) ? lastProject()! : undefined;
    return choosing() ? undefined : (chosen() ?? last ?? (projects().length === 1 ? projects()[0] : undefined));
  };
  const templates = useQuery(() => ({ queryKey: ["templates", project()], queryFn: () => api.project.templates({ id: project()! }), enabled: !!project() }));
  const queued = createMemo(() => {
    const p = project();
    return p ? queuedIn(core()?.issues ?? [], p) : [];
  });
  const sower = () => who() ?? (agents().some((a) => a.id === pick()) ? pick() : byManager);
  const agentOf = (w: string) => (w === byManager ? undefined : w);
  const canSow = () => text().trim() !== "";

  const take = (t: string, blank?: { start: number; end: number }) => {
    setText(t);
    setSelection(blank ? [blank.start, blank.end] : undefined);
    words?.focus();
  };
  const sow = () => {
    const p = project();
    if (!canSow() || !p) return;
    playSound("plant");
    farm.setLastProject(p);
    fire(commands.plant(text(), { station: props.station, agent: agentOf(sower()), project: p }));
    props.onDone();
  };
  const write = async () => {
    const p = project();
    if (!canSow() || !p) return;
    try {
      const got = await writeIssue(text(), agentOf(sower()) ?? "", p);
      if (got.refused) toasts.add({ type: ToastType.info, title: "先没起草", description: got.refused });
      farm.setLastProject(p);
      props.onDone();
      router.navigate(`/issues/${encodeURIComponent(got.issue.id)}`);
    } catch (e) {
      setRefused(reasonOf(e));
    }
  };
  const start = async (i: Issue) => {
    const p = project();
    const got = await commands.startQueued(i.id, props.station);
    if (got.ok) {
      if (p) farm.setLastProject(p);
      playSound("plant");
      props.onDone();
    } else setRefused(got.text);
  };
  const bag = () => ready(templates, undefined);
  const seeds = () => seedsShown(bag(), filter());

  return (
    <Show
      when={project()}
      fallback={
        <div class="flex flex-col">
          <p class="text-[14px] text-bark-900">种在哪个项目？</p>
          <p class={["mt-1", xs]}>这块空地还不属于哪个项目：先挑一个，种子按它的样子给。</p>
          <Show when={projects().length === 0}>
            <p class={["mt-2.5", xs]}>还没有项目：先在工作台的「项目」页开一个。</p>
          </Show>
          <div class="mt-2.5 flex flex-wrap gap-1.5">
            <For each={projects()}>
              {(p) => (
                <Chip
                  text={p}
                  on={false}
                  onClick={() => {
                    setChosen(p);
                    setChoosing(false);
                  }}
                />
              )}
            </For>
          </div>
        </div>
      }
    >
      {(p) => (
        <div class="flex flex-col">
          <div class="flex items-center gap-2">
            <p class="min-w-0 flex-1 truncate text-[14px] text-bark-900">
              种在 {p()}
              <Show when={bag()?.stack.label}>
                <span class={["ml-2", xs]}>{bag()!.stack.label}</span>
              </Show>
            </p>
            <Show when={projects().length > 1}>
              <PxButton size="sm" onClick={() => setChoosing(true)}>
                换个项目
              </PxButton>
            </Show>
          </div>
          <div class="mt-2">
            <PxSegmented
              value={pocket()}
              options={[
                { value: "seeds", label: "挑种子" },
                { value: "queued", label: queued().length ? `开工待办 ${queued().length}` : "开工待办" },
              ]}
              onChange={setPocket}
            />
          </div>
          <div class="mt-3 flex flex-col">
            <Show
              when={pocket() === "queued"}
              fallback={
                <>
                  <PxTextInput value={filter()} onChange={setFilter} placeholder="筛一筛：bug、测试、依赖……" label="筛种子" />
                  <Switch>
                    <Match when={templates.isPending && !!project()}>
                      <p class={["mt-2.5", xs]}>在翻种子袋……</p>
                    </Match>
                    <Match when={templates.error}>{(e) => <p class="mt-2.5 text-[12px] text-berry">种子袋没拿到：{reasonOf(e())}</p>}</Match>
                  </Switch>
                  <Show when={seeds().recent.length > 0}>
                    <p class={["mt-2.5", xs]}>最近</p>
                    <div class="mt-1.5 flex flex-wrap gap-1.5">
                      <For each={seeds().recent}>{(r) => <Chip text={r} on={text() === r} onClick={() => take(r)} />}</For>
                    </div>
                  </Show>
                  <Show when={seeds().kinds.length > 0}>
                    <p class={["mt-2.5", xs]}>常见的活</p>
                    <div class="mt-1.5 flex flex-col gap-2">
                      <For each={seeds().kinds} keyed={(k) => k.kind.id}>
                        {(k) => (
                          <div class="flex items-start gap-2">
                            <span class="flex w-20 shrink-0 items-center gap-1">
                              <SpriteIcon name={k().kind.icon} size={28} />
                              <span class="text-[12px] text-bark-800">{k().kind.name}</span>
                            </span>
                            <div class="flex flex-wrap gap-1.5">
                              <For each={k().templates} keyed={(s) => s.id}>
                                {(s) => <Chip text={s().title} on={text() === s().text} onClick={() => take(s().text, s().blank)} />}
                              </For>
                            </div>
                          </div>
                        )}
                      </For>
                    </div>
                  </Show>
                  <Show when={bag() && filter().trim() && seeds().recent.length === 0 && seeds().kinds.length === 0}>
                    <p class={["mt-2.5", xs]}>没有对得上的种子：在下面自己写。</p>
                  </Show>
                  <p class={["mt-2.5", xs]}>自己写</p>
                  <div class="mt-1.5">
                    <PxTextArea
                      ref={(el) => (words = el)}
                      value={text()}
                      selection={selection()}
                      onChange={setText}
                      rows={3}
                      placeholder="要做什么，做到什么程度算完"
                      label="工单"
                    />
                  </div>
                  <p class={["mt-3", xs]}>谁来种</p>
                  <div class="mt-1.5 flex flex-wrap gap-1" role="group" aria-label="谁来种">
                    <WhoTile active={sower() === byManager} label="管家挑" onClick={() => setWho(byManager)}>
                      <span class="flex h-11 w-11 items-center justify-center bg-cream-200 text-[16px] text-bark-600">?</span>
                    </WhoTile>
                    <For each={agents()} keyed={(a) => a.id}>
                      {(a) => (
                        <WhoTile active={sower() === a().id} label={a().name} onClick={() => setWho(a().id)}>
                          <AgentFace agentId={a().id} look={a().look} size={44} />
                        </WhoTile>
                      )}
                    </For>
                  </div>
                  <div class="mt-3 flex items-center gap-2">
                    <p class={["min-w-0 flex-1", xs]}>
                      管家会把这句话交给帮工，派在 {p()} 里；没开工的话会先开工。先起草：帮工读过代码写成工单，你看过再开工。
                    </p>
                    <PxButton disabled={!canSow()} onClick={() => void write()}>
                      先起草
                    </PxButton>
                    <PxButton tone="primary" disabled={!canSow()} onClick={sow}>
                      播种
                    </PxButton>
                  </div>
                </>
              }
            >
              <Show when={queued().length > 0} fallback={<p class={xs}>这个项目没有排着队的待办。院门外的种子袋就是它们。</p>}>
                <p class={xs}>排着队等空地的待办，按排上的先后；开工的是这张工单本身，不另写一张。</p>
                <div class="mt-2 flex flex-col gap-1.5">
                  <For each={queued()}>
                    {(i) => (
                      <div class="flex items-center gap-2">
                        <SpriteIcon name="icon-seeds" size={20} />
                        <span class="min-w-0 flex-1 truncate text-[13px] text-bark-800">
                          #{Math.round(i.number)} {i.title}
                        </span>
                        <PxButton size="sm" tone="primary" onClick={() => void start(i)}>
                          开工
                        </PxButton>
                      </div>
                    )}
                  </For>
                </div>
              </Show>
            </Show>
            <Show when={refused()}>
              <p class="mt-1.5 text-[12px] text-berry">{refused()}</p>
            </Show>
          </div>
        </div>
      )}
    </Show>
  );
}

const dropsOfAdvice = ["改动小一点", "先别动测试", "做完跟我说一声", "顺便补个测试"];

export function WaterForm(props: { session: Session; onDone: () => void }) {
  const [text, setText] = createSignal("");
  const sendKey = newSendKey();
  const [refused, setRefused] = createSignal<string>();
  const water = async () => {
    if (!text().trim()) return;
    try {
      await commands.water(props.session, text(), sendKey);
      props.onDone();
    } catch (e) {
      setRefused(reasonOf(e));
    }
  };
  return (
    <div class="flex flex-col">
      <p class="text-[13px] text-bark-800">
        {props.session.phase._tag === "working" ? "它正在干活，这句话会在下一步之前收到。" : "它现在没在干活，这句话会让它接着干一轮。"}
      </p>
      <p class={["mt-1", xs]}>这句话记在它的工单串里，它回的话也在那儿。</p>
      <p class={["mt-1", xs]}>现在的活：{props.session.brief}</p>
      <div class="mt-3 flex flex-wrap gap-1.5">
        <For each={dropsOfAdvice}>{(s) => <Chip text={s} on={text() === s} onClick={() => setText(s)} />}</For>
      </div>
      <div class="mt-3 flex items-end gap-2">
        <div class="flex-1">
          <PxTextArea value={text()} onChange={setText} rows={2} placeholder="带句话……" label={`给${props.session.name}带句话`} autoFocus />
        </div>
        <PxButton tone="primary" disabled={!text().trim()} onClick={() => void water()}>
          浇水
        </PxButton>
      </div>
      <Show when={refused()}>
        <p class="mt-1.5 text-[12px] text-berry">{refused()}</p>
      </Show>
    </div>
  );
}
