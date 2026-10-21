// 声音: the call's line on /settings/voice (credentials, how it listens, who answers, dictation)
// and the manager's voice on /manager/voice (what it says, in what voice). Each part saves only its own fields over the
// settings as they are now: the other part may have been saved meanwhile.

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import {
  defaultGreeting,
  type Dictation,
  type KeySource,
  type KeyStatus,
  LanguageValues,
  ModelValues,
  AreaValues,
  type SettingsStatus,
  type SettingsUpdate,
  VoiceAnswerAgoraModelValues,
  type VoiceSettings,
  VoiceTTSMinimaxModelValues,
  VoiceValues,
} from "@vibevalley/protocol";
import { api, reasonOf } from "../../data/api";
import { useSettled } from "../../data/settled";
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
import { Button } from "../../ui/Button";
import { Select, TextArea, TextInput } from "../../ui/Field";
import { Icon } from "../../ui/Icon";
import { Segmented } from "../../ui/Segmented";
import { Card, Quiet, SecretInput, TextLink } from "../kit";
import { useSaveSettings, useSettings } from "./SettingsForm";

type Key = "agoraAppId" | "agoraAppCertificate" | "asrKey" | "llmKey" | "ttsKey" | "dictationKey";

const keyFrom: Record<KeySource, string> = { settings: "存在设置里", config: "来自配置（vibevalley.yaml 或环境变量）" };

const options = <T extends string>(labels: Record<T, string>) => (Object.keys(labels) as T[]).map((value) => ({ value, label: labels[value] }));
const plain = <T extends string>(values: readonly T[]) => values.map((value) => ({ value, label: value }));

export function VoiceForm({ part }: { part: VoicePart }) {
  const settings = useSettings();
  if (!settings.data) return <Quiet>{settings.error ? `问不到服务端的设置（${reasonOf(settings.error)}）。` : "在问服务端……"}</Quiet>;
  return <Form key={settings.data.file} status={settings.data} part={part} />;
}

/** What the server says is wrong with the draft, asked a moment after it last changed. */
function useProblem(update: SettingsUpdate) {
  const asked = useSettled(JSON.stringify(update));
  return useQuery({
    queryKey: ["settings-check", asked],
    queryFn: () => api.setting.check({ body: JSON.parse(asked) as SettingsUpdate }),
    placeholderData: keepPreviousData,
  }).data?.problem;
}

