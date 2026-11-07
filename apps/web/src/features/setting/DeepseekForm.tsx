import { Schema } from "effect";
import { createSignal, Show, snapshot, untrack } from "solid-js";

import { t } from "@vibevalley/i18n";
import type { SettingsStatus } from "@vibevalley/protocol";

import { useForm, type Submission } from "#/infra/form.ts";
import { useSaveSettings } from "#/infra/settings.ts";
import { createAct } from "#/ui/act.ts";
import { Form, formControl, formMessages } from "#/ui/Form.tsx";
import { SaveBar } from "#/ui/KeyField.tsx";
import { KeyRow, SettingsGroup } from "#/ui/settings.tsx";
import { toast } from "#/ui/toasts.ts";

const Input = Schema.Struct({ key: Schema.Trim, removing: Schema.Boolean });
const blank = { key: "", removing: false };
export function DeepseekForm(props: { status: SettingsStatus }) {
  const [status, setStatus] = createSignal(untrack(() => snapshot(props.status)));
  const saveSettings = useSaveSettings();
  const act = createAct();
  const form = useForm({
    schema: Input,
    defaultValues: blank,
    messages: formMessages,
    onSubmit: async (value, attempt): Promise<Submission<SettingsStatus>> => {
      const result = await act.attempt(() => saveSettings(value.key || value.removing ? { deepseekApiKey: value.key } : {}));
      if (result.kind === "accepted") {
        setStatus(result.receipt);
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
    <Form form={form} class="flex flex-col gap-4" testid="deepseek-form">
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
        />
      </SettingsGroup>
      <Show when={dirty() || form.submitError() !== undefined}>
        <SaveBar
          dirty={dirty()}
          busy={form.submitting()}
          onSave={() => {
            document.getElementById(key.id)?.closest("form")?.requestSubmit();
          }}
          onUndo={() => {
            form.reset(blank);
          }}
        />
      </Show>
    </Form>
  );
}
