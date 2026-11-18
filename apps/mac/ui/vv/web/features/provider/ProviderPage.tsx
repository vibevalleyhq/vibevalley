// Ported from VibeValley apps/web/src/features/provider/ProviderPage.tsx: the
// MOSS accounts (on the accounts page) and the uses each feature is bound to.
// The <fieldset> is a View (each control is disabled on its own); the
// adapted models' <details> is a fold opened by its summary.
import { signal, Text, untracked, View } from "nsh";

import { list, t } from "@vibevalley/i18n";
import type { ProviderConnectionUpdate, ProviderModelListing, ProviderStatus, ProviderUpdate } from "@vibevalley/protocol";
import { same } from "@vibevalley/protocol/rules";

import { api, reasonOf } from "../../infra/api";
import { providerQuery, ready, settingsQuery, useQuery, useQueryClient } from "../../infra/query";
import { Link } from "../../infra/router";
import { createAct } from "../../ui/act";
import { Button } from "../../ui/Button";
import { Checkbox } from "../../ui/Checkbox";
import { ConfirmButton } from "../../ui/ConfirmButton";
import { SettingsPage } from "../../ui/domain/settings";
import { Field, Select, TextInput } from "../../ui/Field";
import { Icon } from "../../ui/Icon";
import { OutLink } from "../../ui/IconButton";
import { KeyField, SaveBar } from "../../ui/KeyField";
import { Card, Quiet, SecretInput } from "../../ui/layout";
import { Hint } from "../../ui/Tip";

/** The uses an account serves, in the order the uses table shows them: what the account page lists as its models. */
const adaptedUses = ["image", "understanding", "dictation", "speech", "speakers", "voiceDesign", "transcription", "live", "vision"] as const;

type Use = (typeof adaptedUses)[number];
type UseHint = "imageNotice" | "understandingNotice" | "modelHint" | "speechNotice" | "liveHint";

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
    uses: [
      { use: "dictation", hint: "modelHint" },
      { use: "speech", hint: "speechNotice" },
      { use: "speakers" },
      { use: "voiceDesign" },
      { use: "transcription" },
    ],
  },
  { title: "groupLive", uses: [{ use: "live", hint: "liveHint" }, { use: "vision" }] },
];

const editable = (status: ProviderStatus): ProviderUpdate => ({
  revision: status.revision,
  connections: status.connections.map(({ key: _key, ...connection }) => connection),
  dictation: status.dictation,
  image: status.image,
  understanding: status.understanding,
  speech: status.speech,
  live: status.live,
  speakers: status.speakers,
  voiceDesign: status.voiceDesign,
  transcription: status.transcription,
  vision: status.vision,
});

/** Which of the providers' settings a place shows: the MOSS accounts (with the other keys, on the accounts page), or
 * the uses each feature is bound to. Each saves the whole settings, its own part changed. */
type ProviderPart = "accounts" | "uses";

function Provider(props: { part: ProviderPart }) {
  const query = useQuery(providerQuery);
  return (
    <If when={ready(query, undefined)} else={<Quiet>{query.error() ? reasonOf(query.error()) : t("web.base.form.asking")}</Quiet>}>
      {(status) => <ProviderForm initial={untracked(status)} part={props.part} />}
    </If>
  );
}

/** The uses: which account and model each feature calls. */
export function ProviderPage() {
  return (
    <SettingsPage title={t("web.provider.title")} hint={t("web.provider.intro")}>
      <Provider part="uses" />
    </SettingsPage>
  );
}

/** The MOSS accounts, for the accounts page. */
export function MossAccounts() {
  return <Provider part="accounts" />;
}

