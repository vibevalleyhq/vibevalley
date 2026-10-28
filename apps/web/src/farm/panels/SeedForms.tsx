import { t } from "@vibevalley/i18n";
// Sowing an empty bed and watering a helper's: the sowing form sows in the farm's current project (the sign by the
// mast), offers its seeds (its templates and recent words) and who sows; the watering form takes a
// few words to the helper.

import { createSignal, For, Match, Show, Switch } from "solid-js";
import type { JSX } from "@solidjs/web";

import { type ProjectTemplates, type Session } from "@vibevalley/protocol";
import { api, reasonOf } from "../../base/api";
import { fire } from "../commands";
import { playSound } from "../../ui/pixel/sound";
import { newSendKey } from "../../base/api";
import { writeIssue } from "../../features/issue";
import { aria } from "../../base/util";
import { useRouter } from "../../base/router";
import { ready, useProjects, useQuery } from "../../base/query";
import { AgentFace } from "../../ui/Face";
import { PxButton, PxTextArea, SpriteIcon, toasts, ToastType } from "../../ui/pixel";
import { commands, useFarm } from "../state";
import { useWorkAgents } from "../../base/agents";
import { useCore } from "../../base/frame";
import { issueOf } from "../world/plots";
import { usePrefs } from "../../base/prefs";

const xs = "text-[12px] text-bark-600";
/** Who picks the helper when the owner does not. */
const byOrchestrator = "auto";

/** The bag's seeds: the recent words, and each kind that has templates, with them. */
function seedsOf(bag: ProjectTemplates | undefined) {
  return {
    recent: bag?.recent ?? [],
    kinds: (bag?.kinds ?? []).flatMap((k) => (k.templates.length ? [{ kind: k, templates: k.templates }] : [])),
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
  // Every plot here is sown in this farm's project.
  const farmProject = useFarm((s) => s.project);
  const project = () => farmProject() || undefined;
  const pick = usePrefs((p) => p.pick);
  const agents = useWorkAgents(true);
  const router = useRouter();
  const [text, setText] = createSignal("");
  const [selection, setSelection] = createSignal<readonly [number, number]>();
  const [who, setWho] = createSignal<string>();
  const [refused, setRefused] = createSignal<string>();
  let words: HTMLTextAreaElement | undefined;

  const templates = useQuery(() => ({
    queryKey: ["templates", project()],
    queryFn: () => api.project.template.list({ id: project()! }),
    enabled: !!project(),
  }));
  const sower = () => who() ?? (agents().some((a) => a.id === pick()) ? pick() : byOrchestrator);
  const agentOf = (w: string) => (w === byOrchestrator ? undefined : w);
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
    fire(commands.plant(text(), { station: props.station, agent: agentOf(sower()), project: p }));
    props.onDone();
  };
  const write = async () => {
    const p = project();
    if (!canSow() || !p) return;
    try {
      const got = await writeIssue(text(), agentOf(sower()) ?? "", p);
      if (got.refused) toasts.add({ type: ToastType.info, title: t("web.farm.sow.notDrafted"), description: got.refused });
      props.onDone();
      router.navigate(`/issues/${encodeURIComponent(got.issue.id)}`);
    } catch (e) {
      setRefused(reasonOf(e));
    }
  };
  const bag = () => ready(templates, undefined);
  const seeds = () => seedsOf(bag());
  const [kindId, setKindId] = createSignal<string>();
  // The kind picked, else the first.
  const kind = () => seeds().kinds.find((k) => k.kind.id === kindId()) ?? seeds().kinds[0];

  return (
    <Show
      when={project()}
      fallback={
        <div class="flex flex-col items-start gap-2.5">
          <p class="text-[14px] text-bark-900">{t("web.farm.sow.homeless")}</p>
          <p class={xs}>{projects().length > 0 ? t("web.farm.sow.toMap") : t("web.farm.sow.noProjects")}</p>
          <PxButton tone="primary" onClick={() => (props.onDone(), router.navigate("/projects"))}>
            {projects().length > 0 ? t("web.farm.sow.map") : t("web.farm.sow.makeProject")}
          </PxButton>
        </div>
      }
    >
      {(p) => (
        <div class="flex flex-col">
          <div class="flex items-center gap-2">
            <p class="min-w-0 flex-1 truncate text-[14px] text-bark-900">
              {t("web.farm.sow.plantIn", { project: p() })}
              <Show when={bag()?.stack.label}>
                <span class={["ml-2", xs]}>{bag()!.stack.label}</span>
              </Show>
            </p>
          </div>
          <div class="mt-3 flex flex-col">
            <Switch>
              <Match when={templates.isPending && !!project()}>
                <p class={["mt-2.5", xs]}>{t("web.farm.sow.rummaging")}</p>
              </Match>
              <Match when={templates.error}>
                {(e) => (
                  <div class="mt-2.5 flex flex-wrap items-center gap-2">
                    <p role="alert" class="text-[12px] text-berry">
                      {t("web.farm.sow.noSeeds")}
                      {reasonOf(e())}
                    </p>
                    <PxButton size="sm" data-testid="seeds-retry" disabled={templates.isFetching} onClick={() => void templates.refetch()}>
                      {t("web.farm.sow.retry")}
                    </PxButton>
                  </div>
                )}
              </Match>
            </Switch>
            <Show when={seeds().recent.length > 0}>
              <p class={["mt-2.5", xs]}>{t("web.farm.sow.recent")}</p>
              <div class="mt-1.5 flex flex-wrap gap-1.5">
                <For each={seeds().recent}>{(r) => <Chip text={r} on={text() === r} onClick={() => take(r)} />}</For>
              </div>
            </Show>
            <Show when={seeds().kinds.length > 0}>
              <p class={["mt-2.5", xs]}>{t("web.farm.sow.kinds")}</p>
              {/* One kind at a time: its tab, then its seeds. */}
              <div role="tablist" aria-label={t("web.farm.sow.kinds")} data-testid="seed-kinds" class="mt-1.5 flex flex-wrap gap-1">
                <For each={seeds().kinds} keyed={(k) => k.kind.id}>
                  {(k) => (
                    <button
                      type="button"
                      role="tab"
                      data-key={k().kind.id}
                      aria-selected={aria(k().kind.id === kind()?.kind.id)}
                      onClick={() => setKindId(k().kind.id)}
                      class={[
                        "flex cursor-pointer items-center gap-1 border-2 py-0.5 pr-2 pl-1 text-[12px]",
                        k().kind.id === kind()?.kind.id
                          ? "border-leaf-500 bg-leaf-300/60 text-bark-900"
                          : "border-transparent text-bark-800 hover:bg-cream-200",
                      ]}
                    >
                      <SpriteIcon name={k().kind.icon} size={20} />
                      {k().kind.name}
                    </button>
                  )}
                </For>
              </div>
              <Show when={kind()}>
                {(k) => (
                  <div role="tabpanel" aria-label={k().kind.name} class="mt-1.5 flex flex-wrap gap-1.5">
                    <For each={k().templates} keyed={(s) => s.id}>
                      {(s) => <Chip text={s().title} on={text() === s().text} onClick={() => take(s().text, s().blank)} />}
                    </For>
                  </div>
                )}
              </Show>
            </Show>
            <p class={["mt-2.5", xs]}>{t("web.farm.sow.own")}</p>
            <div class="mt-1.5">
              <PxTextArea
                ref={(el) => (words = el)}
                value={text()}
                selection={selection()}
                onChange={setText}
                rows={3}
                placeholder={t("web.farm.sow.jobHint")}
                label={t("web.farm.sow.job")}
              />
            </div>
            <p class={["mt-3", xs]}>{t("web.farm.sow.who")}</p>
            <div class="mt-1.5 flex flex-wrap gap-1" role="group" aria-label={t("web.farm.sow.who")}>
              <WhoTile active={sower() === byOrchestrator} label={t("web.farm.sow.orchestratorPicks")} onClick={() => setWho(byOrchestrator)}>
                <span class="flex h-11 w-11 items-center justify-center bg-cream-200 text-[16px] text-bark-600">?</span>
              </WhoTile>
              <For each={agents()} keyed={(a) => a.id}>
                {(a) => (
                  <WhoTile active={sower() === a().id} label={a().name} onClick={() => setWho(a().id)}>
                    <AgentFace agentId={a().id} runtime={a().runtime} look={a().look} size={44} />
                  </WhoTile>
                )}
              </For>
            </div>
            <div class="mt-3 flex items-center gap-2">
              <p class={["min-w-0 flex-1", xs]}>{t("web.farm.sow.how", { project: p() })}</p>
              <PxButton disabled={!canSow()} onClick={() => void write()}>
                {t("web.farm.sow.draft")}
              </PxButton>
              <PxButton tone="primary" disabled={!canSow()} onClick={sow}>
                {t("web.farm.sow.start")}
              </PxButton>
            </div>
            <Show when={refused()}>
              <p class="mt-1.5 text-[12px] text-berry">{refused()}</p>
            </Show>
          </div>
        </div>
      )}
    </Show>
  );
}

