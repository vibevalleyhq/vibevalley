import * as stylex from "@stylexjs/stylex";
import { createSignal, Show, snapshot, untrack } from "solid-js";

import { t } from "@vibevalley/i18n";
import {
  AreaValues,
  type Dictation,
  type KeyStatus,
  LanguageValues,
  ModelValues,
  type SettingsStatus,
  type SettingsUpdate,
  VoiceAnswerAgoraModelValues,
  type VoiceSettings,
} from "@vibevalley/protocol";
import { same } from "@vibevalley/protocol/rules";
import * as S from "@vibevalley/protocol/schema";

import { createSettled, Keyed, variant } from "#/base/dom.tsx";
import { api, reasonOf } from "#/infra/api.ts";
import { defineQuery, ready, useQuery, useSettings } from "#/infra/query.ts";
import { useSaveSettings } from "#/infra/settings.ts";
import { createAct } from "#/ui/act.ts";
import { Button } from "#/ui/Button.tsx";
import { Select, TextInput } from "#/ui/Field.tsx";
import { IconLink, OutLink } from "#/ui/IconButton.tsx";
import { KeyField, SaveBar } from "#/ui/KeyField.tsx";
import { Card, Quiet, SecretInput } from "#/ui/layout.tsx";
import { Segmented } from "#/ui/Segmented.tsx";
import { KeyRow, SettingsGroup } from "#/ui/settings.tsx";
import { Hint } from "#/ui/Tip.tsx";
import { toast } from "#/ui/toasts.ts";

import { MossVerify } from "./MossVerify";
import {
  answerLabel,
  answerStart,
  areaLabel,
  asrLabel,
  asrStart,
  Cols,
  keyFrom,
  Labeled,
  languageLabel,
  numberLabel,
  options,
  plain,
  VoiceAgentSection,
  voiceLimits,
  type VoiceNumber,
  type VoicePart,
  withPart,
} from "./VoiceVendorFields";

const viewStyles = stylex.create({
  voiceCard: { maxWidth: "var(--container-4xl)" },
  barP: {
    color: "var(--wb-berry)",
  },
  formDiv: {
    display: "flex",
    height: "100%",
    minHeight: "0",
    flexDirection: "column",
    gap: "calc(var(--spacing) * 3)",
  },
  formDiv2: {
    display: "flex",
    maxWidth: "var(--container-4xl)",
    alignItems: "center",
    gap: "calc(var(--spacing) * 2)",
    paddingInline: "var(--spacing)",
  },
  formSpan: {
    flex: "1",
  },
  formSpan2: {
    fontSize: "var(--text-sm)",
    lineHeight: "var(--text-sm--line-height)",
    color: "var(--wb-muted)",
  },
  formDiv3: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    columnGap: "calc(var(--spacing) * 3)",
    rowGap: "calc(var(--spacing) * 2)",
  },
  formP: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    columnGap: "calc(var(--spacing) * 2)",
    fontSize: "var(--text-sm)",
    lineHeight: "var(--text-sm--line-height)",
    color: "var(--wb-muted)",
  },
  dictationMossKey: {
    display: "contents",
  },
  formDiv4: {
    maxWidth: "var(--container-4xl)",
  },
});

const sameVoice = (a: VoiceSettings, b: VoiceSettings) => same(a, b);

type Key = "agoraAppId" | "agoraAppCertificate" | "asrKey" | "llmKey" | "ttsKey" | "dictationKey" | "mossKey";

/** Which of the line's settings a page shows: the call (credentials, listening, who answers), MOSS Live's key, or dictation. */
type LineView = "call" | "moss" | "dictation";

export function VoiceForm(props: { part: VoicePart; view?: LineView }) {
  const settings = useSettings();
  return (
    <Show
      when={ready(settings, undefined)}
      fallback={<Quiet>{settings.error() ? t("web.voice.voice.noSettings", { why: reasonOf(settings.error()) }) : t("web.base.form.asking")}</Quiet>}
    >
      {(status) => <Keyed key={status().file}>{() => <Form status={untrack(status)} part={props.part} view={props.view ?? "call"} />}</Keyed>}
    </Show>
  );
}

