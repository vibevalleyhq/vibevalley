import { computed, signal, Text, View } from "nsh";

import { t } from "@vibevalley/i18n";
import type { InventoryEntry, McpHostId, McpServerEntry, McpServerListResult, McpTransportKind } from "@vibevalley/protocol";

import { Button } from "../../design/Button";
import { KeyValueEditor } from "../../design/Chips";
import { Dialog } from "../../design/Dialog";
import { SettingsGroup } from "../../design/domain/settings";
import { Field, TextInput } from "../../design/Field";
import { IconButton } from "../../design/IconButton";
import { Banner, Quiet, Toggle } from "../../design/layout";
import { Segmented } from "../../design/Segmented";
import { Bubble } from "../../design/Tip";
import { toast } from "../../design/toasts";
import { createAct } from "../../infra/act";
import { api } from "../../infra/api";
import { defineQuery, useQuery, useQueryClient } from "../../infra/query";
import { untrack } from "../../infra/solid";

export function mcpHostOf(runtimeId: string): McpHostId | undefined {
  const bare = runtimeId.startsWith("acp:") ? runtimeId.slice(4) : runtimeId;
  if (bare === "antigravity" || bare === "claude" || bare === "codex" || bare === "cursor") return bare;
  return undefined;
}

const mcpServerListQuery = defineQuery({
  key: (host: McpHostId) => ["runtime", "mcpServer", host],
  fetch: (host: McpHostId, context) => api.runtime.mcpServer.list({ host }, context),
});

function mcpEntryTarget(entry: McpServerEntry): string {
  if (entry.transport === "stdio") {
    const cmd = entry.command ?? "";
    return entry.args.length > 0 ? `${cmd} ${entry.args.join(" ")}` : cmd;
  }
  return entry.url ?? "";
}

export function mcpEntryDescription(entry: McpServerEntry): string {
  return `${entry.transport} · ${mcpEntryTarget(entry)}`;
}

function splitArgs(raw: string): string[] {
  const trimmed = raw.trim();
  return trimmed ? trimmed.split(/\s+/u) : [];
}

