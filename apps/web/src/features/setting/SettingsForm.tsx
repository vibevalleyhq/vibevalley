// The DeepSeek key, the language and the memory sources (setting.load, setting.save), a part at a time; and what the
// server found of gh.

import { appWording } from "../../base/words";
import { settingsWording } from "./words";
import { createSignal, For, Match, Show, snapshot, Switch as Pick, untrack } from "solid-js";
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
import { api, reasonOf } from "../../base/api";
import { saveSettings } from "../../base/settings";
import { ready, useQuery, useSettings } from "../../base/query";
import { TextInput } from "../../ui/Field";
import { Icon } from "../../ui/Icon";
import { IconButton } from "../../ui/IconButton";
import { KeyField, SaveBar } from "../../ui/KeyField";
import { Segmented } from "../../ui/Segmented";
import { Hint, Tip } from "../../ui/Tip";
import { toast } from "../../ui/toasts";
import { currentLocale } from "@vibevalley/protocol/words";
import { Quiet, SecretInput, Toggle } from "../../ui/layout";

export type SettingsPart = "deepseek" | "memory";

const sourceLabels: Record<MemorySourceKind, string> = { nowledge: "Nowledge Mem", everos: "EverOS" };
const sourceAddress: Record<MemorySourceKind, string> = { nowledge: "http://127.0.0.1:14242/mcp/", everos: "http://127.0.0.1:18791" };

/** One memory source as the form edits it, from what is saved until it is saved again. */
interface SourceDraft {
  readonly kind: MemorySourceKind;
  readonly saved?: MemorySource;
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
  return <Show when={ready(settings, undefined)}>{(s) => <Hint text={appWording().form.storedIn(s().file)} />}</Show>;
}

/** Built again for each part (Keyed by the page): a saved form starts over from what the server answered. */
export function SettingsForm(props: { part: SettingsPart }) {
  const settings = useSettings();
  return (
    <Pick fallback={<Quiet>{appWording().form.asking}</Quiet>}>
      <Match when={settings.error}>{(e) => <Quiet>{appWording().form.unreachable(reasonOf(e()))}</Quiet>}</Match>
      <Match when={ready(settings, undefined)}>{(status) => <Form part={props.part} status={untrack(status)} />}</Match>
    </Pick>
  );
}

