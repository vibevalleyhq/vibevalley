import { signal, View } from "nsh";

import { t } from "@vibevalley/i18n";

import { api } from "../../../infra/api";
import { createAct } from "../../../ui/act";
import { Icon } from "../../../ui/Icon";
import { IconButton } from "../../../ui/IconButton";
import { Tip } from "../../../ui/Tip";

type MossVerifyResult = { readonly ok: true } | { readonly ok: false; readonly why: string };

const said = (r: MossVerifyResult) => (r.ok ? t("web.voice.voice.moss.ok") : r.why);

export function MossVerify() {
  const result = signal<MossVerifyResult | undefined>(undefined);
  // A refusal is the mark's answer too, its reason on hover.
  const act = createAct((why) => result.set({ ok: false, why }));
  const check = () => {
    result.set(undefined);
    return act.run(async () => {
      const r = await api.voice.moss.verify();
      result.set(r.problem ? { ok: false, why: r.problem } : { ok: true });
    });
  };
  return <MossVerifyView busy={act.busy()} result={result()} onCheck={() => void check()} />;
}

/** The check as it looks: nothing yet, asking, or the answer as a mark with its reason on hover. */
function MossVerifyView(props: { busy: boolean; result?: MossVerifyResult | undefined; onCheck: () => void }) {
  return (
    <View class="flex-row items-center gap-1.5">
      <IconButton icon="plug" testid="moss-verify" label={t("web.voice.voice.moss.verify")} disabled={props.busy} onClick={() => props.onCheck()} />
      <If
        when={props.busy}
        else={
          <If when={props.result}>
            {(r) => (
              <Tip text={said(r())}>
                <View role="image" accessible testID={r().ok ? "moss-ok" : "moss-problem"} accessibilityLabel={said(r())}>
                  <Icon name={r().ok ? "check" : "warn"} size={14} />
                </View>
              </Tip>
            )}
          </If>
        }
      >
        <Tip text={t("web.voice.voice.moss.checking")}>
          <View role="image" accessible accessibilityLabel={t("web.voice.voice.moss.checking")}>
            <Icon name="wait" size={14} />
          </View>
        </Tip>
      </If>
    </View>
  );
}
