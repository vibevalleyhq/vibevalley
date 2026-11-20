import { Text, View, type InputRef } from "nsh";

import { t } from "@vibevalley/i18n";
import type { Agent, RuntimeInfo } from "@vibevalley/protocol";

import { Keyed, variant } from "../../base/dom";
import { wallClockText } from "../../base/format";
import { useWorkAgents } from "../../infra/agents";
import { api, reasonOf } from "../../infra/api";
import { ready, runtimesQuery, useQueryClient, useRuntimes } from "../../infra/query";
import { Link as A } from "../../infra/router";
import { createAct } from "../../ui/act";
import { Button } from "../../ui/Button";
import { hexColor } from "../../ui/domain/cast";
import { AgentFace } from "../../ui/domain/Face";
import { OpenTerminal } from "../../ui/domain/OpenTerminal";
import { Card, ListCard, ListRow, Quiet, Split } from "../../ui/layout";
import { RuntimeIcon } from "../../ui/pixel/RuntimeIcon";
import { quotaOf } from "./quota";
import { InventoryCard, ModelsCard, SettingsCard, Stamina, SupportCard, Usage } from "./RuntimeCards";

const statusOf = (r: RuntimeInfo) => {
  const i = r.installation;
  switch (i.status) {
    case "available":
      return r.settings.enabled ? (i.version ?? t("web.runtime.available")) : t("web.runtime.disabled");
    // The reason, not just unsupported: for vibevalley it is a missing DeepSeek key, which is the user's to fix.
    case "unsupported":
      return i.signInCommand ? t("web.runtime.quota.signedOut") : i.reason || t("web.runtime.unsupported");
    case "not_found":
      return t("web.runtime.notFound");
    case "checking":
      return t("web.runtime.checking");
  }
};

/** The folder of an absolute command, where a terminal for the runtime opens. */
const folderOf = (command: string) => (command.startsWith("/") ? command.slice(0, command.lastIndexOf("/")) || "/" : undefined);

/** `rest` is the path after /runtimes/. */
export function RuntimesPage(props: { rest: string }) {
  const runtimes = useRuntimes();
  const agents = useWorkAgents();
  const list = () => ready(runtimes, []);
  const selected = () => list().find((r) => r.id === props.rest) ?? list()[0];
  return (
    <If
      when={!runtimes.error()}
      else={
        <Text class="p-8 text-sm text-berry">
          {t("web.runtime.noRuntimes")}
          {reasonOf(runtimes.error())}
        </Text>
      }
    >
      <View testID="runtimes-page" class="h-full flex-1">
        <Split
          edge
          list={
            <ListCard bare title={t("web.runtime.title")} label={t("web.runtime.list")} testid="runtimes">
              <Text class="px-2.5 pt-1 pb-1.5 text-xs text-muted">{t("web.runtime.intro")}</Text>
              <Each of={list()} key={(r) => r.id}>
                {(r) => {
                  const ok = () => r().installation.status === "available";
                  const using = () => agents().filter((a) => a.runtime === r().id).length;
                  const quota = () => quotaOf(r());
                  return (
                    <ListRow
                      to={`/runtimes/${r().id}`}
                      item={r().id}
                      active={selected()?.id === r().id}
                      title={r().preset.label}
                      line={`${statusOf(r())}${using() > 0 ? t("web.runtime.usedBy", { n: using() }) : ""}`}
                      leading={
                        <View style={{ opacity: ok() ? 1 : 0.5 }}>
                          <RuntimeIcon runtime={r().id} size={36} />
                        </View>
                      }
                      trailing={
                        <View class="items-end gap-1">
                          <View class={`h-2 w-2 rounded-full ${ok() ? (r().settings.enabled ? "bg-leaf" : "bg-faint") : "bg-berry"}`} />
                          <If when={ok() && quota().level !== "unknown"}>
                            <Stamina quota={quota()} width={60} height={7} />
                          </If>
                        </View>
                      }
                    />
                  );
                }}
              </Each>
            </ListCard>
          }
        >
          <If when={selected()} else={<Quiet>{t("web.runtime.reading")}</Quiet>}>
            {(s) => <Keyed key={s().id}>{() => <Detail info={s()} agents={agents().filter((a) => a.runtime === s().id)} />}</Keyed>}
          </If>
        </Split>
      </View>
    </If>
  );
}

