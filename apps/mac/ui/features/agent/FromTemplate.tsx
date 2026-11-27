import { Text, View } from "nsh";

import { t } from "@vibevalley/i18n";
import type { Agent } from "@vibevalley/protocol";

import { ConfirmButton } from "../../design/ConfirmButton";
import { toast } from "../../design/toasts";
import { createAct } from "../../infra/act";
import { api } from "../../infra/api";
import { ready, useAgentTemplates, useQueryClient } from "../../infra/query";

export function FromTemplate(props: { agent: Agent; onUpdated: (a: Agent) => void }) {
  const templates = useAgentTemplates();
  const client = useQueryClient();
  const from = () => props.agent.from;
  const template = () => ready(templates, []).find((t) => t.id === from()?.template);
  const newer = () => {
    const t = template();
    const f = from();
    return t && f && t.version > f.version ? t.version : undefined;
  };
  const act = createAct();
  const update = () => {
    const agent = props.agent.id;
    const updated = props.onUpdated;
    return act.run(async () => {
      const got = await api.agent.template.update({ agent });
      await client.invalidate({ prefix: ["agents"] });
      updated(got);
      toast(t("web.agent.templates.updated"));
    });
  };
  return (
    <If when={from()}>
      {(f) => (
        <View testID="from-template" class="flex-row flex-wrap items-center gap-2 pt-2">
          <Text class="text-xs text-muted">{t("web.agent.templates.from", { name: template()?.name ?? f().template, version: f().version })}</Text>
          <If when={newer()}>
            {(v) => (
              <ConfirmButton
                label={t("web.agent.templates.update", { version: v() })}
                title={t("web.agent.templates.updateHint")}
                question={t("web.agent.templates.updateHint")}
                tone="primary"
                testid="template-update"
                onConfirm={update}
              />
            )}
          </If>
        </View>
      )}
    </If>
  );
}
