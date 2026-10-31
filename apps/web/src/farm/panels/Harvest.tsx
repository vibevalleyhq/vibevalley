// The checklist's words are src/features/issue/overview.ts's.

import { For, Match, Show, Switch } from "solid-js";

import { t } from "@vibevalley/i18n";
import type { Changes, Session } from "@vibevalley/protocol";

import { ago } from "@/base/format";
import { useNow } from "@/base/util";
import { commands } from "@/farm/frames";
import { harvestedOf } from "@/farm/hud/readout";
import { farm } from "@/farm/store";
import { issueOf } from "@/farm/world/plots";
import { changeKind, lineCounts, nothingChanged, issueTitle, useIssueChanges } from "@/features/issue";
import { reasonOf } from "@/infra/api";
import { useCore, useFrames } from "@/infra/frame";
import { ready, useAgents } from "@/infra/query";
import { useRouter } from "@/infra/router";
import { createPixelAct, FarmSection, PxButton, SpriteIcon } from "@/ui/pixel";

import { FarmEmpty, FarmTag, FileRow, PlusMinus, tint, Tinted } from "./bits";

const xs = "text-[12px] text-bark-600";

export function HarvestReview(props: { session: Session; onDone: () => void }) {
  const changes = useIssueChanges(() => issueOf(props.session));
  return (
    <Switch>
      <Match when={changes.isSuccess}>
        <ReadyView session={props.session} changes={changes.data!} onDone={() => props.onDone()} />
      </Match>
      <Match when={changes.error}>
        {(error) => (
          <div class="flex flex-col items-start gap-3">
            <Tinted color={tint("#c84a3a", 0.12)}>
              <p class="text-[13px] text-berry">
                {t("web.farm.graph.unreadable")}
                {reasonOf(error())}
              </p>
            </Tinted>
            <PxButton onClick={() => props.onDone()}>{t("web.farm.notNow")}</PxButton>
          </div>
        )}
      </Match>
      <Match when={true}>
        <p class="py-10 text-center text-[13px] text-bark-600">{t("web.farm.harvest.reading")}</p>
      </Match>
    </Switch>
  );
}

