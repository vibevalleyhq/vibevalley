import { signal, untracked, View } from "nsh";
import { z } from "zod";

import { t } from "@vibevalley/i18n";
import type { SettingsStatus } from "@vibevalley/protocol";

import { createAct } from "../../design/act";
import { KeyRow, SettingsGroup } from "../../design/domain/settings";
import { Form, formControl, formMessages } from "../../design/Form";
import { SaveBar } from "../../design/KeyField";
import { toast } from "../../design/toasts";
import { useForm, type Submission } from "../../infra/form";
import { useSaveSettings } from "../../infra/settings";

const Input = z.object({ key: z.string().trim(), removing: z.boolean() });
const blank = { key: "", removing: false };
export function DeepseekForm(props: { status: SettingsStatus }) {
  const status = signal(untracked(() => props.status));
  const saveSettings = useSaveSettings();
  const act = createAct();
  const form = useForm({
    schema: Input,
    defaultValues: blank,
    messages: formMessages,
    onSubmit: async (value, attempt): Promise<Submission<SettingsStatus>> => {
      const result = await act.attempt(() => saveSettings(value.key || value.removing ? { deepseekApiKey: value.key } : {}));
      if (result.kind === "accepted") {
        status.set(result.receipt);
        form.reset(blank, { ifRevision: attempt.revision });
        toast(t("web.setting.keys.saved"));
      }
      return result;
    },
  });
  const key = form.field(["key"]);
  const removing = form.field(["removing"]);
  const dirty = () => key.value().trim() !== "" || removing.value();
  return (
    <Form form={form} class="gap-4" testid="deepseek-form">
      {(submit) => (
        <View class="gap-4">
          <SettingsGroup title="DeepSeek">
            <KeyRow
              label="API Key"
              testid="deepseek-key"
              hint={t("web.setting.models.deepseekHint")}
              status={status().deepseekApiKey}
              value={key.value()}
              onInput={key.setValue}
              control={formControl(key)}
              removing={removing.value()}
              onRemove={removing.setValue}
              placeholder={t("web.setting.keys.deepseekHint")}
              link={{ href: "https://platform.deepseek.com/api_keys", label: "platform.deepseek.com" }}
              last
            />
          </SettingsGroup>
          <If when={dirty() || form.submitError() !== undefined}>
            <SaveBar dirty={dirty()} busy={form.submitting()} onSave={submit} onUndo={() => form.reset(blank)} />
          </If>
        </View>
      )}
    </Form>
  );
}
