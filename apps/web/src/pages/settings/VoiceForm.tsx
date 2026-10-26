// 声音: the call's line on /settings/voice (credentials, how it listens, who answers, dictation) and the orchestrator's voice
// on /orchestrator/voice (what it says, in what voice). Each part saves only its own fields over the settings as they are
// now: the other part may have been saved meanwhile.

import { createSignal, For, Match, onSettled, Show, snapshot, Switch, untrack } from "solid-js";
import type { JSX } from "@solidjs/web";
import { keepPreviousData } from "@tanstack/solid-query";
import {
  AreaValues,
  defaultGreeting,
  type Dictation,
  type KeySource,
  type KeyStatus,
  LanguageValues,
  ModelValues,
  type SettingsStatus,
  type SettingsUpdate,
  VoiceAnswerAgoraModelValues,
  type VoiceSettings,
  VoiceTTSMinimaxModelValues,
  VoiceValues,
} from "@vibevalley/protocol";
import { api, reasonOf } from "../../data/api";
import {
  answerLabel,
  answerStart,
  areaLabel,
  asrLabel,
  asrStart,
  languageLabel,
  microsoftVoices,
  minimaxVoices,
  numberLabel,
  sameVoice,
  ttsLabel,
  ttsStart,
  type VoiceNumber,
  type VoicePart,
  voiceLimits,
  voiceSample,
  withPart,
} from "../../rules/voice";
import { A } from "../../app/A";
import { aria, createSettled, Keyed } from "../../app/util";
import { ready, useQuery, useSettings } from "../../data/query";
import { Button } from "../../ui/Button";
import { Select, TextArea, TextInput } from "../../ui/Field";
import { Icon } from "../../ui/Icon";
import { Segmented } from "../../ui/Segmented";
import { Card, Quiet, SecretInput, TextLink } from "../kit";
import { saveSettings } from "./SettingsForm";

type Key = "agoraAppId" | "agoraAppCertificate" | "asrKey" | "llmKey" | "ttsKey" | "dictationKey";

const keyFrom: Record<KeySource, string> = { settings: "存在设置里", config: "来自配置（vibevalley.yaml 或环境变量）" };

const options = <T extends string>(labels: Record<T, string>) => (Object.keys(labels) as T[]).map((value) => ({ value, label: labels[value] }));
const plain = <T extends string>(values: readonly T[]) => values.map((value) => ({ value, label: value }));

export function VoiceForm(props: { part: VoicePart }) {
  const settings = useSettings();
  return (
    <Show when={ready(settings, undefined)} fallback={<Quiet>{settings.error ? `问不到服务端的设置（${reasonOf(settings.error)}）。` : "在问服务端……"}</Quiet>}>
      {(status) => <Keyed key={status().file}>{() => <Form status={untrack(status)} part={props.part} />}</Keyed>}
    </Show>
  );
}

/** What the server says is wrong with the draft, asked a moment after it last changed. */
function useProblem(update: () => SettingsUpdate) {
  const asked = createSettled(() => JSON.stringify(update()));
  const check = useQuery(() => ({
    queryKey: ["settings-check", asked()],
    queryFn: () => api.setting.check({ body: JSON.parse(asked()) as SettingsUpdate }),
    placeholderData: keepPreviousData,
  }));
  return () => ready(check, undefined)?.problem;
}