function Form({ status, part }: { status: SettingsStatus; part: VoicePart }) {
  const save = useSaveSettings();
  const [draft, setDraft] = useState(status.voice);
  const [appId, setAppId] = useState(status.agoraAppId.value ?? "");
  const [dictation, setDictation] = useState<Dictation>(status.dictation);
  const [secrets, setSecrets] = useState<Partial<Record<Key, string>>>({});
  const [cleared, setCleared] = useState<ReadonlySet<Key>>(new Set());
  const [error, setError] = useState<string>();
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  // The settings as saved now: a save answers with them, and the form keeps the draft over them.
  const [base, setBase] = useState(status);

  const touched = () => setSaved(false);
  const set = (next: VoiceSettings) => {
    setDraft(next);
    touched();
  };
  const voiceDirty = !sameVoice(draft, base.voice);
  const appIdDirty = appId.trim() !== (base.agoraAppId.value ?? "");
  const dictationDirty = dictation.url.trim() !== base.dictation.url || dictation.model.trim() !== base.dictation.model;
  const dirty = voiceDirty || appIdDirty || dictationDirty || Object.values(secrets).some((v) => v?.trim()) || cleared.size > 0;
  const problem = useProblem({ voice: draft, ...(dictationDirty ? { dictation } : {}) });
  const atDefaults = sameVoice(draft, withPart(part, draft, base.voiceDefaults));

  const submit = async () => {
    const update: Record<string, unknown> = {};
    for (const k of cleared) update[k] = "";
    if (appIdDirty && !cleared.has("agoraAppId")) update.agoraAppId = appId.trim();
    for (const [k, v] of Object.entries(secrets)) if (v?.trim()) update[k] = v.trim();
    if (voiceDirty) update.voice = withPart(part, base.voice, draft);
    if (dictationDirty) update.dictation = { url: dictation.url.trim(), model: dictation.model.trim() };
    setBusy(true);
    setError(undefined);
    try {
      const now = await save(update as SettingsUpdate);
      setBase(now);
      setSecrets({});
      setCleared(new Set());
      setSaved(true);
    } catch (e) {
      setError(reasonOf(e));
    } finally {
      setBusy(false);
    }
  };
  const undo = () => {
    setDraft(base.voice);
    setAppId(base.agoraAppId.value ?? "");
    setDictation(base.dictation);
    setSecrets({});
    setCleared(new Set());
    setError(undefined);
  };

  const clearLink = (k: Key) => (
    <TextLink
      danger
      onClick={() => {
        setCleared(new Set([...cleared, k]));
        touched();
      }}
    >
      清掉
    </TextLink>
  );
  const secret = (k: Key, label: string, current: KeyStatus) => (
    <Labeled
      label={label}
      aside={current.source === "settings" && !cleared.has(k) ? clearLink(k) : undefined}
      hint={cleared.has(k) ? "存的时候清掉" : current.source ? `在用 ${current.hint ?? ""}（${keyFrom[current.source]}）` : "还没有"}
    >
      <SecretInput
        aria-label={label}
        placeholder="不改就空着"
        value={secrets[k] ?? ""}
        onChange={(e) => {
          setSecrets({ ...secrets, [k]: e.target.value });
          touched();
        }}
      />
    </Labeled>
  );
  const number = (k: VoiceNumber) => (
    <Labeled label={numberLabel[k]} hint={`${voiceLimits[k].min} 到 ${voiceLimits[k].max}，默认 ${base.voiceDefaults[k]}`}>
      <TextInput
        aria-label={numberLabel[k]}
        className="font-mono"
        inputMode="numeric"
        value={String(draft[k])}
        onChange={(e) => set({ ...draft, [k]: Number(e.target.value.replace(/\D/g, "")) || 0 })}
      />
    </Labeled>
  );

  const bar = (
    <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-line bg-page px-4 py-2.5">
      {error ? (
        <p className="text-sm text-berry">{error}</p>
      ) : problem ? (
        <p className="text-sm text-berry">{problem}</p>
      ) : saved ? (
        <p className="text-sm text-accent">存好了，下一通电话就用上。</p>
      ) : (
        <p className="text-xs text-muted">{dirty ? "有没存的改动。" : "都存着。"}</p>
      )}
      <div className="flex gap-2">
        <Button disabled={atDefaults} onClick={() => set(withPart(part, draft, base.voiceDefaults))}>
          恢复默认
        </Button>
        <Button disabled={!dirty} onClick={undo}>
          撤销
        </Button>
        <Button tone="primary" disabled={!dirty || !!problem || busy} onClick={submit}>
          {busy ? "在存…" : "保存"}
        </Button>
      </div>
    </div>
  );

  if (part === "agent") {
    const tts = draft.tts;
    return (
      <div className="flex max-w-4xl flex-col gap-3">
        <p className="text-sm text-muted">
          打电话时管家怎么开口、用什么声音。凭据、怎么听、谁接电话在
          <Link className="underline" to="/settings/voice">
            声音
          </Link>
          页。
        </p>
        <Card title="开口" action={<span className="text-sm text-muted">人设 · 开场白</span>}>
          <Labeled
            label="人设"
            hint={
              draft.answer.vendor === "manager"
                ? "「想」选了农场的管家：它自己接电话，用的是它自己的提示词，这段人设不用。"
                : "语音管家是谁、怎么说话。他看不到地里，派活由本机的管家做；写明别编进度。"
            }
          >
            <TextArea aria-label="人设" rows={8} value={draft.persona} onChange={(e) => set({ ...draft, persona: e.target.value })} />
          </Labeled>
          <Cols>
            <Labeled label="开场白" hint="接通时先说的一句。">
              <TextInput aria-label="开场白" value={draft.greeting} onChange={(e) => set({ ...draft, greeting: e.target.value })} />
            </Labeled>
            <Labeled label="出错时说" hint="大模型出错时说的一句。">
              <TextInput aria-label="出错时说" value={draft.failureMessage} onChange={(e) => set({ ...draft, failureMessage: e.target.value })} />
            </Labeled>
          </Cols>
        </Card>
        <Card title="说" action={<span className="text-sm text-muted">{ttsLabel[tts.vendor]}</span>}>
          <Cols>
            <Labeled label="合成" hint={tts.vendor === "microsoft" ? "微软 Azure 语音，用自己的 key。" : "声网托管，不用别的 key。"}>
              <Segmented
                label="合成"
                value={tts.vendor}
                options={options(ttsLabel)}
                onChange={(v) => set({ ...draft, tts: v === tts.vendor ? tts : ttsStart[v] })}
              />
            </Labeled>
            {tts.vendor === "minimax" && (
              <Labeled label="合成模型">
                <Segmented
                  label="合成模型"
                  value={tts.model}
                  options={plain(VoiceTTSMinimaxModelValues)}
                  onChange={(model) => set({ ...draft, tts: { ...tts, model } })}
                />
              </Labeled>
            )}
            {tts.vendor === "openai" && (
              <Labeled label="音色" hint="OpenAI tts-1 的音色。">
                <Segmented label="音色" value={tts.voice} options={plain(VoiceValues)} onChange={(voice) => set({ ...draft, tts: { ...tts, voice } })} />
              </Labeled>
            )}
            {tts.vendor === "microsoft" && (
              <>
                <Labeled label="Azure 区域">
                  <TextInput
                    aria-label="合成的 Azure 区域"
                    className="font-mono"
                    value={tts.region}
                    onChange={(e) => set({ ...draft, tts: { ...tts, region: e.target.value } })}
                  />
                </Labeled>
                <Labeled label="音色" hint="Azure 的神经网络音色名，比如 zh-CN-XiaoxiaoNeural。">
                  <TextInput
                    aria-label="微软音色"
                    className="font-mono"
                    list="microsoft-voices"
                    value={tts.voiceName}
                    onChange={(e) => set({ ...draft, tts: { ...tts, voiceName: e.target.value } })}
                  />
                  <datalist id="microsoft-voices">
                    {microsoftVoices.map((v) => (
                      <option key={v} value={v} />
                    ))}
                  </datalist>
                </Labeled>
                {secret("ttsKey", "微软语音的 key", base.ttsKey)}
              </>
            )}
          </Cols>
          {tts.vendor === "minimax" && (
            <>
              <Labeled label="音色" hint="点名字选它，点左边的播放键先听一句；也可以在下面填别的 MiniMax 系统音色 id。">
                <MiniMaxVoices value={tts.voiceId} onChange={(voiceId) => set({ ...draft, tts: { ...tts, voiceId } })} />
              </Labeled>
              <Cols>
                <Labeled label="音色 id">
                  <TextInput
                    aria-label="音色 id"
                    className="font-mono"
                    value={tts.voiceId}
                    onChange={(e) => set({ ...draft, tts: { ...tts, voiceId: e.target.value } })}
                  />
                </Labeled>
              </Cols>
            </>
          )}
        </Card>
        {bar}
      </div>
    );
  }

  const asr = draft.asr;
  const answer = draft.answer;
  const ready = base.agoraAppId.source !== undefined && base.agoraAppCertificate.source !== undefined;
  const answerHint =
    answer.vendor === "manager"
      ? "田头上那个管家本人接电话：看得到地里，自己派活，记得你们说过的话。声网经隧道（cloudflared）访问本机的一个接口，只有这一个接口对外，每通电话一把钥匙。"
      : answer.vendor === "agora"
        ? "声网托管的模型，不用别的 key。"
        : answer.vendor === "deepseek"
          ? base.deepseekApiKey.source
            ? `用农场的 DeepSeek key（${keyFrom[base.deepseekApiKey.source]}）。`
            : "用农场的 DeepSeek key，现在还没有：去首页「设置」填。"
          : "任何 OpenAI 兼容的接口：通义、Kimi、自己部署的……";
  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto">
        <div className="flex max-w-4xl flex-col gap-2 px-1 pt-1">
          <h2 className="text-xl font-semibold">声音</h2>
          <p className="text-sm text-muted">
            管家用声网的对话式 AI 听你说话、开口回答。这里配线路：凭据、怎么听、谁接电话，都可以用声网托管的（不用别的
            key），也可以换成自己的服务。管家的人设、开场白和音色在
            <Link className="underline" to="/manager/voice">
              管家页
            </Link>
            。
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <span className={`rounded px-1.5 py-0.5 text-xs ${ready ? "bg-[#e3efd2] text-[#3f6427]" : "bg-[#f6ddd8] text-berry"}`}>
              {ready ? "能接通" : "还缺凭据"}
            </span>
            <span className="text-xs text-muted">改了以后，下一通电话生效</span>
            <span className="min-w-0 truncate font-mono text-xs text-muted" title={base.file}>
              {base.file}
            </span>
          </div>
        </div>
        <Card title="凭据" action={<TextLink href="https://console.agora.io/">声网控制台 →</TextLink>} className="max-w-4xl">
          <Cols>
            <Labeled
              label="App ID"
              aside={base.agoraAppId.source === "settings" && !cleared.has("agoraAppId") ? clearLink("agoraAppId") : undefined}
              hint={cleared.has("agoraAppId") ? "存的时候清掉" : base.agoraAppId.source ? keyFrom[base.agoraAppId.source] : "还没有"}
            >
              <TextInput
                aria-label="Agora App ID"
                className="font-mono"
                placeholder="32 位十六进制"
                value={appId}
                onChange={(e) => {
                  setAppId(e.target.value);
                  touched();
                }}
              />
            </Labeled>
            {secret("agoraAppCertificate", "App Certificate", base.agoraAppCertificate)}
            <Labeled label="区域" hint="Agora 接口的区域，选离服务端近的；中国大陆的项目选中国大陆。">
              <Segmented
                label="区域"
                value={draft.area}
                options={AreaValues.map((a) => ({ value: a, label: areaLabel[a] }))}
                onChange={(area) => set({ ...draft, area })}
              />
            </Labeled>
          </Cols>
        </Card>
        <Card title="听" action={<span className="text-sm text-muted">识别 · VAD 断句</span>} className="max-w-4xl">
          <Cols>
            <Labeled label="识别" hint={asr.vendor === "microsoft" ? "微软 Azure 语音，用自己的 key。" : "声网托管，不用别的 key。"}>
              <Segmented
                label="识别"
                value={asr.vendor}
                options={options(asrLabel)}
                onChange={(v) => set({ ...draft, asr: v === asr.vendor ? asr : asrStart[v] })}
              />
            </Labeled>
            <Labeled label="语言" hint="听哪种话。人设里也写明用这种话回答。">
              <Select
                label="语言"
                value={draft.language}
                options={LanguageValues.map((l) => ({ value: l, label: `${languageLabel[l]}（${l}）` }))}
                onChange={(l) => l && set({ ...draft, language: l as typeof draft.language })}
              />
            </Labeled>
            {asr.vendor === "deepgram" && (
              <Labeled label="Deepgram 模型">
                <Segmented
                  label="Deepgram 模型"
                  value={asr.model}
                  options={plain(ModelValues)}
                  onChange={(model) => set({ ...draft, asr: { vendor: "deepgram", model } })}
                />
              </Labeled>
            )}
            {asr.vendor === "microsoft" && (
              <>
                <Labeled label="Azure 区域" hint="语音资源所在的区域，比如 eastasia、eastus。">
                  <TextInput
                    aria-label="识别的 Azure 区域"
                    className="font-mono"
                    value={asr.region}
                    onChange={(e) => set({ ...draft, asr: { vendor: "microsoft", region: e.target.value } })}
                  />
                </Labeled>
                {secret("asrKey", "微软语音的 key", base.asrKey)}
              </>
            )}
            {number("silenceMs")}
            {number("interruptMs")}
            {number("idleSeconds")}
          </Cols>
        </Card>
        <Card title="想" action={<span className="text-sm text-muted">{answerLabel[answer.vendor]}</span>} className="max-w-4xl">
          <Labeled label="谁接电话" hint={answerHint}>
            <Segmented
              label="谁接电话"
              value={answer.vendor}
              options={options(answerLabel)}
              onChange={(v) => set({ ...draft, answer: v === answer.vendor ? answer : answerStart[v] })}
            />
          </Labeled>
          {answer.vendor === "agora" && (
            <Labeled label="模型">
              <Segmented
                label="模型"
                value={answer.model}
                options={plain(VoiceAnswerAgoraModelValues)}
                onChange={(model) => set({ ...draft, answer: { vendor: "agora", model } })}
              />
            </Labeled>
          )}
          {answer.vendor === "deepseek" && (
            <Labeled label="模型" hint="DeepSeek 的模型名。">
              <TextInput
                aria-label="DeepSeek 模型"
                className="font-mono"
                value={answer.model}
                onChange={(e) => set({ ...draft, answer: { vendor: "deepseek", model: e.target.value } })}
              />
            </Labeled>
          )}
          {answer.vendor === "openai" && (
            <Cols>
              <Labeled label="地址" hint="OpenAI 兼容的 chat completions 完整地址。">
                <TextInput
                  aria-label="大模型地址"
                  className="font-mono"
                  value={answer.url}
                  onChange={(e) => set({ ...draft, answer: { ...answer, url: e.target.value } })}
                />
              </Labeled>
              <Labeled label="模型">
                <TextInput
                  aria-label="大模型名"
                  className="font-mono"
                  value={answer.model}
                  onChange={(e) => set({ ...draft, answer: { ...answer, model: e.target.value } })}
                />
              </Labeled>
              {secret("llmKey", "接口的 key", base.llmKey)}
            </Cols>
          )}
        </Card>
        <Card title="听写" action={<TextLink href="https://github.com/soniqo/speech-swift">本机的 speech-server →</TextLink>} className="max-w-4xl">
          <p className="text-sm text-muted">
            田头输入框旁的录音按钮：说一段，停下以后识别成字放进输入框，看过再发。服务端把录音原样转给下面这个 OpenAI 兼容的转写地址；填本机的
            speech-server，声音就不出这台电脑。
          </p>
          <Cols>
            <Labeled label="地址" hint="到 /v1 为止。本机：http://127.0.0.1:8080/v1；OpenAI：https://api.openai.com/v1。空着就不用听写。">
              <TextInput
                aria-label="听写的地址"
                className="font-mono"
                placeholder="http://127.0.0.1:8080/v1"
                value={dictation.url}
                onChange={(e) => {
                  setDictation({ ...dictation, url: e.target.value });
                  touched();
                }}
              />
            </Labeled>
            <Labeled label="模型" hint="本机的 speech-server 填 qwen3；OpenAI 填 gpt-4o-mini-transcribe。">
              <TextInput
                aria-label="听写的模型"
                className="font-mono"
                placeholder="qwen3"
                value={dictation.model}
                onChange={(e) => {
                  setDictation({ ...dictation, model: e.target.value });
                  touched();
                }}
              />
            </Labeled>
            {secret("dictationKey", "凭据（本机可以空着）", base.dictationKey)}
          </Cols>
        </Card>
      </div>
      <div className="max-w-4xl">{bar}</div>
    </div>
  );
}

