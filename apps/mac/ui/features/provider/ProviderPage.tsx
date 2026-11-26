import { computed, Scroll, signal, Text, untracked, View } from "nsh";

import { list, t } from "@vibevalley/i18n";
import {
  type Feature,
  FeatureValues,
  type ProviderConnectionUpdate,
  type ProviderModelListing,
  type ProviderStatus,
  type ProviderUpdate,
} from "@vibevalley/protocol";
import { same } from "@vibevalley/protocol/rules";

import { createAct } from "../../design/act";
import { Button } from "../../design/Button";
import { Checkbox } from "../../design/Checkbox";
import { ConfirmButton } from "../../design/ConfirmButton";
import { Field, Select, TextInput } from "../../design/Field";
import { Icon } from "../../design/Icon";
import { OutLink } from "../../design/IconButton";
import { KeyField, SaveBar } from "../../design/KeyField";
import { Card, Quiet, SecretInput } from "../../design/layout";
import { motionClass } from "../../design/motion";
import { Dot } from "../../design/Tag";
import { Bubble, Hint } from "../../design/Tip";
import { mix } from "../../design/tone";
import { api, reasonOf } from "../../infra/api";
import { providerQuery, ready, settingsQuery, useQuery, useQueryClient } from "../../infra/query";
import { Link } from "../../infra/router";

/** The uses an account serves, in the order the uses table shows them: what the account page lists as its models. */
const adaptedUses = FeatureValues.filter((f): f is Exclude<Feature, "orchestrator" | "call"> => f !== "orchestrator" && f !== "call");

type Use = (typeof adaptedUses)[number];
type UseHint = "imageNotice" | "understandingNotice" | "speechNotice" | "liveHint";

/** The uses a connection serves, in the groups the page shows them in; each one's words where it needs some. */
const useGroups: readonly { title: "groupImage" | "groupVoice" | "groupLive"; uses: readonly { use: Use; hint?: UseHint }[] }[] = [
  {
    title: "groupImage",
    uses: [
      { use: "image", hint: "imageNotice" },
      { use: "understanding", hint: "understandingNotice" },
    ],
  },
  {
    title: "groupVoice",
    uses: [{ use: "speech", hint: "speechNotice" }, { use: "speakers" }, { use: "voiceDesign" }, { use: "transcription" }],
  },
  { title: "groupLive", uses: [{ use: "live", hint: "liveHint" }, { use: "vision" }] },
];

const editable = (status: ProviderStatus): ProviderUpdate => ({
  revision: status.revision,
  connections: status.connections.map(({ key: _key, ...connection }) => connection),
  image: status.image,
  understanding: status.understanding,
  speech: status.speech,
  live: status.live,
  speakers: status.speakers,
  voiceDesign: status.voiceDesign,
  transcription: status.transcription,
  vision: status.vision,
});

/** Which of the providers' settings a place shows: the MOSS accounts, the uses each feature is bound to, or both in one form. */
type ProviderPart = "accounts" | "uses" | "all";

function Provider(props: { part: ProviderPart }) {
  const query = useQuery(providerQuery);
  return (
    <If when={ready(query, undefined)} else={<Quiet>{query.error() ? reasonOf(query.error()) : t("web.base.form.asking")}</Quiet>}>
      {(status) => <ProviderForm initial={untracked(status)} part={props.part} />}
    </If>
  );
}

export function ProviderModels() {
  return <Provider part="all" />;
}