function McpServerForm(props: { host: McpHostId; initial?: McpServerEntry | undefined; onClose: () => void; onSaved: (result: McpServerListResult) => void }) {
  const initial = untrack(() => props.initial);
  const name = signal(initial?.name ?? "");
  const transport = signal<McpTransportKind>(initial?.transport ?? "stdio");
  const command = signal(initial?.command ?? "");
  const argsText = signal(initial?.args.join(" ") ?? "");
  const env = signal<Record<string, string>>(initial?.env ?? {});
  const url = signal(initial?.url ?? "");
  const headers = signal<Record<string, string>>(initial?.headers ?? {});
  const enabled = signal(initial?.enabled ?? true);
  const error = signal<string | undefined>(undefined);
  const saving = createAct((reason) => error.set(reason));

  const valid = computed(() => {
    if (!name().trim()) return false;
    if (transport() === "stdio") return Boolean(command().trim());
    return Boolean(url().trim());
  });

  const submit = () => {
    if (!valid() || saving.busy()) return;
    error.set(undefined);
    const trimmedName = name().trim();
    const kind = transport();
    void saving.run(async () => {
      const result = await api.runtime.mcpServer.save({
        host: props.host,
        ...(initial ? { previousName: initial.name } : {}),
        name: trimmedName,
        transport: kind,
        ...(kind === "stdio"
          ? { command: command().trim(), args: splitArgs(argsText()), env: env(), headers: {} }
          : { args: [], env: {}, url: url().trim(), headers: headers() }),
        enabled: enabled(),
      });
      props.onSaved(result);
      toast(t("web.runtime.mcpServer.savedToast", { name: trimmedName }));
      props.onClose();
    });
  };

  return (
    <View class="gap-4">
      <If when={error()}>
        {(err) => (
          <Banner tone="bad" size="sm" role="alert" testID="mcp-server-dialog-error">
            {err()}
          </Banner>
        )}
      </If>

      <Field label={t("web.runtime.mcpServer.name")} hint={t("web.runtime.mcpServer.nameHint")}>
        <TextInput
          testID="mcp-server-name"
          accessibilityLabel={t("web.runtime.mcpServer.name")}
          placeholder="context7"
          class="font-mono"
          value={name()}
          onInput={(v) => name.set(v)}
          onSubmit={submit}
        />
      </Field>

      <Field label={t("web.runtime.mcpServer.transport")}>
        <Segmented
          label={t("web.runtime.mcpServer.transport")}
          testid="mcp-server-transport"
          value={transport()}
          options={[
            { value: "stdio", label: "stdio" },
            { value: "streamableHttp", label: "streamableHttp" },
          ]}
          onChange={(next) => transport.set(next)}
        />
      </Field>

      <If
        when={transport() === "stdio"}
        else={
          <>
            <Field label={t("web.runtime.mcpServer.url")}>
              <TextInput
                testID="mcp-server-url"
                accessibilityLabel={t("web.runtime.mcpServer.url")}
                placeholder="https://mcp.example.com/mcp"
                class="font-mono"
                value={url()}
                onInput={(v) => url.set(v)}
                onSubmit={submit}
              />
            </Field>
            <Field label={t("web.runtime.mcpServer.headers")}>
              <KeyValueEditor value={headers()} onChange={(next) => headers.set(next)} />
            </Field>
          </>
        }
      >
        <>
          <Field label={t("web.runtime.mcpServer.command")}>
            <TextInput
              testID="mcp-server-command"
              accessibilityLabel={t("web.runtime.mcpServer.command")}
              placeholder="npx"
              class="font-mono"
              value={command()}
              onInput={(v) => command.set(v)}
              onSubmit={submit}
            />
          </Field>
          <Field label={t("web.runtime.mcpServer.args")} hint={t("web.runtime.mcpServer.argsHint")}>
            <TextInput
              testID="mcp-server-args"
              accessibilityLabel={t("web.runtime.mcpServer.args")}
              placeholder="-y @upstash/context7-mcp"
              class="font-mono"
              value={argsText()}
              onInput={(v) => argsText.set(v)}
              onSubmit={submit}
            />
          </Field>
          <Field label={t("web.runtime.mcpServer.env")}>
            <KeyValueEditor value={env()} onChange={(next) => env.set(next)} />
          </Field>
        </>
      </If>

      <Toggle testid="mcp-server-enabled" label={t("web.runtime.mcpServer.enabled")} checked={enabled()} onChange={(next) => enabled.set(next)} />

      <View class="flex-row items-center justify-end gap-2 border-t border-line pt-3">
        <Button size="compact" tone="quiet" testID="mcp-server-cancel" onPress={() => props.onClose()}>
          {t("web.runtime.mcpServer.cancel")}
        </Button>
        <Button size="compact" tone="primary" testID="mcp-server-save" disabled={!valid() || saving.busy()} onPress={submit}>
          {t("web.runtime.mcpServer.save")}
        </Button>
      </View>
    </View>
  );
}

function ReadonlyInventoryList(props: { entries: InventoryEntry[] | null }) {
  return (
    <If
      when={props.entries}
      else={
        <View class="px-3.5 py-3">
          <Quiet>{t("web.runtime.unreported")}</Quiet>
        </View>
      }
    >
      {(entries) => (
        <If
          when={entries().length > 0}
          else={
            <View class="px-3.5 py-3">
              <Quiet>{t("web.runtime.none")}</Quiet>
            </View>
          }
        >
          <Each of={entries()} key={(e) => `${e.name}:${e.source ?? ""}`}>
            {(e, i) => (
              <View class={`min-w-0 gap-0.5 px-3.5 py-2.5 ${i() === entries().length - 1 ? "" : "border-b border-line"}`}>
                <View class="min-w-0 flex-row items-center justify-between gap-2">
                  <Text class={`min-w-0 flex-1 truncate font-mono text-xs ${e().enabled === false ? "text-muted line-through" : "text-ink"}`}>{e().name}</Text>
                  <If when={e().enabled === false}>
                    <View class="shrink-0 rounded-full bg-hover px-1.5 py-px">
                      <Text class="text-2xs text-faint">{t("web.runtime.mcpServer.disabledTag")}</Text>
                    </View>
                  </If>
                </View>
                <If when={e().description}>
                  <View class="min-w-0" tooltip={<Bubble text={e().description} />}>
                    <Text class="truncate text-2xs text-muted">{e().description}</Text>
                  </View>
                </If>
                <If when={e().source}>
                  <View class="min-w-0" tooltip={<Bubble text={e().source} />}>
                    <Text class="truncate font-mono text-2xs text-faint">{e().source}</Text>
                  </View>
                </If>
              </View>
            )}
          </Each>
        </If>
      )}
    </If>
  );
}

