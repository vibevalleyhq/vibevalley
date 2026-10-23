// 管家: who the orchestrator is, and its 记性, 轨迹 (every round, a round markable as wrong),
// 旧账 (the conversation it folded away) and 声音 (what it says on a call); /orchestrator/<tab>.

import { For, Match, Switch } from "solid-js";
import { orchestratorAgent } from "@vibevalley/protocol";
import { api } from "../../data/api";
import { orchestratorLooks } from "../../farm/kit/looks";
import { A } from "../../app/A";
import { useRouter } from "../../app/router";
import { aria } from "../../app/util";
import { OrchestratorFace } from "../../ui/Face";
import { ArchivePanel, OrchestratorMemoryPanel } from "../Memory";
import { VoiceForm } from "../settings/VoiceForm";
import { TrajectoryLog } from "../Trajectory";
import { usePrefs } from "../../data/prefs";

const tabs = [
  { id: "memory", label: "记性" },
  { id: "trajectory", label: "轨迹" },
  { id: "archive", label: "旧账" },
  { id: "voice", label: "声音" },
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
          ← 全部帮工
        </A>
        <h1 class="text-2xl font-semibold">管家</h1>
        <p class="text-sm text-muted">
          管家不当帮工：听你说要做什么，派帮工去做，盯着进度，转告结果。{look() ? `长相是${look()!.name}，在农场的管家面板里换。` : ""}
        </p>
      </div>
    </div>
  );
  const bar = () => (
    <div role="tablist" aria-label="管家的" class="flex gap-1 border-b border-line pb-2">
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
              asked="收到"
              empty="管家还没开过口。"
              title="管家每一轮的经过"
              about="它收到的话、调的每个工具（点一行看参数和结果）、它说的话。新的在下面，一直留着最近的 1000 步。哪一轮做错了，在它收到的话上点「这一轮做错了」，写一句应该怎样，存成一条评测。"
              onMarkWrong={(on, want) => api.orchestrator.markWrong({ body: { on, want } })}
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