function ProviderForm(props: { initial: ProviderStatus; part: ProviderPart }) {
  const start = untracked(() => props.initial);
  const base = signal(start);
  const draft = signal(editable(start));
  const listing = signal<ProviderModelListing | undefined>(undefined);
  const error = signal<string | undefined>(undefined);
  const client = useQueryClient();
  const act = createAct((v) => error.set(v));
  const dirty = computed(() => !same(draft(), editable(base())));
  const baseById = computed(() => new Map(base().connections.map((item) => [item.id, item])));
  const accept = (status: ProviderStatus) => {
    base.set(status);
    draft.set(editable(status));
    listing.set(undefined);
    error.set(undefined);
    client.setData(providerQuery(), () => ({ value: status }));
  };
  const change = (id: string, patch: Partial<ProviderConnectionUpdate>) => {
    draft.set({
      ...draft(),
      connections: draft().connections.map((connection) => {
        if (connection.id !== id) return connection;
        const { key, ...rest } = { ...connection, ...patch };
        return key === undefined ? rest : { ...rest, key };
      }),
    });
    error.set(undefined);
  };
  const keepKey = (id: string) =>
    draft.set({
      ...draft(),
      connections: draft().connections.map((connection) => {
        if (connection.id !== id) return connection;
        const { key: _key, ...rest } = connection;
        return rest;
      }),
    });
  const save = () => {
    const input = draft();
    return act.run(async () => {
      accept(await api.provider.update(input));
      await client.invalidate({ key: settingsQuery().key });
    });
  };
  const reload = () => act.run(async () => accept(await api.provider.get()));
  const discover = (connection: string) => {
    const revision = base().revision;
    listing.set(undefined);
    error.set(undefined);
    return act.run(async () => listing.set(await api.provider.model.list({ connection, revision })));
  };
  const choices = computed(() => draft().connections.map((connection) => ({ value: connection.id, label: connection.name || "MOSS" })));
  const canAdd = computed(() => !act.busy() && draft().connections.length < 32);
  const bind = (use: Use, connection: string) => {
    const current = draft();
    draft.set({ ...current, [use]: connection ? { connection, model: current[use]?.model ?? base()[`${use}Models`][0] ?? "" } : null });
  };
  const pickModel = (use: Use, model: string) => {
    const current = draft();
    const binding = current[use];
    draft.set({ ...current, [use]: binding ? { ...binding, model } : null });
  };
  const boundCount = computed(() => adaptedUses.filter((use) => Boolean(draft()[use])).length);
  return (
    <View accessibilityLabel={t("web.provider.title")} class="min-w-0 max-w-4xl gap-6" testID="provider-form">
      <If when={props.part !== "uses"}>
        <View class="min-w-0 gap-3">
          <View class="flex-row flex-wrap items-center gap-2">
            <View class="min-w-0 flex-1 flex-row items-center gap-2">
              <Text role="header" class="text-sm font-semibold text-ink">
                MOSS
              </Text>
              <If when={draft().connections.length > 0}>
                <View class="rounded-sm bg-hover px-1.5 py-0.5">
                  <Text class="text-2xs font-medium text-muted tabular-nums">{draft().connections.length}</Text>
                </View>
              </If>
            </View>
            <OutLink href="https://platform.moss.cn/" label={t("web.provider.console")} />
            <ConfirmButton
              testid="provider-reload"
              icon="refresh"
              label={t("web.provider.reload")}
              question={t("web.provider.reloadAsk")}
              disabled={act.busy()}
              onConfirm={() => void reload()}
            />
            <Button
              testID="provider-add"
              icon="add"
              disabled={!canAdd()}
              onPress={() =>
                draft.set({ ...draft(), connections: [...draft().connections, { id: crypto.randomUUID(), name: "MOSS", adapter: "moss", enabled: true }] })
              }
            >
              {t("web.provider.add")}
            </Button>
          </View>
          <If when={draft().connections.length === 0}>
            <View class="items-center gap-2 rounded-lg border border-line bg-side px-4 py-6">
              <Icon name="plug" size={20} tone="faint" />
              <Quiet>{t("web.provider.empty")}</Quiet>
            </View>
          </If>
          <Each of={draft().connections} key={(connection) => connection.id}>
            {(connection) => (
              <Card
                title={
                  <View class="min-w-0 flex-row items-center gap-2">
                    <Dot tone={connection().enabled ? "leaf" : "idle"} size={7} ring={false} />
                    <Text role="header" class={`min-w-0 truncate text-base font-semibold ${connection().enabled ? "text-ink" : "text-muted"}`}>
                      {connection().name || "MOSS"}
                    </Text>
                    <View class="shrink-0 rounded-sm bg-side px-1.5 py-0.5">
                      <Text class="font-mono text-2xs text-muted">{connection().adapter}</Text>
                    </View>
                  </View>
                }
                testid="provider-connection"
                item={connection().id}
                class="min-w-0"
                action={
                  <View class="flex-row flex-wrap items-center gap-2">
                    <Button
                      testID="provider-models"
                      icon="search"
                      tooltip={<Bubble text={dirty() ? t("web.provider.saveFirst") : t("web.provider.discoveryHint")} />}
                      disabled={act.busy() || dirty()}
                      onPress={() => void discover(connection().id)}
                    >
                      {t("web.provider.discover")}
                    </Button>
                    <ConfirmButton
                      testid="provider-delete"
                      tone="danger"
                      icon="delete"
                      label={t("web.provider.remove")}
                      question={t("web.provider.removeAsk")}
                      disabled={act.busy()}
                      onConfirm={() => {
                        const id = connection().id;
                        draft.set({ ...draft(), connections: draft().connections.filter((item) => item.id !== id) });
                      }}
                    />
                  </View>
                }
              >
                <View class="min-w-0 gap-3">
                  <View class="flex-row flex-wrap items-end gap-3">
                    <View class="min-w-48 flex-1">
                      <Field label={t("web.provider.name")}>
                        <TextInput
                          testID="provider-name"
                          accessibilityLabel={t("web.provider.name")}
                          disabled={act.busy()}
                          value={connection().name}
                          onInput={(name) => change(connection().id, { name })}
                        />
                      </Field>
                    </View>
                    <View class="h-8 flex-row items-center gap-2 rounded-md px-2 hover:bg-hover">
                      <Checkbox
                        testid="provider-enabled"
                        label={t("web.provider.enabled")}
                        checked={connection().enabled}
                        disabled={act.busy()}
                        onChange={(enabled) => change(connection().id, { enabled })}
                      />
                      <View role="button" disabled={act.busy()} onPress={() => change(connection().id, { enabled: !connection().enabled })}>
                        <Text class="text-sm text-ink">{t("web.provider.enabled")}</Text>
                      </View>
                    </View>
                  </View>
                  <View testID="provider-key">
                    <KeyField
                      label="API Key"
                      status={baseById().get(connection().id)?.key ?? { source: null }}
                      removing={connection().key === null}
                      onRemove={(remove) => (remove ? change(connection().id, { key: null }) : keepKey(connection().id))}
                    >
                      <SecretInput
                        testID="secret"
                        accessibilityLabel="MOSS API Key"
                        disabled={act.busy() || connection().key === null}
                        value={connection().key ?? ""}
                        placeholder={t("web.base.form.keepEmpty")}
                        onInput={(value) => (value ? change(connection().id, { key: value }) : keepKey(connection().id))}
                      />
                    </KeyField>
                  </View>
                  <Adapted status={base()} />
                  <View
                    class={`flex-row items-start gap-2 rounded-md px-3 py-2 ${dirty() ? "" : "bg-side"}`}
                    style={dirty() ? { backgroundColor: mix("wheat", 0.18) } : undefined}
                  >
                    <View class="mt-0.5 shrink-0">
                      <Icon name={dirty() ? "warn" : "info"} size={12} tone="faint" />
                    </View>
                    <Text class={`min-w-0 flex-1 text-xs leading-relaxed ${dirty() ? "font-medium text-warn-ink" : "text-muted"}`}>
                      {dirty() ? t("web.provider.saveFirst") : t("web.provider.discoveryHint")}
                    </Text>
                  </View>
                  <If when={!dirty() && listing()?.revision === base().revision && listing()?.connection === connection().id ? listing() : undefined}>
                    {(result) => (
                      <View testID="provider-model-list" class="gap-2 rounded-md bg-side p-2.5">
                        <If when={result().models.length > 0} else={<Quiet>{t("web.provider.noModels")}</Quiet>}>
                          <View class="flex-row items-center justify-between gap-2 border-b border-line pb-1.5">
                            <Text class="text-xs font-medium text-muted">{t("web.provider.discover")}</Text>
                            <View class="rounded-sm bg-hover px-1.5 py-0.5">
                              <Text class="text-2xs font-medium text-muted tabular-nums">{result().models.length}</Text>
                            </View>
                          </View>
                          <Scroll class="max-h-48" contentClass="gap-0.5">
                            <Each of={result().models} key={(model) => model.id}>
                              {(model) => (
                                <View class="rounded-sm px-1.5 py-0.5 hover:bg-hover">
                                  <Text class="font-mono text-xs text-ink">{model().id}</Text>
                                </View>
                              )}
                            </Each>
                          </Scroll>
                        </If>
                      </View>
                    )}
                  </If>
                </View>
              </Card>
            )}
          </Each>
        </View>
      </If>
      <If when={props.part !== "accounts"}>
        <Card
          title={t("web.provider.uses")}
          action={
            <View class={`h-5 flex-row items-center rounded-sm px-1.5 ${boundCount() > 0 ? "bg-ok-soft" : "bg-hover"}`}>
              <Text class={`text-2xs font-medium tabular-nums ${boundCount() > 0 ? "text-ok-ink" : "text-muted"}`}>
                {`${boundCount()}/${adaptedUses.length}`}
              </Text>
            </View>
          }
        >
          <Text class="text-xs leading-relaxed text-muted">{t("web.provider.usesIntro")}</Text>
          <View class="min-w-0">
            <Each of={useGroups} key={(g) => g.title}>
              {(group) => {
                const groupBound = computed(() => group().uses.filter((entry) => Boolean(draft()[entry.use])).length);
                return (
                  <View>
                    <View class="flex-row items-center justify-between gap-2 pt-3 pb-1.5">
                      <Text class="text-xs font-semibold text-muted">{t(`web.provider.${group().title}`)}</Text>
                      <Text class="text-2xs text-faint tabular-nums">{`${groupBound()}/${group().uses.length}`}</Text>
                    </View>
                    <Each of={group().uses} key={(entry) => entry.use}>
                      {(item) => {
                        const use = item().use;
                        const name = t(`web.provider.use.${use}`);
                        const bound = computed(() => Boolean(draft()[use]));
                        const modelOptions = computed(() => base()[`${use}Models`].map((model) => ({ value: model, label: model })));
                        return (
                          <View testID={`provider-use-${use}`} class="min-w-0 flex-row flex-wrap items-center gap-x-3 gap-y-1.5 border-t border-line py-2.5">
                            <View class="w-40 shrink-0 flex-row flex-wrap items-center gap-1.5">
                              <Dot tone={bound() ? "leaf" : "idle"} size={6} ring={false} />
                              <Text class={`text-sm ${bound() ? "font-medium text-ink" : "text-muted"}`}>{name}</Text>
                              <If when={item().hint}>{(h) => <Hint text={t(`web.provider.${h()}`)} />}</If>
                              <If when={use === "speech"}>
                                <Link
                                  href="/library?make=speech"
                                  testID="provider-speech-open"
                                  class="rounded-sm px-1 py-0.5 hover:bg-hover focus-visible:outline-2 focus-visible:outline-focus"
                                >
                                  <Text class="text-xs font-medium text-water underline">{t("web.provider.openSpeechShort")}</Text>
                                </Link>
                              </If>
                            </View>
                            <View class="min-w-60 flex-1 flex-row items-center gap-2">
                              <Select
                                label={t("web.provider.connectionFor", { use: name })}
                                testid={`provider-${use}`}
                                class="flex-1"
                                placeholder={t("web.provider.unbound")}
                                disabled={act.busy()}
                                value={draft()[use]?.connection ?? ""}
                                options={choices()}
                                onChange={(connection) => bind(use, connection)}
                              />
                              <View class="flex-1">
                                <If
                                  when={draft()[use]}
                                  else={
                                    <View class="h-8 justify-center rounded-md bg-side px-2.5">
                                      <Text class="text-xs text-faint">—</Text>
                                    </View>
                                  }
                                >
                                  <Select
                                    label={t("web.provider.modelFor", { use: name })}
                                    testid={`provider-${use}-model`}
                                    disabled={act.busy()}
                                    value={draft()[use]?.model ?? ""}
                                    options={modelOptions()}
                                    onChange={(model) => pickModel(use, model)}
                                  />
                                </If>
                              </View>
                            </View>
                          </View>
                        );
                      }}
                    </Each>
                  </View>
                );
              }}
            </Each>
          </View>
          <View class="flex-row items-start gap-2 rounded-md bg-side px-3 py-2">
            <View class="mt-0.5 shrink-0">
              <Icon name="info" size={12} tone="faint" />
            </View>
            <Text class="min-w-0 flex-1 text-xs leading-relaxed text-muted">{t("web.provider.bindingHint")}</Text>
          </View>
        </Card>
      </If>
      <SaveBar
        dirty={dirty()}
        busy={act.busy()}
        onSave={() => void save()}
        onUndo={() => accept(base())}
        left={
          <If when={error()}>
            {(why) => (
              <View class="flex-row items-center gap-1.5 self-start rounded-md bg-bad-soft px-2.5 py-1">
                <Icon name="cross" size={12} />
                <Text testID="provider-error" role="alert" class="min-w-0 text-xs font-medium text-berry">
                  {why()}
                </Text>
              </View>
            )}
          </If>
        }
      />
    </View>
  );
}

