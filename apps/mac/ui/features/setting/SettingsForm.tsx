import { signal, Text, untracked, View } from "nsh";

import { setLocale, t, currentLocale } from "@vibevalley/i18n";
import {
  type GitHubStatus,
  type Locale,
  LocaleValues,
  type MemorySource,
  type MemorySourceKind,
  MemorySourceKindValues,
  type SettingsStatus,
  type SettingsUpdate,
} from "@vibevalley/protocol";
import { omitUndefined } from "@vibevalley/protocol/rules";
import * as S from "@vibevalley/protocol/schema";

import { createAct } from "../../design/act";
import { SettingRow, SettingsGroup } from "../../design/domain/settings";
import { TextInput } from "../../design/Field";
import { Icon } from "../../design/Icon";
import { IconButton } from "../../design/IconButton";
import { KeyField, SaveBar } from "../../design/KeyField";
import { Quiet, SecretInput, Toggle } from "../../design/layout";
import { Segmented } from "../../design/Segmented";
import { Hint, Tip } from "../../design/Tip";
import { toast } from "../../design/toasts";
import { api, reasonOf } from "../../infra/api";
import { currentHost } from "../../infra/host";
import { defineQuery, retryRead, ready, useQuery, useSettings } from "../../infra/query";
import { useRouter } from "../../infra/router";
import { useSaveSettings } from "../../infra/settings";
import { DeepseekForm } from "./DeepseekForm";

type SettingsPart = "deepseek" | "memory";

const sourceLabels: Record<MemorySourceKind, string> = { nowledge: "Nowledge Mem", everos: "EverOS" };
const sourceAddress: Record<MemorySourceKind, string> = { nowledge: "http://127.0.0.1:14242/mcp/", everos: "http://127.0.0.1:18791" };

/** One memory source as the form edits it, from what is saved until it is saved again. */
interface SourceDraft {
  readonly kind: MemorySourceKind;
  readonly saved: MemorySource | undefined;
  url: string;
  user: string;
  key: string;
  enabled: boolean;
  read: boolean;
  write: boolean;
  everything: boolean;
  keyCleared: boolean;
  /** Only a source touched is sent: the list goes whole, and an untouched one must not undo a change made elsewhere. */
  changed: boolean;
  open: boolean;
}

const draftOf = (kind: MemorySourceKind, saved: MemorySource | undefined): SourceDraft => ({
  kind,
  saved,
  url: saved?.url ?? "",
  user: saved?.user ?? "",
  key: "",
  enabled: saved?.enabled ?? false,
  read: saved?.read ?? true,
  write: saved?.write ?? true,
  everything: saved?.everything ?? false,
  keyCleared: false,
  changed: false,
  open: false,
});

const draftsOf = (status: SettingsStatus) =>
  MemorySourceKindValues.map((k) =>
    draftOf(
      k,
      status.memorySources.find((m) => m.kind === k),
    ),
  );

/** Where the settings are kept, said on hover: a card's header puts it beside its title. */
export function SettingsFile() {
  const settings = useSettings();
  return <If when={ready(settings, undefined)}>{(s) => <Hint icon="file" text={t("web.base.form.storedIn", { file: s().file })} />}</If>;
}

/** Built again for each part (Keyed by the page): a saved form starts over from what the server answered. */
export function SettingsForm(props: { part: SettingsPart }) {
  const settings = useSettings();
  return (
    <If
      when={settings.error()}
      else={
        <If when={ready(settings, undefined)} else={<Quiet>{t("web.base.form.asking")}</Quiet>}>
          {(status) => (
            <If when={props.part === "deepseek"} else={<MemoryForm status={untracked(status)} />}>
              <DeepseekForm status={untracked(status)} />
            </If>
          )}
        </If>
      }
    >
      {(e) => <Quiet>{t("web.base.form.unreachable", { why: reasonOf(e()) })}</Quiet>}
    </If>
  );
}

