import type { JSX } from "@solidjs/web";
import { For, Match, Show, Switch } from "solid-js";

import { t } from "@vibevalley/i18n";
import type { Agent, RuntimeInfo } from "@vibevalley/protocol";

import { Keyed, variant } from "#/base/dom.tsx";
import { wallClockText } from "#/base/format.ts";
import { useWorkAgents } from "#/infra/agents.ts";
import { api, reasonOf } from "#/infra/api.ts";
import { runtimesQuery, useQueryClient, ready, useRuntimes } from "#/infra/query.ts";
import { Link as A } from "#/infra/router.ts";
import { createAct } from "#/ui/act.ts";
import { Button } from "#/ui/Button.tsx";
import { AgentFace } from "#/ui/domain/Face.tsx";
import { Card, ListCard, ListRow, Quiet, Split } from "#/ui/layout.tsx";
import { RuntimeIcon } from "#/ui/pixel/RuntimeIcon.tsx";

import { quotaOf } from "./quota";
import { InventoryCard, ModelsCard, SettingsCard, Stamina, SupportCard, Usage } from "./RuntimeCards";

const styles = {
  portrait: (hat: string): JSX.CSSProperties => ({ "background-image": `radial-gradient(70% 70% at 50% 70%, ${hat}33, var(--color-page))` }),
};

const statusOf = (r: RuntimeInfo) => {
  const i = r.installation;
  switch (i.status) {
    case "available":
      return r.settings.enabled ? (i.version ?? t("web.runtime.available")) : t("web.runtime.disabled");
    // The reason, not just unsupported: for vibevalley it is a missing DeepSeek key, which is the user's to fix.
    case "unsupported":
      return i.reason || t("web.runtime.unsupported");
    case "not_found":
      return t("web.runtime.notFound");
    case "checking":
      return t("web.runtime.checking");
  }
};

/** `rest` is the path after /runtimes/. */
export function RuntimesPage(props: { rest: string }) {
  const runtimes = useRuntimes();
  const agents = useWorkAgents();
  const list = () => ready(runtimes, []);
  const selected = () => list().find((r) => r.id === props.rest) ?? list()[0];
  return (
    <Show
      when={!runtimes.error()}
      fallback={
        <p class="p-8 text-sm text-berry">
          {t("web.runtime.noRuntimes")}
          {reasonOf(runtimes.error())}
        </p>
      }
    >
      <div class="h-full">
        <Split
          edge
          list={
            <ListCard bare title={t("web.runtime.title")} label={t("web.runtime.list")} testid="runtimes">
              <li class="px-2.5 pt-1 pb-1.5 text-xs text-muted">{t("web.runtime.intro")}</li>
              <For each={list()}>
                {(r) => {
                  const ok = () => r.installation.status === "available";
                  const using = () => agents().filter((a) => a.runtime === r.id).length;
                  const quota = () => quotaOf(r);
                  return (
                    <ListRow
                      to={`/runtimes/${r.id}`}
                      item={r.id}
                      active={selected()?.id === r.id}
                      title={r.preset.label}
                      line={`${statusOf(r)}${using() > 0 ? t("web.runtime.usedBy", { n: using() }) : ""}`}
                      leading={
                        <span class={["", !ok() ? "opacity-50 [filter:grayscale(100%)]" : ""]}>
                          <RuntimeIcon runtime={r.id} size={36} />
                        </span>
                      }
                      trailing={
                        <span class="flex flex-col items-end gap-1">
                          <span class={["w-2 h-2 rounded-full", ok() ? (r.settings.enabled ? "bg-leaf" : "bg-faint") : "bg-berry"]} aria-hidden="true" />
                          <Show when={ok() && quota().level !== "unknown"}>
                            <Stamina quota={quota()} width={60} height={7} />
                          </Show>
                        </span>
                      }
                    />
                  );
                }}
              </For>
            </ListCard>
          }
        >
          <Show when={selected()} fallback={<Quiet>{t("web.runtime.reading")}</Quiet>}>
            {(s) => <Keyed key={s().id}>{() => <Detail info={s()} agents={agents().filter((a) => a.runtime === s().id)} />}</Keyed>}
          </Show>
        </Split>
      </div>
    </Show>
  );
}