function McpInventoryCard(props: {
  title: string;
  host: McpHostId;
  fallbackEntries: InventoryEntry[] | null;
  onSynced?: ((host: McpHostId, servers: readonly McpServerEntry[]) => void) | undefined;
}) {
  const client = useQueryClient();
  const query = useQuery(() => mcpServerListQuery(props.host));
  const error = signal<string | undefined>(undefined);
  const busyName = signal<string | undefined>(undefined);
  const dialogState = signal<{ open: boolean; editing?: McpServerEntry | undefined }>({ open: false });
  const act = createAct((reason) => error.set(reason));

  const servers = computed(() => query.data()?.servers);
  const countNote = computed(() => {
    const list = servers();
    if (list) return String(list.length);
    return props.fallbackEntries ? String(props.fallbackEntries.length) : undefined;
  });

  const applyResult = (result: McpServerListResult) => {
    client.setData(mcpServerListQuery(result.host), () => ({ value: result }));
    props.onSynced?.(result.host, result.servers);
  };

  const toggleServer = (entry: McpServerEntry, nextEnabled: boolean) => {
    if (act.busy()) return;
    error.set(undefined);
    busyName.set(entry.name);
    void act
      .run(async () => {
        const result = await api.runtime.mcpServer.toggle({ host: props.host, name: entry.name, enabled: nextEnabled });
        applyResult(result);
        toast(t("web.runtime.mcpServer.toggledToast", { name: entry.name, enabled: nextEnabled }));
      })
      .finally(() => {
        if (busyName() === entry.name) busyName.set(undefined);
      });
  };

  const removeServer = (entry: McpServerEntry) => {
    if (act.busy()) return;
    error.set(undefined);
    busyName.set(entry.name);
    void act
      .run(async () => {
        const result = await api.runtime.mcpServer.remove({ host: props.host, name: entry.name });
        applyResult(result);
        toast(t("web.runtime.mcpServer.removedToast", { name: entry.name }));
      })
      .finally(() => {
        if (busyName() === entry.name) busyName.set(undefined);
      });
  };

  return (
    <>
      <SettingsGroup
        title={props.title}
        note={countNote()}
        testid="runtime-mcp-card"
        action={
          <IconButton
            icon="add"
            size={14}
            label={t("web.runtime.mcpServer.add")}
            testid="mcp-server-add"
            onClick={() => {
              error.set(undefined);
              dialogState.set({ open: true });
            }}
          />
        }
      >
        <If when={error()}>
          {(err) => (
            <Banner tone="bad" size="sm" role="alert" testID="mcp-server-error" edge>
              {err()}
            </Banner>
          )}
        </If>
        <If when={servers()} else={<ReadonlyInventoryList entries={props.fallbackEntries} />}>
          {(list) => (
            <If
              when={list().length > 0}
              else={
                <View class="px-3.5 py-3">
                  <Quiet>{t("web.runtime.none")}</Quiet>
                </View>
              }
            >
              <Each of={list()} key={(s) => `${s.host}:${s.name}`}>
                {(s, i) => {
                  const target = () => mcpEntryTarget(s());
                  const rowBusy = () => busyName() === s().name;
                  return (
                    <View
                      testID={`mcp-server-row-${s().name}`}
                      class={`min-w-0 gap-1 px-3.5 py-2.5 ${i() === list().length - 1 ? "" : "border-b border-line"}`}
                    >
                      <View class="min-w-0 flex-row items-center justify-between gap-2">
                        <View class="min-w-0 flex-1 flex-row items-center gap-1.5 overflow-hidden">
                          <View class="min-w-0 shrink" tooltip={<Bubble text={s().name} />}>
                            <Text class={`min-w-0 shrink truncate font-mono text-xs font-medium ${s().enabled ? "text-ink" : "text-muted line-through"}`}>
                              {s().name}
                            </Text>
                          </View>
                          <View class="shrink-0 rounded-sm bg-hover px-1.5 py-px">
                            <Text class="font-mono text-2xs text-muted">{s().transport === "streamableHttp" ? "http" : "stdio"}</Text>
                          </View>
                        </View>
                        <View class="shrink-0 flex-row items-center gap-1.5">
                          <Toggle
                            bare
                            testid={`mcp-server-toggle-${s().name}`}
                            ariaLabel={t("web.runtime.mcpServer.toggle", { name: s().name })}
                            checked={s().enabled}
                            disabled={rowBusy()}
                            onChange={(next) => toggleServer(s(), next)}
                          />
                          <IconButton
                            icon="edit"
                            size={12}
                            label={t("web.runtime.mcpServer.edit", { name: s().name })}
                            testid={`mcp-server-edit-${s().name}`}
                            disabled={act.busy()}
                            onClick={() => {
                              error.set(undefined);
                              dialogState.set({ open: true, editing: s() });
                            }}
                          />
                          <IconButton
                            icon="delete"
                            size={12}
                            label={t("web.runtime.mcpServer.remove", { name: s().name })}
                            testid={`mcp-server-remove-${s().name}`}
                            disabled={rowBusy()}
                            onClick={() => removeServer(s())}
                          />
                        </View>
                      </View>
                      <If when={target()}>
                        <View class="min-w-0" tooltip={<Bubble text={target()} />}>
                          <Text class="truncate font-mono text-2xs text-muted">{target()}</Text>
                        </View>
                      </If>
                      <View class="min-w-0 flex-row items-center justify-between gap-2">
                        <View class="min-w-0 flex-1" tooltip={<Bubble text={s().configPath} />}>
                          <Text class="truncate font-mono text-2xs text-faint">{s().configPath}</Text>
                        </View>
                        <Text class={`shrink-0 text-2xs ${s().enabled ? "text-ok-ink" : "text-faint"}`}>
                          {s().enabled ? t("web.runtime.mcpServer.enabledTag") : t("web.runtime.mcpServer.disabledTag")}
                        </Text>
                      </View>
                    </View>
                  );
                }}
              </Each>
            </If>
          )}
        </If>
      </SettingsGroup>

      <Dialog
        open={dialogState().open}
        onClose={() => dialogState.set({ open: false })}
        title={dialogState().editing ? t("web.runtime.mcpServer.editTitle") : t("web.runtime.mcpServer.addTitle")}
        size="md"
        testid="mcp-server-dialog"
      >
        <If when={dialogState().open}>
          <McpServerForm host={props.host} initial={dialogState().editing} onClose={() => dialogState.set({ open: false })} onSaved={applyResult} />
        </If>
      </Dialog>
    </>
  );
}

export function InventoryCard(props: {
  title: string;
  entries: InventoryEntry[] | null;
  mcpHost?: McpHostId | undefined;
  onMcpServersSynced?: ((host: McpHostId, servers: readonly McpServerEntry[]) => void) | undefined;
}) {
  return (
    <If
      when={props.mcpHost}
      else={
        <SettingsGroup title={props.title} note={props.entries ? String(props.entries.length) : undefined}>
          <ReadonlyInventoryList entries={props.entries} />
        </SettingsGroup>
      }
    >
      {(host) => <McpInventoryCard title={props.title} host={host()} fallbackEntries={props.entries} onSynced={props.onMcpServersSynced} />}
    </If>
  );
}