function Form(props: { part: SettingsPart; status: SettingsStatus }) {
  // A plain copy: the form starts from it once, and reading the store's fields later would be untracked reads.
  const start = untrack(() => snapshot(props.status));
  const [status, setStatus] = createSignal(start);
  const [deepseek, setDeepseek] = createSignal("");
  const [removing, setRemoving] = createSignal(false);
  const [sources, setSources] = createSignal(draftsOf(start));
  const [error, setError] = createSignal<string>();
  const [busy, setBusy] = createSignal(false);

  const setSource = (kind: MemorySourceKind, change: Partial<SourceDraft>, touched = true) =>
    setSources((all) => all.map((d) => (d.kind === kind ? { ...d, ...change, changed: d.changed || touched } : d)));
  const dirty = () => deepseek().trim() !== "" || removing() || sources().some((d) => d.changed);
  const undo = () => {
    setDeepseek("");
    setRemoving(false);
    setSources(draftsOf(status()).map((d, i) => ({ ...d, open: sources()[i]?.open ?? false })));
    setError(undefined);
  };

  const submit = async () => {
    const update: SettingsUpdate = {
      // A key removed and not typed again goes as "" (the server forgets it).
      deepseekApiKey: deepseek().trim() ? deepseek().trim() : removing() ? "" : undefined,
      memorySources: !sources().some((d) => d.changed)
        ? undefined
        : sources()
            .filter((d) => d.url.trim() || d.enabled)
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
    };
    setBusy(true);
    setError(undefined);
    try {
      const now = await saveSettings(update);
      setStatus(now);
      setDeepseek("");
      setRemoving(false);
      setSources(draftsOf(now));
      toast(settingsWording().keys.saved);
    } catch (e) {
      setError(reasonOf(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      class="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (!busy() && dirty()) void submit();
      }}
    >
      <Show when={props.part === "deepseek"}>
        <KeyField
          label="DeepSeek API Key"
          status={status().deepseekApiKey}
          removing={removing()}
          onRemove={setRemoving}
          link={{ href: "https://platform.deepseek.com/api_keys", label: "platform.deepseek.com" }}
        >
          <SecretInput
            aria-label="DeepSeek API Key"
            placeholder={settingsWording().keys.deepseekHint}
            value={deepseek()}
            onInput={(e) => setDeepseek(e.currentTarget.value)}
          />
        </KeyField>
      </Show>
      <Show when={props.part === "memory"}>
        <div class="flex flex-col gap-2">
          <For each={sources()} keyed={(d) => d.kind}>
            {(d) => <SourceField draft={d()} set={(change, touched) => setSource(d().kind, change, touched)} />}
          </For>
        </div>
      </Show>
      <Show when={dirty() || error()}>
        <SaveBar
          dirty={dirty()}
          busy={busy()}
          onSave={() => void submit()}
          onUndo={undo}
          left={<Show when={error()}>{(e) => <p class="text-berry">{e()}</p>}</Show>}
        />
      </Show>
    </form>
  );
}

/** A memory source's state as a dot: not set up, on, or off; what and where on hover. */
function SourceMark(props: { draft: SourceDraft }) {
  const text = () =>
    !props.draft.saved
      ? settingsWording().source.off
      : props.draft.saved.enabled
        ? `${settingsWording().source.on} · ${props.draft.saved.url}`
        : settingsWording().source.closed;
  return (
    <Tip text={text()}>
      <span role="img" aria-label={text()} tabindex={0} class="inline-flex p-1 outline-none focus-visible:outline-2 focus-visible:outline-focus">
        <span class={["block size-2 rounded-full", !props.draft.saved ? "border border-faint" : props.draft.saved.enabled ? "bg-leaf" : "bg-faint"]} />
      </span>
    </Tip>
  );
}

function SourceField(props: { draft: SourceDraft; set: (change: Partial<SourceDraft>, touched?: boolean) => void }) {
  const label = () => sourceLabels[props.draft.kind];
  return (
    <div class="rounded-lg border border-line">
      <div class="flex items-center gap-2 px-3 py-2">
        <span class="text-sm font-medium">{label()}</span>
        <SourceMark draft={props.draft} />
        <span class="flex-1" />
        <Toggle
          label={settingsWording().source.enabled}
          ariaLabel={settingsWording().source.enable(label())}
          checked={props.draft.enabled}
          onChange={(enabled) => props.set({ enabled, open: props.draft.open || (enabled && !props.draft.url) })}
        />
        <IconButton
          icon="settings"
          label={settingsWording().source.configure(label())}
          pressed={props.draft.open}
          onClick={() => props.set({ open: !props.draft.open }, false)}
        />
      </div>
      <Show when={props.draft.open}>
        <div class="flex flex-col gap-3 border-t border-line p-3">
          <TextInput
            aria-label={settingsWording().source.address(label())}
            class="font-mono"
            placeholder={sourceAddress[props.draft.kind]}
            value={props.draft.url}
            onInput={(e) => props.set({ url: e.currentTarget.value })}
          />
          <KeyField
            label="key"
            status={props.draft.saved?.key ?? {}}
            removing={props.draft.keyCleared}
            onRemove={(keyCleared) => props.set({ keyCleared })}
            tip={settingsWording().source.noKey}
          >
            <SecretInput
              aria-label={settingsWording().source.key(label())}
              placeholder={settingsWording().source.keyHint}
              value={props.draft.key}
              onInput={(e) => props.set({ key: e.currentTarget.value })}
            />
          </KeyField>
          <Show when={props.draft.kind === "everos"}>
            <TextInput
              aria-label={settingsWording().source.user(label())}
              placeholder={settingsWording().source.userHint}
              value={props.draft.user}
              onInput={(e) => props.set({ user: e.currentTarget.value })}
            />
          </Show>
          <div class="flex flex-wrap gap-x-6 gap-y-2.5">
            <Toggle
              label={settingsWording().source.read}
              tip={settingsWording().source.readHint}
              checked={props.draft.read}
              onChange={(read) => props.set({ read })}
            />
            <Toggle
              label={settingsWording().source.write}
              tip={settingsWording().source.writeHint}
              checked={props.draft.write}
              onChange={(write) => props.set({ write })}
            />
            <Show when={props.draft.kind === "nowledge"}>
              <Toggle
                label={settingsWording().source.everything}
                tip={settingsWording().source.everythingHint}
                checked={props.draft.everything}
                onChange={(everything) => props.set({ everything })}
              />
            </Show>
          </div>
        </div>
      </Show>
    </div>
  );
}

/** What the server found of gh (github.status); the refresh asks it to look again. */
export function GitHub() {
  const [refreshed, setRefreshed] = createSignal<GitHubStatus>();
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string>();
  const status = useQuery(() => ({ queryKey: ["github"], queryFn: () => api.github.get() }));
  const now = () => refreshed() ?? ready(status, undefined);
  const recheck = async () => {
    setBusy(true);
    setError(undefined);
    try {
      setRefreshed(await api.github.refresh());
    } catch (e) {
      setError(reasonOf(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div class="flex flex-col gap-2">
      <Pick fallback={<Quiet>{status.error ? appWording().form.unreachable(reasonOf(status.error)) : appWording().form.asking}</Quiet>}>
        <Match when={now()}>
          {(s) => (
            <div class="flex items-center gap-2 text-sm">
              <Icon name={s().installed && s().loggedIn ? "check" : s().installed ? "warn" : "cross"} size={16} />
              <span class="font-mono">{s().installed ? `gh ${s().version}` : settingsWording().github.noGh}</span>
              <Show when={s().loggedIn}>
                <span class="text-muted">· {s().account}</span>
              </Show>
              <Show when={s().reason}>{(r) => <Hint text={r()} />}</Show>
              <span class="flex-1" />
              <IconButton icon="refresh" label={settingsWording().github.recheck} disabled={busy()} onClick={() => void recheck()} />
            </div>
          )}
        </Match>
      </Pick>
      <Show when={error()}>
        <p class="text-sm text-berry">{error()}</p>
      </Show>
    </div>
  );
}

/** The farm's language: the page's words, what the orchestrator and the helpers answer in, what goes to the chat apps.
 * Saved, the page opens again in it: its words are read once, when it loads (protocol words/locale.ts). */
export function LanguageForm() {
  const [error, setError] = createSignal<string>();
  const [busy, setBusy] = createSignal(false);
  const choose = async (locale: Locale) => {
    if (locale === currentLocale() || busy()) return;
    setBusy(true);
    setError(undefined);
    try {
      await saveSettings({ locale });
      location.reload();
    } catch (e) {
      setError(reasonOf(e));
      setBusy(false);
    }
  };
  return (
    <div class="flex flex-col gap-3">
      <div>
        <Segmented
          label={settingsWording().language.label}
          value={currentLocale()}
          options={LocaleValues.map((l) => ({ value: l, label: settingsWording().language[l], disabled: busy() }))}
          onChange={(l) => void choose(l)}
        />
      </div>
      <Show when={error()}>
        <p class="text-sm text-berry">{error()}</p>
      </Show>
    </div>
  );
}