export function Detail(props: { info: RuntimeInfo; agents: Agent[] }) {
  const client = useQueryClient();
  const refreshing = createAct();
  const inst = () => props.info.installation;
  const keep = (got: RuntimeInfo) => client.setData(runtimesQuery(), (all) => (all ? { value: all.value.map((r) => (r.id === got.id ? got : r)) } : undefined));
  const refresh = () => {
    const id = props.info.id;
    return refreshing.run(async () => keep(await api.runtime.refresh({ id })));
  };
  return (
    <div class="flex max-w-4xl flex-col gap-3">
      <div class="flex items-center gap-4 px-1 pt-1 pb-2">
        <span class="flex w-18 h-18 shrink-0 items-center justify-center rounded-lg border border-line" style={styles.portrait(props.info.preset.look.hat)}>
          <span class={["", inst().status !== "available" ? "opacity-50 [filter:grayscale(100%)]" : ""]}>
            <RuntimeIcon runtime={props.info.id} size={60} />
          </span>
        </span>
        <div class="flex min-w-0 flex-1 flex-col gap-0.5">
          <h2 class="text-xl font-semibold">{props.info.preset.label}</h2>
          <p class="text-sm text-muted">{props.info.preset.blurb}</p>
          <div class="flex flex-wrap items-center gap-2 pt-1 text-xs text-muted">
            <Switch>
              <Match when={variant(inst(), "status", "available")}>
                {(i) => (
                  <>
                    <span class="rounded-sm bg-ok-soft px-1.5 text-ok-ink">
                      {t("web.runtime.available")} {i().version ?? ""}
                    </span>
                    <span class="font-mono">{i().command}</span>
                    <span>{i().via === "bundled" ? t("web.runtime.bundled") : t("web.runtime.commandLine")}</span>
                  </>
                )}
              </Match>
              <Match when={variant(inst(), "status", "unsupported")}>
                {(i) => <span class="rounded-sm bg-bad-soft px-1.5 text-berry">{t("web.runtime.unsupportedWhy", { why: i().reason })}</span>}
              </Match>
              <Match when={inst().status === "not_found"}>
                <span class="rounded-sm bg-bad-soft px-1.5 text-berry">{t("web.runtime.notHere")}</span>
              </Match>
            </Switch>
            <Show when={inst().status !== "checking"} fallback={<span>{t("web.runtime.checking")}</span>}>
              <span>{t("web.runtime.checkedAt", { clock: wallClockText(props.info.checkedAt) })}</span>
            </Show>
          </div>
        </div>
        <Button disabled={refreshing.busy()} onClick={() => void refresh()}>
          {refreshing.busy() ? t("web.runtime.checking") : t("web.runtime.recheck")}
        </Button>
      </div>
      <div class="grid gap-3 md:grid-cols-2">
        <Card title={t("web.runtime.account")}>
          <Usage info={props.info} />
        </Card>
        <SupportCard info={props.info} />
      </div>
      <SettingsCard info={props.info} onSaved={keep} />
      <ModelsCard info={props.info} />
      <div class="grid gap-3 md:grid-cols-3">
        <InventoryCard title={t("web.runtime.skills")} entries={props.info.skills} />
        <InventoryCard title={t("web.runtime.mcp")} entries={props.info.mcpServers} />
        <InventoryCard title={t("web.runtime.tools")} entries={props.info.tools} />
      </div>
      <Card
        title={t("web.runtime.agents")}
        action={
          <A href={`/agents/new?runtime=${encodeURIComponent(props.info.id)}`} data-testid="new-agent" class="text-xs text-muted hover:text-ink underline">
            {t("web.runtime.makeAgent")}
          </A>
        }
      >
        <Show when={props.agents.length > 0} fallback={<Quiet>{t("web.runtime.noneYet")}</Quiet>}>
          <div class="flex flex-wrap gap-2">
            <For each={props.agents}>
              {(a) => (
                <A
                  href={`/agents/${encodeURIComponent(a.id)}`}
                  class="flex items-center gap-1.5 rounded-md border border-line py-1 pr-3 pl-1 text-sm hover:bg-hover"
                >
                  <AgentFace agentId={a.id} runtime={a.runtime} look={a.look} size={26} />
                  {a.name}
                </A>
              )}
            </For>
          </div>
        </Show>
      </Card>
    </div>
  );
}