function Detail(props: { info: RuntimeInfo; agents: Agent[] }) {
  const client = useQueryClient();
  const refreshing = createAct();
  const inst = () => props.info.installation;
  let pathInput: InputRef | undefined;
  const terminalDirectory = () => {
    const i = inst();
    if (i.status === "available") return folderOf(i.command);
    return i.status === "unsupported" && i.signInCommand ? folderOf(i.signInCommand) : undefined;
  };
  const keep = (got: RuntimeInfo) => client.setData(runtimesQuery(), (all) => (all ? { value: all.value.map((r) => (r.id === got.id ? got : r)) } : undefined));
  const refresh = () => {
    const id = props.info.id;
    return refreshing.run(async () => keep(await api.runtime.refresh({ id })));
  };
  return (
    <View testID="runtime-detail" class="max-w-4xl gap-3">
      <View class="flex-row items-center gap-4 px-1 pt-1 pb-2">
        <View
          class="h-18 w-18 shrink-0 items-center justify-center rounded-lg border border-line"
          style={{ backgroundColor: `${hexColor(props.info.preset.look.hat)}33` }}
        >
          <View style={{ opacity: inst().status !== "available" ? 0.5 : 1 }}>
            <RuntimeIcon runtime={props.info.id} size={60} />
          </View>
        </View>
        <View class="min-w-0 flex-1 gap-0.5">
          <Text role="header" class="text-xl font-semibold text-ink">
            {props.info.preset.label}
          </Text>
          <Text class="text-sm text-muted">{props.info.preset.blurb}</Text>
          <View class="flex-row flex-wrap items-center gap-2 pt-1">
            <If when={variant(inst(), "status", "available")}>
              {(i) => (
                <>
                  <View class="rounded-sm bg-ok-soft px-1.5">
                    <Text class="text-xs text-ok-ink">{`${t("web.runtime.available")} ${i().version ?? ""}`}</Text>
                  </View>
                  <Text class="font-mono text-xs text-muted">{i().command}</Text>
                  <If when={folderOf(i().command)}>{(cwd) => <OpenTerminal cwd={cwd()} title={props.info.preset.label} testid="runtime-terminal" />}</If>
                  <Text class="text-xs text-muted">{i().via === "bundled" ? t("web.runtime.bundled") : t("web.runtime.commandLine")}</Text>
                </>
              )}
            </If>
            <If when={variant(inst(), "status", "unsupported")}>
              {(i) => (
                <If
                  when={i().signInCommand}
                  else={
                    <View class="rounded-sm bg-bad-soft px-1.5">
                      <Text class="text-xs text-berry">{t("web.runtime.unsupportedWhy", { why: i().reason })}</Text>
                    </View>
                  }
                >
                  {(command) => <Text class="font-mono text-xs text-muted">{command()}</Text>}
                </If>
              )}
            </If>
            <If when={inst().status === "not_found"}>
              <View class="gap-1.5">
                <Text class="text-xs text-berry">{t("web.runtime.notHere")}</Text>
                <Text class="text-sm text-muted">{t("web.runtime.missingCommand", { runtime: props.info.preset.label })}</Text>
                <Button
                  testID="runtime-locate-command"
                  onPress={() => {
                    pathInput?.reveal({ vertical: "nearest" });
                    pathInput?.focus();
                  }}
                >
                  {t("web.runtime.enterPath")}
                </Button>
              </View>
            </If>
            <Text class="text-xs text-muted">
              {inst().status !== "checking" ? t("web.runtime.checkedAt", { clock: wallClockText(props.info.checkedAt) }) : t("web.runtime.checking")}
            </Text>
          </View>
        </View>
        <Button disabled={refreshing.busy()} onPress={() => void refresh()}>
          {refreshing.busy() ? t("web.runtime.checking") : t("web.runtime.recheck")}
        </Button>
      </View>
      <View class="grid gap-3 md:grid-cols-2">
        <Card title={t("web.runtime.account")}>
          <Usage info={props.info} terminalDirectory={terminalDirectory()} />
        </Card>
        <SupportCard info={props.info} />
      </View>
      <SettingsCard
        info={props.info}
        onSaved={keep}
        pathRef={(node) => {
          pathInput = node;
        }}
      />
      <ModelsCard info={props.info} />
      <View class="grid gap-3 md:grid-cols-3">
        <InventoryCard title={t("web.runtime.skills")} entries={props.info.skills} />
        <InventoryCard title={t("web.runtime.mcp")} entries={props.info.mcpServers} />
        <InventoryCard title={t("web.runtime.tools")} entries={props.info.tools} />
      </View>
      <Card
        title={t("web.runtime.agents")}
        action={
          <A href={`/agents/new?runtime=${encodeURIComponent(props.info.id)}`} testID="new-agent">
            <Text class="text-xs text-muted underline">{t("web.runtime.makeAgent")}</Text>
          </A>
        }
      >
        <If when={props.agents.length > 0} else={<Quiet>{t("web.runtime.noneYet")}</Quiet>}>
          <View class="flex-row flex-wrap gap-2">
            <Each of={props.agents} key={(a) => a.id}>
              {(a) => (
                <A
                  href={`/agents/${encodeURIComponent(a().id)}`}
                  class="flex-row items-center gap-1.5 rounded-md border border-line py-1 pr-3 pl-1 hover:bg-hover"
                >
                  <AgentFace agentId={a().id} name={a().name} runtime={a().runtime} look={a().look} size={26} />
                  <Text class="text-sm text-ink">{a().name}</Text>
                </A>
              )}
            </Each>
          </View>
        </If>
      </Card>
    </View>
  );
}