function ReadyView(props: { session: Session; changes: Changes; onDone: () => void }) {
  const now = useNow();
  const core = useCore();
  const acts = () => (core()?.issues.find((i) => i.id === issueOf(props.session))?.attention.acts ?? []).map((a) => a.act);
  const counts = () => lineCounts(props.changes);
  const empty = () => nothingChanged(props.changes);
  const conflicts = () => props.changes.conflicts;
  const act = createPixelAct(t("web.farm.plot.failed"));
  // The window stays until the server took it, so a refusal is said beside it and the press can be made again.
  const take = async () => {
    if (!acts().includes("complete")) return;
    const session = props.session;
    if ((await act.run(async () => (await commands.harvest(session), true))) === true) props.onDone();
  };
  const resolve = async () => {
    if (!acts().includes("resolve")) return;
    const session = props.session;
    if ((await act.run(async () => (await commands.resolve(session), true))) === true) props.onDone();
  };
  return (
    <div class="flex flex-col">
      <div class="flex flex-wrap items-center gap-1.5">
        <FarmTag text={t("web.farm.harvest.project", { project: props.changes.project })} fill="#a5743f" ink="#f7e8c4" />
        <Show when={props.changes.branch}>
          <FarmTag text={`${props.changes.branch} → ${props.changes.base}`} ink="#46301d" />
        </Show>
        <span class={xs}>{t("web.farm.harvest.counts", { commits: props.changes.commits.length, files: props.changes.files.length })}</span>
        <Show when={props.changes.files.length > 0}>
          <PlusMinus added={counts()[0]} removed={counts()[1]} />
        </Show>
      </div>
      <Show
        when={conflicts().length > 0}
        fallback={
          <Show when={empty()}>
            <Tinted class="mt-3">
              <p class="text-[13px] text-bark-600">{t("web.farm.harvest.none")}</p>
            </Tinted>
          </Show>
        }
      >
        <Tinted color={tint("#c84a3a", 0.12)} class="mt-3 py-2.5">
          <p class="text-[13px] text-berry">{t("web.farm.harvest.conflict", { base: props.changes.base })}</p>
          <div class="mt-1.5 flex flex-wrap gap-1">
            <For each={conflicts()}>{(f) => <FarmTag text={f} fill="#f7e8c4" ink="#c84a3a" />}</For>
          </div>
          <p class={["mt-1.5", xs]}>{t("web.farm.harvest.resolveHow", { base: props.changes.base })}</p>
        </Tinted>
      </Show>
      <Show when={props.changes.behind > 0 && conflicts().length === 0}>
        <p class={["mt-2", xs]}>{t("web.farm.harvest.behind", { base: props.changes.base, n: Math.round(props.changes.behind) })}</p>
      </Show>
      <Show when={props.changes.uncommitted.length > 0}>
        <Tinted color={tint("#e5a93c", 0.2)} class="mt-3">
          <p class="text-[12px] text-bark-800">{t("web.farm.harvest.uncommitted", { n: props.changes.uncommitted.length })}</p>
          <div class="mt-1 flex flex-wrap gap-1">
            <For each={props.changes.uncommitted}>
              {(f) => (
                <span class="bg-cream-50 px-1.5 py-0.5 font-mono text-[12.5px]">
                  {changeKind(f.status).mark} {f.path}
                </span>
              )}
            </For>
          </div>
        </Tinted>
      </Show>
      <div class="mt-3 flex flex-wrap gap-2">
        <Show when={acts().includes("complete")}>
          <PxButton tone="primary" data-act="complete" disabled={act.busy()} onClick={() => void take()}>
            {empty() ? t("web.farm.harvest.letGo") : t("web.farm.harvest.take", { base: props.changes.base })}
          </PxButton>
        </Show>
        <Show when={acts().includes("resolve")}>
          <PxButton tone="danger" data-act="resolve" disabled={act.busy()} onClick={() => void resolve()}>
            {t("web.farm.harvest.resolve")}
          </PxButton>
        </Show>
        <PxButton onClick={() => props.onDone()}>{t("web.farm.notNow")}</PxButton>
      </div>
      <Show when={!acts().includes("complete") && !acts().includes("resolve")}>
        <p class={["mt-2", xs]}>{t("web.farm.water.moved")}</p>
      </Show>
      <Show when={props.changes.commits.length > 0}>
        <FarmSection title={t("web.farm.graph.commits")}>
          <For each={props.changes.commits}>
            {(c) => (
              <div class="flex items-center gap-2 py-px">
                <span class="font-mono text-[12.5px] text-bark-500">{c.hash}</span>
                <span class="min-w-0 flex-1 truncate text-[13px]">{c.subject}</span>
                <span class="text-[12px] text-bark-400">{ago(c.at, now())}</span>
              </div>
            )}
          </For>
        </FarmSection>
      </Show>
      <Show when={props.changes.files.length > 0}>
        <FarmSection title={t("web.farm.harvest.files")}>
          <div class="flex flex-col gap-1">
            <For each={props.changes.files}>{(f) => <FileRow file={f} conflict={conflicts().includes(f.path)} />}</For>
          </div>
        </FarmSection>
      </Show>
    </div>
  );
}

export function Warehouse() {
  const core = useCore();
  const frames = useFrames();
  const agentsQuery = useAgents();
  const router = useRouter();
  const now = useNow();
  const agents = () => new Map(ready(agentsQuery, []).map((a) => [a.id, a]));
  const stored = () => harvestedOf(core());
  const graphs = () => frames.frame?.graphs ?? [];
  return (
    <Show when={stored().length > 0} fallback={<FarmEmpty text={t("web.farm.harvest.empty")} />}>
      <div class="grid gap-2 sm:grid-cols-2">
        <For each={stored()}>
          {(i) => (
            <button
              type="button"
              aria-label={issueTitle(i, graphs())}
              onClick={() => {
                if (i.graph) farm.openTaskBoard(i.id);
                else router.navigate(`/issues/${encodeURIComponent(i.id)}`);
              }}
              class="flex cursor-pointer items-start gap-3 bg-cream-100 p-3 text-left hover:bg-cream-200"
            >
              <SpriteIcon name={i.graph ? "icon-task-board" : "icon-harvest"} size={40} />
              <span class="min-w-0 flex-1">
                <span class="line-clamp-2 text-[13px]">{issueTitle(i, graphs())}</span>
                <span class={["mt-1 block", xs]}>
                  {[
                    i.graph ? t("web.farm.harvest.graph") : undefined,
                    i.assignee ? (agents().get(i.assignee)?.name ?? i.assignee) : undefined,
                    i.project,
                    i.closedAt !== undefined ? t("web.farm.harvest.taken", { ago: ago(i.closedAt, now()) }) : undefined,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
              </span>
            </button>
          )}
        </For>
      </div>
    </Show>
  );
}
