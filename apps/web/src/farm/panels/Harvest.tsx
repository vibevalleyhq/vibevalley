// Harvesting a helper's plot and the warehouse of what was harvested; the checklist's rules are src/rules/issueState.ts.

import { For, Match, Show, Switch } from "solid-js";
import { useQuery } from "@tanstack/solid-query";
import type { Changes, Session } from "@vibevalley/protocol";
import { api, reasonOf } from "../../data/api";
import { fire } from "../commands";
import { harvestedOf } from "../hud/rules";
import { farm } from "../store";
import { issueOf } from "../world/plots";
import { changeKind, lineCounts, nothingChanged } from "../../rules/issueState";
import { issueTitle } from "../../rules/issues";
import { ago } from "../../rules/time";
import { useRouter } from "../../app/router";
import { useNow } from "../../app/util";
import { useCore, useFrames } from "../../data/frame";
import { ready, useAgents } from "../../data/query";
import { FarmSection, PxButton, SpriteIcon } from "../kit";
import { commands } from "../state";
import { FarmEmpty, FarmTag, FileRow, PlusMinus, tint, Tinted } from "./bits";

const xs = "text-[12px] text-bark-600";

export function HarvestReview(props: { session: Session; onDone: () => void }) {
  const changes = useQuery(() => ({
    queryKey: ["issues", "changes", issueOf(props.session)],
    queryFn: () => api.issue.changes({ id: issueOf(props.session) }),
  }));
  return (
    <Switch>
      <Match when={changes.isSuccess}>
        <ReadyView session={props.session} changes={changes.data!} onDone={() => props.onDone()} />
      </Match>
      <Match when={changes.error}>
        {(error) => (
          <div class="flex flex-col items-start gap-3">
            <Tinted color={tint("#c84a3a", 0.12)}>
              <p class="text-[13px] text-berry">看不了改动：{reasonOf(error())}</p>
            </Tinted>
            <PxButton onClick={() => props.onDone()}>先不收</PxButton>
          </div>
        )}
      </Match>
      <Match when={true}>
        <p class="py-10 text-center text-[13px] text-bark-600">正在看它改了什么…</p>
      </Match>
    </Switch>
  );
}

function ReadyView(props: { session: Session; changes: Changes; onDone: () => void }) {
  const now = useNow();
  const counts = () => lineCounts(props.changes);
  const empty = () => nothingChanged(props.changes);
  const conflicts = () => props.changes.conflicts;
  const take = () => {
    fire(commands.harvest(props.session));
    props.onDone();
  };
  const resolve = () => {
    fire(commands.resolve(props.session));
    props.onDone();
  };
  return (
    <div class="flex flex-col">
      <div class="flex flex-wrap items-center gap-1.5">
        <FarmTag text={`项目 ${props.changes.project}`} fill="#a5743f" ink="#f7e8c4" />
        <Show when={props.changes.branch}>
          <FarmTag text={`${props.changes.branch} → ${props.changes.base}`} ink="#46301d" />
        </Show>
        <span class={xs}>
          {props.changes.commits.length} 个提交 · {props.changes.files.length} 个文件
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
              <p class="text-[13px] text-bark-600">这一单没有改动。收获就是请它收工。</p>
            </Tinted>
          </Show>
        }
      >
        <Tinted color={tint("#c84a3a", 0.12)} class="mt-3 py-2.5">
          <p class="text-[13px] text-berry">合进 {props.changes.base} 会冲突，先没法收</p>
          <div class="mt-1.5 flex flex-wrap gap-1">
            <For each={conflicts()}>{(f) => <FarmTag text={f} fill="#f7e8c4" ink="#c84a3a" />}</For>
          </div>
          <p class={["mt-1.5", xs]}>让它在自己的分支上把 {props.changes.base} 合进来、解决冲突、跑一遍测试再提交；做完再来收。</p>
        </Tinted>
      </Show>
      <Show when={props.changes.behind > 0 && conflicts().length === 0}>
        <p class={["mt-2", xs]}>
          它干活这段时间，{props.changes.base} 上多了 {Math.round(props.changes.behind)} 个提交；收获时会合在一起（多一个合并提交）。
        </p>
      </Show>
      <Show when={props.changes.uncommitted.length > 0}>
        <Tinted color={tint("#e5a93c", 0.2)} class="mt-3">
          <p class="text-[12px] text-bark-800">还有 {props.changes.uncommitted.length} 个文件没提交，收获时会先帮它提交：</p>
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
        <Show
          when={conflicts().length > 0}
          fallback={
            <PxButton tone="primary" onClick={take}>
              {empty() ? "请它收工" : `确认收获，合进 ${props.changes.base}`}
            </PxButton>
          }
        >
          <PxButton tone="danger" onClick={resolve}>
            让它解决冲突
          </PxButton>
        </Show>
        <PxButton onClick={() => props.onDone()}>先不收</PxButton>
      </div>
      <Show when={props.changes.commits.length > 0}>
        <FarmSection title="提交">
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
        <FarmSection title="改了的文件">
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
    <Show when={stored().length > 0} fallback={<FarmEmpty text="仓库还空着。收获进主分支的活会放在这里。" />}>
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
                    i.graph ? "种植计划" : undefined,
                    i.assignee ? (agents().get(i.assignee)?.name ?? i.assignee) : undefined,
                    i.project,
                    i.closedAt !== undefined ? `${ago(i.closedAt, now())}收的` : undefined,
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
