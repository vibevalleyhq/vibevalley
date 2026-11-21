import { signal, Text, View } from "nsh";

import { t } from "@vibevalley/i18n";

import { api } from "../../../infra/api";
import { createAct } from "../../../ui/act";
import { Button } from "../../../ui/Button";
import { Icon } from "../../../ui/Icon";
import { Dot } from "../../../ui/Tag";
import { Bubble, Tip } from "../../../ui/Tip";
import { mix } from "../../../ui/tone";

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

function MossVerifyView(props: { busy: boolean; result?: MossVerifyResult | undefined; onCheck: () => void }) {
  return (
    <View class="flex-row flex-wrap items-center gap-2">
      <If
        when={props.busy}
        else={
          <If when={props.result}>
            {(r) => (
              <Tip text={said(r())}>
                <View
                  role="image"
                  accessible
                  testID={r().ok ? "moss-ok" : "moss-problem"}
                  accessibilityLabel={said(r())}
                  class={`h-6 flex-row items-center gap-1.5 rounded-sm px-2 ${r().ok ? "bg-ok-soft" : "max-w-64 bg-bad-soft"}`}
                >
                  <Icon name={r().ok ? "check" : "cross"} size={12} />
                  <Text class={`min-w-0 truncate text-xs font-medium ${r().ok ? "text-ok-ink" : "text-berry"}`}>{said(r())}</Text>
                </View>
              </Tip>
            )}
          </If>
        }
      >
        <Tip text={t("web.voice.voice.moss.checking")}>
          <View
            role="image"
            accessible
            accessibilityLabel={t("web.voice.voice.moss.checking")}
            class="h-6 flex-row items-center gap-1.5 rounded-sm px-2"
            style={{ backgroundColor: mix("water", 0.14) }}
          >
            <Dot tone="water" size={6} ring={false} />
            <Text class="text-xs font-medium text-water">{t("web.voice.voice.moss.checking")}</Text>
          </View>
        </Tip>
      </If>
      <Button
        icon="plug"
        size="compact"
        testID="moss-verify"
        accessibilityLabel={t("web.voice.voice.moss.verify")}
        tooltip={<Bubble text={t("web.voice.voice.moss.verify")} />}
        disabled={props.busy}
        onPress={() => props.onCheck()}
      >
        {t("web.voice.voice.moss.verify")}
      </Button>
    </View>
  );
}
