import { signal, Text, untracked, View, type JSX } from "nsh";

import { t } from "@vibevalley/i18n";
import type { SettingsStatus, SettingsUpdate, VoiceSettings } from "@vibevalley/protocol";
import { same } from "@vibevalley/protocol/rules";

import { createAct } from "../../../design/act";
import { Button } from "../../../design/Button";
import { TextArea, TextInput } from "../../../design/Field";
import { Icon } from "../../../design/Icon";
import { SaveBar } from "../../../design/KeyField";
import { Card, Quiet } from "../../../design/layout";
import { TextLink } from "../../../design/TextLink";
import { Hint } from "../../../design/Tip";
import { toast } from "../../../design/toasts";
import { api, reasonOf } from "../../../infra/api";
import { createSettled, Keyed } from "../../../infra/base/dom";
import { defineQuery, ready, useQuery, useSettings } from "../../../infra/query";
import { Link as A } from "../../../infra/router";
import { useSaveSettings } from "../../../infra/settings";
import { MossVerify } from "./MossVerify";
import { NativeCall } from "./NativeCall";

type VoicePart = "line" | "agent";

const sameVoice = (a: VoiceSettings, b: VoiceSettings) => same(a, b);

export function VoiceForm(props: { part: VoicePart }) {
  const settings = useSettings();
  return (
    <If
      when={ready(settings, undefined)}
      else={<Quiet>{settings.error() ? t("web.voice.voice.noSettings", { why: reasonOf(settings.error()) }) : t("web.base.form.asking")}</Quiet>}
    >
      {(status) => <Keyed key={status().file}>{() => <Form status={untracked(status)} part={props.part} />}</Keyed>}
    </If>
  );
}

/** What the server says is wrong with the draft, asked a moment after it last changed. */
const problemQuery = defineQuery({
  key: (a: { input: SettingsUpdate; token: string }) => ["settings-check", a.token],
  fetch: (a, context) => api.setting.validate(a.input, context),
  gcTime: 0,
});

function useProblem(update: () => SettingsUpdate) {
  const asked = createSettled(update);
  const check = useQuery(() => problemQuery({ input: asked(), token: crypto.randomUUID() }));
  return () => ready(check, undefined)?.problem;
}

function Labeled(props: { label: string; hint?: string; children: JSX.Element }) {
  return (
    <View class="gap-1.5">
      <View class="min-h-4 flex-row items-center gap-1.5">
        <Text class="text-xs font-medium text-muted">{props.label}</Text>
        <If when={props.hint}>{(h) => <Hint text={h()} />}</If>
      </View>
      <View>{props.children}</View>
    </View>
  );
}

function Form(props: { status: SettingsStatus; part: VoicePart }) {
  if (props.part === "line") {
    return (
      <View testID="voice-moss" class="min-h-0 gap-3">
        <View class="max-w-4xl flex-row flex-wrap items-center justify-between gap-3 rounded-lg border border-line bg-page px-4 py-3">
          <View class="min-w-0 flex-1 flex-row items-center gap-2">
            <Icon name="plug" size={14} tone="muted" />
            <TextLink href="/settings/models">{t("web.provider.manage")}</TextLink>
          </View>
          <MossVerify />
        </View>
        <NativeCall />
      </View>
    );
  }
  return <AgentVoiceForm status={props.status} />;
}

function AgentVoiceForm(props: { status: SettingsStatus }) {
  const saveSettings = useSaveSettings();
  const start = untracked(() => props.status);
  const draft = signal<VoiceSettings>(start.voice);
  const error = signal<string | undefined>(undefined);
  const act = createAct((e) => error.set(e));
  const busy = act.busy;
  const base = signal(start);

  const dirty = () => !sameVoice(draft(), base().voice);
  const problem = useProblem(() => ({ voice: draft() }));
  const atDefaults = () => sameVoice(draft(), base().voiceDefaults);

  const submit = async () => {
    error.set(undefined);
    await act.run(async () => {
      const now = await saveSettings({ voice: draft() });
      base.set(now);
      draft.set(now.voice);
      toast(t("web.voice.voice.saved"));
    });
  };

  const undo = () => {
    draft.set(base().voice);
    error.set(undefined);
  };

  return (
    <View testID="voice-agent" class="max-w-4xl gap-3">
      <View class="flex-row flex-wrap items-center gap-x-1 rounded-lg bg-side px-3.5 py-2">
        <View class="mr-0.5 shrink-0">
          <Icon name="info" size={12} tone="faint" />
        </View>
        <Text class="text-xs leading-relaxed text-muted">{t("web.voice.voice.persona.intro")}</Text>
        <A href="/settings/voice" class="rounded-sm px-0.5 hover:bg-hover focus-visible:outline-2 focus-visible:outline-focus">
          <Text class="text-xs font-medium text-water underline">{t("web.voice.voice.section.label")}</Text>
        </A>
        <Text class="text-xs leading-relaxed text-muted">{t("web.voice.voice.persona.page")}</Text>
      </View>
      <Card
        title={t("web.voice.voice.persona.open")}
        action={
          <View class="rounded-sm bg-side px-2 py-0.5">
            <Text class="text-xs font-medium text-muted">{t("web.voice.voice.persona.openParts")}</Text>
          </View>
        }
      >
        <Labeled label={t("web.voice.voice.persona.persona")} hint={t("web.voice.voice.persona.personaHint")}>
          <TextArea
            testID="persona"
            accessibilityLabel={t("web.voice.voice.persona.persona")}
            rows={8}
            value={draft().persona}
            onInput={(persona) => draft.set({ ...draft(), persona })}
          />
        </Labeled>
        <Labeled label={t("web.voice.voice.persona.greeting")} hint={t("web.voice.voice.persona.greetingHint")}>
          <TextInput
            testID="greeting"
            accessibilityLabel={t("web.voice.voice.persona.greeting")}
            value={draft().greeting}
            onInput={(greeting) => draft.set({ ...draft(), greeting })}
          />
        </Labeled>
      </Card>
      <SaveBar
        dirty={dirty()}
        busy={busy() || !!problem()}
        onSave={() => void submit()}
        onUndo={undo}
        left={
          <If when={error() ?? problem()}>
            {(e) => (
              <View class="flex-row items-center gap-1.5 self-start rounded-md bg-bad-soft px-2.5 py-1">
                <Icon name="cross" size={12} />
                <Text testID="voice-problem" role="alert" class="min-w-0 text-xs font-medium text-berry">
                  {e()}
                </Text>
              </View>
            )}
          </If>
        }
        extra={
          <Button tone="quiet" testID="reset" disabled={atDefaults()} onPress={() => draft.set(base().voiceDefaults)}>
            {t("web.base.form.reset")}
          </Button>
        }
      />
    </View>
  );
}