/** What models each use has on this account: <details> closed until its summary is pressed. */
function Adapted(props: { status: ProviderStatus }) {
  const open = signal(false);
  const total = computed(() => adaptedUses.reduce((sum, use) => sum + props.status[`${use}Models`].length, 0));
  return (
    <View testID="provider-adapted" class="gap-1.5">
      <View
        role="button"
        testID="provider-adapted-toggle"
        accessibilityState={{ expanded: open() }}
        onPress={() => open.set(!open())}
        class="flex-row items-center gap-1.5 rounded-md px-2 py-1.5 hover:bg-hover focus-visible:outline-2 focus-visible:outline-focus"
      >
        <View
          class={`size-3.5 shrink-0 items-center justify-center ${motionClass("transition-transform duration-120 ease-out")}`}
          style={{ transform: [{ rotate: open() ? "90deg" : "0deg" }] }}
        >
          <Icon name="expand" size={10} tone="muted" />
        </View>
        <Text class="min-w-0 flex-1 text-xs font-medium text-muted">{t("web.provider.adapted")}</Text>
        <View class="shrink-0 rounded-sm bg-hover px-1.5 py-0.5">
          <Text class="text-2xs font-medium text-muted tabular-nums">{total()}</Text>
        </View>
      </View>
      <If when={open()}>
        <View class="rounded-md bg-side px-3 py-1.5">
          <Each of={adaptedUses}>
            {(use) => (
              <View class={`flex-row items-baseline gap-3 py-1.5 ${use() === adaptedUses[0] ? "" : "border-t border-line"}`}>
                <Text class="w-24 shrink-0 text-xs font-medium text-muted">{t(`web.provider.use.${use()}`)}</Text>
                <Text class="min-w-0 flex-1 font-mono text-xs text-ink">{list(props.status[`${use()}Models`])}</Text>
              </View>
            )}
          </Each>
        </View>
      </If>
    </View>
  );
}