function ProviderForm(props: { initial: ProviderStatus; part: ProviderPart }) {
  const start = untracked(() => props.initial);
  const base = signal(start);
  const draft = signal(editable(start));
  const listing = signal<ProviderModelListing | undefined>(undefined);
  const error = signal<string | undefined>(undefined);
  const client = useQueryClient();
  const act = createAct(error.set);
  const dirty = () => !same(draft(), editable(base()));
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
  const choices = () => draft().connections.map((connection) => ({ value: connection.id, label: connection.name || "MOSS" }));
  const bind = (use: Use, connection: string) => {
    const current = draft();
    draft.set({ ...current, [use]: connection ? { connection, model: current[use]?.model ?? base()[`${use}Models`][0] ?? "" } : null });
  };
  const pickModel = (use: Use, model: string) => {
    const current = draft();
    const binding = current[use];
    draft.set({ ...current, [use]: binding ? { ...binding, model } : null });
  };
  return (
    <View accessibilityLabel={t("web.provider.title")} class="min-w-0 max-w-3xl gap-6" testID="provider-form">
      <If when={props.part === "accounts"}>
        <View class="min-w-0 gap-3">
          <View class="flex-row flex-wrap items-center gap-2">
            <Text role="header" class="flex-1 text-sm font-semibold text-ink">
              MOSS
            </Text>
            <OutLink href="https://platform.moss.cn/" label={t("web.provider.console")} />
            <ConfirmButton
              testid="provider-reload"
              label={t("web.provider.reload")}
              question={t("web.provider.reloadAsk")}
              disabled={act.busy()}
              onConfirm={() => void reload()}
            />
            <Button
              testID="provider-add"
              disabled={act.busy() || draft().connections.length >= 32}
              onPress={() =>
                draft.set({ ...draft(), connections: [...draft().connections, { id: crypto.randomUUID(), name: "MOSS", adapter: "moss", enabled: true }] })
              }
            >
              {t("web.provider.add")}
            </Button>
          </View>
          <If when={draft().connections.length === 0}>
            <Quiet>{t("web.provider.empty")}</Quiet>
          </If>
          <Each of={draft().connections} key={(connection) => connection.id}>
            {(connection) => (
              <Card
                title={connection().name || "MOSS"}
                testid="provider-connection"
                item={connection().id}
                class="min-w-0"
                action={
                  <View class="flex-row flex-wrap items-center gap-2">
                    <Button testID="provider-models" disabled={act.busy() || dirty()} onPress={() => void discover(connection().id)}>
                      {t("web.provider.discover")}
                    </Button>
                    <ConfirmButton
                      testid="provider-delete"
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
                    <View class="h-7 flex-row items-center gap-2">
                      <Checkbox
                        testid="provider-enabled"
                        label={t("web.provider.enabled")}
                        checked={connection().enabled}
                        disabled={act.busy()}
                        onChange={(enabled) => change(connection().id, { enabled })}
                      />
                      <Text class="text-sm text-ink">{t("web.provider.enabled")}</Text>
                    </View>
                  </View>
                  <View testID="provider-key">
                    <KeyField
                      label="API Key"
                      status={base().connections.find((item) => item.id === connection().id)?.key ?? { source: null }}
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
                  <Text class="text-xs text-muted">{dirty() ? t("web.provider.saveFirst") : t("web.provider.discoveryHint")}</Text>
                  <If when={!dirty() && listing()?.revision === base().revision && listing()?.connection === connection().id ? listing() : undefined}>
                    {(result) => (
                      <View testID="provider-model-list" class="max-h-48">
                        <If when={result().models.length > 0} else={<Quiet>{t("web.provider.noModels")}</Quiet>}>
                          <View class="gap-1">
                            <Each of={result().models}>{(model) => <Text class="font-mono text-sm text-ink">{model().id}</Text>}</Each>
                          </View>
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
      <If when={props.part === "uses"}>
        <Card title={t("web.provider.uses")}>
          <Text class="text-xs text-muted">{t("web.provider.usesIntro")}</Text>
          <View class="min-w-0">
            <Each of={useGroups}>
              {(group) => (
                <View>
                  <Text class="pt-3 pb-1 text-xs font-semibold text-muted">{t(`web.provider.${group().title}`)}</Text>
                  <Each of={group().uses}>
                    {(item) => {
                      const use = item().use;
                      const name = t(`web.provider.use.${use}`);
                      return (
                        <View testID={`provider-use-${use}`} class="min-w-0 flex-row flex-wrap items-center gap-x-3 gap-y-1 border-t border-line py-2">
                          <View class="w-32 flex-row flex-wrap items-center gap-1.5">
                            <Text class="text-sm text-ink">{name}</Text>
                            <If when={item().hint}>{(h) => <Hint text={t(`web.provider.${h()}`)} />}</If>
                            <If when={use === "speech"}>
                              <Link href="/library?make=speech" testID="provider-speech-open">
                                <Text class="text-xs text-water underline">{t("web.provider.openSpeechShort")}</Text>
                              </Link>
                            </If>
                          </View>
                          <View class="min-w-60 flex-1 flex-row gap-2">
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
                              <If when={draft()[use]}>
                                <Select
                                  label={t("web.provider.modelFor", { use: name })}
                                  testid={`provider-${use}-model`}
                                  disabled={act.busy()}
                                  value={draft()[use]?.model ?? ""}
                                  options={base()[`${use}Models`].map((model) => ({ value: model, label: model }))}
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
              )}
            </Each>
          </View>
          <Text class="text-xs text-muted">{t("web.provider.bindingHint")}</Text>
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
              <Text testID="provider-error" role="alert" class="text-sm text-berry">
                {why()}
              </Text>
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
  return (
    <View testID="provider-adapted" class="gap-1">
      <View
        role="button"
        testID="provider-adapted-toggle"
        accessibilityState={{ expanded: open() }}
        onPress={() => open.set(!open())}
        class="flex-row items-center gap-1"
      >
        <View style={{ transform: [{ rotate: open() ? "90deg" : "0deg" }] }}>
          <Icon name="expand" size={12} tone="muted" />
        </View>
        <Text class="text-xs text-muted">{t("web.provider.adapted")}</Text>
      </View>
      <If when={open()}>
        <View class="gap-1">
          <Each of={adaptedUses}>
            {(use) => (
              <Text class="text-sm text-ink">
                {t(`web.provider.use.${use()}`)}
                <Text class="text-xs text-muted"> {list(props.status[`${use()}Models`])}</Text>
              </Text>
            )}
          </Each>
        </View>
      </If>
    </View>
  );
}
