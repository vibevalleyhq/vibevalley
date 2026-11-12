import { For, Match, Show, Switch } from "solid-js";

import { t } from "@vibevalley/i18n";
import type { Changes, Issue, Session } from "@vibevalley/protocol";
import { assignedAgentOf } from "@vibevalley/protocol/rules";

import { useNow } from "#/base/dom.tsx";
import { ago } from "#/base/format.ts";
import { commands } from "#/farm/frames.ts";
import { harvestedOf } from "#/farm/hud/readout.ts";
import { issueOf } from "#/farm/world/plots.ts";
import { changeKind, lineCounts, nothingChanged, issueTitle, useIssueChanges } from "#/features/issue/index.ts";
import { reasonOf } from "#/infra/api.ts";
import { useCore } from "#/infra/frame.ts";
import { ready, useAgents } from "#/infra/query.ts";
import { useRouter } from "#/infra/router.ts";
import { createPixelAct, FarmSection, PxButton, SpriteIcon } from "#/ui/pixel/index.ts";

import { FarmEmpty, FarmTag, FileRow, PlusMinus, Tinted } from "./rows";

export function HarvestReview(props: { session: Session; onDone: () => void }) {
  const changes = useIssueChanges(() => issueOf(props.session));
  return (
    <Switch>
      <Match when={changes.status() === "success" ? changes.data() : undefined}>
        {(data) => <ReadyView session={props.session} changes={data()} onDone={() => props.onDone()} />}
      </Match>
      <Match when={changes.error()}>
        {(error) => (
          <div class="flex flex-col items-start gap-3">
            <Tinted class="bg-[color-mix(in_srgb,_var(--color-berry-500)_12%,_var(--color-cream-50))]">
              <p class="text-(length:--text-sm) text-berry">
                {t("web.farm.graph.unreadable")}
                {reasonOf(error())}
              </p>
            </Tinted>
            <PxButton onClick={() => props.onDone()}>{t("web.farm.notNow")}</PxButton>
          </div>
        )}
      </Match>
      <Match when={true}>
        <p class="py-10 text-center text-(length:--text-sm) text-bark-600">{t("web.farm.harvest.reading")}</p>
      </Match>
    </Switch>
  );
}

function ReadyView(props: { session: Session; changes: Changes; onDone: () => void }) {
  const now = useNow();
  const core = useCore();
  const acts = () => (core()?.issues.find((i) => i.id === issueOf(props.session))?.stage.acts ?? []).map((a) => a.act);
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
        <FarmTag text={t("web.farm.harvest.repo", { repo: props.changes.repo })} class="bg-bark-450 text-cream-50" />
        <Show when={props.changes.branch}>
          <FarmTag text={`${props.changes.branch} → ${props.changes.base}`} />
        </Show>
        <span class="text-(length:--text-xs) text-bark-600">
          {t("web.farm.harvest.counts", { commits: props.changes.commits.length, files: props.changes.files.length })}
        </span>
        <Show when={props.changes.files.length > 0}>
          <PlusMinus added={counts()[0]} removed={counts()[1]} />
        </Show>
      </div>
      <Show
        when={conflicts().length > 0}
        fallback={
          <Show when={empty()}>
            <Tinted class="mt-3">
              <p class="text-(length:--text-sm) text-bark-600">{t("web.farm.harvest.none")}</p>
            </Tinted>
          </Show>
        }
      >
        <Tinted class="mt-3 bg-[color-mix(in_srgb,_var(--color-berry-500)_12%,_var(--color-cream-50))] py-2.5">
          <p class="text-(length:--text-sm) text-berry">{t("web.farm.harvest.conflict", { base: props.changes.base })}</p>
          <div class="mt-1.5 flex flex-wrap gap-1">
            <For each={conflicts()}>{(f) => <FarmTag text={f} class="bg-cream-50 text-berry-500" />}</For>
          </div>
          <p class="mt-1.5 text-(length:--text-xs) text-bark-600">{t("web.farm.harvest.resolveHow", { base: props.changes.base })}</p>
        </Tinted>
      </Show>
      <Show when={props.changes.behind > 0 && conflicts().length === 0}>
        <p class="mt-2 text-(length:--text-xs) text-bark-600">
          {t("web.farm.harvest.behind", { base: props.changes.base, n: Math.round(props.changes.behind) })}
        </p>
      </Show>
      <Show when={props.changes.uncommitted.length > 0}>
        <Tinted class="mt-3 bg-[color-mix(in_srgb,_var(--color-wheat)_20%,_var(--color-cream-50))]">
          <p class="text-(length:--text-xs) text-bark-800">{t("web.farm.harvest.uncommitted", { n: props.changes.uncommitted.length })}</p>
          <div class="mt-1 flex flex-wrap gap-1">
            <For each={props.changes.uncommitted}>
              {(f) => (
                <span class="bg-cream-50 px-1.5 py-0.5 font-mono text-[length:12.5px]">
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
        <p class="mt-2 text-(length:--text-xs) text-bark-600">{t("web.farm.water.moved")}</p>
      </Show>
      <Show when={props.changes.commits.length > 0}>
        <FarmSection title={t("web.farm.graph.commits")}>
          <For each={props.changes.commits}>
            {(c) => (
              <div class="flex items-center gap-2 py-px">
                <span class="font-mono text-[length:12.5px] text-bark-500">{c.hash}</span>
                <span class="min-w-0 flex-1 truncate text-(length:--text-sm)">{c.subject}</span>
                <span class="text-(length:--text-xs) text-bark-400">{ago(c.at, now())}</span>
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
  const agentsQuery = useAgents();
  const router = useRouter();
  const now = useNow();
  const agents = () => new Map(ready(agentsQuery, []).map((a) => [a.id, a]));
  const agentName = (issue: Issue) => {
    const id = assignedAgentOf(issue);
    return id ? (agents().get(id)?.name ?? id) : undefined;
  };
  const stored = () => harvestedOf(core());
  const issues = () => core()?.issues ?? [];
  return (
    <Show when={stored().length > 0} fallback={<FarmEmpty text={t("web.farm.harvest.empty")} />}>
      <div class="grid gap-2 sm:grid-cols-2">
        <For each={stored()}>
          {(i) => (
            <button
              type="button"
              aria-label={issueTitle(i, issues())}
              onClick={() => {
                router.navigate(`/issues/${encodeURIComponent(i.id)}`);
              }}
              class="flex cursor-pointer items-start gap-3 bg-cream-100 hover:bg-cream-200 p-3 text-left"
            >
              <SpriteIcon name="icon-harvest" size={40} />
              <span class="min-w-0 flex-1">
                <span class="line-clamp-2 text-(length:--text-sm)">{issueTitle(i, issues())}</span>
                <span class="mt-1 block text-(length:--text-xs) text-bark-600">
                  {[agentName(i), i.repo, i.closedAt !== undefined ? t("web.farm.harvest.taken", { ago: ago(i.closedAt, now()) }) : undefined]
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