function Form(props: { status: SettingsStatus; part: VoicePart }) {
  // A plain copy: the form starts from it once, and reading the store's fields later would be untracked reads.
  const start = untrack(() => snapshot(props.status));
  const [draft, setDraft] = createSignal<VoiceSettings>(start.voice);
  const [appId, setAppId] = createSignal(start.agoraAppId.value ?? "");
  const [dictation, setDictation] = createSignal<Dictation>(start.dictation);
  const [secrets, setSecrets] = createSignal<Partial<Record<Key, string>>>({});
  const [cleared, setCleared] = createSignal<ReadonlySet<Key>>(new Set());
  const [error, setError] = createSignal<string>();
  const [saved, setSaved] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  // The settings as saved now: a save answers with them, and the form keeps the draft over them.
  const [base, setBase] = createSignal(start);

  const touched = () => setSaved(false);
  const set = (next: VoiceSettings) => {
    setDraft(next);
    touched();
  };
  const voiceDirty = () => !sameVoice(draft(), base().voice);
  const appIdDirty = () => appId().trim() !== (base().agoraAppId.value ?? "");
  const dictationDirty = () => dictation().url.trim() !== base().dictation.url || dictation().model.trim() !== base().dictation.model;
  const dirty = () => voiceDirty() || appIdDirty() || dictationDirty() || Object.values(secrets()).some((v) => v?.trim()) || cleared().size > 0;
  const problem = useProblem(() => ({ voice: draft(), ...(dictationDirty() ? { dictation: dictation() } : {}) }));
  const atDefaults = () => sameVoice(draft(), withPart(props.part, draft(), base().voiceDefaults));

  const submit = async () => {
    const update: Record<string, unknown> = {};
    for (const k of cleared()) update[k] = "";
    if (appIdDirty() && !cleared().has("agoraAppId")) update.agoraAppId = appId().trim();
    for (const [k, v] of Object.entries(secrets())) if (v?.trim()) update[k] = v.trim();
    if (voiceDirty()) update.voice = withPart(props.part, base().voice, draft());
    if (dictationDirty()) update.dictation = { url: dictation().url.trim(), model: dictation().model.trim() };
    setBusy(true);
    setError(undefined);
    try {
      const now = await saveSettings(update);
      setBase(now);
      setSecrets({});
      setCleared(new Set<Key>());
      setSaved(true);
    } catch (e) {
      setError(reasonOf(e));
    } finally {
      setBusy(false);
    }
  };
  const undo = () => {
    setDraft(base().voice);
    setAppId(base().agoraAppId.value ?? "");
    setDictation(base().dictation);
    setSecrets({});
    setCleared(new Set<Key>());
    setError(undefined);
  };

  const clearLink = (k: Key) => (
    <TextLink
      danger
      onClick={() => {
        setCleared(new Set([...cleared(), k]));
        touched();
      }}
    >
      清掉
    </TextLink>
  );
  const secret = (k: Key, label: string, current: () => KeyStatus) => (
    <Labeled
      label={label}
      aside={current().source === "settings" && !cleared().has(k) ? clearLink(k) : undefined}
      hint={cleared().has(k) ? "存的时候清掉" : current().source ? `在用 ${current().hint ?? ""}（${keyFrom[current().source!]}）` : "还没有"}
    >
      <SecretInput
        aria-label={label}
        placeholder="不改就空着"
        value={secrets()[k] ?? ""}
        onInput={(e) => {
          setSecrets({ ...secrets(), [k]: e.currentTarget.value });
          touched();
        }}
      />
    </Labeled>
  );
  const number = (k: VoiceNumber) => (
    <Labeled label={numberLabel[k]} hint={`${voiceLimits[k].min} 到 ${voiceLimits[k].max}，默认 ${base().voiceDefaults[k]}`}>
      <TextInput
        aria-label={numberLabel[k]}
        class="font-mono"
        inputmode="numeric"
        value={String(draft()[k])}
        onInput={(e) => set({ ...draft(), [k]: Number(e.currentTarget.value.replace(/\D/g, "")) || 0 })}
      />
    </Labeled>
  );

  const bar = () => (
    <div class="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-line bg-page px-4 py-2.5">
      <Switch fallback={<p class="text-xs text-muted">{dirty() ? "有没存的改动。" : "都存着。"}</p>}>
        <Match when={error()}>
          <p class="text-sm text-berry">{error()}</p>
        </Match>
        <Match when={problem()}>
          <p class="text-sm text-berry">{problem()}</p>
        </Match>
        <Match when={saved()}>
          <p class="text-sm text-accent">存好了，下一通电话就用上。</p>
        </Match>
      </Switch>
      <div class="flex gap-2">
        <Button disabled={atDefaults()} onClick={() => set(withPart(props.part, draft(), base().voiceDefaults))}>
          恢复默认
        </Button>
        <Button disabled={!dirty()} onClick={undo}>
          撤销
        </Button>
        <Button tone="primary" disabled={!dirty() || !!problem() || busy()} onClick={() => void submit()}>
          {busy() ? "在存…" : "保存"}
        </Button>
      </div>
    </div>
  );

  const tts = () => draft().tts;
  const asr = () => draft().asr;
  const answer = () => draft().answer;
  const credentialsReady = () => base().agoraAppId.source !== undefined && base().agoraAppCertificate.source !== undefined;
  const answerHint = () =>
    answer().vendor === "orchestrator"
      ? "田头上那个管家本人接电话：看得到现状，自己派活，记得你们说过的话。声网经一个公网地址访问本机的一个接口（配置的 voice.line.url，比如 Tailscale Funnel；没配时临时开 cloudflared），只有这一个接口对外，每通电话一把钥匙。"
      : answer().vendor === "agora"
        ? "声网托管的模型，不用别的 key。"
        : answer().vendor === "deepseek"
          ? base().deepseekApiKey.source
            ? `用设置里的 DeepSeek key（${keyFrom[base().deepseekApiKey.source!]}）。`
            : "用设置里的 DeepSeek key，现在还没有：去首页「设置」填。"
          : "任何 OpenAI 兼容的接口：通义、Kimi、自己部署的……";

  return (
    <Show
      when={props.part === "agent"}
      fallback={
        <div class="flex h-full min-h-0 flex-col gap-3">
          <div class="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto">
            <div class="flex max-w-4xl flex-col gap-2 px-1 pt-1">
              <h2 class="text-xl font-semibold">声音</h2>
              <p class="text-sm text-muted">
                管家用声网的对话式 AI 听你说话、开口回答。这里配线路：凭据、怎么听、谁接电话，都可以用声网托管的（不用别的
                key），也可以换成自己的服务。管家的人设、开场白和音色在
                <A class="underline" href="/orchestrator/voice">
                  管家页
                </A>
                。
              </p>
              <div class="flex flex-wrap items-center gap-2">
                <span class={["rounded px-1.5 py-0.5 text-xs", credentialsReady() ? "bg-[#e3efd2] text-[#3f6427]" : "bg-[#f6ddd8] text-berry"]}>
                  {credentialsReady() ? "能接通" : "还缺凭据"}
                </span>
                <span class="text-xs text-muted">改了以后，下一通电话生效</span>
                <span class="min-w-0 truncate font-mono text-xs text-muted" title={base().file}>
                  {base().file}
                </span>
              </div>
            </div>
            <Card title="凭据" action={<TextLink href="https://console.agora.io/">声网控制台 →</TextLink>} class="max-w-4xl">
              <Cols>
                <Labeled
                  label="App ID"
                  aside={base().agoraAppId.source === "settings" && !cleared().has("agoraAppId") ? clearLink("agoraAppId") : undefined}
                  hint={cleared().has("agoraAppId") ? "存的时候清掉" : base().agoraAppId.source ? keyFrom[base().agoraAppId.source!] : "还没有"}
                >
                  <TextInput
                    aria-label="Agora App ID"
                    class="font-mono"
                    placeholder="32 位十六进制"
                    value={appId()}
                    onInput={(e) => {
                      setAppId(e.currentTarget.value);
                      touched();
                    }}
                  />
                </Labeled>
                {secret("agoraAppCertificate", "App Certificate", () => base().agoraAppCertificate)}
                <Labeled label="区域" hint="Agora 接口的区域，选离服务端近的；中国大陆的项目选中国大陆。">
                  <Segmented
                    label="区域"
                    value={draft().area}
                    options={AreaValues.map((a) => ({ value: a, label: areaLabel[a] }))}
                    onChange={(area) => set({ ...draft(), area })}
                  />
                </Labeled>
              </Cols>
            </Card>
            <Card title="听" action={<span class="text-sm text-muted">识别 · VAD 断句</span>} class="max-w-4xl">
              <Cols>
                <Labeled label="识别" hint={asr().vendor === "microsoft" ? "微软 Azure 语音，用自己的 key。" : "声网托管，不用别的 key。"}>
                  <Segmented
                    label="识别"
                    value={asr().vendor}
                    options={options(asrLabel)}
                    onChange={(v) => set({ ...draft(), asr: v === asr().vendor ? asr() : asrStart[v] })}
                  />
                </Labeled>
                <Labeled label="语言" hint="听哪种话。人设里也写明用这种话回答。">
                  <Select
                    label="语言"
                    value={draft().language}
                    options={LanguageValues.map((l) => ({ value: l, label: `${languageLabel[l]}（${l}）` }))}
                    onChange={(l) => l && set({ ...draft(), language: l as VoiceSettings["language"] })}
                  />
                </Labeled>
                <Show when={asr().vendor === "deepgram" ? (asr() as Extract<VoiceSettings["asr"], { vendor: "deepgram" }>) : undefined}>
                  {(a) => (
                    <Labeled label="Deepgram 模型">
                      <Segmented
                        label="Deepgram 模型"
                        value={a().model}
                        options={plain(ModelValues)}
                        onChange={(model) => set({ ...draft(), asr: { vendor: "deepgram", model } })}
                      />
                    </Labeled>
                  )}
                </Show>
                <Show when={asr().vendor === "microsoft" ? (asr() as Extract<VoiceSettings["asr"], { vendor: "microsoft" }>) : undefined}>
                  {(a) => (
                    <>
                      <Labeled label="Azure 区域" hint="语音资源所在的区域，比如 eastasia、eastus。">
                        <TextInput
                          aria-label="识别的 Azure 区域"
                          class="font-mono"
                          value={a().region}
                          onInput={(e) => set({ ...draft(), asr: { vendor: "microsoft", region: e.currentTarget.value } })}
                        />
                      </Labeled>
                      {secret("asrKey", "微软语音的 key", () => base().asrKey)}
                    </>
                  )}
                </Show>
                {number("silenceMs")}
                {number("interruptMs")}
                {number("idleSeconds")}
              </Cols>
            </Card>
            <Card title="想" action={<span class="text-sm text-muted">{answerLabel[answer().vendor]}</span>} class="max-w-4xl">
              <Labeled label="谁接电话" hint={answerHint()}>
                <Segmented
                  label="谁接电话"
                  value={answer().vendor}
                  options={options(answerLabel)}
                  onChange={(v) => set({ ...draft(), answer: v === answer().vendor ? answer() : answerStart[v] })}
                />
              </Labeled>
              <Show when={answer().vendor === "agora" ? (answer() as Extract<VoiceSettings["answer"], { vendor: "agora" }>) : undefined}>
                {(a) => (
                  <Labeled label="模型">
                    <Segmented
                      label="模型"
                      value={a().model}
                      options={plain(VoiceAnswerAgoraModelValues)}
                      onChange={(model) => set({ ...draft(), answer: { vendor: "agora", model } })}
                    />
                  </Labeled>
                )}
              </Show>
              <Show when={answer().vendor === "deepseek" ? (answer() as Extract<VoiceSettings["answer"], { vendor: "deepseek" }>) : undefined}>
                {(a) => (
                  <Labeled label="模型" hint="DeepSeek 的模型名。">
                    <TextInput
                      aria-label="DeepSeek 模型"
                      class="font-mono"
                      value={a().model}
                      onInput={(e) => set({ ...draft(), answer: { vendor: "deepseek", model: e.currentTarget.value } })}
                    />
                  </Labeled>
                )}
              </Show>
              <Show when={answer().vendor === "openai" ? (answer() as Extract<VoiceSettings["answer"], { vendor: "openai" }>) : undefined}>
                {(a) => (
                  <Cols>
                    <Labeled label="地址" hint="OpenAI 兼容的 chat completions 完整地址。">
                      <TextInput
                        aria-label="大模型地址"
                        class="font-mono"
                        value={a().url}
                        onInput={(e) => set({ ...draft(), answer: { ...a(), url: e.currentTarget.value } })}
                      />
                    </Labeled>
                    <Labeled label="模型">
                      <TextInput
                        aria-label="大模型名"
                        class="font-mono"
                        value={a().model}
                        onInput={(e) => set({ ...draft(), answer: { ...a(), model: e.currentTarget.value } })}
                      />
                    </Labeled>
                    {secret("llmKey", "接口的 key", () => base().llmKey)}
                  </Cols>
                )}
              </Show>
            </Card>
            <Card title="听写" action={<TextLink href="https://github.com/soniqo/speech-swift">本机的 speech-server →</TextLink>} class="max-w-4xl">
              <p class="text-sm text-muted">
                田头输入框旁的录音按钮：说一段，停下以后识别成字放进输入框，看过再发。服务端把录音原样转给下面这个 OpenAI 兼容的转写地址；填本机的
                speech-server，声音就不出这台电脑。
              </p>
              <Cols>
                <Labeled label="地址" hint="到 /v1 为止。本机：http://127.0.0.1:8080/v1；OpenAI：https://api.openai.com/v1。空着就不用听写。">
                  <TextInput
                    aria-label="听写的地址"
                    class="font-mono"
                    placeholder="http://127.0.0.1:8080/v1"
                    value={dictation().url}
                    onInput={(e) => {
                      setDictation({ ...dictation(), url: e.currentTarget.value });
                      touched();
                    }}
                  />
                </Labeled>
                <Labeled label="模型" hint="本机的 speech-server 填 qwen3；OpenAI 填 gpt-4o-mini-transcribe。">
                  <TextInput
                    aria-label="听写的模型"
                    class="font-mono"
                    placeholder="qwen3"
                    value={dictation().model}
                    onInput={(e) => {
                      setDictation({ ...dictation(), model: e.currentTarget.value });
                      touched();
                    }}
                  />
                </Labeled>
                {secret("dictationKey", "凭据（本机可以空着）", () => base().dictationKey)}
              </Cols>
            </Card>
          </div>
          <div class="max-w-4xl">{bar()}</div>
        </div>
      }
    >
      <div class="flex max-w-4xl flex-col gap-3">
        <p class="text-sm text-muted">
          打电话时管家怎么开口、用什么声音。凭据、怎么听、谁接电话在
          <A class="underline" href="/settings/voice">
            声音
          </A>
          页。
        </p>
        <Card title="开口" action={<span class="text-sm text-muted">人设 · 开场白</span>}>
          {/* The persona is the quick model's only: the orchestrator answering is itself, with its own prompt. */}
          <Show
            when={answer().vendor !== "orchestrator"}
            fallback={<p class="text-sm text-muted">电话由管家自己接：它就是田头里那个管家，用它自己的提示词，不另设人设。</p>}
          >
            <Labeled label="人设" hint="电话里先答话的模型是谁、怎么说话。它看不到现状，派活由本机的管家做；写明别编进度。">
              <TextArea aria-label="人设" rows={8} value={draft().persona} onInput={(e) => set({ ...draft(), persona: e.currentTarget.value })} />
            </Labeled>
          </Show>
          <Cols>
            <Labeled label="开场白" hint="接通时先说的一句。">
              <TextInput aria-label="开场白" value={draft().greeting} onInput={(e) => set({ ...draft(), greeting: e.currentTarget.value })} />
            </Labeled>
            <Labeled label="出错时说" hint="大模型出错时说的一句。">
              <TextInput aria-label="出错时说" value={draft().failureMessage} onInput={(e) => set({ ...draft(), failureMessage: e.currentTarget.value })} />
            </Labeled>
          </Cols>
        </Card>
        <Card title="说" action={<span class="text-sm text-muted">{ttsLabel[tts().vendor]}</span>}>
          <Cols>
            <Labeled label="合成" hint={tts().vendor === "microsoft" ? "微软 Azure 语音，用自己的 key。" : "声网托管，不用别的 key。"}>
              <Segmented
                label="合成"
                value={tts().vendor}
                options={options(ttsLabel)}
                onChange={(v) => set({ ...draft(), tts: v === tts().vendor ? tts() : ttsStart[v] })}
              />
            </Labeled>
            <Show when={tts().vendor === "minimax" ? (tts() as Extract<VoiceSettings["tts"], { vendor: "minimax" }>) : undefined}>
              {(t) => (
                <Labeled label="合成模型">
                  <Segmented
                    label="合成模型"
                    value={t().model}
                    options={plain(VoiceTTSMinimaxModelValues)}
                    onChange={(model) => set({ ...draft(), tts: { ...t(), model } })}
                  />
                </Labeled>
              )}
            </Show>
            <Show when={tts().vendor === "openai" ? (tts() as Extract<VoiceSettings["tts"], { vendor: "openai" }>) : undefined}>
              {(t) => (
                <Labeled label="音色" hint="OpenAI tts-1 的音色。">
                  <Segmented label="音色" value={t().voice} options={plain(VoiceValues)} onChange={(voice) => set({ ...draft(), tts: { ...t(), voice } })} />
                </Labeled>
              )}
            </Show>
            <Show when={tts().vendor === "microsoft" ? (tts() as Extract<VoiceSettings["tts"], { vendor: "microsoft" }>) : undefined}>
              {(t) => (
                <>
                  <Labeled label="Azure 区域">
                    <TextInput
                      aria-label="合成的 Azure 区域"
                      class="font-mono"
                      value={t().region}
                      onInput={(e) => set({ ...draft(), tts: { ...t(), region: e.currentTarget.value } })}
                    />
                  </Labeled>
                  <Labeled label="音色" hint="Azure 的神经网络音色名，比如 zh-CN-XiaoxiaoNeural。">
                    <TextInput
                      aria-label="微软音色"
                      class="font-mono"
                      list="microsoft-voices"
                      value={t().voiceName}
                      onInput={(e) => set({ ...draft(), tts: { ...t(), voiceName: e.currentTarget.value } })}
                    />
                    <datalist id="microsoft-voices">
                      <For each={microsoftVoices}>{(v) => <option value={v} />}</For>
                    </datalist>
                  </Labeled>
                  {secret("ttsKey", "微软语音的 key", () => base().ttsKey)}
                </>
              )}
            </Show>
          </Cols>
          <Show when={tts().vendor === "minimax" ? (tts() as Extract<VoiceSettings["tts"], { vendor: "minimax" }>) : undefined}>
            {(t) => (
              <>
                <Labeled label="音色" hint="点名字选它，点左边的播放键先听一句；也可以在下面填别的 MiniMax 系统音色 id。">
                  <MiniMaxVoices value={t().voiceId} onChange={(voiceId) => set({ ...draft(), tts: { ...t(), voiceId } })} />
                </Labeled>
                <Cols>
                  <Labeled label="音色 id">
                    <TextInput
                      aria-label="音色 id"
                      class="font-mono"
                      value={t().voiceId}
                      onInput={(e) => set({ ...draft(), tts: { ...t(), voiceId: e.currentTarget.value } })}
                    />
                  </Labeled>
                </Cols>
              </>
            )}
          </Show>
        </Card>
        {bar()}
      </div>
    </Show>
  );
}

