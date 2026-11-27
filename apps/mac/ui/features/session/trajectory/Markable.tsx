import { signal, Text, View, type JSX } from "nsh";

import { t } from "@vibevalley/i18n";

import { Button } from "../../../design/Button";
import { TextInput } from "../../../design/Field";
import { Icon } from "../../../design/Icon";
import { motionClass } from "../../../design/motion";
import { Bubble } from "../../../design/Tip";
import { mix } from "../../../design/tone";
import { createAct } from "../../../infra/act";
import { createMemo } from "../../../infra/solid";
import type { MarkWrong } from "./model";

/** Mark round wrong floats over a message it heard. */
export function Markable(props: { step: number; send: MarkWrong; file?: string | undefined; onMarked: (file: string) => void; children: JSX.Element }) {
  const writing = signal(false);
  const over = signal(false);
  const act = createAct();
  const busy = act.busy;
  const want = signal("");
  const canSubmit = createMemo(() => !busy() && Boolean(want().trim()));
  const submit = async () => {
    const w = want().trim();
    if (!w || busy()) return;
    const step = props.step;
    const send = props.send;
    const got = await act.run(() => send(step, w));
    if (!got) return;
    writing.set(false);
    props.onMarked(got.file);
  };
  return (
    <View testID="round" onMouseEnter={() => over.set(true)} onMouseLeave={() => over.set(false)}>
      {props.children}
      <If when={!props.file && !writing()}>
        <View
          role="button"
          testID="mark-wrong"
          tooltip={<Bubble text={t("web.session.trajectory.wrong")} />}
          onPress={() => writing.set(true)}
          class={`absolute top-1 right-2 flex-row items-center gap-1 rounded-md border border-line bg-page px-2 py-0.5 shadow-raise ${motionClass("transition-transform duration-120 ease-out")} focus-visible:outline-2 focus-visible:outline-focus hover:bg-hover active:translate-y-px`}
          style={{ opacity: over() ? 1 : 0 }}
          focusStyle={{ opacity: 1 }}
        >
          <Icon name="bug" size={12} tone="berry" />
          <Text class="text-xs font-medium text-ink">{t("web.session.trajectory.wrong")}</Text>
        </View>
      </If>
      <If when={props.file}>
        <View
          testID="marked"
          tooltip={<Bubble text={props.file ?? ""} />}
          class="mx-3 my-1.5 ml-8 flex-row items-center gap-1.5 rounded-md border px-2.5 py-1.5"
          style={{ backgroundColor: mix("bad-soft", 0.85), borderColor: mix("berry", 0.25) }}
        >
          <Icon name="bug" size={12} tone="berry" />
          <Text class="text-xs font-medium text-berry">{t("web.session.trajectory.marked")}</Text>
        </View>
      </If>
      <If when={writing()}>
        <View class="mx-3 my-1.5 ml-8 flex-row items-center gap-1.5">
          <TextInput
            autoFocus
            testID="mark-want"
            accessibilityLabel={t("web.session.trajectory.want")}
            disabled={busy()}
            placeholder={t("web.session.trajectory.wantHint")}
            value={want()}
            onInput={(v) => want.set(v)}
            onSubmit={() => void submit()}
            class="flex-1"
          />
          <Button tone="primary" testID="mark-submit" disabled={!canSubmit()} onPress={() => void submit()}>
            {t("web.base.write")}
          </Button>
          <Button tone="quiet" disabled={busy()} onPress={() => writing.set(false)}>
            {t("web.base.form.never")}
          </Button>
        </View>
      </If>
    </View>
  );
}
