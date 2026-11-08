import * as stylex from "@stylexjs/stylex";
import { createSignal, Show } from "solid-js";

import { stories, story } from "@vibevalley/stories";

import { Field, Select, TextInput } from "#/ui/Field.tsx";
import { KeyField, SaveBar } from "#/ui/KeyField.tsx";
import { SecretInput, Toggle } from "#/ui/layout.tsx";
import { ToastHost } from "#/ui/ToastHost.tsx";
import { toast } from "#/ui/toasts.ts";

const variantStyles = stylex.create({
  formStoriesForm: {
    display: "flex",
    width: "100%",
    maxWidth: "var(--container-lg)",
    flexDirection: "column",
    gap: "calc(var(--spacing) * 4)",
  },
  formStoriesSpan: {
    color: "var(--wb-berry)",
  },
});

interface Draft {
  name: string;
  runtime: string;
  worktree: boolean;
  key: string;
  removing: boolean;
}

const saved: Draft = { name: "后端老周", runtime: "claude", worktree: true, key: "", removing: false };

export default stories({
  title: "交互/表单和保存",
  stories: {
    "Edit and save": story({
      fill: true,
      note: "改了才出现保存和撤销；保存时按钮等着，失败的原因写在保存条左边。",
      args: { fails: false },
      render: (a) => {
        const [base, setBase] = createSignal(saved);
        const [draft, setDraft] = createSignal(saved);
        const [busy, setBusy] = createSignal(false);
        const [problem, setProblem] = createSignal("");
        const patch = (p: Partial<Draft>) => setDraft({ ...draft(), ...p });
        const dirty = () => JSON.stringify(draft()) !== JSON.stringify(base());
        const save = () => {
          setBusy(true);
          setProblem("");
          setTimeout(() => {
            setBusy(false);
            if (a.fails) {
              setProblem("名字已经有人用了");
              return;
            }
            setBase({ ...draft(), key: "", removing: false });
            setDraft({ ...draft(), key: "", removing: false });
            toast("存好了");
          }, 600);
        };
        return (
          <form {...stylex.attrs(variantStyles.formStoriesForm)} onSubmit={(e) => e.preventDefault()}>
            <Field label="名字" hint="在田头和看板上叫它的">
              <TextInput value={draft().name} onInput={(e) => patch({ name: e.currentTarget.value })} />
            </Field>
            <Field label="农机">
              <Select
                label="农机"
                value={draft().runtime}
                onChange={(runtime) => patch({ runtime })}
                options={[
                  { value: "claude", label: "Claude Code" },
                  { value: "codex", label: "Codex" },
                ]}
              />
            </Field>
            <Toggle label="在工单的 worktree 里干活" checked={draft().worktree} onChange={(worktree) => patch({ worktree })} />
            <KeyField label="钥匙" status={{ source: "settings", hint: "a1b2" }} removing={draft().removing} onRemove={(removing) => patch({ removing })} small>
              <SecretInput placeholder="留空就不换" value={draft().key} onInput={(e) => patch({ key: e.currentTarget.value })} />
            </KeyField>
            <SaveBar
              dirty={dirty()}
              busy={busy()}
              onSave={save}
              onUndo={() => setDraft(base())}
              left={
                <Show when={problem()}>
                  <span {...stylex.attrs(variantStyles.formStoriesSpan)}>{problem()}</span>
                </Show>
              }
            />
            <ToastHost />
          </form>
        );
      },
    }),
  },
});
