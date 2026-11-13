// Ported from VibeValley apps/web/src/features/media/UnderstandingPanel.tsx.
import { signal, Text, View } from "nsh";

import { t } from "@vibevalley/i18n";
import type { Attachment, MediaUnderstandingJob } from "@vibevalley/protocol";

import { reasonOf } from "../../infra/api";
import { useCore } from "../../infra/frame";
import { providerQuery, ready, useQuery } from "../../infra/query";
import { Button } from "../../ui/Button";
import { Field, TextArea, TextInput } from "../../ui/Field";
import { Card, Quiet } from "../../ui/layout";

export function UnderstandingPanel(props: { file: Attachment }) {
  const core = useCore();
  const query = useQuery(providerQuery);
  const status = () => ready(query, undefined);
  const jobs = () => {
    const file = props.file.id;
    return (core()?.media ?? []).filter((job): job is MediaUnderstandingJob => job.kind === "understanding" && job.inputs.some((input) => input.hash === file));
  };
  const prompt = signal("");
  const tokens = signal(512);

  return (
    <View testID="understanding-panel" class="min-w-0 gap-4">
      <Card title={t("web.media.understanding.title")}>
        <Text class="text-sm text-muted">{t("web.media.understanding.notice")}</Text>
        <If when={status()?.understanding} else={<Quiet>{query.error() ? reasonOf(query.error()) : t("web.media.understanding.configure")}</Quiet>}>
          {(binding) => (
            <Text testID="understanding-connection" class="text-xs text-muted">
              {`${binding().connection} · ${binding().model}`}
            </Text>
          )}
        </If>
        <Text testID="understanding-file" class="text-xs text-muted">
          {props.file.name}
        </Text>
        <Field label={t("web.media.understanding.prompt")}>
          <TextArea
            testID="understanding-prompt"
            accessibilityLabel={t("web.media.understanding.prompt")}
            rows={3}
            value={prompt()}
            onInput={(e) => prompt.set(e.currentTarget.value)}
          />
        </Field>
        <Field label={t("web.media.understanding.tokens")}>
          <TextInput
            testID="understanding-tokens"
            accessibilityLabel={t("web.media.understanding.tokens")}
            value={String(tokens())}
            onInput={(e) => tokens.set(Number(e.currentTarget.value) || 512)}
          />
        </Field>
        <Button testID="understanding-submit" tone="primary" disabled={!status()?.understanding || !prompt().trim()}>
          {t("web.media.understanding.title")}
        </Button>
      </Card>
      <If when={jobs().length > 0}>
        <Each of={jobs()} key={(j) => j.id}>
          {(j) => (
            <Card title={j().phaseText}>
              <Text class="text-sm text-ink">{j().result?.text ?? j().prompt}</Text>
            </Card>
          )}
        </Each>
      </If>
    </View>
  );
}
