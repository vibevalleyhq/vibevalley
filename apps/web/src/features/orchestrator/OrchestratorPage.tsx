// 管家: who the orchestrator is, and its 记性, 轨迹 (every round, a round markable as wrong),
// 旧账 (the conversation it folded away) and 声音 (what it says on a call); /orchestrator/<tab>.

import { orchestratorWording } from "./words";
import { For, Match, Switch } from "solid-js";
import { orchestratorAgent } from "@vibevalley/protocol";
import { api } from "../../base/api";
import { orchestratorLooks } from "./looks";
import { A } from "../../ui/A";
import { useRouter } from "../../base/router";
import { aria } from "../../base/util";
import { OrchestratorFace } from "../../ui/Face";
import { ArchivePanel, OrchestratorMemoryPanel } from "../memory";
import { VoiceForm } from "../voice";
import { TrajectoryLog } from "../session";
import { usePrefs } from "../../base/prefs";

const tabs = [
  { id: "memory", label: orchestratorWording().orchestrator.tab.memory },
  { id: "trajectory", label: orchestratorWording().orchestrator.tab.trajectory },
  { id: "archive", label: orchestratorWording().orchestrator.tab.archive },
  { id: "voice", label: orchestratorWording().orchestrator.tab.voice },
] as const;

/** `rest` is the path after /orchestrator/. */
export function OrchestratorPage(props: { rest: string }) {
  const at = () => tabs.find((t) => t.id === props.rest)?.id ?? "memory";
  const router = useRouter();
  const chosen = usePrefs((p) => p.orchestratorLook);
  const look = () => orchestratorLooks.find((l) => l.id === chosen());
  const head = () => (
    <div class="flex items-center gap-4 pt-4">
      <span class="flex size-18 shrink-0 items-center justify-center rounded-lg bg-hover">
        <OrchestratorFace size={64} look={chosen()} />
      </span>
      <div class="flex min-w-0 flex-col gap-0.5">
        <A href="/agents" class="text-xs text-muted hover:underline">
          {orchestratorWording().orchestrator.all}
        </A>
        <h1 class="text-2xl font-semibold">{orchestratorWording().orchestrator.title}</h1>
        <p class="text-sm text-muted">
          {orchestratorWording().orchestrator.intro}
          {look() ? orchestratorWording().orchestrator.look(look()!.name) : ""}
        </p>
      </div>
    </div>
  );
  const bar = () => (
    <div role="tablist" aria-label={orchestratorWording().orchestrator.tabs} class="flex gap-1 border-b border-line pb-2">
      <For each={tabs}>
        {(t) => (
          <button
            type="button"
            role="tab"
            aria-selected={aria(t.id === at())}
            onClick={() => router.navigate(`/orchestrator/${t.id}`)}
            class={["h-8 cursor-pointer rounded-md px-3 text-base", t.id === at() ? "bg-selected font-semibold" : "text-muted hover:bg-hover hover:text-ink"]}
          >
            {t.label}
          </button>
        )}
      </For>
    </div>
  );
  // The trajectory takes the whole content area, its rows scrolling under a fixed head; the other tabs are a column.
  return (
    <Switch>
      <Match when={at() === "trajectory"}>
        <div class="flex h-full min-h-0 flex-col gap-4 px-4 pb-4">
          {head()}
          {bar()}
          <div class="min-h-0 flex-1">
            <TrajectoryLog
              id={orchestratorAgent}
              asked={orchestratorWording().orchestrator.heard}
              empty={orchestratorWording().orchestrator.quiet}
              title={orchestratorWording().orchestrator.trajectory}
              about={orchestratorWording().orchestrator.about}
              onMarkWrong={(on, want) => api.orchestrator.eval.create({ on, want })}
            />
          </div>
        </div>
      </Match>
      <Match when={at() !== "trajectory"}>
        <div class="h-full overflow-y-auto px-4 pb-4">
          <div class="mx-auto flex max-w-4xl flex-col gap-4">
            {head()}
            {bar()}
            <Switch>
              <Match when={at() === "memory"}>
                <OrchestratorMemoryPanel />
              </Match>
              <Match when={at() === "archive"}>
                <ArchivePanel />
              </Match>
              <Match when={at() === "voice"}>
                <VoiceForm part="agent" />
              </Match>
            </Switch>
          </div>
        </div>
      </Match>
    </Switch>
  );
}
