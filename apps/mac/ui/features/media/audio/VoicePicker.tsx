import { computed, signal, Text, View } from "nsh";

import { t } from "@vibevalley/i18n";

import { Button } from "../../../design/Button";
import { Field, Select, TextInput } from "../../../design/Field";
import { Quiet } from "../../../design/layout";
import { createAct } from "../../../infra/act";
import { reasonOf } from "../../../infra/api";
import { providerVoicesQuery, ready, useQuery } from "../../../infra/query";
import { Refusal } from "../JobFacts";

export function VoicePicker(props: {
  connection: string;
  revision: number;
  value: string;
  disabled: boolean;
  testid: string;
  onChange: (voice: string) => void;
}) {
  const scope = () => `${props.connection}:${props.revision}`;
  const page = signal<{ scope: string; after: string } | undefined>(undefined);
  const search = signal("");
  const error = signal<string | undefined>(undefined);
  const act = createAct((e) => error.set(e));
  const voices = useQuery(
    () => {
      const after = page()?.scope === scope() ? page()?.after : undefined;
      return providerVoicesQuery({ connection: props.connection, revision: props.revision, limit: 20, ...(after ? { after } : {}) });
    },
    { enabled: () => Boolean(props.connection) },
  );
  const options = computed(() => {
    const term = search().trim().toLowerCase();
    const items = (ready(voices, undefined)?.voices ?? [])
      .filter((voice) => !term || voice.id.toLowerCase().includes(term) || voice.name.toLowerCase().includes(term))
      .map((voice) => ({ value: voice.id, label: voice.name ? `${voice.name} · ${voice.id}` : voice.id }));
    return props.value && !items.some((item) => item.value === props.value) ? [{ value: props.value, label: props.value }, ...items] : items;
  });
  return (
    <View class="min-w-0 gap-2">
      <View class="flex-row gap-2.5">
        <View class="min-w-0 flex-1">
          <Field label={t("web.audio.queryVoice")} hint={t("web.audio.queryHint")}>
            <TextInput
              testID={`${props.testid}-search`}
              accessibilityLabel={t("web.audio.queryVoice")}
              disabled={props.disabled}
              value={search()}
              onInput={(v) => search.set(v)}
            />
          </Field>
        </View>
        <View class="min-w-0 flex-1">
          <Field label={t("web.audio.voice")}>
            <Select
              testid={props.testid}
              label={t("web.audio.voice")}
              placeholder={t("web.audio.chooseVoice")}
              disabled={props.disabled || voices.fetching() || !props.connection}
              value={props.value}
              options={options()}
              onChange={(voice) => props.onChange(voice)}
            />
          </Field>
        </View>
      </View>
      <View class="flex-row flex-wrap items-center gap-2">
        <Button
          testID={`${props.testid}-first`}
          icon="refresh"
          disabled={props.disabled || voices.fetching() || !props.connection}
          onPress={() => {
            const first = page()?.scope !== scope() || !page()?.after;
            page.set(undefined);
            if (first) void act.run(() => voices.refetch());
          }}
        >
          {t("web.audio.first")}
        </Button>
        <Button
          testID={`${props.testid}-next`}
          icon="next"
          disabled={props.disabled || voices.fetching() || ready(voices, undefined)?.hasMore !== true}
          onPress={() => {
            const after = ready(voices, undefined)?.nextCursor;
            if (after) page.set({ scope: scope(), after });
          }}
        >
          {t("web.audio.next")}
        </Button>
        <If when={voices.fetching()}>
          <Text class="text-xs text-muted">{t("web.base.form.asking")}</Text>
        </If>
      </View>
      <If when={voices.status() === "success" && ready(voices, undefined)?.voices.length === 0}>
        <Quiet>{t("web.audio.emptyVoices")}</Quiet>
      </If>
      <Refusal error={error() ?? (voices.error() ? reasonOf(voices.error()) : undefined)} />
    </View>
  );
}