function Cols({ children }: { children: ReactNode }) {
  return <div className="grid gap-4 md:grid-cols-2">{children}</div>;
}

/** A label, what sits at its right (清掉), the control and a hint under it. */
function Labeled({ label, hint, aside, children }: { label: string; hint?: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2">
        <span className="flex-1 text-xs font-medium text-muted">{label}</span>
        {aside}
      </div>
      <div>{children}</div>
      {hint && <span className="text-xs text-faint">{hint}</span>}
    </div>
  );
}

/** The MiniMax voices with a sample each: one plays at a time, pressed again it stops. */
function MiniMaxVoices({ value, onChange }: { value: string; onChange: (id: string) => void }) {
  const [playing, setPlaying] = useState<string>();
  const audio = useRef<HTMLAudioElement>(null);
  useEffect(() => () => audio.current?.pause(), []);
  const play = (id: string, src: string) => {
    audio.current?.pause();
    if (playing === id) return setPlaying(undefined);
    const a = new Audio(src);
    audio.current = a;
    a.onended = a.onerror = () => setPlaying((p) => (p === id ? undefined : p));
    setPlaying(id);
    a.play().catch(() => setPlaying(undefined));
  };
  return (
    <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3">
      {minimaxVoices.map((v) => {
        const sample = voiceSample(v.id);
        const chosen = v.id === value;
        return (
          <div key={v.id} className={`flex h-[34px] items-center rounded-md border ${chosen ? "border-ink/40 bg-selected" : "border-line bg-page"}`}>
            <button
              type="button"
              disabled={!sample}
              title={sample ? `试听：${defaultGreeting}` : "没有样音"}
              aria-label={playing === v.id ? `停下 ${v.label}` : `试听 ${v.label}`}
              className="ml-0.5 inline-flex size-7 shrink-0 cursor-pointer items-center justify-center rounded hover:bg-hover disabled:cursor-default disabled:opacity-40"
              onClick={() => sample && play(v.id, sample)}
            >
              <Icon name={playing === v.id ? "button-stop" : "button-play"} size={16} />
            </button>
            <button
              type="button"
              title={v.id}
              aria-pressed={chosen}
              className={`h-full min-w-0 flex-1 cursor-pointer truncate pr-2 pl-1 text-left text-sm ${chosen ? "font-semibold" : "text-bark-800 hover:text-ink"}`}
              onClick={() => onChange(v.id)}
            >
              {v.label}
            </button>
          </div>
        );
      })}
    </div>
  );
}