function MemoryForm(props: { status: SettingsStatus }) {
  const saveSettings = useSaveSettings();
  // A plain copy: the form starts from it once.
  const start = untracked(() => props.status);
  const status = signal(start);
  const sources = signal(draftsOf(start));
  const error = signal<string | undefined>(undefined);
  const act = createAct((reason) => error.set(reason));
  const busy = act.busy;

  const setSource = (kind: MemorySourceKind, change: Partial<SourceDraft>, touched = true) =>
    sources.set(untracked(sources).map((d) => (d.kind === kind ? { ...d, ...change, changed: d.changed || touched } : d)));
  const dirty = () => sources().some((d) => d.changed);
  const undo = () => {
    sources.set(draftsOf(status()).map((d, i) => ({ ...d, open: sources()[i]?.open ?? false })));
    error.set(undefined);
  };

  const submit = async () => {
    if (busy() || !dirty()) return;
    const update: SettingsUpdate = omitUndefined({
      memorySources: !sources().some((d) => d.changed)
        ? undefined
        : sources()
            .filter((d) => d.url.trim() !== "" || d.enabled)
            .map((d) => ({
              kind: d.kind,
              url: d.url.trim(),
              enabled: d.enabled,
              read: d.read,
              write: d.write,
              ...(d.everything ? { everything: true } : {}),
              ...(d.user.trim() ? { user: d.user.trim() } : {}),
              ...(d.key.trim() ? { key: d.key.trim() } : d.keyCleared ? { key: "" } : {}),
            })),
    });
    error.set(undefined);
    await act.run(async () => {
      const now = await saveSettings(update);
      status.set(now);
      sources.set(draftsOf(now));
      toast(t("web.setting.keys.saved"));
    });
  };

  return (
    <View testID="memory-form" class="gap-4">
      <SettingsGroup>
        <Each of={sources()} key={(d) => d.kind}>
          {(d, i) => <SourceField draft={d()} last={i() === sources().length - 1} set={(change, touched) => setSource(d().kind, change, touched)} />}
        </Each>
      </SettingsGroup>
      <If when={dirty() || error()}>
        <SaveBar
          dirty={dirty()}
          busy={busy()}
          onSave={() => void submit()}
          onUndo={undo}
          left={<If when={error()}>{(e) => <Text class="text-sm text-berry">{e()}</Text>}</If>}
        />
      </If>
    </View>
  );
}

/** A memory source's state as a dot: not set up, on, or off; what and where on hover. */
function SourceMark(props: { draft: SourceDraft }) {
  const text = () =>
    !props.draft.saved
      ? t("web.setting.source.off")
      : props.draft.saved.enabled
        ? `${t("web.setting.source.on")} · ${props.draft.saved.url}`
        : t("web.setting.source.closed");
  return (
    <Tip text={text()}>
      <View
        accessible
        focusable
        role="image"
        testID={`source-mark-${!props.draft.saved ? "unset" : props.draft.saved.enabled ? "on" : "off"}`}
        accessibilityLabel={text()}
        class="p-1"
      >
        <View class={`h-2 w-2 rounded-full ${!props.draft.saved ? "border border-faint" : props.draft.saved.enabled ? "bg-leaf" : "bg-faint"}`} />
      </View>
    </Tip>
  );
}

function SourceField(props: { draft: SourceDraft; last: boolean; set: (change: Partial<SourceDraft>, touched?: boolean) => void }) {
  const label = () => sourceLabels[props.draft.kind];
  return (
    <View testID={`source-${props.draft.kind}`} class={props.last ? "" : "border-b border-line"}>
      <View class="flex-row items-center gap-2 px-4 py-3">
        <Text class="text-sm font-medium text-ink">{label()}</Text>
        <SourceMark draft={props.draft} />
        <View class="flex-1" />
        <Toggle
          label={t("web.setting.source.enabled")}
          ariaLabel={t("web.setting.source.enable", { label: label() })}
          testid="source-enable"
          checked={props.draft.enabled}
          onChange={(enabled) => props.set({ enabled, open: props.draft.open || (enabled && !props.draft.url) })}
        />
        <IconButton
          icon="settings"
          testid="source-configure"
          label={t("web.setting.source.configure", { label: label() })}
          pressed={props.draft.open}
          onClick={() => props.set({ open: !props.draft.open }, false)}
        />
      </View>
      <If when={props.draft.open}>
        <View class="gap-3 border-t border-line bg-page px-4 py-3">
          <TextInput
            testID="source-address"
            accessibilityLabel={t("web.setting.source.address", { label: label() })}
            class="font-mono"
            placeholder={sourceAddress[props.draft.kind]}
            value={props.draft.url}
            onInput={(url) => props.set({ url })}
          />
          <KeyField
            label="key"
            status={props.draft.saved?.key ?? { source: null }}
            removing={props.draft.keyCleared}
            onRemove={(keyCleared) => props.set({ keyCleared })}
            tip={t("web.setting.source.noKey")}
          >
            <SecretInput
              accessibilityLabel={t("web.setting.source.key", { label: label() })}
              placeholder={t("web.setting.source.keyHint")}
              value={props.draft.key}
              onInput={(key) => props.set({ key })}
            />
          </KeyField>
          <If when={props.draft.kind === "everos"}>
            <TextInput
              accessibilityLabel={t("web.setting.source.user", { label: label() })}
              placeholder={t("web.setting.source.userHint")}
              value={props.draft.user}
              onInput={(user) => props.set({ user })}
            />
          </If>
          <View class="flex-row flex-wrap gap-x-6 gap-y-2.5">
            <Toggle
              label={t("web.setting.source.read")}
              tip={t("web.setting.source.readHint")}
              checked={props.draft.read}
              onChange={(read) => props.set({ read })}
            />
            <Toggle
              label={t("web.setting.source.write")}
              tip={t("web.setting.source.writeHint")}
              checked={props.draft.write}
              onChange={(write) => props.set({ write })}
            />
            <If when={props.draft.kind === "nowledge"}>
              <Toggle
                label={t("web.setting.source.everything")}
                tip={t("web.setting.source.everythingHint")}
                checked={props.draft.everything}
                onChange={(everything) => props.set({ everything })}
              />
            </If>
          </View>
        </View>
      </If>
    </View>
  );
}