/** What the server says is wrong with the draft, asked a moment after it last changed. */
const problemQuery = defineQuery({
  schema: S.Validation,
  key: (a: { input: SettingsUpdate; token: string }) => ["settings-check", a.token],
  fetch: (a, context) => api.setting.validate(a.input, context),
  gcTime: 0,
});
function useProblem(update: () => SettingsUpdate) {
  const asked = createSettled(update);
  const check = useQuery(() => problemQuery({ input: asked(), token: crypto.randomUUID() }));
  return () => ready(check, undefined)?.problem;
}

function Form(props: { status: SettingsStatus; part: VoicePart; view: LineView }) {
  const saveSettings = useSaveSettings();
  // A plain copy: the form starts from it once, and reading the store's fields later would be untracked reads.
  const start = untrack(() => snapshot(props.status));
  const [draft, setDraft] = createSignal<VoiceSettings>(start.voice);
  const [appId, setAppId] = createSignal(start.agoraAppId.value ?? "");
  const [dictation, setDictation] = createSignal<Dictation>(start.dictation);
  const [secrets, setSecrets] = createSignal<Partial<Record<Key, string>>>({});
  const [cleared, setCleared] = createSignal<ReadonlySet<Key>>(new Set());
  const [error, setError] = createSignal<string>();
  const act = createAct(setError);
  const busy = act.busy;
  // The settings as saved now: a save answers with them, and the form keeps the draft over them.
  const [base, setBase] = createSignal(start);

  const set = (next: VoiceSettings) => {
    setDraft(next);
  };
  const voiceDirty = () => !sameVoice(draft(), base().voice);
  const appIdDirty = () => appId().trim() !== (base().agoraAppId.value ?? "");
  const dictationDirty = () =>
    dictation().via !== base().dictation.via || dictation().url.trim() !== base().dictation.url || dictation().model.trim() !== base().dictation.model;
  const dirty = () => voiceDirty() || appIdDirty() || dictationDirty() || Object.values(secrets()).some((v) => v.trim()) || cleared().size > 0;
  const problem = useProblem(() => ({ voice: draft(), ...(dictationDirty() ? { dictation: dictation() } : {}) }));
  const atDefaults = () => sameVoice(draft(), withPart(props.part, draft(), base().voiceDefaults));

  const submit = async () => {
    const update: Record<string, unknown> = {};
    for (const k of cleared()) update[k] = "";
    if (appIdDirty() && !cleared().has("agoraAppId")) update.agoraAppId = appId().trim();
    for (const [k, v] of Object.entries(secrets())) if (v.trim()) update[k] = v.trim();
    if (voiceDirty()) update.voice = withPart(props.part, base().voice, draft());
    if (dictationDirty()) update.dictation = { via: dictation().via, url: dictation().url.trim(), model: dictation().model.trim() };
    setError(undefined);
    await act.run(async () => {
      const now = await saveSettings(update);
      setBase(now);
      setSecrets({});
      setCleared(new Set<Key>());
      toast(t("web.voice.voice.saved"));
    });
  };
  const undo = () => {
    setDraft(base().voice);
    setAppId(base().agoraAppId.value ?? "");
    setDictation(base().dictation);
    setSecrets({});
    setCleared(new Set<Key>());
    setError(undefined);
  };

  const remove = (k: Key) => (on: boolean) => {
    const next = new Set(cleared());
    if (on) next.add(k);
    else next.delete(k);
    setCleared(next);
  };
  const secret = (k: Key, label: string, current: () => KeyStatus, link?: { readonly href: string; readonly label: string }) => (
    <KeyField small label={label} status={current()} removing={cleared().has(k)} onRemove={remove(k)} link={link}>
      <SecretInput
        aria-label={label}
        placeholder={t("web.base.form.keepEmpty")}
        value={secrets()[k] ?? ""}
        onInput={(e) => {
          setSecrets({ ...secrets(), [k]: e.currentTarget.value });
        }}
      />
    </KeyField>
  );
  const number = (k: VoiceNumber) => (
    <Labeled label={numberLabel[k]} hint={t("web.voice.voice.range", { min: voiceLimits[k].min, max: voiceLimits[k].max, fallback: base().voiceDefaults[k] })}>
      <TextInput
        aria-label={numberLabel[k]}
        class="font-mono"
        inputmode="numeric"
        value={String(draft()[k])}
        onInput={(e) => set({ ...draft(), [k]: Number(e.currentTarget.value.replace(/\D/gu, "")) })}
      />
    </Labeled>
  );

  const bar = () => (
    <SaveBar
      dirty={dirty()}
      busy={busy() || !!problem()}
      onSave={() => void submit()}
      onUndo={undo}
      left={<Show when={error() ?? problem()}>{(e) => <p {...stylex.attrs(viewStyles.barP)}>{e()}</p>}</Show>}
      // Reset to defaults puts back the call's own settings: on MOSS Live's key or dictation it would touch what is not shown.
      extra={
        <Show when={props.part === "agent" || props.view === "call"}>
          <Button tone="quiet" data-testid="reset" disabled={atDefaults()} onClick={() => set(withPart(props.part, draft(), base().voiceDefaults))}>
            {t("web.base.form.reset")}
          </Button>
        </Show>
      }
    />
  );

  const asr = () => draft().asr;
  const answer = () => draft().answer;
  const credentialsReady = () =>
    answer().vendor === "moss" ? base().mossKey.source !== null : base().agoraAppId.source !== null && base().agoraAppCertificate.source !== null;
  const answerHint = () => {
    const source = base().deepseekApiKey.source;
    return answer().vendor === "orchestrator"
      ? t("web.voice.voice.answer.orchestrator")
      : answer().vendor === "moss"
        ? t("web.voice.voice.answer.moss")
        : answer().vendor === "agora"
          ? t("web.voice.voice.answer.agora")
          : answer().vendor === "deepseek"
            ? source !== null
              ? t("web.voice.voice.answer.deepseek", { from: keyFrom[source] })
              : t("web.voice.voice.answer.noDeepseek")
            : t("web.voice.voice.answer.openai");
  };

  return (
    <Show
      when={props.part === "agent"}
      fallback={
        <div {...stylex.attrs(viewStyles.formDiv)}>
          <div class="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto">
            <Show when={props.view === "moss"}>
              <SettingsGroup>
                <KeyRow
                  label="API Key"
                  hint={t("web.voice.voice.moss.keyHint")}
                  status={base().mossKey}
                  value={secrets().mossKey ?? ""}
                  onInput={(v) => setSecrets({ ...secrets(), mossKey: v })}
                  removing={cleared().has("mossKey")}
                  onRemove={remove("mossKey")}
                  link={{ href: "https://platform.mosi.cn/", label: t("web.voice.voice.moss.console") }}
                  after={<MossVerify typed={() => secrets().mossKey ?? ""} />}
                />
              </SettingsGroup>
            </Show>
            <Show when={props.view === "call"}>
              <div {...stylex.attrs(viewStyles.formDiv2)}>
                <span class={["rounded px-1.5 py-0.5 text-xs", credentialsReady() ? "bg-ok-soft text-ok-ink" : "bg-bad-soft text-berry"]}>
                  {credentialsReady() ? t("web.voice.voice.ready") : t("web.voice.voice.missing")}
                </span>
                <Hint
                  text={t("web.voice.voice.intro") + t("web.voice.voice.orchestratorPage") + t("web.voice.voice.period") + " " + t("web.voice.voice.nextCall")}
                />
                <span {...stylex.attrs(viewStyles.formSpan)} />
                <IconLink href="/orchestrator/voice" icon="agents" label={t("web.voice.voice.orchestratorPage")} />
                <Hint text={t("web.base.form.storedIn", { file: base().file })} />
              </div>
              <Card
                title={t("web.voice.voice.credentials")}
                action={<OutLink href="https://console.agora.io/" label={t("web.voice.voice.console")} />}
                styles={viewStyles.voiceCard}
              >
                <Cols>
                  <KeyField small label="App ID" status={base().agoraAppId} removing={cleared().has("agoraAppId")} onRemove={remove("agoraAppId")}>
                    <TextInput
                      data-testid="agora-app-id"
                      aria-label="Agora App ID"
                      class="font-mono"
                      placeholder={t("web.voice.voice.hex")}
                      value={appId()}
                      onInput={(e) => {
                        setAppId(e.currentTarget.value);
                      }}
                    />
                  </KeyField>
                  {secret("agoraAppCertificate", "App Certificate", () => base().agoraAppCertificate)}
                  <Labeled label={t("web.voice.voice.area")} hint={t("web.voice.voice.areaHint")}>
                    <Segmented
                      label={t("web.voice.voice.area")}
                      testid="voice-area"
                      value={draft().area}
                      options={AreaValues.map((a) => ({ value: a, label: areaLabel[a] }))}
                      onChange={(area) => set({ ...draft(), area })}
                    />
                  </Labeled>
                </Cols>
              </Card>
              <Card
                title={t("web.voice.voice.listen")}
                action={<span {...stylex.attrs(viewStyles.formSpan2)}>{t("web.voice.voice.listenParts")}</span>}
                styles={viewStyles.voiceCard}
              >
                <Cols>
                  <Labeled label={t("web.voice.voice.asr")} hint={asr().vendor === "microsoft" ? t("web.voice.voice.microsoft") : t("web.voice.voice.hosted")}>
                    <Segmented
                      label={t("web.voice.voice.asr")}
                      testid="voice-asr"
                      value={asr().vendor}
                      options={options(["ares", "deepgram", "microsoft"] as const, asrLabel)}
                      onChange={(v) => set({ ...draft(), asr: v === asr().vendor ? asr() : asrStart[v] })}
                    />
                  </Labeled>
                  <Labeled label={t("web.voice.voice.language")} hint={t("web.voice.voice.languageHint")}>
                    <Select
                      label={t("web.voice.voice.language")}
                      value={draft().language}
                      options={LanguageValues.map((l) => ({ value: l, label: t("shared.join.aside", { text: languageLabel[l], aside: l }) }))}
                      onChange={(l) => set({ ...draft(), language: l })}
                    />
                  </Labeled>
                  <Show when={variant(asr(), "vendor", "deepgram")}>
                    {(a) => (
                      <Labeled label={t("web.voice.voice.deepgramModel")}>
                        <Segmented
                          label={t("web.voice.voice.deepgramModel")}
                          testid="voice-deepgram-model"
                          value={a().model}
                          options={plain(ModelValues)}
                          onChange={(model) => set({ ...draft(), asr: { vendor: "deepgram", model } })}
                        />
                      </Labeled>
                    )}
                  </Show>
                  <Show when={variant(asr(), "vendor", "microsoft")}>
                    {(a) => (
                      <>
                        <Labeled label={t("web.voice.voice.azureArea")} hint={t("web.voice.voice.azureAreaHint")}>
                          <TextInput
                            aria-label={t("web.voice.voice.asrArea")}
                            class="font-mono"
                            value={a().region}
                            onInput={(e) => set({ ...draft(), asr: { vendor: "microsoft", region: e.currentTarget.value } })}
                          />
                        </Labeled>
                        {secret("asrKey", t("web.voice.voice.microsoftKey"), () => base().asrKey)}
                      </>
                    )}
                  </Show>
                  {number("silenceMs")}
                  {number("interruptMs")}
                  {number("idleSeconds")}
                </Cols>
              </Card>
              <Card
                title={t("web.voice.voice.think")}
                action={<span {...stylex.attrs(viewStyles.formSpan2)}>{answerLabel[answer().vendor]}</span>}
                styles={viewStyles.voiceCard}
              >
                <Labeled label={t("web.voice.voice.who")} hint={answerHint()}>
                  <Segmented
                    label={t("web.voice.voice.who")}
                    testid="voice-answer"
                    value={answer().vendor}
                    options={options(["orchestrator", "moss", "agora", "deepseek", "openai"] as const, answerLabel)}
                    onChange={(v) => set({ ...draft(), answer: v === answer().vendor ? answer() : answerStart[v] })}
                  />
                </Labeled>
                <Show when={answer().vendor === "moss"}>
                  <Cols>
                    {secret("mossKey", "MOSS API Key", () => base().mossKey, {
                      href: "https://platform.mosi.cn/",
                      label: t("web.voice.voice.moss.console"),
                    })}
                  </Cols>
                </Show>
                <Show when={variant(answer(), "vendor", "agora")}>
                  {(a) => (
                    <Labeled label={t("web.voice.voice.model")}>
                      <Segmented
                        label={t("web.voice.voice.model")}
                        testid="voice-model"
                        value={a().model}
                        options={plain(VoiceAnswerAgoraModelValues)}
                        onChange={(model) => set({ ...draft(), answer: { vendor: "agora", model } })}
                      />
                    </Labeled>
                  )}
                </Show>
                <Show when={variant(answer(), "vendor", "deepseek")}>
                  {(a) => (
                    <Labeled label={t("web.voice.voice.model")} hint={t("web.voice.voice.deepseekModel")}>
                      <TextInput
                        aria-label={t("web.voice.voice.deepseekModelLabel")}
                        class="font-mono"
                        value={a().model}
                        onInput={(e) => set({ ...draft(), answer: { vendor: "deepseek", model: e.currentTarget.value } })}
                      />
                    </Labeled>
                  )}
                </Show>
                <Show when={variant(answer(), "vendor", "openai")}>
                  {(a) => (
                    <Cols>
                      <Labeled label={t("web.voice.voice.address")} hint={t("web.voice.voice.llmAddress")}>
                        <TextInput
                          aria-label={t("web.voice.voice.llmAddressLabel")}
                          class="font-mono"
                          value={a().url}
                          onInput={(e) => set({ ...draft(), answer: { ...a(), url: e.currentTarget.value } })}
                        />
                      </Labeled>
                      <Labeled label={t("web.voice.voice.model")}>
                        <TextInput
                          aria-label={t("web.voice.voice.llmModel")}
                          class="font-mono"
                          value={a().model}
                          onInput={(e) => set({ ...draft(), answer: { ...a(), model: e.currentTarget.value } })}
                        />
                      </Labeled>
                      {secret("llmKey", t("web.voice.voice.llmKey"), () => base().llmKey)}
                    </Cols>
                  )}
                </Show>
              </Card>
            </Show>
            <Show when={props.view === "dictation"}>
              {/* The page's title already says Dictation: the card has none of its own. */}
              <Card styles={viewStyles.voiceCard}>
                <div {...stylex.attrs(viewStyles.formDiv3)}>
                  <Segmented
                    label={t("web.voice.voice.dictationVia")}
                    testid="dictation-via"
                    value={dictation().via}
                    options={[
                      { value: "moss", label: "MOSS" },
                      { value: "own", label: t("web.voice.voice.dictationOwn") },
                    ]}
                    onChange={(via) => setDictation({ ...dictation(), via })}
                  />
                  <p {...stylex.attrs(viewStyles.formP)}>
                    {dictation().via === "moss" ? t("web.voice.voice.dictationMossIntro") : t("web.voice.voice.dictationIntro")}
                    <Show when={dictation().via === "own"}>
                      <OutLink href="https://github.com/soniqo/speech-swift" label={t("web.voice.voice.speechServer")} />
                    </Show>
                  </p>
                </div>
                <Show
                  when={dictation().via === "own"}
                  fallback={
                    <Cols>
                      <div data-testid="dictation-moss-key" {...stylex.attrs(viewStyles.dictationMossKey)}>
                        {secret("mossKey", t("web.voice.voice.dictationMossKey"), () => base().mossKey, {
                          href: "https://platform.mosi.cn/",
                          label: t("web.voice.voice.moss.console"),
                        })}
                      </div>
                    </Cols>
                  }
                >
                  <Cols>
                    <Labeled label={t("web.voice.voice.address")} hint={t("web.voice.voice.dictationAddress")}>
                      <TextInput
                        aria-label={t("web.voice.voice.dictationAddressLabel")}
                        data-testid="dictation-url"
                        class="font-mono"
                        placeholder={t("web.base.form.example", { value: "http://127.0.0.1:8080/v1" })}
                        value={dictation().url}
                        onInput={(e) => {
                          setDictation({ ...dictation(), url: e.currentTarget.value });
                        }}
                      />
                    </Labeled>
                    <Labeled label={t("web.voice.voice.model")} hint={t("web.voice.voice.dictationModel")}>
                      <TextInput
                        aria-label={t("web.voice.voice.dictationModelLabel")}
                        data-testid="dictation-model"
                        class="font-mono"
                        placeholder={t("web.base.form.example", { value: "qwen3" })}
                        value={dictation().model}
                        onInput={(e) => {
                          setDictation({ ...dictation(), model: e.currentTarget.value });
                        }}
                      />
                    </Labeled>
                    {secret("dictationKey", t("web.voice.voice.dictationKey"), () => base().dictationKey)}
                  </Cols>
                </Show>
              </Card>
            </Show>
          </div>
          <div {...stylex.attrs(viewStyles.formDiv4)}>{bar()}</div>
        </div>
      }
    >
      <VoiceAgentSection draft={draft()} set={set} ttsKeyField={secret("ttsKey", t("web.voice.voice.microsoftKey"), () => base().ttsKey)} bar={bar()} />
    </Show>
  );
}