const dropsOfAdvice = ([0, 1, 2, 3] as const).map((i) => t(`web.farm.water.drops.${i}`));

export function WaterForm(props: { session: Session; onDone: () => void }) {
  const core = useCore();
  const canTell = () =>
    core()
      ?.issues?.find((i) => i.id === issueOf(props.session))
      ?.attention.acts.some((a) => a.act === "tell") ?? false;
  const [text, setText] = createSignal("");
  const sendKey = newSendKey();
  const [refused, setRefused] = createSignal<string>();
  const water = async () => {
    if (!text().trim() || !canTell()) return;
    try {
      await commands.water(props.session, text(), sendKey);
      props.onDone();
    } catch (e) {
      setRefused(reasonOf(e));
    }
  };
  return (
    <div class="flex flex-col">
      <p class="text-[13px] text-bark-800">{props.session.phase._tag === "working" ? t("web.farm.water.working") : t("web.farm.water.idle")}</p>
      <p class={["mt-1", xs]}>{t("web.farm.water.thread")}</p>
      <p class={["mt-1", xs]}>{t("web.farm.water.job", { brief: props.session.brief })}</p>
      <div class="mt-3 flex flex-wrap gap-1.5">
        <For each={dropsOfAdvice}>{(s) => <Chip text={s} on={text() === s} onClick={() => setText(s)} />}</For>
      </div>
      <div class="mt-3 flex items-end gap-2">
        <div class="flex-1">
          <PxTextArea
            value={text()}
            onChange={setText}
            rows={2}
            placeholder={t("web.farm.water.hint")}
            label={t("web.farm.plot.tell", { who: props.session.name })}
            autoFocus
          />
        </div>
        <PxButton tone="primary" disabled={!text().trim() || !canTell()} onClick={() => void water()}>
          {t("web.farm.water.water")}
        </PxButton>
      </div>
      <Show when={!canTell()}>
        <p class="mt-1.5 text-[12px] text-bark-600">{t("web.farm.water.moved")}</p>
      </Show>
      <Show when={refused()}>
        <p class="mt-1.5 text-[12px] text-berry">{refused()}</p>
      </Show>
    </div>
  );
}