/** What the server found of gh (github.status); the refresh asks it to look again. */
const githubQuery = defineQuery({ schema: S.GitHubStatus, key: () => ["github"], fetch: (_: void, context) => api.github.get(context), ...retryRead });
export function GitHub() {
  const refreshed = signal<GitHubStatus | undefined>(undefined);
  const error = signal<string | undefined>(undefined);
  // A refusal shows under the status it was asked about.
  const act = createAct((reason) => error.set(reason));
  const busy = act.busy;
  const status = useQuery(githubQuery);
  const now = () => refreshed() ?? ready(status, undefined);
  const recheck = () => {
    error.set(undefined);
    return act.run(async () => refreshed.set(await api.github.refresh()));
  };
  return (
    <View class="gap-2">
      <If when={now()} else={<Quiet>{status.error() ? t("web.base.form.unreachable", { why: reasonOf(status.error()) }) : t("web.base.form.asking")}</Quiet>}>
        {(s) => (
          <SettingsGroup>
            <SettingRow label={t("web.setting.github.cli")} hint={t("web.setting.github.cliHint")} tip={s().reason || undefined}>
              <Icon name={s().installed ? "check" : "cross"} size={16} />
              <Text class="font-mono text-sm tabular-nums text-ink">{s().installed ? (s().version ?? "") : t("web.setting.github.noGh")}</Text>
              <IconButton icon="refresh" testid="github-recheck" label={t("web.setting.github.recheck")} disabled={busy()} onClick={() => void recheck()} />
            </SettingRow>
            <SettingRow label={t("web.setting.github.login")} hint={t("web.setting.github.loginHint")} last>
              <Icon name={s().loggedIn ? "check" : "warn"} size={16} />
              <Text class="text-sm text-ink">{s().loggedIn ? (s().account ?? "") : t("web.setting.github.notLoggedIn")}</Text>
            </SettingRow>
          </SettingsGroup>
        )}
      </If>
      <If when={error()}>
        <Text class="text-sm text-berry">{error()}</Text>
      </If>
    </View>
  );
}

/** The farm's language: the page's words, what the orchestrator and the helpers answer in, what goes to the chat apps. */
export function LanguageChoice() {
  const saveSettings = useSaveSettings();
  const router = useRouter();
  const error = signal<string | undefined>(undefined);
  const act = createAct((reason) => error.set(reason));
  const busy = act.busy;
  const choose = async (locale: Locale) => {
    if (locale === currentLocale() || busy()) return;
    error.set(undefined);
    if (await act.run(() => saveSettings({ locale }))) {
      setLocale(locale);
      currentHost().locale?.(locale);
      router.navigate(router.path(), { replace: true });
    }
  };
  return (
    <>
      <If when={error()}>{(e) => <Hint text={e()} />}</If>
      <Segmented
        label={t("web.setting.language.label")}
        testid="language"
        value={currentLocale()}
        options={LocaleValues.map((l) => ({ value: l, label: t(`web.setting.language.${l}`), disabled: busy() }))}
        onChange={(l) => void choose(l)}
      />
    </>
  );
}