function Cols(props: { children: JSX.Element }) {
  return <div class="grid gap-4 md:grid-cols-2">{props.children}</div>;
}

/** A label, what sits at its right (清掉), the control and a hint under it. */
function Labeled(props: { label: string; hint?: string; aside?: JSX.Element; children: JSX.Element }) {
  return (
    <div class="flex flex-col gap-1">
      <div class="flex items-center gap-2">
        <span class="flex-1 text-xs font-medium text-muted">{props.label}</span>
        {props.aside}
      </div>
      <div>{props.children}</div>
      <Show when={props.hint}>
        <span class="text-xs text-faint">{props.hint}</span>
      </Show>
    </div>
  );
}

/** The MiniMax voices with a sample each: one plays at a time, pressed again it stops. */
function MiniMaxVoices(props: { value: string; onChange: (id: string) => void }) {
  const [playing, setPlaying] = createSignal<string>();
  let audio: HTMLAudioElement | undefined;
  onSettled(() => () => audio?.pause());
  const play = (id: string, src: string) => {
    audio?.pause();
    if (playing() === id) return setPlaying(undefined);
    const a = new Audio(src);
    audio = a;
    a.onended = a.onerror = () => setPlaying((p) => (p === id ? undefined : p));
    setPlaying(id);
    a.play().catch(() => setPlaying(undefined));
  };
  return (
    <div class="grid grid-cols-2 gap-1.5 sm:grid-cols-3">
      <For each={minimaxVoices}>
        {(v) => {
          const sample = voiceSample(v.id);
          const chosen = () => v.id === props.value;
          return (
            <div class={["flex h-[34px] items-center rounded-md border", chosen() ? "border-ink/40 bg-selected" : "border-line bg-page"]}>
              <button
                type="button"
                disabled={!sample}
                title={sample ? `试听：${defaultGreeting}` : "没有样音"}
                aria-label={playing() === v.id ? `停下 ${v.label}` : `试听 ${v.label}`}
                class="ml-0.5 inline-flex size-7 shrink-0 cursor-pointer items-center justify-center rounded hover:bg-hover disabled:cursor-default disabled:opacity-40"
                onClick={() => sample && play(v.id, sample)}
              >
                <Icon name={playing() === v.id ? "button-stop" : "button-play"} size={16} />
              </button>
              <button
                type="button"
                title={v.id}
                aria-pressed={aria(chosen())}
                class={[
                  "h-full min-w-0 flex-1 cursor-pointer truncate pr-2 pl-1 text-left text-sm",
                  chosen() ? "font-semibold" : "text-bark-800 hover:text-ink",
                ]}
                onClick={() => props.onChange(v.id)}
              >
                {v.label}
              </button>
            </div>
          );
        }}
      </For>
    </div>
  );
}
